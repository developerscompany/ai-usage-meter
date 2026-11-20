// Codex and Kimi: their logins, usage answers, logs and prices; and the marks that tell the services apart.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import { KIMI_LIMIT_ACTIONS, fiveHourAction, longLimit } from "../src/actions/limits.js";
import { overviewAction } from "../src/actions/overview.js";
import { CODEX_LOGS, codexRoots } from "../src/codex-logs.js";
import { CODEX_LIMITS, codexHome, parseCodexAuth, parseCodexUsage, readCodexLogin } from "../src/codex.js";
import { KIMI_LIMITS, kimiBase, parseKimiCredentials, parseKimiUsage, readKimiKey, readKimiLogin } from "../src/kimi.js";
import { LimitsService } from "../src/limits.js";
import { openaiFamilyOf, openaiModelLabel, openaiPriceFor, openaiRequestCost, priceFor } from "../src/pricing.js";
import { PROVIDERS } from "../src/providers.js";
import { LOGO_IDS, logo } from "../src/render/logos.js";
import { renderModels } from "../src/render/models.js";
import { OVERVIEW_STYLES, renderOverview } from "../src/render/overview.js";
import { PERCENT_STYLES, renderPercent } from "../src/render/percent.js";
import { header } from "../src/render/svg.js";
import { cleanSecret, safeMessage, testUrl } from "../src/secrets.js";
import { STATUS_PAGES, parseSummary, statusFor } from "../src/status.js";
import { UsageIndex } from "../src/usage-index.js";
import { codexLines, jwt } from "./fixtures.js";

const NOW = Date.parse("2026-11-18T19:00:00Z");
const HOUR = 3_600_000;
const response = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "usage-meter-"));
/** Texts of an SVG, to tell what a key says. */
const texts = (svg) => [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));

/** Well-formed XML: every "<" opens or closes a tag. Stream Deck draws nothing from a key that is not. */
function assertXml(svg, what) {
	const stray = svg.replace(/<\/?[a-zA-Z][^<>]*>/g, "");
	assert.ok(!/[<>]/.test(stray), `${what}: stray < or > in ${stray.slice(0, 80)}`);
}

test("Codex login: the ChatGPT tokens of auth.json, with the expiry the token states", async () => {
	const exp = Math.floor(NOW / 1000) + 10 * 86_400;
	const auth = JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: jwt({ email: "you@example.com" }), access_token: jwt({ exp }), refresh_token: "r", account_id: "acct-1" } });
	assert.deepEqual(parseCodexAuth(auth), { token: jwt({ exp }), accountId: "acct-1", expiresAt: exp * 1000, email: "you@example.com" });
	assert.equal(parseCodexAuth(JSON.stringify({ OPENAI_API_KEY: "sk-x", tokens: null })), null, "an API key alone has no plan limits");
	assert.equal(parseCodexAuth("not json"), null);

	const home = tmpdir();
	assert.equal(await readCodexLogin("", { home, env: {} }), null, "signed out");
	fs.mkdirSync(path.join(home, ".codex"));
	fs.writeFileSync(path.join(home, ".codex", "auth.json"), auth);
	const login = await readCodexLogin("", { home, env: {} });
	assert.equal(login.source, "~/.codex/auth.json");
	assert.deepEqual(login.logins, [{ source: "~/.codex/auth.json", expiresAt: exp * 1000, dir: path.join(home, ".codex") }]);
	assert.equal(codexHome({ home, env: { CODEX_HOME: "~/elsewhere" } }), path.join(home, "elsewhere"));
});

test("Codex usage: windows are told apart by their length, not by their slot", () => {
	const window = (used, seconds, at) => ({ used_percent: used, limit_window_seconds: seconds, reset_after_seconds: 60, reset_at: at });
	const both = parseCodexUsage({ plan_type: "plus", rate_limit: { primary_window: window(9, 18_000, 1_800_000_000), secondary_window: window(2, 604_800, 1_800_500_000) }, credits: { has_credits: false, unlimited: false, balance: "0" } }, NOW);
	assert.deepEqual(both.fiveHour, { used: 9, resetsAt: 1_800_000_000_000, windowMs: 5 * HOUR });
	assert.deepEqual(both.sevenDay, { used: 2, resetsAt: 1_800_500_000_000, windowMs: 168 * HOUR });
	assert.deepEqual(both.credits, { has: false, unlimited: false, balance: 0 });

	// a plan with a weekly limit only sends it as the primary window
	const weekly = parseCodexUsage({ rate_limit: { primary_window: window(8, 604_800, 1_800_500_000), secondary_window: null }, rate_limit_reset_credits: { available_count: 3 } }, NOW);
	assert.equal(weekly.fiveHour, null);
	assert.equal(weekly.sevenDay.used, 8);
	assert.equal(weekly.resets, 3);

	// a window that only says when it resets from now
	const relative = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 50, reset_after_seconds: 120 } } }, NOW);
	assert.deepEqual(relative.fiveHour, { used: 50, resetsAt: NOW + 120_000 });

	const more = parseCodexUsage({ additional_rate_limits: [{ limit_name: "Spark", rate_limit: { primary_window: window(40, 18_000, 1) } }], code_review_rate_limit: { primary_window: window(1, 604_800, 1) }, email: "you@example.com" }, NOW);
	assert.equal(more.more[0].name, "Spark");
	assert.equal(more.more[0].fiveHour.used, 40);
	assert.equal(more.codeReview.sevenDay.used, 1);
	assert.ok(!more.fields.includes("email"), "who is signed in is not listed among the fields");
	assert.deepEqual(parseCodexUsage(null, NOW).fiveHour, null);
});

