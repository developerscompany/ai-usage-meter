// Codex's session logs: <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl, and archived_sessions/ for the
// sessions the user archived, which Codex compresses (.jsonl.zst).
//
// Each API response is a "token_usage_record" line with the response's id and its tokens. Codex before
// those records only wrote "token_count" events with the session's running total: their tokens are the
// growth of that total. The model is in the "turn_context" line before them.
import path from "node:path";
import { codexHome } from "./codex.js";
import { openaiFamilyOf, openaiModelLabel, openaiPriceFor, openaiRequestCost } from "./pricing.js";
import { expandHome } from "./usage-index.js";

const FAMILY_NAMES = { astra: "Astra", sol: "Sol", terra: "Terra", luna: "Luna", "gpt-5": "GPT-5", other: "Other" };

const count = (v) => (typeof v === "number" && v > 0 ? v : 0);

/**
 * OpenAI counts cached input, and input written to the cache, inside input_tokens; reasoning inside
 * output_tokens. The keys count the three kinds of input apart, as they do for Claude.
 */
function tokensOf(usage) {
	const cacheRead = count(usage?.cached_input_tokens);
	const cacheWrite = count(usage?.cache_write_input_tokens);
	return { input: Math.max(0, count(usage?.input_tokens) - cacheRead - cacheWrite), output: count(usage?.output_tokens), cacheWrite, cacheRead };
}

const FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens"];

/** What a running total grew by since the one before. */
function growth(total, before) {
	const out = {};
	for (const f of FIELDS) out[f] = Math.max(0, count(total[f]) - count(before[f]));
	return out;
}

/** Folders with Codex logs: the user's own (one per line), or Codex's sessions and archived sessions. */
export function codexRoots(custom = "", { env = process.env, home } = {}) {
	const list = String(custom ?? "")
		.split(/[\n,;]/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (list.length) return list.map((p) => path.resolve(expandHome(p, home)));
	const dir = codexHome({ env, home });
	return [path.join(dir, "sessions"), path.join(dir, "archived_sessions")];
}

/** @type {import("./usage-index.js").LogFormat} */
export const CODEX_LOGS = {
	id: "codex",
	app: "Codex",
	marks: ['"token_usage_record"', '"turn_context"', '"token_count"'],
	roots: (custom) => codexRoots(custom),
	accepts: (name) => name.endsWith(".jsonl") || name.endsWith(".jsonl.zst"),

	parse(text, memo, file) {
		let line;
		try {
			line = JSON.parse(text);
		} catch {
			return null;
		}
		const p = line?.payload;
		if (!p || typeof p !== "object") return null;
		if (line.type === "turn_context") {
			if (typeof p.model === "string" && p.model) memo.model = p.model;
			return null;
		}
		const ts = Date.parse(line.timestamp);
		const model = memo.model ?? "unknown";
		// a log is one thread; sub-agents write logs of their own, which count like any other
		const session = path.basename(file).replace(/\.jsonl(\.zst)?$/, "");
		if (line.type === "token_usage_record") {
			memo.records = true;
			if (!p.usage || typeof p.usage !== "object") return null;
			return { id: typeof p.response_id === "string" && p.response_id ? p.response_id : `${session}:${p.turn_id}:${p.usage.total_tokens}`, ts, model, tokens: tokensOf(p.usage) };
		}
		if (line.type === "event_msg" && p.type === "token_count") {
			if (memo.records) return null; // counted by its record
			const total = p.info?.total_token_usage;
			if (!total || typeof total !== "object") return null;
			const before = memo.total;
			memo.total = total;
			// the total starts again after a reset: then the last response is all there is to go by
			const usage = before && count(total.total_tokens) >= count(before.total_tokens) ? growth(total, before) : (p.info.last_token_usage ?? total);
			return { id: `${session}:${count(total.total_tokens)}`, ts, model, tokens: tokensOf(usage) };
		}
		return null;
	},

	cost: (model, t) => openaiRequestCost(model, t),
	price: openaiPriceFor,
	family(model) {
		const id = openaiFamilyOf(model);
		return { id, name: FAMILY_NAMES[id] };
	},
	label: openaiModelLabel,
};
