// Kimi Code (Moonshot AI): plan limits from the endpoint Kimi Code asks for its own usage panel.
// Two logins work, and both are only read:
//  - a Kimi Code API key the user stored for the plugin: the macOS Keychain item "AI Usage Meter Kimi API Key",
//    or the file kimi-api-key in the plugin's data folder. A key does not expire.
//  - else the login of the Kimi Code app in <KIMI_CODE_HOME>/credentials (~/.kimi-code by default). It lasts
//    15 minutes, and Kimi Code renews it only while it is in use, so without a key the numbers go stale
//    soon after you stop working in Kimi Code.
// Either is sent to Kimi's own API only: api.kimi.com or api.kimi.ai, whichever Kimi Code is set up with.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSecurity } from "./keychain.js";
import { dataDir, num, time } from "./limits.js";
import { cleanSecret, testUrl } from "./secrets.js";
import { tildify } from "./login.js";
import { expandHome } from "./usage-index.js";

const USAGE_URL = testUrl(process.env.KIMI_USAGE_URL);
const USER_AGENT = "ai-usage-meter-streamdeck/4.0";
export const KIMI_KEY_SERVICE = "AI Usage Meter Kimi API Key";
export const KIMI_KEY_FILE = "kimi-api-key";

// Kimi's API in mainland China and elsewhere; a login is only ever sent to one of these.
const BASES = ["https://api.kimi.com/coding/v1", "https://api.kimi.ai/coding/v1"];

/** Kimi Code's folder: KIMI_CODE_HOME, or ~/.kimi-code. */
export function kimiHome({ env = process.env, home = os.homedir() } = {}) {
	const dir = String(env.KIMI_CODE_HOME ?? "").trim();
	return dir ? path.resolve(expandHome(dir, home)) : path.join(home, ".kimi-code");
}