test("Codex limits service: the login is sent to OpenAI as it is, and a refusal is told apart from an expiry", async () => {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url: String(url), headers: init.headers, redirect: init.redirect });
		return response(200, { rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: NOW / 1000 + 3600 } } });
	};
	const svc = new LimitsService("", { source: CODEX_LIMITS, dir: null, fetchImpl, now: () => NOW, credentials: async () => ({ token: "tok", accountId: "acct-1", expiresAt: NOW + HOUR, source: "s", logins: [] }) });
	await svc.refresh();
	assert.equal(calls[0].url, "https://chatgpt.com/backend-api/wham/usage");
	assert.equal(calls[0].headers.Authorization, "Bearer tok");
	assert.equal(calls[0].headers["ChatGPT-Account-Id"], "acct-1");
	assert.equal(calls[0].redirect, "error", "a login never follows a redirect to another address");
	assert.deepEqual(svc.window("fiveHour", NOW), { used: 12, resetsAt: NOW + HOUR, reset: false, windowMs: 5 * HOUR });
	assert.equal(svc.window("sevenDay", NOW), null);
	assert.deepEqual(svc.series("fiveHour"), [[NOW, 12]]);

	const refused = new LimitsService("", { source: CODEX_LIMITS, dir: null, fetchImpl: async () => response(401, {}), now: () => NOW, credentials: async () => ({ token: "tok", expiresAt: NOW + HOUR, logins: [] }) });
	await refused.refresh();
	assert.deepEqual(refused.error, { code: "auth", message: "OpenAI refused the token (HTTP 401)" });
	const signedOut = new LimitsService("", { source: CODEX_LIMITS, dir: null, credentials: async () => null });
	await signedOut.refresh();
	assert.equal(signedOut.error.code, "signin");
	assert.match(signedOut.error.message, /Codex app/);
});

test("Kimi login: a stored API key before the app's login, and only Kimi's own addresses", async () => {
	assert.equal(kimiBase('[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.ai/coding/v1/"\n'), "https://api.kimi.ai/coding/v1");
	assert.equal(kimiBase('base_url = "https://evil.example/coding/v1"'), "https://api.kimi.com/coding/v1", "a login is never sent to an address that is not Kimi's");
	assert.equal(kimiBase(""), "https://api.kimi.com/coding/v1");
	assert.deepEqual(parseKimiCredentials(JSON.stringify({ access_token: "a", expires_at: 1_795_028_799 })), { token: "a", expiresAt: 1_795_028_799_000 });
	assert.equal(parseKimiCredentials("{}"), null);

	const home = tmpdir();
	const keyDir = path.join(home, "data");
	const options = { home, env: {}, platform: "linux", keyDir };
	assert.equal(await readKimiLogin("", options), null, "nothing to sign in with");

	fs.mkdirSync(path.join(home, ".kimi-code", "credentials"), { recursive: true });
	fs.writeFileSync(path.join(home, ".kimi-code", "config.toml"), 'base_url = "https://api.kimi.ai/coding/v1"\n');
	fs.writeFileSync(path.join(home, ".kimi-code", "credentials", "a.json"), JSON.stringify({ access_token: "older", expires_at: NOW / 1000 + 60 }));
	fs.writeFileSync(path.join(home, ".kimi-code", "credentials", "b.json"), JSON.stringify({ access_token: "newer", expires_at: NOW / 1000 + 600 }));
	const app = await readKimiLogin("", options);
	assert.equal(app.token, "newer", "of the app's logins, the one that lasts longest");
	assert.equal(app.kind, "oauth");
	assert.equal(app.base, "https://api.kimi.ai/coding/v1");
	assert.equal(app.host, "api.kimi.ai");
	assert.equal(app.logins.length, 2);

	fs.mkdirSync(keyDir);
	fs.writeFileSync(path.join(keyDir, "kimi-api-key"), "sk-kimi-key\n");
	const stored = await readKimiLogin("", options);
	assert.equal(stored.token, "sk-kimi-key");
	assert.equal(stored.kind, "key");
	assert.equal(stored.expiresAt, null);
	assert.ok(!JSON.stringify(stored.logins).includes("sk-kimi-key"), "what was found is listed without the secrets");

	// on a Mac the Keychain comes first
	const mac = await readKimiKey({ platform: "darwin", security: async (args) => (args.includes("AI Usage Meter Kimi API Key") ? "sk-from-keychain\n" : null), dir: keyDir });
	assert.deepEqual(mac, { key: "sk-from-keychain", source: "Keychain «AI Usage Meter Kimi API Key»" });
});

