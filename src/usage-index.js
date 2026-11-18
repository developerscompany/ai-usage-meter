// Incremental reader of session logs: tokens, cost, models, hours and sessions. How a program writes
// its logs is a "format": Claude Code's here, Codex's in codex-logs.js.
//
// Claude Code (~/.claude/projects/**/*.jsonl) writes one JSONL line per content block of a response,
// and every line of the same response repeats the same message.id and usage. Resumed sessions also copy
// old lines into a new file. So usage is de-duplicated by message id before it is summed.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { familyOf, modelLabel, priceFor, requestCost } from "./pricing.js";

const CHUNK_SIZE = 1 << 20;
// Assistant lines are well below this; longer lines (pasted images, huge tool output) never carry usage.
const MAX_LINE = 16 << 20;
const NEWLINE = 0x0a;
const MAX_DEPTH = 6;

export const FIELDS = ["input", "output", "cacheWrite", "cacheRead"];
// Per-request counters kept for de-duplication; cacheWrite1h and webSearches only matter for the price.
const RECORD_FIELDS = [...FIELDS, "cacheWrite1h", "webSearches"];

export function emptyTotals() {
	return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, requests: 0, cost: 0 };
}

function addTotals(target, source) {
	for (const f of FIELDS) target[f] += source[f];
	target.requests += source.requests;
	target.cost += source.cost;
}

/** Local calendar day as "YYYY-MM-DD". */
export function dayKey(date) {
	const m = date.getMonth() + 1;
	const d = date.getDate();
	return `${date.getFullYear()}-${m < 10 ? "0" : ""}${m}-${d < 10 ? "0" : ""}${d}`;
}

/** Local hour as "YYYY-MM-DDTHH". */
export function hourKey(date) {
	const h = date.getHours();
	return `${dayKey(date)}T${h < 10 ? "0" : ""}${h}`;
}

export function startOfDay(date) {
	const d = new Date(date);
	d.setHours(0, 0, 0, 0);
	return d;
}

export function addDays(date, days) {
	const d = new Date(date);
	d.setDate(d.getDate() + days);
	return d;
}

export function expandHome(p, home = os.homedir()) {
	if (p === "~") return home;
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
	return p;
}

function isDir(p) {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Folders that hold Claude Code transcripts.
 * @param {string} custom user-supplied folders (one per line, or comma separated); empty = auto-detect
 */
export function resolveRoots(custom = "", { home = os.homedir(), env = process.env } = {}) {
	const candidates = [];
	const list = String(custom ?? "")
		.split(/[\n,;]/)
		.map((s) => s.trim())
		.filter(Boolean);

	if (list.length) {
		for (const p of list) {
			const dir = path.resolve(expandHome(p, home));
			const projects = path.join(dir, "projects");
			candidates.push(isDir(projects) ? projects : dir);
		}
	} else {
		for (const dir of String(env.CLAUDE_CONFIG_DIR ?? "").split(",")) {
			if (dir.trim()) candidates.push(path.join(expandHome(dir.trim(), home), "projects"));
		}
		candidates.push(path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "claude", "projects"));
		candidates.push(path.join(home, ".claude", "projects"));
		// Extra Claude Code profiles, e.g. ~/.claude-work used via CLAUDE_CONFIG_DIR.
		try {
			for (const ent of fs.readdirSync(home, { withFileTypes: true })) {
				if (ent.isDirectory() && /^\.claude[-_.]./i.test(ent.name)) {
					candidates.push(path.join(home, ent.name, "projects"));
				}
			}
		} catch {
			// unreadable home directory: keep the defaults
		}
	}

	const seen = new Set();
	const roots = [];
	for (const dir of candidates) {
		if (!isDir(dir)) continue;
		let real;
		try {
			real = fs.realpathSync(dir);
		} catch {
			continue;
		}
		if (seen.has(real)) continue;
		seen.add(real);
		roots.push(dir);
	}
	return roots;
}

async function collectJsonl(dir, out, depth, accepts) {
	let entries;
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const ent of entries) {
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (depth < MAX_DEPTH && ent.name !== "node_modules" && ent.name !== ".git") {
				await collectJsonl(full, out, depth + 1, accepts);
			}
		} else if (ent.isFile() && accepts(ent.name)) {
			out.push(full);
		}
	}
}

function tokens(value) {
	return typeof value === "number" && value > 0 ? value : 0;
}

function costOf(model, t, fast) {
	const cacheWrite1h = Math.min(t.cacheWrite1h, t.cacheWrite);
	return requestCost(model, {
		input: t.input,
		output: t.output,
		cacheWrite5m: t.cacheWrite - cacheWrite1h,
		cacheWrite1h,
		cacheRead: t.cacheRead,
		webSearches: t.webSearches,
		fast,
	});
}

