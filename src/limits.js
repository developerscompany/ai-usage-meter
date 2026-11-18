// Plan limits of a service: requests, retries, a cache and a short history. Where the numbers come from
// is a "source": Claude here, Codex in codex.js, Kimi in kimi.js.
//
// Claude: 5-hour session, weekly and per-model weekly limits, extra usage and included credits, from the
// endpoint that Claude Code's /usage command calls, with Claude Code's own login (see login.js).
// The login is only read; an expired one is still tried, and the server decides.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXPIRY_MARGIN_MS, accountDir, readCredentials } from "./login.js";
import { safeMessage, testUrl } from "./secrets.js";

export { accountDir, keychainServices, loginCandidates, parseCredentials, pickLogin, readCredentials } from "./login.js";

const USAGE_URL = testUrl(process.env.CLAUDE_USAGE_URL) ?? "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const USER_AGENT = "usage-meter-for-claude-streamdeck/3.2";
const REREAD_TOKEN_MS = 30_000;
// A login that is still valid is read again this often: after /login with another account, or a
// fresher login in another profile, the keys follow within minutes instead of at the old one's end.
const REUSE_LOGIN_MS = 5 * 60_000;
const SAMPLE_EVERY_MS = 5 * 60_000;
const HISTORY_MS = 8 * 86_400_000;
const MAX_BACKOFF_MS = 10 * 60_000;

/** How long each limit window is, unless the service says so itself. */
export const WINDOW_MS = {
	fiveHour: 5 * 3_600_000,
	sevenDay: 7 * 86_400_000,
	sonnet: 7 * 86_400_000,
	opus: 7 * 86_400_000,
	fable: 7 * 86_400_000,
	haiku: 7 * 86_400_000,
	month: 30 * 86_400_000,
};

/** Windows kept in the history, in column order. */
const SAMPLED = ["fiveHour", "sevenDay", "sonnet", "opus", "fable", "haiku"];
/** Weekly limits of one model: a seven_day_<model> field, or an entry in the newer `limits` list. */
const MODEL_WINDOWS = ["sonnet", "opus", "fable", "haiku"];

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
export const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const time = (v) => {
	const t = v ? Date.parse(v) : NaN;
	return Number.isFinite(t) ? t : null;
};

function windowOf(o) {
	if (!o || typeof o.utilization !== "number") return null;
	return { used: o.utilization, resetsAt: time(o.resets_at) };
}

/** A dollar credit such as the cloud session credit: "$222 of $250 left, expires November 4". */
function creditOf(o) {
	if (!o || typeof o !== "object") return null;
	const limit = num(o.limit_dollars);
	let spent = num(o.used_dollars);
	let remaining = num(o.remaining_dollars);
	if (spent === null && limit !== null && remaining !== null) spent = limit - remaining;
	if (remaining === null && limit !== null && spent !== null) remaining = limit - spent;
	let used = num(o.utilization);
	if (used === null && limit && spent !== null) used = (spent / limit) * 100;
	if (used === null) return null;
	if (limit !== null && spent === null) {
		spent = (limit * used) / 100;
		remaining = limit - spent;
	}
	const resetsAt = time(o.resets_at);
	const periods = Array.isArray(o.periods) ? o.periods : [];
	const lastEnd = time(periods.at(-1)?.ends_at);
	return {
		label: typeof o.label === "string" && o.label ? o.label : null,
		used,
		limit,
		spent,
		remaining,
		resetsAt,
		// Claude Code says "Resets" only for credits that renew (two periods or more), else "Expires"
		recurring: periods.length >= 2 && resetsAt !== null && lastEnd !== null && resetsAt < lastEnd,
	};
}

/** An object with dollar amounts, like the credit in `wattle_ember` (a code name that may change). */
const isCredit = (o) => !!o && typeof o === "object" && !Array.isArray(o) && (num(o.limit_dollars) !== null || num(o.remaining_dollars) !== null);