test("Kimi usage: shares of 1 become percentages, and the wallet of extra usage becomes money", () => {
	const usage = parseKimiUsage({
		usages: { limit_5h: { used_ratio: 0.29, reset_time: "2026-11-18T22:00:00Z" }, limit_7d: { used_ratio: "0.615" }, limit_month_total: { used_ratio: 1.4 }, limit_month_code: { used_ratio: 0.15 } },
		boosterWallet: { balance: { type: "BOOSTER", amount: 5_000_000_000, amountLeft: 3_770_000_000 }, monthlyChargeLimitEnabled: true, monthlyChargeLimit: { priceInCents: "2000", currency: "cny" }, monthlyUsed: { priceInCents: 1230, currency: "CNY" } },
	});
	assert.deepEqual(usage.fiveHour, { used: 29, resetsAt: Date.parse("2026-11-18T22:00:00Z") }, "29, not 28.999999999999996");
	assert.deepEqual(usage.sevenDay, { used: 61.5, resetsAt: null });
	assert.equal(usage.month.used, 100, "never more than all of it");
	assert.deepEqual(usage.extra, { total: 50, left: 37.7, capped: true, cap: 20, spent: 12.3, currency: "CNY" });
	assert.equal(parseKimiUsage({ usages: {}, boosterWallet: { balance: { type: "OTHER", amount: 1 } } }).extra, null);
	assert.equal(parseKimiUsage({}).fiveHour, null);
});

test("Kimi limits service: a login that says it is over is not sent; a renewed one is found at once", async () => {
	let login = { token: "old", kind: "oauth", expiresAt: NOW - HOUR, base: "https://api.kimi.ai/coding/v1", logins: [] };
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url: String(url), auth: init.headers.Authorization });
		return response(200, { usages: { limit_7d: { used_ratio: 0.5 } } });
	};
	const svc = new LimitsService("", { source: KIMI_LIMITS, dir: null, fetchImpl, now: () => NOW, credentials: async () => login });
	await svc.refresh();
	assert.equal(svc.error.code, "expired");
	assert.equal(calls.length, 0);

	login = { ...login, token: "new", expiresAt: NOW + 900_000 };
	await svc.refresh(true);
	assert.equal(svc.error, null);
	assert.deepEqual(calls, [{ url: "https://api.kimi.ai/coding/v1/usages", auth: "Bearer new" }]);
	assert.equal(svc.window("sevenDay", NOW).used, 50);

	// a stored key has no end; when Kimi refuses it, the message says key
	const refused = new LimitsService("", { source: KIMI_LIMITS, dir: null, fetchImpl: async () => response(401, {}), now: () => NOW, credentials: async () => ({ token: "k", kind: "key", expiresAt: null, base: "https://api.kimi.com/coding/v1", logins: [] }) });
	await refused.refresh();
	assert.deepEqual(refused.error, { code: "auth", message: "Kimi API refused the key (HTTP 401)" });
});

test("limits service: a refused login is not sent again and again, but another one is tried at once", async () => {
	const key = (token) => ({ token, kind: "key", expiresAt: null, base: "https://api.kimi.ai/coding/v1", logins: [] });
	const service = () => {
		const t = { now: NOW, login: key("typo"), asked: [] };
		const fetchImpl = async (_url, init) => {
			const token = init.headers.Authorization.replace("Bearer ", "");
			t.asked.push(token);
			if (token === "good") return response(200, { usages: { limit_5h: { used_ratio: 0.1 } } });
			if (token === "busy") return response(429, {}, { "retry-after": "300" });
			if (token === "down") throw new Error("ECONNRESET");
			return response(401, {});
		};
		t.svc = new LimitsService("", { source: KIMI_LIMITS, dir: null, fetchImpl, now: () => t.now, credentials: async () => t.login });
		return t;
	};
	/** Refused three times, half a minute and then a minute apart: the next try of the same login is two minutes away. */
	const refused = async (t) => {
		for (const wait of [0, 31_000, 61_000]) {
			t.now += wait;
			await t.svc.refresh();
		}
		assert.equal(t.svc.error.code, "auth");
		assert.deepEqual(t.asked, ["typo", "typo", "typo"]);
	};

	// the key is stored again, this time the right one
	const a = service();
	await refused(a);
	a.now += 31_000;
	await a.svc.refresh();
	assert.equal(a.asked.length, 3, "the same login waits its turn");
	a.login = key("good");
	a.now += 31_000;
	await a.svc.refresh();
	assert.equal(a.svc.error, null, "a login that changed does not wait for the old one's turn");
	assert.equal(a.asked.at(-1), "good");
	assert.equal(a.svc.window("fiveHour", a.now).used, 10);

	// the key is deleted, and a new one stored a little later
	const b = service();
	await refused(b);
	b.login = null;
	b.now += 31_000;
	await b.svc.refresh();
	assert.equal(b.svc.error.code, "signin", "a login that is gone is not called refused any longer");
	b.login = key("good");
	b.now += 31_000;
	await b.svc.refresh();
	assert.equal(b.svc.error, null);
	assert.equal(b.asked.length, 4);

	// the Keychain does not answer for a moment: afterwards the refused key still waits its turn
	const c = service();
	await refused(c);
	const typo = c.login;
	c.login = null;
	c.now += 31_000;
	await c.svc.refresh();
	c.login = typo;
	c.now += 31_000;
	await c.svc.refresh();
	assert.equal(c.asked.length, 3, "not sent again because it could not be read for a moment");
	assert.equal(c.svc.error.code, "auth", "and the key says refused again");
	c.now += 120_000;
	await c.svc.refresh();
	assert.equal(c.asked.length, 4, "its turn comes when the wait is over");

	// a new login starts afresh: its first failure waits half a minute, not the old login's ten
	const d = service();
	await refused(d);
	d.login = key("down");
	d.now += 31_000;
	await d.svc.refresh();
	assert.equal(d.svc.error.code, "network");
	d.now += 31_000;
	await d.svc.refresh();
	assert.deepEqual(d.asked.slice(3), ["down", "down"]);

	// "too many requests" is waited out whatever login turns up
	const e = service();
	await refused(e);
	e.login = key("busy");
	e.now += 31_000;
	await e.svc.refresh();
	assert.equal(e.svc.error.code, "rate");
	e.login = key("good");
	e.now += 31_000;
	await e.svc.refresh(true);
	assert.equal(e.asked.length, 4, "not even a press asks before the time the server gave");
	e.now += 300_000;
	await e.svc.refresh();
	assert.equal(e.svc.error, null);

	// a press asks with the login as it is now, not as it was read a moment ago
	const f = service();
	await refused(f);
	f.now += 10_000;
	await f.svc.refresh();
	f.login = key("good");
	await f.svc.refresh(true);
	assert.equal(f.svc.error, null);
	assert.deepEqual(f.asked.slice(3), ["good"]);
});