const FAMILY_NAMES = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable", other: "Other" };

/**
 * One API response found in a log.
 * @typedef {object} LogEntry
 * @property {string | undefined} id   the same response logged again has the same id; counted once
 * @property {number} ts
 * @property {string} model
 * @property {boolean} [fast]
 * @property {{ input: number, output: number, cacheWrite: number, cacheRead: number, cacheWrite1h?: number, webSearches?: number }} tokens
 * @property {{ id: string, cwd: string } | null} [session]  the main-thread session it belongs to
 *
 * How a program writes its session logs, and what its models cost.
 * @typedef {object} LogFormat
 * @property {string} id            "claude" or "codex"
 * @property {string} app           the program, for messages: "Claude Code"
 * @property {string[]} marks       only lines that contain one of these are parsed
 * @property {(custom?: string) => string[]} roots   folders to scan; `custom` are the user's own, "" to find them
 * @property {(name: string) => boolean} [accepts]   the log files among a folder's files; *.jsonl when left out
 * @property {(text: string, memo: object, file: string) => LogEntry | null} parse   `memo` is kept per file
 * @property {(model: string, tokens: object, fast: boolean) => number} cost   USD at API list prices
 * @property {(model: string) => { input: number, cacheRead: number } | null} price   USD per million tokens
 * @property {(model: string) => { id: string, name: string }} family   the group a model counts under
 * @property {(model: string) => string} label
 */

/** @type {LogFormat} */
export const CLAUDE_LOGS = {
	id: "claude",
	app: "Claude Code",
	marks: ['"usage":{'],
	roots: (custom) => resolveRoots(custom),
	parse(text) {
		// Tool results of sub-agents also contain "usage", but only assistant lines are API responses.
		if (!text.includes('"assistant"')) return null;
		let entry;
		try {
			entry = JSON.parse(text);
		} catch {
			return null;
		}
		if (entry?.type !== "assistant") return null;
		const message = entry.message;
		const usage = message?.usage;
		if (!usage || typeof usage !== "object") return null;
		const cacheWrite = tokens(usage.cache_creation_input_tokens);
		return {
			id: message.id || entry.requestId,
			ts: Date.parse(entry.timestamp),
			model: typeof message.model === "string" ? message.model : "unknown",
			fast: usage.speed === "fast",
			tokens: {
				input: tokens(usage.input_tokens),
				output: tokens(usage.output_tokens),
				cacheWrite,
				cacheRead: tokens(usage.cache_read_input_tokens),
				cacheWrite1h: Math.min(cacheWrite, tokens(usage.cache_creation?.ephemeral_1h_input_tokens)),
				webSearches: tokens(usage.server_tool_use?.web_search_requests),
			},
			session: entry.isSidechain ? null : { id: entry.sessionId || "unknown", cwd: typeof entry.cwd === "string" ? entry.cwd : "" },
		};
	},
	cost: costOf,
	price: priceFor,
	family(model) {
		const id = familyOf(model);
		return { id, name: FAMILY_NAMES[id] };
	},
	label: modelLabel,
};

const isJsonl = (name) => name.endsWith(".jsonl");

export class UsageIndex {
	/**
	 * @param {() => string[]} getRoots folders to scan; called on every scan so new profiles are picked up
	 * @param {{ windowDays?: number, now?: () => Date, format?: LogFormat, inflate?: ((data: Buffer) => Buffer) | null }} [options]
	 *        inflate: opens a .zst log (Codex compresses the sessions it archives); null where Node.js cannot
	 */
	constructor(getRoots, { windowDays = 40, now = () => new Date(), format = CLAUDE_LOGS, inflate = zlib.zstdDecompressSync ?? null } = {}) {
		this.format = format;
		this.marks = format.marks.map((mark) => Buffer.from(mark));
		this.inflate = inflate;
		this.getRoots = getRoots;
		this.windowDays = windowDays;
		this.now = now;
		this.roots = [];
		this.lastScan = null;
		this.scanning = null;
		this.reset(0);
	}

	reset(windowStartMs) {
		this.windowStartMs = windowStartMs;
		this.files = new Map(); // path -> { offset, size, mtimeMs }
		this.seen = new Map(); // message id -> counters of that response, its day/hour/model and cost
		this.days = new Map(); // "YYYY-MM-DD" -> Map(model -> totals)
		this.hours = new Map(); // "YYYY-MM-DDTHH" -> totals of all models
		this.sessions = new Map(); // session id -> latest main-thread request { at, model, context, cwd }
	}