/** The /api/oauth/usage response; utilization is a percentage, extra usage credits are cents. */
export function parseUsage(json) {
	const obj = json && typeof json === "object" ? json : {};
	const extra = obj.extra_usage;
	const creditField = obj.wattle_ember ? "wattle_ember" : Object.keys(obj).find((k) => isCredit(obj[k]));
	return {
		fiveHour: windowOf(json?.five_hour),
		sevenDay: windowOf(json?.seven_day),
		sonnet: windowOf(json?.seven_day_sonnet),
		opus: windowOf(json?.seven_day_opus),
		fable: windowOf(json?.seven_day_fable),
		haiku: windowOf(json?.seven_day_haiku),
		// newer answers list per-model weekly limits here
		modelLimits: (Array.isArray(json?.limits) ? json.limits : [])
			.filter((l) => typeof l?.scope?.model?.display_name === "string" && typeof l.percent === "number")
			.map((l) => ({ name: l.scope.model.display_name, used: l.percent, resetsAt: time(l.resets_at) })),
		credit: creditField ? creditOf(obj[creditField]) : null,
		codeCredit: windowOf(json?.cinder_cove),
		extra: extra
			? {
					enabled: extra.is_enabled === true,
					limit: typeof extra.monthly_limit === "number" ? extra.monthly_limit / 100 : null,
					spent: typeof extra.used_credits === "number" ? extra.used_credits / 100 : null,
					used: typeof extra.utilization === "number" ? extra.utilization : null,
				}
			: null,
		// what the server sent, for the settings panel
		fields: Object.entries(obj)
			.filter(([, v]) => v !== null && v !== undefined)
			.map(([k, v]) => (Array.isArray(v) ? `${k} (${v.length})` : k)),
	};
}

export function dataDir(home = os.homedir()) {
	if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "agency.rivo.usage-meter-for-claude");
	if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "agency.rivo.usage-meter-for-claude");
	return path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), "agency.rivo.usage-meter-for-claude");
}

/**
 * Where a service's plan limits come from.
 * @typedef {object} LimitsSource
 * @property {string} id                 "claude", "codex" or "kimi"
 * @property {string} api                what answers, for messages: "Anthropic API"
 * @property {string[]} windows          the limit windows kept in the history, in column order
 * @property {(account: string) => string} cacheName   the cache file of an account
 * @property {(account: string) => string | null} [oldCacheName]  where an earlier version kept it, if elsewhere
 * @property {(account: string, o: { dirs: string[], now: number }) => Promise<object | null>} login
 *           reads the login: { token, expiresAt, source, dir, logins } or null; never changes it
 * @property {(fetchImpl: typeof fetch, login: object) => Promise<Response>} request
 * @property {(json: any, now: number) => object} parse
 * @property {(data: object, name: string) => { used: number, resetsAt: number | null, windowMs?: number } | null} [window]
 *           a window that is not simply data[name]
 * @property {boolean} [exactExpiry]     the login says exactly when it ends: an expired one is not sent
 * @property {{ signin: string, expired: string }} text   what the settings panel says about a missing or expired login
 */

/** @type {LimitsSource} */
export const CLAUDE_LIMITS = {
	id: "claude",
	api: "Anthropic API",
	windows: SAMPLED,
	// "Auto" takes the freshest login of any profile, which need not be the default profile's: the two
	// must not share a cache, or one key would show the other account's numbers as its own
	cacheName: (account) => (account ? `limits-${sha(accountDir(account)).slice(0, 10)}.json` : "limits-auto.json"),
	// where Auto's numbers were kept before, read once so the history collected there is not lost
	oldCacheName: (account) => (account ? null : `limits-${sha(accountDir("")).slice(0, 10)}.json`),
	login: readCredentials,
	request: (fetchImpl, login) =>
		fetchImpl(USAGE_URL, {
			headers: {
				Authorization: `Bearer ${login.token}`,
				"anthropic-beta": OAUTH_BETA,
				"Content-Type": "application/json",
				"User-Agent": USER_AGENT,
			},
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		}),
	parse: (json) => parseUsage(json),
	// per-model limits also come from the newer `limits` list
	window(data, name) {
		const w = data?.[name];
		if (w) return w;
		if (!MODEL_WINDOWS.includes(name)) return null;
		const m = data?.modelLimits?.find((l) => l.name.toLowerCase().includes(name));
		return m ? { used: m.used, resetsAt: m.resetsAt } : null;
	},
	text: {
		signin: "No Claude Code login found for this account. Sign in with `claude` in Terminal, or pick another account.",
		expired: "The Claude Code login the plugin found has expired. Run `claude` in Terminal and send any message: Claude Code then renews its login and the keys update within a minute.",
	},
};