test("Kimi limits service: waiting for a renewed login does not lengthen the wait after a refusal", async () => {
	let now = NOW;
	let login = { token: "old", kind: "oauth", expiresAt: NOW - HOUR, base: "https://api.kimi.ai/coding/v1", logins: [] };
	let asked = 0;
	const svc = new LimitsService("", { source: KIMI_LIMITS, dir: null, fetchImpl: async () => (asked++, response(401, {})), now: () => now, credentials: async () => login });
	for (let i = 0; i < 6; i++) {
		await svc.refresh();
		now += 31_000;
	}
	assert.equal(svc.error.code, "expired");
	assert.equal(asked, 0);

	login = { token: "typo", kind: "key", expiresAt: null, base: "https://api.kimi.ai/coding/v1", logins: [] };
	await svc.refresh();
	assert.equal(svc.error.code, "auth");
	now += 31_000;
	await svc.refresh();
	assert.equal(asked, 2, "the first refusal waits half a minute, not ten");
});

test("a plan without a weekly limit: the monthly one takes its place, and says so", async () => {
	// what Kimi answers for a plan with a 5-hour and a monthly limit only
	const answer = {
		limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", remaining: "100", resetTime: "2026-11-18T22:32:53.952049Z" } }],
		usages: {
			limit_5h: { used_ratio: 0, reset_time: "2026-11-18T22:32:53Z" },
			limit_month_total: { used_ratio: 0.1908, reset_time: "2026-12-11T00:00:00Z" },
			limit_month_code: { used_ratio: 0.1403, reset_time: "2026-12-11T00:00:00Z" },
		},
	};
	const kimi = new LimitsService("", { source: KIMI_LIMITS, dir: null, fetchImpl: async () => response(200, answer), now: () => NOW, credentials: async () => ({ token: "k", kind: "key", expiresAt: null, base: "https://api.kimi.ai/coding/v1", host: "api.kimi.ai", source: "Keychain", logins: [] }) });
	await kimi.refresh();
	assert.equal(kimi.window("sevenDay", NOW), null);
	assert.deepEqual(longLimit(kimi, NOW), { window: { used: 19.08, resetsAt: Date.parse("2026-12-11T00:00:00Z"), reset: false }, monthly: true });
	// a plan with a weekly limit keeps it, whatever else it has
	const weekly = { window: (name) => ({ sevenDay: { used: 5 }, month: { used: 9 } })[name] ?? null };
	assert.deepEqual(longLimit(weekly, NOW), { window: { used: 5 }, monthly: false });
	assert.deepEqual(longLimit({ window: () => null }, NOW), { window: null, monthly: false });

	const action = (id) => KIMI_LIMIT_ACTIONS.find((a) => a.id === id);
	const ctx = (a, settings = {}) => ({ settings: a.normalize(settings), limits: kimi, limitsOf: { kimi }, now: new Date(NOW) });

	// both limits on one key: 5-hour and month
	const both = action("kimi-limits");
	for (const style of both.styles) assertXml(both.render(ctx(both), style.id), style.id);
	assert.deepEqual(texts(both.render(ctx(both), "bars")), ["5H", "100%", "3h32m", "MO", "81%", "22d5h", "left"]);
	assert.deepEqual(texts(both.render(ctx(both), "split")), ["5H", "3h", "100%", "MO", "22d5h", "81%"], "beside a large 100% the reset time keeps its first unit");

	// all services on one key
	const all = (settings) => ({ ...ctx(overviewAction, { services: ["kimi"], ...settings }) });
	assert.deepEqual(texts(overviewAction.render(all(), "bars")), ["MO", "22d5h", "81%", "WEEKLY · left"]);
	assert.deepEqual(texts(overviewAction.render(all(), "rings")), ["WEEKLY · left", "81%", "MO 22d"]);
	assert.deepEqual(texts(overviewAction.render(all(), "table")), ["left", "5H", "7D", "100%", "81%", "MO"]);
	assert.deepEqual(texts(overviewAction.render(all({ window: "fiveHour" }), "bars")), ["3h32m", "100%", "5-HOUR · left"], "the 5-hour limit is what it says");
	for (const style of OVERVIEW_STYLES) assertXml(overviewAction.render(all(), style.id), style.id);
	assert.deepEqual(overviewAction.info(all()).table.rows, [["Kimi", "0% used", "19% used (monthly)"]]);

	// the Weekly key has nothing to show, and its settings say which key has
	const week = action("kimi-limit7d");
	assert.deepEqual(texts(week.render(ctx(week))), ["WEEKLY", "—", "not on your plan"]);
	assert.match(week.info(ctx(week)).note, /^Your Kimi Code plan has no weekly limit: .*Kimi Monthly Limit/);
});

