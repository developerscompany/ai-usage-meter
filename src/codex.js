// Codex (OpenAI): plan limits from the endpoint the Codex app and CLI ask for their own usage panel,
// with the ChatGPT login Codex keeps in <CODEX_HOME>/auth.json (~/.codex by default). The login is only
// read: Codex renews it whenever it runs. A Codex set up with an API key alone has no plan limits.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { num } from "./limits.js";
import { tildify } from "./login.js";
import { testUrl } from "./secrets.js";
import { expandHome } from "./usage-index.js";

const USAGE_URL = testUrl(process.env.CODEX_USAGE_URL) ?? "https://chatgpt.com/backend-api/wham/usage";
const USER_AGENT = "usage-meter-streamdeck/3.2";
const DAY_MS = 86_400_000;

/** Codex's folder: CODEX_HOME, or ~/.codex. */
export function codexHome({ env = process.env, home = os.homedir() } = {}) {
	const dir = String(env.CODEX_HOME ?? "").trim();
	return dir ? path.resolve(expandHome(dir, home)) : path.join(home, ".codex");
}

/** The claims of a JWT, unverified: only its expiry and the account's email are read from them. */
function claims(jwt) {
	try {
		return JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64url").toString("utf8"));
	} catch {
		return null;
	}
}

/** The ChatGPT login in auth.json, or null: signed out, or a Codex that only has an API key. */
export function parseCodexAuth(text) {
	try {
		const tokens = JSON.parse(String(text))?.tokens;
		if (typeof tokens?.access_token !== "string" || !tokens.access_token) return null;
		const exp = claims(tokens.access_token)?.exp;
		const email = claims(tokens.id_token)?.email;
		return {
			token: tokens.access_token,
			accountId: typeof tokens.account_id === "string" ? tokens.account_id : "",
			expiresAt: typeof exp === "number" && exp > 0 ? exp * 1000 : null,
			email: typeof email === "string" && email.includes("@") ? email : null,
		};
	} catch {
		return null;
	}
}

/**
 * Codex's login and what was found (without the token) for the settings panel.
 * @returns {Promise<{ token: string, accountId: string, expiresAt: number | null, email: string | null, source: string, dir: string, logins: object[] } | null>}
 */
export async function readCodexLogin(_account = "", { home = os.homedir(), env = process.env } = {}) {
	const dir = codexHome({ env, home });
	const file = path.join(dir, "auth.json");
	let login;
	try {
		login = parseCodexAuth(await fsp.readFile(file, "utf8"));
	} catch {
		return null; // no login file
	}
	if (!login) return null;
	const source = tildify(file, home);
	return { ...login, dir, source, logins: [{ source, expiresAt: login.expiresAt, dir }] };
}

function windowOf(w, now) {
	if (!w || typeof w.used_percent !== "number") return null;
	const seconds = num(w.limit_window_seconds);
	const resetsAt = num(w.reset_at) !== null ? w.reset_at * 1000 : num(w.reset_after_seconds) !== null ? now + w.reset_after_seconds * 1000 : null;
	return { used: w.used_percent, resetsAt, ...(seconds ? { windowMs: seconds * 1000 } : {}) };
}

/**
 * The two windows of a rate limit as "the session one" (hours) and "the weekly one". Which slot holds
 * which depends on the plan: one with only a weekly limit sends it as the primary window.
 */
function windowsOf(limit, now) {
	const first = windowOf(limit?.primary_window, now);
	const second = windowOf(limit?.secondary_window, now);
	// a window that does not say how long it is: the first is the session, the second the week
	const isLong = (w) => (w.windowMs ?? (w === first ? 0 : Infinity)) >= DAY_MS;
	const list = [first, second].filter(Boolean);
	return { fiveHour: list.find((w) => !isLong(w)) ?? null, sevenDay: list.find(isLong) ?? null };
}

/** The usage answer: percentages are 0-100, times are in seconds. */
export function parseCodexUsage(json, now = Date.now()) {
	const obj = json && typeof json === "object" ? json : {};
	const credits = obj.credits && typeof obj.credits === "object" ? obj.credits : null;
	const balance = credits ? Number(credits.balance) : NaN;
	return {
		...windowsOf(obj.rate_limit, now),
		plan: typeof obj.plan_type === "string" && obj.plan_type ? obj.plan_type : null,
		credits: credits ? { has: credits.has_credits === true, unlimited: credits.unlimited === true, balance: Number.isFinite(balance) ? balance : null } : null,
		// "limit resets" an account can spend to start a limit window afresh
		resets: num(obj.rate_limit_reset_credits?.available_count),
		codeReview: obj.code_review_rate_limit ? windowsOf(obj.code_review_rate_limit, now) : null,
		// limits of single models or features, next to the main one
		more: (Array.isArray(obj.additional_rate_limits) ? obj.additional_rate_limits : [])
			.filter((l) => l && typeof l === "object")
			.map((l) => ({ name: String(l.limit_name ?? l.metered_feature ?? "Other"), ...windowsOf(l.rate_limit, now) })),
		// what the server sent, for the settings panel
		fields: Object.entries(obj)
			.filter(([k, v]) => v !== null && v !== undefined && !["user_id", "account_id", "email"].includes(k))
			.map(([k]) => k),
	};
}

/** @type {import("./limits.js").LimitsSource} */
export const CODEX_LIMITS = {
	id: "codex",
	api: "OpenAI",
	windows: ["fiveHour", "sevenDay"],
	cacheName: () => "limits-codex.json",
	login: readCodexLogin,
	request: (fetchImpl, login) =>
		fetchImpl(USAGE_URL, {
			headers: {
				Authorization: `Bearer ${login.token}`,
				...(login.accountId ? { "ChatGPT-Account-Id": login.accountId } : {}),
				Accept: "application/json",
				"User-Agent": USER_AGENT,
			},
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		}),
	parse: parseCodexUsage,
	text: {
		signin: "No Codex login found. Sign in with your ChatGPT account in the Codex app, or run `codex login` in Terminal. A Codex set up with an API key alone has no plan limits to show.",
		expired: "The Codex login the plugin found has expired. Open Codex and send any message: Codex then renews its login and the keys update within a minute.",
	},
};