	/** Reads whatever was appended since the previous call. Concurrent calls share one scan. */
	refresh() {
		this.scanning ??= this.scan().finally(() => {
			this.scanning = null;
		});
		return this.scanning;
	}

	async scan() {
		const started = Date.now();
		// Start from scratch once a day so memory stays bounded to the window. The fresh totals are
		// collected aside and swapped in when complete: until then the keys keep showing the old ones.
		const windowStartMs = startOfDay(addDays(this.now(), 1 - this.windowDays)).getTime();
		if (windowStartMs !== this.windowStartMs && this.lastScan) {
			const fresh = new UsageIndex(this.getRoots, { windowDays: this.windowDays, now: this.now, format: this.format, inflate: this.inflate });
			const scan = await fresh.scan();
			for (const part of ["windowStartMs", "roots", "files", "seen", "days", "hours", "sessions"]) this[part] = fresh[part];
			this.lastScan = scan;
			return scan;
		}
		if (windowStartMs !== this.windowStartMs) this.reset(windowStartMs);

		this.roots = this.getRoots();
		const files = [];
		for (const root of this.roots) await collectJsonl(root, files, 0, this.format.accepts ?? isJsonl);

		let bytes = 0;
		let errors = 0;
		let unread = 0; // compressed logs this Node.js cannot open
		const present = new Set(files);
		for (const file of files) {
			try {
				const st = await fsp.stat(file);
				if (st.mtimeMs < this.windowStartMs) continue; // nothing new enough in it
				if (!file.endsWith(".zst")) bytes += await this.readAppended(file, st);
				else if (this.inflate) bytes += await this.readCompressed(file, st);
				else unread++;
			} catch {
				errors++;
			}
		}
		// Forget deleted files; the tokens they contributed stay counted.
		for (const file of this.files.keys()) if (!present.has(file)) this.files.delete(file);

		this.lastScan = { at: Date.now(), ms: Date.now() - started, files: files.length, bytes, errors, unread };
		return this.lastScan;
	}