test("Claude on an account without a 5-hour limit: the key says so, and its settings say why", async () => {
	// what Anthropic answers for a verified Ultra account: a weekly limit, and no five_hour
	const answer = { seven_day: { utilization: 15, resets_at: "2026-11-24T23:00:00Z" }, limits: [{ percent: 25, scope: { model: { display_name: "Fable" } } }] };
	const claude = new LimitsService("", { dir: null, fetchImpl: async () => response(200, answer), now: () => NOW, credentials: async () => ({ token: "t", expiresAt: NOW + 8 * HOUR, source: "keychain", logins: [] }) });
	await claude.refresh();
	const ctx = (a) => ({ settings: a.normalize({}), limits: claude, limitsOf: { claude }, now: new Date(NOW) });
	assert.deepEqual(texts(fiveHourAction.render(ctx(fiveHourAction))), ["5-HOUR", "—", "not on your plan"]);
	assert.match(fiveHourAction.info(ctx(fiveHourAction)).note, /no 5-hour limit for this account/);
	assert.deepEqual(longLimit(claude, NOW), { window: { used: 15, resetsAt: Date.parse("2026-11-24T23:00:00Z"), reset: false }, monthly: false }, "the weekly limit stays the long one");

	// an account that has both limits gets no such note
	const both = new LimitsService("", { dir: null, fetchImpl: async () => response(200, { ...answer, five_hour: { utilization: 40, resets_at: "2026-11-18T21:00:00Z" } }), now: () => NOW, credentials: async () => ({ token: "t", expiresAt: NOW + 8 * HOUR, source: "keychain", logins: [] }) });
	await both.refresh();
	assert.equal(fiveHourAction.info({ ...ctx(fiveHourAction), limits: both }).note, undefined);
});

test("limits cache: Auto and the default profile each have their own", () => {
	const dir = tmpdir();
	const auto = new LimitsService("", { dir, credentials: async () => null });
	const named = new LimitsService("~/.claude", { dir, credentials: async () => null });
	assert.notEqual(auto.cacheFile, named.cacheFile, "Auto may hold another profile's login");
	assert.equal(path.basename(auto.cacheFile), "limits-auto.json");

	named.fetchedAt = 123;
	named.save();
	assert.equal(new LimitsService("", { dir, credentials: async () => null }).fetchedAt, 0, "the default profile's numbers are not Auto's");
	auto.fetchedAt = 456;
	auto.save();
	assert.equal(new LimitsService("", { dir, credentials: async () => null }).fetchedAt, 456);
	assert.ok(!fs.existsSync(`${auto.cacheFile}.tmp`), "written beside the file and moved over it");
	assert.equal(path.basename(new LimitsService("", { source: CODEX_LIMITS, dir }).cacheFile), "limits-codex.json");
});

test("a valid login is read again after a while, so the keys follow a new sign-in", async () => {
	let now = NOW;
	let reads = 0;
	const svc = new LimitsService("", { dir: null, now: () => now, fetchImpl: async () => response(200, {}), credentials: async () => ({ token: `t${++reads}`, expiresAt: NOW + 8 * HOUR, logins: [] }) });
	await svc.refresh();
	now += 60_000;
	await svc.refresh();
	assert.equal(reads, 1, "not on every request");
	now += 5 * 60_000;
	await svc.refresh();
	assert.equal(reads, 2);
});