const loginMeta = (creds) =>
	creds && { source: creds.source ?? "", dir: creds.dir ?? null, expiresAt: creds.expiresAt ?? null, logins: creds.logins ?? [], email: creds.email ?? null, kind: creds.kind ?? null, host: creds.host ?? null };

export class LimitsService {
	/**
	 * @param {string} account "" for Auto (the freshest Claude Code login), or a profile folder such as ~/.claude-work;
	 *                         Codex and Kimi have one login, and take ""
	 * @param {{ source?: LimitsSource, profileDirs?: () => string[] }} options profileDirs: Claude Code folders to look for logins in Auto mode
	 */
	constructor(account, { source = CLAUDE_LIMITS, dir = dataDir(), log = null, fetchImpl = globalThis.fetch, credentials = source.login, profileDirs = () => [], now = Date.now } = {}) {
		this.source = source;
		this.account = account;
		this.profileDirs = profileDirs;
		this.log = log;
		this.fetchImpl = fetchImpl;
		this.credentials = credentials;
		this.now = now;
		this.data = null;
		this.fetchedAt = 0;
		this.error = null; // { code: "signin" | "expired" | "auth" | "rate" | "network" | "http", message }
		this.history = []; // [time, one column per window of the source]
		this.creds = null;
		this.credsReadAt = 0;
		this.lastLogin = null;
		this.failures = 0;
		this.retryAt = 0;
		this.inflight = null;
		this.cacheFile = dir ? path.join(dir, source.cacheName(account)) : null;
		const old = dir && source.oldCacheName?.(account);
		this.load(this.cacheFile) || (old && this.load(path.join(dir, old)));
	}

	/** Takes the numbers and history from a cache file; false when there is none to take. */
	load(file) {
		if (!file) return false;
		try {
			const saved = JSON.parse(fs.readFileSync(file, "utf8"));
			this.data = saved.data ?? null;
			this.fetchedAt = saved.fetchedAt ?? 0;
			this.history = Array.isArray(saved.history) ? saved.history : [];
			return true;
		} catch {
			return false; // first run
		}
	}