	async readAppended(file, st) {
		let state = this.files.get(file);
		if (!state) this.files.set(file, (state = { offset: 0, size: -1, mtimeMs: 0, ino: st.ino, memo: {} }));
		if (st.size === state.size && st.mtimeMs === state.mtimeMs && st.ino === state.ino) return 0;
		if (st.size < state.offset || st.ino !== state.ino) {
			// rewritten, or another file under the same name
			state.offset = 0;
			state.memo = {};
			state.ino = st.ino;
		}
		const { memo } = state;

		const from = state.offset;
		let pos = from;
		let pending = []; // pieces of a line that continues in the next chunk
		let pendingLen = 0;
		const fh = await fsp.open(file, "r");
		try {
			while (pos < st.size) {
				const buf = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, st.size - pos));
				const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
				if (bytesRead === 0) break;
				const chunk = bytesRead < buf.length ? buf.subarray(0, bytesRead) : buf;
				const chunkStart = pos;
				pos += bytesRead;

				let start = 0;
				if (pendingLen) {
					const nl = chunk.indexOf(NEWLINE);
					if (nl === -1) {
						if (pendingLen + chunk.length <= MAX_LINE) pending.push(chunk);
						pendingLen += chunk.length;
						continue;
					}
					if (pendingLen + nl <= MAX_LINE) {
						pending.push(chunk.subarray(0, nl));
						const line = Buffer.concat(pending);
						this.scanLines(line, 0, line.length, memo, file);
					}
					pending = [];
					pendingLen = 0;
					start = nl + 1;
					state.offset = chunkStart + start;
				}

				const last = chunk.lastIndexOf(NEWLINE);
				if (last >= start) {
					this.scanLines(chunk, start, last, memo, file);
					start = last + 1;
					state.offset = chunkStart + start;
				}
				if (start < chunk.length) {
					pending.push(chunk.subarray(start));
					pendingLen = chunk.length - start;
				}
			}
		} finally {
			await fh.close();
		}

		// A last line without a newline yet: count it now if it is already complete JSON.
		// The offset stays before it, so it is read again later; the id check prevents double counting.
		if (pendingLen && pendingLen <= MAX_LINE) {
			const line = Buffer.concat(pending);
			this.scanLines(line, 0, line.length, memo, file);
		}

		state.size = st.size;
		state.mtimeMs = st.mtimeMs;
		return pos - from;
	}

	/** A compressed log cannot be read from where the last scan stopped: when it has changed, all of it is read. */
	async readCompressed(file, st) {
		let state = this.files.get(file);
		if (!state) this.files.set(file, (state = { offset: 0, size: -1, mtimeMs: 0, memo: {} }));
		if (st.size === state.size && st.mtimeMs === state.mtimeMs) return 0;
		const text = this.inflate(await fsp.readFile(file));
		state.memo = {};
		this.scanLines(text, 0, text.length, state.memo, file);
		state.size = st.size;
		state.mtimeMs = st.mtimeMs;
		return st.size;
	}

	/** Parses the lines of buf[start, end) that contain one of the format's marks. */
	scanLines(buf, start, end, memo = {}, file = "") {
		// where each mark is found next; a mark is looked for again only once the scan has passed it
		const next = this.marks.map((mark) => buf.indexOf(mark, start));
		let pos = start;
		while (pos < end) {
			let hit = -1;
			for (let i = 0; i < next.length; i++) {
				if (next[i] !== -1 && next[i] < pos) next[i] = buf.indexOf(this.marks[i], pos);
				if (next[i] !== -1 && (hit === -1 || next[i] < hit)) hit = next[i];
			}
			if (hit === -1 || hit >= end) return;
			const lineStart = Math.max(start, buf.lastIndexOf(NEWLINE, hit) + 1);
			let lineEnd = buf.indexOf(NEWLINE, hit);
			if (lineEnd === -1 || lineEnd > end) lineEnd = end;
			this.addLine(buf.toString("utf8", lineStart, lineEnd), memo, file);
			pos = lineEnd + 1;
		}
	}

	addLine(text, memo = {}, file = "") {
		const entry = this.format.parse(text, memo, file);
		if (!entry) return;
		const { ts, model } = entry;
		if (!(ts >= this.windowStartMs)) return;
		const t = { cacheWrite1h: 0, webSearches: 0, ...entry.tokens };
		if (!(t.input || t.output || t.cacheWrite || t.cacheRead)) return;
		const fast = entry.fast === true;

		if (entry.session) this.noteSession(entry.session, ts, model, t);

		const { id } = entry;
		const prev = id && this.seen.get(id);
		if (prev) {
			// Same response logged again: keep the largest value of each counter.
			const delta = emptyTotals();
			let grew = false;
			for (const f of RECORD_FIELDS) {
				if (t[f] > prev[f]) {
					if (f in delta) delta[f] = t[f] - prev[f];
					prev[f] = t[f];
					grew = true;
				}
			}
			if (!grew) return;
			const cost = this.format.cost(prev.model, prev, prev.fast);
			delta.cost = cost - prev.cost;
			prev.cost = cost;
			this.addToBuckets(prev.day, prev.hour, prev.model, delta);
			return;
		}

		const at = new Date(ts);
		const record = { day: dayKey(at), hour: hourKey(at), model, fast, ...t, cost: this.format.cost(model, t, fast) };
		this.addToBuckets(record.day, record.hour, model, { ...t, requests: 1, cost: record.cost });
		if (id) this.seen.set(id, record);
	}

	addToBuckets(day, hour, model, delta) {
		let models = this.days.get(day);
		if (!models) this.days.set(day, (models = new Map()));
		let bucket = models.get(model);
		if (!bucket) models.set(model, (bucket = emptyTotals()));
		addTotals(bucket, delta);
		let hourly = this.hours.get(hour);
		if (!hourly) this.hours.set(hour, (hourly = emptyTotals()));
		addTotals(hourly, delta);
	}

	noteSession({ id, cwd }, ts, model, t) {
		const known = this.sessions.get(id);
		if (known && known.at > ts) return;
		this.sessions.set(id, { id, at: ts, model, context: t.input + t.cacheWrite + t.cacheRead, output: t.output, cwd });
	}

	/** Main-thread sessions, most recent first. */
	recentSessions(limit = 5) {
		return [...this.sessions.values()].sort((a, b) => b.at - a.at).slice(0, limit);
	}

	/** Totals for one local day ("YYYY-MM-DD"), all models. */
	day(key) {
		const total = emptyTotals();
		for (const bucket of this.days.get(key)?.values() ?? []) addTotals(total, bucket);
		return total;
	}

	/** Totals for one local hour ("YYYY-MM-DDTHH"). */
	hour(key) {
		return this.hours.get(key) ?? emptyTotals();
	}

	/** Totals over a list of local days. */
	sum(days) {
		const total = emptyTotals();
		for (const key of days) {
			for (const bucket of this.days.get(key)?.values() ?? []) addTotals(total, bucket);
		}
		return total;
	}

	/** Totals per model over a list of local days. */
	byModel(days) {
		const out = new Map();
		for (const key of days) {
			for (const [model, bucket] of this.days.get(key) ?? []) {
				let total = out.get(model);
				if (!total) out.set(model, (total = emptyTotals()));
				addTotals(total, bucket);
			}
		}
		return out;
	}
}