test("secrets: one clean token from what was stored, and never in an error's text", async () => {
	assert.equal(cleanSecret("sk-ant-admin01-key\n"), "sk-ant-admin01-key");
	assert.equal(cleanSecret("  sk-key  \nnotes about it\n"), "sk-key", "the first line");
	assert.equal(cleanSecret("two words"), null, "not something a header can carry");
	assert.equal(cleanSecret(null), null);
	assert.equal(safeMessage(new Error('Headers.append: "Bearer tok-123" is an invalid header value'), "tok-123"), 'Headers.append: "Bearer …" is an invalid header value');
	assert.equal(testUrl("http://127.0.0.1:4010/usage"), "http://127.0.0.1:4010/usage");
	assert.equal(testUrl("https://evil.example/usage"), null, "an environment variable cannot send a login elsewhere");
	assert.equal(testUrl(undefined), null);

	const svc = new LimitsService("", {
		dir: null,
		now: () => NOW,
		credentials: async () => ({ token: "tok-123", expiresAt: NOW + HOUR, logins: [] }),
		fetchImpl: async () => {
			throw new TypeError('Headers.append: "Bearer tok-123" is an invalid header value');
		},
	});
	await svc.refresh();
	assert.equal(svc.error.code, "network");
	assert.ok(!svc.error.message.includes("tok-123"), svc.error.message);
});

test("OpenAI prices: cached input, cache writes, long context, and newer versions of a family", () => {
	assert.deepEqual([openaiPriceFor("gpt-6.1-sol").input, openaiPriceFor("gpt-6.1-sol").cacheRead, openaiPriceFor("gpt-6.1-sol").output], [2, 0.1, 10]);
	assert.equal(openaiPriceFor("gpt-6.3-sol").input, 2, "a newer Sol: the family's current price");
	assert.equal(openaiPriceFor("gpt-5.3-codex").input, 1.75);
	assert.equal(openaiPriceFor("gpt-5-codex").input, 1.25);
	assert.equal(openaiPriceFor("gpt-5.1-codex-mini").input, 0.25);
	assert.equal(openaiPriceFor("codex-auto-review"), null, "no list price: counted as tokens, not as dollars");
	assert.equal(openaiRequestCost("codex-auto-review", { input: 1e6, cacheWrite: 0, cacheRead: 0, output: 1e6 }), 0);
	assert.equal(openaiFamilyOf("gpt-6-astra"), "astra");
	assert.equal(openaiFamilyOf("gpt-5.3-codex"), "gpt-5");
	assert.equal(openaiModelLabel("gpt-6.1-sol"), "GPT-6.1 Sol");
	assert.equal(openaiModelLabel("codex-auto-review"), "codex-auto-review");

	const short = openaiRequestCost("gpt-6.1-sol", { input: 100_000, cacheWrite: 10_000, cacheRead: 150_000, output: 10_000 });
	assert.ok(Math.abs(short - (100_000 * 2 + 10_000 * 2.5 + 150_000 * 0.1 + 10_000 * 10) / 1e6) < 1e-9);
	// over 272K input tokens: input, cached input and cache writes cost twice as much, output 1.5 times
	const long = openaiRequestCost("gpt-6.1-sol", { input: 100_000, cacheWrite: 10_000, cacheRead: 200_000, output: 10_000 });
	assert.ok(Math.abs(long - (2 * (100_000 * 2 + 10_000 * 2.5 + 200_000 * 0.1) + 1.5 * 10_000 * 10) / 1e6) < 1e-9);
	// a model without a cache-write price charges the write as input
	assert.ok(Math.abs(openaiRequestCost("gpt-5.4-mini", { input: 0, cacheWrite: 1e6, cacheRead: 0, output: 0 }) - 0.75) < 1e-9);
});

test("Claude prices: a minor version newer than the table takes the family's latest price", () => {
	assert.equal(priceFor("claude-fable-5").cacheRead, 1);
	assert.equal(priceFor("claude-fable-5-20260801").cacheRead, 1, "a dated id of Fable 5 is Fable 5");
	assert.equal(priceFor("claude-fable-5-2").cacheRead, 0.25, "not the price of the oldest sibling");
	assert.equal(priceFor("claude-opus-5-6").input, 4);
	assert.equal(priceFor("claude-opus-5").input, 5);
});