	save() {
		if (!this.cacheFile) return;
		try {
			fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
			// written beside the file and moved over it, so a crash half way cannot leave a broken cache
			const tmp = `${this.cacheFile}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify({ data: this.data, fetchedAt: this.fetchedAt, history: this.history }));
			fs.renameSync(tmp, this.cacheFile);
		} catch (err) {
			this.log?.warn(`cannot save limits cache: ${err.message}`);
		}
	}

	/** Fetches unless a previous error asked to wait; `force` skips that wait except after HTTP 429. */
	refresh(force = false) {
		this.inflight ??= this.fetchNow(force).finally(() => {
			this.inflight = null;
		});
		return this.inflight;
	}

	async token() {
		const now = this.now();
		const valid = this.creds && (!this.creds.expiresAt || this.creds.expiresAt - EXPIRY_MARGIN_MS > now);
		if (this.credsReadAt && now - this.credsReadAt < (valid ? REUSE_LOGIN_MS : REREAD_TOKEN_MS)) return this.creds;
		this.credsReadAt = now;
		this.creds = await this.credentials(this.account, { dirs: this.profileDirs(), now });
		// kept apart from the token so the settings panel can still show it after a refusal
		this.lastLogin = loginMeta(this.creds);
		return this.creds;
	}

	/** What the settings panel shows about the login, never the token itself. */
	loginInfo() {
		return this.lastLogin ?? null;
	}

	fail(code, message, retryAfterMs) {
		this.failures++;
		this.error = { code, message };
		const backoff = Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** (this.failures - 1));
		this.retryAt = this.now() + (retryAfterMs ?? backoff);
	}

	async fetchNow(force) {
		const now = this.now();
		if (now < this.retryAt && (!force || this.error?.code === "rate")) return;

		const { api, text } = this.source;
		const creds = await this.token();
		if (!creds) {
			this.error = { code: "signin", message: text.signin };
			return;
		}
		// An old expiry date is only a hint: ask anyway and let the server decide. A login that states its
		// own end exactly (Kimi's lasts 15 minutes) is not sent once it is over; it is read again instead.
		const expired = !!creds.expiresAt && creds.expiresAt - EXPIRY_MARGIN_MS <= now;
		if (expired && this.source.exactExpiry) {
			this.credsReadAt = 0; // look for a renewed login next time
			this.fail("expired", text.expired, REREAD_TOKEN_MS);
			return;
		}

		let res;
		try {
			res = await this.source.request(this.fetchImpl, creds);
		} catch (err) {
			this.fail("network", err?.name === "TimeoutError" ? `${api} timed out` : `Network error: ${safeMessage(err, creds.token)}`);
			return;
		}

		if (res.status === 401 || res.status === 403) {
			this.creds = null; // read the login again next time
			this.credsReadAt = 0;
			if (expired) {
				this.fail("expired", text.expired, 60_000);
			} else {
				this.fail("auth", `${api} refused the ${creds.kind === "key" ? "key" : "token"} (HTTP ${res.status})`);
			}
			return;
		}
		if (res.status === 429) {
			const seconds = Number(res.headers.get("retry-after"));
			this.fail("rate", `${api} rate limit; retrying later`, seconds > 0 ? seconds * 1000 : undefined);
			return;
		}
		if (!res.ok) {
			this.fail("http", `${api} error (HTTP ${res.status})`);
			return;
		}

		try {
			this.data = this.source.parse(await res.json(), now);
		} catch {
			this.fail("http", `Unexpected answer from the ${api}`);
			return;
		}
		this.fetchedAt = now;
		this.error = null;
		this.failures = 0;
		this.retryAt = 0;
		this.sample(now);
		this.save();
	}

	/** A window as the server sent it. */
	rawWindow(name) {
		return (this.source.window ? this.source.window(this.data, name) : this.data?.[name]) ?? null;
	}

	sample(now) {
		const row = [now, ...this.source.windows.map((name) => this.rawWindow(name)?.used ?? null)];
		const last = this.history.at(-1);
		const changed = !last || row.some((v, i) => i > 0 && v !== last[i]);
		if (changed || now - last[0] >= SAMPLE_EVERY_MS) this.history.push(row);
		while (this.history.length && this.history[0][0] < now - HISTORY_MS) this.history.shift();
	}

	/**
	 * One limit window as it is now: after its reset time the window is empty again.
	 * `windowMs` is there when the service says how long the window is (Codex does).
	 * @param {string} name "fiveHour", "sevenDay", or another window of the source ("sonnet", "month", ...)
	 */
	window(name, now = this.now()) {
		const w = this.rawWindow(name);
		if (!w) return null;
		const length = w.windowMs ? { windowMs: w.windowMs } : {};
		if (w.resetsAt && now >= w.resetsAt) return { used: 0, resetsAt: null, reset: true, ...length };
		return { used: w.used, resetsAt: w.resetsAt, reset: false, ...length };
	}

	/** Samples of one window: [[time, percent], ...] */
	series(name) {
		const column = this.source.windows.indexOf(name) + 1;
		if (!column) return [];
		return this.history.filter((row) => row[column] !== null && row[column] !== undefined).map((row) => [row[0], row[column]]);
	}

	/** True when the numbers shown are older than they should be. */
	stale(refreshSeconds, now = this.now()) {
		return !this.fetchedAt || now - this.fetchedAt > Math.max(3 * refreshSeconds * 1000, 5 * 60_000);
	}
}