function sameUrl(url) {
	try {
		const u = new URL(url);
		return `${u.origin.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
	} catch {
		return null;
	}
}

/** The API address in Kimi Code's config.toml when it is one of Kimi's own, else the default one. */
export function kimiBase(config) {
	for (const m of String(config ?? "").matchAll(/^\s*base_url\s*=\s*"([^"]*)"/gm)) {
		const known = BASES.find((base) => base === sameUrl(m[1]));
		if (known) return known;
	}
	return BASES[0];
}

/**
 * The Kimi Code API key the user stored for the plugin, and where it was found (never the key in messages).
 * @returns {Promise<{ key: string, source: string } | null>}
 */
export async function readKimiKey({ platform = process.platform, security = runSecurity, dir = null } = {}) {
	if (platform === "darwin") {
		const key = cleanSecret(await security(["find-generic-password", "-w", "-s", KIMI_KEY_SERVICE]));
		if (key) return { key, source: `Keychain «${KIMI_KEY_SERVICE}»` };
	}
	if (dir) {
		const file = path.join(dir, KIMI_KEY_FILE);
		try {
			const key = cleanSecret(await fsp.readFile(file, "utf8"));
			if (key) return { key, source: file };
		} catch {
			// no key file
		}
	}
	return null;
}

/** A login file of the Kimi Code app: its access token and when that ends (stored in seconds). */
export function parseKimiCredentials(text) {
	try {
		const json = JSON.parse(String(text));
		if (typeof json?.access_token !== "string" || !json.access_token) return null;
		const at = Number(json.expires_at);
		return { token: json.access_token, expiresAt: Number.isFinite(at) && at > 0 ? (at < 1e12 ? at * 1000 : at) : null };
	} catch {
		return null;
	}
}

/**
 * The login to ask Kimi with: the stored API key when there is one, else the app's login that lasts
 * longest; plus what was found (without secrets) for the settings panel.
 */
export async function readKimiLogin(_account = "", { home = os.homedir(), env = process.env, platform = process.platform, security = runSecurity, keyDir = dataDir(home) } = {}) {
	const dir = kimiHome({ env, home });
	let config = "";
	try {
		config = await fsp.readFile(path.join(dir, "config.toml"), "utf8");
	} catch {
		// Kimi Code not set up here: the default address
	}
	const logins = [];
	const stored = await readKimiKey({ platform, security, dir: keyDir });
	if (stored) logins.push({ token: stored.key, expiresAt: null, kind: "key", source: tildify(stored.source, home), dir });
	try {
		const folder = path.join(dir, "credentials");
		for (const name of (await fsp.readdir(folder)).filter((n) => n.endsWith(".json")).sort()) {
			const file = path.join(folder, name);
			const login = parseKimiCredentials(await fsp.readFile(file, "utf8").catch(() => ""));
			if (login) logins.push({ ...login, kind: "oauth", source: tildify(file, home), dir });
		}
	} catch {
		// no login of the app
	}
	const best = logins.find((l) => l.kind === "key") ?? [...logins].sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0];
	if (!best) return null;
	const base = kimiBase(config);
	return { ...best, base, host: new URL(base).host, logins: logins.map(({ source, expiresAt, kind }) => ({ source, expiresAt, kind, dir })) };
}

const number = (v) => num(typeof v === "string" && v.trim() ? Number(v) : v);

/** A limit: Kimi sends the share used as 0..1 and the reset time as text. */
function windowOf(o) {
	const ratio = number(o?.used_ratio);
	if (ratio === null) return null;
	// 0.29 * 100 is 28.999999999999996 in floating point: round the noise away
	return { used: Math.round(Math.max(0, Math.min(1, ratio)) * 1e6) / 1e4, resetsAt: time(o.reset_time) };
}

/** Kimi counts money in millionths of a cent; anything above zero is at least one cent. */
function centsOf(micro) {
	const cents = micro / 1e6;
	return cents > 0 && cents < 1 ? 1 : Math.round(cents);
}

/** The "booster" wallet of extra usage bought on top of the plan, in the currency's main unit. */
function walletOf(w) {
	const balance = w?.balance;
	if (!balance || typeof balance !== "object" || balance.type !== "BOOSTER") return null;
	const amount = number(balance.amount);
	if (amount === null || amount <= 0) return null;
	const left = number(balance.amountLeft);
	const price = (o) => {
		const cents = number(o?.priceInCents);
		return cents === null ? 0 : Math.trunc(cents) / 100;
	};
	const currency = [w.monthlyChargeLimit?.currency, w.monthlyUsed?.currency].find((c) => typeof c === "string" && c) ?? "USD";
	return {
		total: centsOf(amount) / 100,
		left: left === null ? 0 : centsOf(Math.max(0, left)) / 100,
		// a cap on what may be charged in a month, when the user set one
		capped: w.monthlyChargeLimitEnabled === true,
		cap: price(w.monthlyChargeLimit),
		spent: price(w.monthlyUsed),
		currency: currency.toUpperCase(),
	};
}

export function parseKimiUsage(json) {
	const obj = json && typeof json === "object" ? json : {};
	const usages = obj.usages && typeof obj.usages === "object" ? obj.usages : {};
	return {
		fiveHour: windowOf(usages.limit_5h),
		sevenDay: windowOf(usages.limit_7d),
		month: windowOf(usages.limit_month_total),
		// the part of the monthly limit that coding took; the rest is Kimi chat
		monthCode: windowOf(usages.limit_month_code),
		extra: walletOf(obj.boosterWallet),
		// what the server sent, for the settings panel
		fields: Object.keys(usages),
	};
}

/** @type {import("./limits.js").LimitsSource} */
export const KIMI_LIMITS = {
	id: "kimi",
	api: "Kimi API",
	windows: ["fiveHour", "sevenDay", "month"],
	cacheName: () => "limits-kimi.json",
	login: readKimiLogin,
	// the app's login is a token that states when it ends; an API key has no end
	exactExpiry: true,
	request: (fetchImpl, login) =>
		fetchImpl(USAGE_URL ?? `${login.base}/usages`, {
			headers: { Authorization: `Bearer ${login.token}`, Accept: "application/json", "User-Agent": USER_AGENT },
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		}),
	parse: (json) => parseKimiUsage(json),
	text: {
		signin: "No Kimi Code login found. Sign in to the Kimi Code app on this computer, or store a Kimi Code API key for the plugin: see the steps below.",
		expired: "Kimi Code's login lasts 15 minutes, and Kimi Code renews it only while you use it. Open Kimi Code and send any message, or store a Kimi Code API key for the plugin so the numbers never go stale: see the steps below.",
	},
};