test("Codex logs: a response is counted once, by its record; older logs by the growth of the running total", async () => {
	const home = tmpdir();
	const dir = path.join(home, ".codex", "sessions", "2026", "11", "18");
	fs.mkdirSync(dir, { recursive: true });
	const at = new Date();
	const usage = (input, cached, output, write = 0) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
	fs.writeFileSync(path.join(dir, "rollout-a.jsonl"), codexLines({ at, model: "gpt-6.1-sol", responses: [usage(1000, 600, 50), usage(5000, 4000, 100, 500)] }).join("\n") + "\n");
	// a Codex from before the records: only token_count events, one of them repeated (Codex also writes them when only the limits change)
	const old = codexLines({ at, model: "gpt-5.3-codex", records: false, responses: [usage(2000, 0, 10), usage(3000, 1000, 20)] });
	fs.writeFileSync(path.join(dir, "rollout-b.jsonl"), [...old, old.at(-1)].join("\n") + "\n");

	const index = new UsageIndex(() => codexRoots("", { home, env: {} }), { format: CODEX_LOGS });
	const scan = await index.refresh();
	assert.equal(scan.files, 2);
	const day = index.byModel([...index.days.keys()]);
	const sol = day.get("gpt-6.1-sol");
	assert.deepEqual([sol.requests, sol.input, sol.cacheRead, sol.cacheWrite, sol.output], [2, 400 + 500, 4600, 500, 150], "cached input and cache writes are counted apart from the rest of the input");
	const codex = day.get("gpt-5.3-codex");
	assert.deepEqual([codex.requests, codex.input, codex.cacheRead, codex.output], [2, 4000, 1000, 30]);
	assert.ok(sol.cost > 0 && codex.cost > 0);

	// reading the same lines again adds nothing
	fs.appendFileSync(path.join(dir, "rollout-b.jsonl"), `${old.at(-1)}\n`);
	await index.refresh();
	assert.equal(index.byModel([...index.days.keys()]).get("gpt-5.3-codex").requests, 2);
	assert.deepEqual(CODEX_LOGS.family("gpt-6.1-sol"), { id: "sol", name: "Sol" });
});

test("Codex logs: compressed sessions are read where Node.js can open them, and counted as unread where it cannot", async () => {
	const home = tmpdir();
	const dir = path.join(home, ".codex", "sessions", "2026", "11", "01");
	fs.mkdirSync(dir, { recursive: true });
	const lines = codexLines({ at: new Date(), responses: [{ input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 1010 }] }).join("\n");
	// stands in for zstd, which Stream Deck's Node.js 20 does not have
	fs.writeFileSync(path.join(dir, "rollout-old.jsonl.zst"), zlib.gzipSync(lines));
	const roots = () => codexRoots("", { home, env: {} });

	const able = new UsageIndex(roots, { format: CODEX_LOGS, inflate: zlib.gunzipSync });
	assert.equal((await able.refresh()).unread, 0);
	assert.equal(able.sum([...able.days.keys()]).requests, 1);
	const again = await able.refresh();
	assert.equal(again.bytes, 0, "an unchanged file is not opened again");

	const unable = new UsageIndex(roots, { format: CODEX_LOGS, inflate: null });
	const scan = await unable.refresh();
	assert.equal(scan.unread, 1);
	assert.equal(unable.days.size, 0);
});

test("logos: a mark for each service, as Stream Deck's renderer needs it", () => {
	assert.deepEqual(LOGO_IDS, Object.keys(PROVIDERS));
	for (const id of LOGO_IDS) {
		const svg = logo(id, 10, 9, 18);
		assert.match(svg, /^<g transform="translate\(10\.00 9\.00\) scale\(0\.7500\)">/);
		// Qt's SVG reader wants absolute commands with every number apart
		for (const [, d] of svg.matchAll(/ d="([^"]+)"/g)) assert.match(d, /^[MLCAZ0-9 .-]+$/, `${id}: ${d.slice(0, 40)}`);
	}
	assert.equal(logo("nobody", 0, 0, 18), "");
});

test("header: mark and label are centred as one, and a long label keeps clear of the tag", () => {
	assert.match(header("5-HOUR"), /^<text x="72" y="24" font-family="[^"]+" font-size="17" [^>]*text-anchor="middle"/, "no mark: centred by the renderer, as before");
	const marked = header("5-HOUR", { logo: "kimi" });
	assert.match(marked, /^<g transform/);
	assert.match(marked, /font-size="17"[^>]*text-anchor="start"/);
	const long = header("CLOUD CREDIT", { logo: "claude", tag: "N" });
	const size = Number(/font-size="(\d+)"[^>]*text-anchor="start"/.exec(long)[1]);
	assert.ok(size < 17, "smaller letters");
	const x = Number(/<text x="([\d.]+)"/.exec(long)[1]);
	assert.ok(x + 7.98 * size <= 124, "the label ends before the tag begins");
	// without a mark too: the audit found the tag on top of long labels
	assert.match(header("CLOUD CREDIT", { tag: "ABC" }), /font-size="1[2-5]"/);
	assert.match(header("WEEKLY", { stale: true }), /<circle cx="11" cy="5" r="3"/);
});

test("every style of a limit key is well-formed with a mark, a tag and old numbers", () => {
	const view = { label: "SONNET 7D", used: 52, show: "used", resetsAt: NOW + 61 * HOUR, now: NOW, windowMs: 168 * HOUR, warn: 50, danger: 80, series: [[NOW - HOUR, 40], [NOW, 52]], tag: "N", logo: "codex" };
	for (const style of PERCENT_STYLES) {
		assertXml(renderPercent(style.id, view), style.id);
		assertXml(renderPercent(style.id, { ...view, stale: true, old: "login expired" }), `${style.id}, old`);
	}
});

test("model mix: a share under one percent does not break the image", () => {
	const items = [
		{ name: "Opus", family: "opus", share: 0.995 },
		{ name: "Haiku", family: "haiku", share: 0.005 },
	];
	for (const style of ["donut", "bars", "stack"]) {
		const svg = renderModels(style, { label: "7 DAYS", items, total: "432M tokens", logo: "claude" });
		assertXml(svg, style);
		if (style !== "donut") assert.ok(svg.includes("&lt;1%"), style);
	}
});

test("all services on one key: a row each, a dash where a plan has no such limit, dimmed when stale", () => {
	const rows = [
		{ id: "claude", name: "Claude", five: { used: 25.4, resetsAt: NOW + 2 * HOUR }, week: { used: 52, resetsAt: NOW + 61 * HOUR } },
		{ id: "codex", name: "Codex", five: null, week: { used: 8, resetsAt: NOW + 160 * HOUR } },
		{ id: "kimi", name: "Kimi", five: { used: 91, resetsAt: NOW + HOUR }, week: { used: 100, resetsAt: NOW + 30 * HOUR }, dim: true, alert: true },
	];
	const view = { rows, window: "sevenDay", show: "left", warn: 50, danger: 80, now: NOW, tag: "N" };
	for (const style of OVERVIEW_STYLES) assertXml(renderOverview(style.id, view), style.id);
	const bars = renderOverview("bars", view);
	assert.deepEqual(texts(bars).filter((t) => t.endsWith("%") || t.includes("·")), ["48%", "92%", "0%", "WEEKLY · left · N"]);
	assert.equal((bars.match(/<g transform="translate/g) ?? []).length, 3, "three marks");
	assert.equal((bars.match(/<g opacity="0.35">/g) ?? []).length, 1, "Kimi's numbers are no longer current");
	assert.match(bars, /<circle [^>]*fill="#ff9f0a"/, "and its login needs attention");
	assert.deepEqual(texts(renderOverview("table", { ...view, show: "used" })), ["used · N", "5H", "7D", "25%", "52%", "—", "8%", "91%", "100%"]);
	assert.deepEqual(texts(renderOverview("bars", { ...view, marks: false })).slice(0, 1), ["CL"], "letters instead of marks");
	const unused = { id: "kimi", name: "Kimi", five: null, week: { used: 0, resetsAt: NOW + 20 * HOUR } };
	assert.deepEqual(texts(renderOverview("bars", { ...view, tag: "", rows: [unused] })), ["20h", "100%", "WEEKLY · left"], "a long reset time does not run into 100%");

	const s = overviewAction.normalize({ services: ["kimi", "nobody"], press: "window", window: "fiveHour" });
	assert.deepEqual(s.services, ["kimi"]);
	assert.deepEqual(overviewAction.needs(s), [{ kind: "limits", provider: "kimi", arg: "" }]);
	assert.equal(overviewAction.press({ settings: s }), "save");
	assert.equal(s.window, "sevenDay", "press switched the limit");
	assert.deepEqual(overviewAction.normalize({ services: [] }).services, ["claude", "codex", "kimi"], "never an empty key");
});

test("status pages of OpenAI and Moonshot: components by name or by the page's group", () => {
	const openai = parseSummary({ status: { indicator: "none", description: "All Systems Operational" }, components: [{ name: "Responses", status: "operational" }, { name: "Codex in ChatGPT Desktop", status: "partial_outage" }, { name: "Codex Web", status: "degraded_performance" }] }, STATUS_PAGES.codex);
	assert.deepEqual(statusFor(openai, "codex", STATUS_PAGES.codex), { level: 3, text: "partial outage", incident: null }, "of several components, the one in most trouble");
	assert.equal(statusFor(openai, "api", STATUS_PAGES.codex).level, 0);

	const moonshot = parseSummary(
		{
			status: { indicator: "minor", description: "Minor Service Outage" },
			components: [
				{ id: "g1", name: "Kimi Code", status: "operational", group: true },
				{ id: "a", name: "K3.1 Pro", status: "degraded_performance", group_id: "g1" },
				{ id: "b", name: "Open API", status: "major_outage", group_id: "g2" },
			],
			incidents: [
				{ name: "Slow K3.1 Pro", impact: "minor", status: "investigating", shortlink: "javascript:alert(1)", components: [{ name: "K3.1 Pro" }] },
				{ name: "API down", impact: "critical", status: "identified", shortlink: "https://stspg.io/x", components: [{ name: "Open API" }] },
			],
		},
		STATUS_PAGES.kimi,
	);
	const code = statusFor(moonshot, "code", STATUS_PAGES.kimi);
	assert.equal(code.level, 2);
	assert.equal(code.incident.name, "Slow K3.1 Pro", "only incidents that hit the group's components");
	assert.equal(code.incident.url, "https://status.moonshot.cn", "a link that is not https is not opened");
	assert.equal(statusFor(moonshot, "api", STATUS_PAGES.kimi).incident.url, "https://stspg.io/x");
	assert.equal(statusFor(moonshot, "all", STATUS_PAGES.kimi).text, "Minor Service Outage");
});
