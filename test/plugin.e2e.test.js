// Runs the built plugin against a fake Stream Deck (same WebSocket protocol and launch arguments),
// fake usage endpoints of Anthropic, OpenAI and Kimi, and fake status pages.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { WebSocketServer } from "ws";
import { monthDay } from "../src/actions/common.js";
import { utcDay, utcMonthStart } from "../src/console.js";
import { formatMoney } from "../src/format.js";
import { peakAt } from "../src/peak.js";
import { getPeriod } from "../src/periods.js";
import { openaiRequestCost, priceFor, requestCost } from "../src/pricing.js";
import { addDays, dayKey, startOfDay } from "../src/usage-index.js";
import { assistantLines, codexLines, jwt, taskResultLine, userLine } from "./fixtures.js";

const PREFIX = "agency.rivo.ai-usage-meter";
const PLUGIN_UUID = "0123456789ABCDEF";
// what Stream Deck on a Mac passes in -info; the SDK reads the application version from it
const INFO = JSON.stringify({
	application: { font: ".AppleSystemUIFont", language: "en", platform: "mac", platformVersion: "15.1.0", version: "7.1.0.22035" },
	plugin: { uuid: "agency.rivo.ai-usage-meter", version: "4.0.1.0" },
	devicePixelRatio: 2,
	colors: { buttonPressedBackgroundColor: "#303030FF", buttonPressedBorderColor: "#646464FF", buttonPressedTextColor: "#969696FF", disabledColor: "#F7821B59", highlightColor: "#F7821BFF", mouseDownColor: "#CF6304FF" },
	devices: [{ id: "dev-1", name: "Stream Deck XL", size: { columns: 8, rows: 4 }, type: 2 }],
});
const OUTPUT = path.resolve("test/output");
// PLUGIN_DIR: test an unpacked .streamDeckPlugin instead of the build; PLUGIN_NODE: e.g. a Node.js 20 binary like Stream Deck's.
const SOURCE = process.env.PLUGIN_DIR ?? path.resolve("agency.rivo.ai-usage-meter.sdPlugin");
const NODE = process.env.PLUGIN_NODE ?? process.execPath;

const now = new Date();
const at = (daysAgo) => {
	const d = addDays(startOfDay(now), -daysAgo);
	d.setHours(daysAgo === 0 ? 0 : 12, daysAgo === 0 ? 1 : 0);
	return d;
};
const DATA = [
	{ daysAgo: 0, model: "claude-opus-5-5", tokens: { input: 1_000, output: 50_000, cacheWrite: 200_000, cacheRead: 3_000_000 } },
	{ daysAgo: 1, model: "claude-sonnet-5-5", tokens: { input: 0, output: 100_000, cacheWrite: 0, cacheRead: 10_000_000 } },
	{ daysAgo: 3, model: "claude-opus-5-5", tokens: { input: 500_000, output: 400_000, cacheWrite: 1_000_000, cacheRead: 20_000_000 } },
	{ daysAgo: 10, model: "claude-opus-5-5", tokens: { input: 0, output: 2_000_000, cacheWrite: 0, cacheRead: 100_000_000 } },
	{ daysAgo: 25, model: "claude-haiku-5-5", tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 999_000_000 } },
];
const ALL = (t) => t.input + t.output + t.cacheWrite + t.cacheRead;
const IO = (t) => t.input + t.output;
const costOf = (d) => requestCost(d.model, { input: d.tokens.input, output: d.tokens.output, cacheWrite5m: 0, cacheWrite1h: d.tokens.cacheWrite, cacheRead: d.tokens.cacheRead });

function expected(periodId, value = ALL) {
	const days = new Set(getPeriod(periodId, {}, now).days);
	return DATA.filter((d) => days.has(dayKey(at(d.daysAgo)))).reduce((sum, d) => sum + value(d.tokens, d), 0);
}

function millions(n) {
	const m = n / 1e6;
	return m < 9.995 ? `${m.toFixed(2)}M` : m < 99.95 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
}

const svgOf = (message) => Buffer.from(message.payload.image.split(",")[1], "base64").toString("utf8");
const textsOf = (svg) => [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
/** Visible texts: the outline copies under some numbers are skipped. */
const visible = (svg) => [...new Set(textsOf(svg))];

class FakeStreamDeck {
	messages = [];
	listeners = new Set();

	async start() {
		this.server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await new Promise((resolve) => this.server.once("listening", resolve));
		this.port = this.server.address().port;
		this.server.on("connection", (ws) => {
			this.ws = ws;
			ws.on("message", (data) => {
				this.messages.push(JSON.parse(data.toString()));
				for (const check of [...this.listeners]) check();
			});
		});
	}

	send(message) {
		this.ws.send(JSON.stringify(message));
	}

	mark() {
		return this.messages.length;
	}

	/** First message from index `from` on that satisfies `predicate`. */
	waitFor(predicate, from = 0, timeout = 10_000) {
		return new Promise((resolve, reject) => {
			const check = () => {
				const found = this.messages.slice(from).find(predicate);
				if (found) {
					clearTimeout(timer);
					this.listeners.delete(check);
					resolve(found);
				}
			};
			const timer = setTimeout(() => {
				this.listeners.delete(check);
				reject(new Error(`timed out; last messages: ${JSON.stringify(this.messages.slice(-3)).slice(0, 600)}`));
			}, timeout);
			this.listeners.add(check);
			check();
		});
	}
}

// Fake Anthropic usage endpoint, Admin API cost report and status page.
const CREDIT_EXPIRES = Date.now() + 15 * 86_400_000;
const daysAgo = (n) => utcDay(Date.now() - n * 86_400_000);
const ADMIN_KEY = "sk-ant-admin01-test-key";
const api = {
	usage: {
		five_hour: { utilization: 25.4, resets_at: new Date(Date.now() + 2 * 3_600_000 + 47 * 60_000).toISOString() },
		seven_day: { utilization: 52, resets_at: new Date(Date.now() + 61 * 3_600_000).toISOString() },
		seven_day_sonnet: { utilization: 12, resets_at: new Date(Date.now() + 61 * 3_600_000).toISOString() },
		seven_day_opus: null,
		extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1230, utilization: 24.6 },
		wattle_ember: {
			utilization: 11.2,
			resets_at: new Date(CREDIT_EXPIRES).toISOString(),
			label: "Cloud session credits",
			limit_dollars: 250,
			used_dollars: 28,
			remaining_dollars: 222,
			periods: [{ starts_at: new Date(CREDIT_EXPIRES - 30 * 86_400_000).toISOString(), ends_at: new Date(CREDIT_EXPIRES).toISOString() }],
		},
		limits: [
			{
				kind: "weekly",
				group: "model",
				percent: 2,
				resets_at: new Date(Date.now() + 61 * 3_600_000).toISOString(),
				severity: "normal",
				is_active: false,
				scope: { model: { display_name: "Fable" }, surface: null },
			},
		],
	},
	usageStatus: 200,
	// cents as decimal strings, one bucket per UTC day
	cost: {
		data: [
			{ starting_at: `${daysAgo(2)}T00:00:00Z`, ending_at: `${daysAgo(1)}T00:00:00Z`, results: [{ amount: "512.5", currency: "USD" }] },
			{ starting_at: `${daysAgo(1)}T00:00:00Z`, ending_at: `${daysAgo(0)}T00:00:00Z`, results: [{ amount: "300", currency: "USD" }, { amount: "162.5", currency: "USD" }] },
			{ starting_at: `${daysAgo(0)}T00:00:00Z`, ending_at: `${daysAgo(-1)}T00:00:00Z`, results: [] },
		],
		has_more: false,
		next_page: null,
	},
	summary: {
		status: { indicator: "none", description: "All Systems Operational" },
		components: [
			{ name: "claude.ai", status: "operational" },
			{ name: "Claude API (api.anthropic.com)", status: "operational" },
			{ name: "Claude Code", status: "operational" },
		],
		incidents: [],
	},
	// Codex on a plan that has a weekly limit only: it comes as the primary window
	codex: {
		email: "you@example.com",
		plan_type: "self_serve_business_prolite",
		rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 8, limit_window_seconds: 604_800, reset_after_seconds: 500_000, reset_at: Math.floor(Date.now() / 1000) + 500_000 }, secondary_window: null },
		code_review_rate_limit: null,
		additional_rate_limits: null,
		credits: { has_credits: true, unlimited: false, balance: "1240" },
		rate_limit_reset_credits: { available_count: 3 },
	},
	kimi: {
		usages: {
			limit_5h: { used_ratio: 0.37, reset_time: new Date(Date.now() + 3 * 3_600_000 + 5 * 60_000).toISOString() },
			limit_7d: { used_ratio: 0.615, reset_time: new Date(Date.now() + 80.5 * 3_600_000).toISOString() },
			limit_month_total: { used_ratio: "0.22", reset_time: new Date(Date.now() + 12 * 86_400_000).toISOString() },
			limit_month_code: { used_ratio: 0.15 },
		},
		boosterWallet: { balance: { type: "BOOSTER", amount: 5_000_000_000, amountLeft: 3_770_000_000 }, monthlyChargeLimitEnabled: false, monthlyUsed: { priceInCents: 1230, currency: "USD" } },
	},
	pages: {
		openai: { status: { indicator: "none", description: "All Systems Operational" }, components: [{ name: "Responses", status: "operational" }, { name: "Codex in ChatGPT Desktop", status: "degraded_performance" }] },
		moonshot: {
			status: { indicator: "none", description: "All Systems Operational" },
			components: [
				{ id: "g1", name: "Kimi Code", status: "operational", group: true },
				{ id: "c1", name: "K3.1 Pro", status: "operational", group_id: "g1" },
				{ id: "c2", name: "Open API", status: "major_outage", group_id: "g0" },
			],
			incidents: [],
		},
	},
	requests: [],
};

// Codex's login as its auth.json holds it: tokens that say themselves when they end
const CODEX_TOKEN = jwt({ exp: Math.floor(Date.now() / 1000) + 10 * 86_400 });
const CODEX_USAGE = [
	{ input_tokens: 23_469, cached_input_tokens: 13_184, cache_write_input_tokens: 0, output_tokens: 201, reasoning_output_tokens: 177, total_tokens: 23_670 },
	{ input_tokens: 400_000, cached_input_tokens: 300_000, cache_write_input_tokens: 50_000, output_tokens: 9_000, reasoning_output_tokens: 0, total_tokens: 409_000 },
];
const KIMI_KEY = "sk-kimi-test-key";

const sd = new FakeStreamDeck();
let server;
let plugin;
let home;
let pluginDir;
let sessionFile;
let launched;
let state;
let kimiLogin;

const event = (context, name, extra = {}) => ({ action: `${PREFIX}.usage`, event: name, context, device: "dev-1", ...extra });
const keyPayload = (settings = {}) => ({ settings, coordinates: { column: 7, row: 1 }, controller: "Keypad", isInMultiAction: false });
const imageOf = (context, from, test = () => true) =>
	sd.waitFor((m) => m.event === "setImage" && m.context === context && !/scanning|loading/.test(svgOf(m)) && test(svgOf(m)), from).then(svgOf);

function appear(context, actionId, settings = {}) {
	const from = sd.mark();
	sd.send({ action: `${PREFIX}.${actionId}`, event: "willAppear", context, device: "dev-1", payload: keyPayload(settings) });
	return from;
}

async function tap(context, actionId) {
	const from = sd.mark();
	sd.send({ action: `${PREFIX}.${actionId}`, event: "keyDown", context, device: "dev-1", payload: keyPayload() });
	await new Promise((r) => setTimeout(r, 60));
	sd.send({ action: `${PREFIX}.${actionId}`, event: "keyUp", context, device: "dev-1", payload: keyPayload() });
	return from;
}

function hold(context, actionId) {
	const from = sd.mark();
	sd.send({ action: `${PREFIX}.${actionId}`, event: "keyDown", context, device: "dev-1", payload: keyPayload() });
	return from;
}

function release(context, actionId) {
	sd.send({ action: `${PREFIX}.${actionId}`, event: "keyUp", context, device: "dev-1", payload: keyPayload() });
}

function settingsFor(context, actionId, settings) {
	const from = sd.mark();
	sd.send({ action: `${PREFIX}.${actionId}`, event: "didReceiveSettings", context, device: "dev-1", payload: { settings } });
	return from;
}

function save(name, svg) {
	fs.writeFileSync(path.join(OUTPUT, `${name}.svg`), svg);
}

before(async () => {
	fs.mkdirSync(OUTPUT, { recursive: true });

	// Install a copy of the built plugin, like Stream Deck does (no package.json above it).
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-e2e-"));
	pluginDir = path.join(tmp, "Plugins", "agency.rivo.ai-usage-meter.sdPlugin");
	fs.cpSync(SOURCE, pluginDir, { recursive: true });

	home = path.join(tmp, "home");
	sessionFile = path.join(home, ".claude", "projects", "-Users-nick-app", "5f0c.jsonl");
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	const lines = [];
	for (const d of DATA) {
		lines.push(userLine({ at: at(d.daysAgo) }), ...assistantLines({ at: at(d.daysAgo), tokens: d.tokens, model: d.model }));
		lines.push(taskResultLine({ at: at(d.daysAgo), tokens: { input: 5e8, output: 5e8 } }));
	}
	fs.writeFileSync(sessionFile, lines.join("\n") + "\n");
	fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "test-token", expiresAt: Date.now() + 3_600_000 } }));
	// who is signed in, as Claude Code records it
	fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "a", emailAddress: "you@example.com", organizationUuid: "o" } }));
	// stands in for Terminal: notes the folder and command it was given, and the profile it got
	launched = path.join(tmp, "launched.txt");
	const launcher = path.join(tmp, "launcher.sh");
	fs.writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$@" "\${CLAUDE_CONFIG_DIR:-}" > "${launched}"\n`);
	fs.chmodSync(launcher, 0o755);
	// The plugin's data folder on this platform (dataDir in src/limits.js), inside the fake home. The Admin
	// API key goes there as a file: the Keychain is switched off for the test, so the real one is never read.
	const appData = path.join(home, "AppData", "Roaming");
	state = process.platform === "darwin" ? path.join(home, "Library", "Application Support", PREFIX) : process.platform === "win32" ? path.join(appData, PREFIX) : path.join(home, ".local", "state", PREFIX);
	fs.mkdirSync(state, { recursive: true });
	fs.writeFileSync(path.join(state, "admin-key"), `${ADMIN_KEY}\n`);

	// Codex: its login, and a session log of today with two responses on one model
	fs.mkdirSync(path.join(home, ".codex", "sessions", "2026", "11", "18"), { recursive: true });
	fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: jwt({ email: "you@example.com" }), access_token: CODEX_TOKEN, refresh_token: "never-read", account_id: "acct-1" } }));
	fs.writeFileSync(path.join(home, ".codex", "sessions", "2026", "11", "18", "rollout-2026-11-18T10-00-00-0000.jsonl"), codexLines({ at: at(0), model: "gpt-6.1-sol", responses: CODEX_USAGE }).join("\n") + "\n");
	// Kimi Code: set up for the service outside mainland China; its 15-minute login ran out an hour ago
	fs.mkdirSync(path.join(home, ".kimi-code", "credentials"), { recursive: true });
	fs.writeFileSync(path.join(home, ".kimi-code", "config.toml"), 'default_model = "kimi-code/k3"\n\n[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.ai/coding/v1"\ntype = "kimi"\napi_key = ""\n');
	kimiLogin = path.join(home, ".kimi-code", "credentials", "kimi-code-env-test.json");
	fs.writeFileSync(kimiLogin, JSON.stringify({ access_token: "kimi-token", refresh_token: "never-read", expires_at: Math.floor(Date.now() / 1000) - 3600, token_type: "Bearer", expires_in: 900 }));

	server = http.createServer((req, res) => {
		api.requests.push({ url: req.url, headers: req.headers });
		if (req.url === "/api/oauth/usage") {
			if (req.headers.authorization === "Bearer old-token") return res.writeHead(401).end();
			res.writeHead(api.usageStatus, { "content-type": "application/json" });
			return res.end(JSON.stringify(api.usageStatus === 200 ? api.usage : { error: "nope" }));
		}
		if (req.url.startsWith("/v1/organizations/cost_report")) {
			res.writeHead(req.headers["x-api-key"] === ADMIN_KEY ? 200 : 401, { "content-type": "application/json" });
			return res.end(JSON.stringify(api.cost));
		}
		if (req.url === "/api/v2/summary.json") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify(api.summary));
		}
		const json = (body, ok = true) => {
			res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
			res.end(JSON.stringify(ok ? body : { error: { message: "The API Key appears to be invalid", type: "invalid_authentication_error" } }));
		};
		if (req.url === "/codex/usage") return json(api.codex, req.headers.authorization === `Bearer ${CODEX_TOKEN}` && req.headers["chatgpt-account-id"] === "acct-1");
		if (req.url === "/kimi/usages") return json(api.kimi, [`Bearer kimi-token`, `Bearer ${KIMI_KEY}`].includes(req.headers.authorization));
		if (req.url === "/openai/summary.json") return json(api.pages.openai);
		if (req.url === "/moonshot/summary.json") return json(api.pages.moonshot);
		res.writeHead(404).end();
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;

	await sd.start();
	plugin = spawn(NODE, [path.join(pluginDir, "bin", "plugin.js"), "-port", String(sd.port), "-pluginUUID", PLUGIN_UUID, "-registerEvent", "registerPlugin", "-info", INFO], {
		cwd: pluginDir,
		// Nothing of this computer may leak into the plugin under test: no real Keychain, no profile or
		// tool folders named by the developer's own environment, no real data folder.
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			APPDATA: appData,
			XDG_STATE_HOME: path.join(home, ".local", "state"),
			XDG_CONFIG_HOME: path.join(home, ".config"),
			CLAUDE_CONFIG_DIR: "",
			CODEX_HOME: "",
			KIMI_CODE_HOME: "",
			USAGE_METER_KEYCHAIN: "off",
			CLAUDE_USAGE_URL: `${base}/api/oauth/usage`,
			CLAUDE_STATUS_URL: `${base}/api/v2/summary.json`,
			CLAUDE_COST_URL: `${base}/v1/organizations/cost_report`,
			CLAUDE_LAUNCHER: path.join(path.dirname(launched), "launcher.sh"),
			CODEX_USAGE_URL: `${base}/codex/usage`,
			KIMI_USAGE_URL: `${base}/kimi/usages`,
			OPENAI_STATUS_URL: `${base}/openai/summary.json`,
			KIMI_STATUS_URL: `${base}/moonshot/summary.json`,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	plugin.stderr.on("data", (d) => process.stderr.write(d));
	await sd.waitFor((m) => m.event === "registerPlugin");
});

after(() => {
	plugin?.kill();
	sd.server?.close();
	server?.close();
});

test("registers with the launch arguments", async () => {
	const message = await sd.waitFor((m) => m.event === "registerPlugin");
	assert.equal(message.uuid, PLUGIN_UUID);
});

test("token usage: 7 days in millions, press switches to the month", async () => {
	const svg = await imageOf("tokens", appear("tokens", "usage"));
	save("tokens-week", svg);
	const total = expected("week");
	assert.equal(total, 35_251_000);
	assert.deepEqual(visible(svg), ["7 DAYS", millions(total), `~${millions(total / 7)}/day`]);

	const from = await tap("tokens", "usage");
	const saved = await sd.waitFor((m) => m.event === "setSettings" && m.context === "tokens", from);
	assert.equal(saved.payload.periodIndex, 1);
	const month = await imageOf("tokens", from);
	save("tokens-month", month);
	assert.equal(visible(month)[0], getPeriod("month", {}, now).label);
	assert.equal(visible(month)[1], millions(expected("month")));
});

test("token usage: chart style and input + output count", async () => {
	const svg = await imageOf("tokens", settingsFor("tokens", "usage", { periods: ["week", "month"], count: "io", periodIndex: 0, style: "chart" }));
	save("tokens-chart-io", svg);
	assert.ok(visible(svg).includes(millions(expected("week", IO))));
	assert.ok(visible(svg).includes("7 DAYS"));
});

test("API cost: today per hour, then 7 days in dollars", async () => {
	const svg = await imageOf("cost", appear("cost", "cost"));
	save("cost-today", svg);
	assert.equal(visible(svg)[0], "TODAY");
	assert.equal((svg.match(/<rect /g) ?? []).length - 1, 24, "one bar per hour");
	const week = await imageOf("cost", await tap("cost", "cost"));
	save("cost-week", week);
	const dollars = expected("week", (t, d) => costOf(d));
	assert.equal(visible(week)[1], `$${dollars < 9.995 ? dollars.toFixed(2) : dollars < 99.95 ? dollars.toFixed(1) : Math.round(dollars)}`);
});

test("5-hour limit: what's left in a ring, press switches to used", async () => {
	const svg = await imageOf("five", appear("five", "limit5h", { tag: "N" }));
	save("limit5h-ring", svg);
	const texts = visible(svg);
	assert.deepEqual(texts.slice(0, 2), ["5-HOUR", "N"]);
	assert.ok(texts.includes("75%") && texts.includes("left"), texts.join("|"));
	assert.match(texts.at(-1), /^2h4[67]m$/);

	const usage = api.requests.find((r) => r.url === "/api/oauth/usage");
	assert.equal(usage.headers.authorization, "Bearer test-token");
	assert.equal(usage.headers["anthropic-beta"], "oauth-2025-04-20");

	const from = await tap("five", "limit5h");
	const saved = await sd.waitFor((m) => m.event === "setSettings" && m.context === "five", from);
	assert.equal(saved.payload.show, "used");
	const used = await imageOf("five", from);
	assert.ok(visible(used).includes("25%") && visible(used).includes("used"));
});

test("5-hour limit: the settings panel gets a preview of every style", async () => {
	const from = sd.mark();
	sd.send({ action: `${PREFIX}.limit5h`, event: "propertyInspectorDidAppear", context: "five", device: "dev-1" });
	const status = await sd.waitFor((m) => m.event === "sendToPropertyInspector" && m.context === "five", from);
	assert.equal(status.payload.action, "limit5h", "the panel learns which key it belongs to");
	assert.deepEqual(
		status.payload.previews.map((p) => p.id),
		["ring", "number", "bar", "pie", "battery", "gauge", "segments", "pace", "history", "countdown"],
	);
	for (const p of status.payload.previews) {
		const svg = Buffer.from(p.image.split(",")[1], "base64").toString("utf8");
		assert.match(svg, /^<svg [^>]+>.*<\/svg>$/);
		save(`limit5h-${p.id}`, svg);
	}
	assert.equal(status.payload.table.rows[0][0], "5-hour");
	assert.equal(status.payload.table.rows[0][1], "25% used · 75% left");
	assert.ok(status.payload.accounts.some((a) => a.value === ""));
	assert.ok(status.payload.accounts.some((a) => a.value === "~/.claude" && a.label === "~/.claude · you@example.com"), "each profile with its email");
	assert.equal(Object.fromEntries(status.payload.info)["Signed in as"], "you@example.com");
	assert.equal(status.payload.error, null);
	const login = Object.fromEntries(status.payload.info).Login;
	assert.match(login, /^~\/\.claude\/\.credentials\.json, valid for \d+m$/);
	assert.ok(!JSON.stringify(status.payload).includes("test-token"), "the token never reaches the settings panel");
});

test("weekly limit: Sonnet scope, battery style", async () => {
	const svg = await imageOf("week", appear("week", "limit7d", { scope: "sonnet", style: "battery", show: "used" }));
	save("limit7d-sonnet-battery", svg);
	assert.equal(visible(svg)[0], "SONNET 7D");
	assert.ok(visible(svg).includes("12%"));
	const opus = await imageOf("week", settingsFor("week", "limit7d", { scope: "opus" }));
	assert.ok(visible(opus).includes("not on your plan"));
	const fable = await imageOf("week", settingsFor("week", "limit7d", { scope: "fable", show: "used" }));
	save("limit7d-fable-ring", fable);
	assert.deepEqual(visible(fable).slice(0, 3), ["FABLE 7D", "2%", "used"]);
	const haiku = await imageOf("week", settingsFor("week", "limit7d", { scope: "haiku" }));
	assert.equal(visible(haiku)[0], "HAIKU 7D");
	assert.ok(visible(haiku).includes("not on your plan"), "no Haiku limit in the answer");
});

test("both limits on one key", async () => {
	const svg = await imageOf("both", appear("both", "limits", { show: "used" }));
	save("limits-bars", svg);
	const texts = visible(svg);
	assert.ok(texts.includes("25%") && texts.includes("52%"), texts.join("|"));
	assert.ok(texts.includes("5H") && texts.includes("7D"));
});

test("extra usage: dollars spent of the monthly limit", async () => {
	const svg = await imageOf("extra", appear("extra", "extra"));
	save("extra-ring", svg);
	assert.ok(visible(svg).includes("24%"));
	assert.ok(visible(svg).includes("$12.30 / $50"), visible(svg).join("|"));
	const from = await tap("extra", "extra");
	const open = await sd.waitFor((m) => m.event === "openUrl", from);
	assert.equal(open.payload.url, "https://claude.ai/settings/usage");
});

test("credit balance: dollars left of the included credit, and when it expires", async () => {
	const svg = await imageOf("credit", appear("credit", "credit"));
	save("credit-ring", svg);
	assert.deepEqual(visible(svg), ["CLOUD CREDIT", "$222", "left", `of $250 · exp ${monthDay(CREDIT_EXPIRES)}`]);
	const spent = await imageOf("credit", await tap("credit", "credit"), (s) => s.includes("spent"));
	assert.deepEqual(visible(spent).slice(1, 3), ["$28", "spent"]);

	const from = sd.mark();
	sd.send({ action: `${PREFIX}.credit`, event: "propertyInspectorDidAppear", context: "credit", device: "dev-1" });
	const status = await sd.waitFor((m) => m.event === "sendToPropertyInspector" && m.context === "credit", from);
	const row = status.payload.table.rows.find((r) => r[0] === "Cloud session credits");
	assert.equal(row[1], "$222 of $250 left");
	assert.match(row[2], /^expires /);
	assert.equal(status.payload.previews.length, 8);

	assert.equal(Object.fromEntries(status.payload.info)["API fields"], "five_hour, seven_day, seven_day_sonnet, extra_usage, wattle_ember, limits (1)");
	assert.equal(status.payload.note, undefined);

	// What happened on a real account: no dollar credit in the answer, only the Claude Code and Cowork
	// credit as a percentage. The key must not pass that off as money.
	const dollars = api.usage.wattle_ember;
	const codeEnds = Date.now() + 3 * 3_600_000;
	delete api.usage.wattle_ember;
	api.usage.cinder_cove = { utilization: 0, resets_at: new Date(codeEnds).toISOString() };
	const refreshed = hold("credit", "credit");
	const none = await imageOf("credit", refreshed, (s) => s.includes("only on claude.ai"));
	release("credit", "credit");
	assert.deepEqual(visible(none), ["CLOUD CREDIT", "—", "only on claude.ai", "press to open"]);
	const noted = await sd.waitFor((m) => m.event === "sendToPropertyInspector" && m.context === "credit" && m.payload.note, refreshed);
	assert.match(noted.payload.note, /does not send your cloud session credit.*choose it under Credit/);
	const open = await sd.waitFor((m) => m.event === "openUrl", await tap("credit", "credit"));
	assert.equal(open.payload.url, "https://claude.ai/settings/usage");

	// the percentage credit only when chosen, and labelled as what it is
	const code = await imageOf("credit", settingsFor("credit", "credit", { which: "code", show: "left" }));
	assert.deepEqual(visible(code), ["CODE CREDIT", "100%", "left", `until ${monthDay(codeEnds)}`]);

	api.usage.wattle_ember = dollars;
	delete api.usage.cinder_cove;
});

test("API credit: what is left of a Console credit after the API spend since it was granted", async () => {
	const spent = (512.5 + 300 + 162.5) / 100;
	const expires = daysAgo(-10);
	const expiresLabel = new Date(`${expires}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
	const svg = await imageOf("api", appear("api", "apicredit", { amount: 200, granted: daysAgo(5), expires }));
	save("apicredit-number", svg);
	assert.deepEqual(visible(svg), ["API CREDIT", formatMoney(200 - spent), "LEFT", `of $200 · exp ${expiresLabel}`]);
	const request = api.requests.find((r) => r.url.startsWith("/v1/organizations/cost_report"));
	assert.equal(request.headers["x-api-key"], ADMIN_KEY);
	assert.equal(request.headers["anthropic-version"], "2023-06-01");
	assert.match(request.url, new RegExp(`starting_at=${daysAgo(5) < utcMonthStart(Date.now()) ? daysAgo(5) : utcMonthStart(Date.now())}T00%3A00%3A00Z`));

	const from = sd.mark();
	sd.send({ action: `${PREFIX}.apicredit`, event: "propertyInspectorDidAppear", context: "api", device: "dev-1" });
	const status = await sd.waitFor((m) => m.event === "sendToPropertyInspector" && m.context === "api", from);
	const info = Object.fromEntries(status.payload.info);
	assert.match(info["Admin key"], /admin-key$/, "where the key was found, never the key");
	assert.ok(!JSON.stringify(status.payload).includes(ADMIN_KEY));
	// on a Mac the key belongs in the Keychain, elsewhere in a file
	assert.match(status.payload.note, process.platform === "darwin" ? /security add-generic-password .*-s "AI Usage Meter Admin Key" -w$/m : /Save the key as the only line of this file:\n.*admin-key$/m, "the steps for this computer");
	assert.deepEqual(status.payload.table.rows.at(-1), ["Credit left", `$${(200 - spent).toFixed(2)}`], "with cents in the table");

	// without an amount: this month's API spend
	const month = api.cost.data.filter((b) => b.starting_at.slice(0, 10) >= utcMonthStart(Date.now()));
	const monthSpend = month.flatMap((b) => b.results).reduce((sum, r) => sum + Number(r.amount) / 100, 0);
	const spend = await imageOf("spend", appear("spend", "apicredit", {}));
	assert.deepEqual(visible(spend), ["API SPEND", formatMoney(monthSpend), "THIS MONTH", "Claude Console"]);
});

test("peak hours: peak or not now, in local time; press for the next style", async () => {
	const w = peakAt(Date.now());
	const word = w.peak ? "PEAK" : w.start - Date.now() <= 30 * 60_000 ? "SOON" : "OFF-PEAK";
	const svg = await imageOf("peak", appear("peak", "peak"));
	save("peak-badge", svg);
	assert.deepEqual(visible(svg).slice(0, 2), ["PEAK HOURS", word]);
	const timer = await imageOf("peak", await tap("peak", "peak"), (s) => s.includes("until peak"));
	assert.ok(visible(timer).some((t) => t.startsWith("until peak")), visible(timer).join("|"));

	const from = sd.mark();
	sd.send({ action: `${PREFIX}.peak`, event: "propertyInspectorDidAppear", context: "peak", device: "dev-1" });
	const status = await sd.waitFor((m) => m.event === "sendToPropertyInspector" && m.context === "peak", from);
	assert.equal(status.payload.table.rows.length, 5, "the next five windows");
	assert.match(status.payload.table.rows[0][1], /^(\d\d:\d\d–\d\d:\d\d|\d{1,2}(:\d\d)?( [AP]M)?–\d{1,2}(:\d\d)? [AP]M)$/);
	assert.match(status.payload.note, /6 May 2026/);
	assert.equal(status.payload.previews.length, 3);
});

test("cache hits over 7 days, and what the cache reads saved", async () => {
	const days = new Set(getPeriod("week", {}, now).days);
	let [read, prompt, saved] = [0, 0, 0];
	for (const d of DATA.filter((d) => days.has(dayKey(at(d.daysAgo))))) {
		read += d.tokens.cacheRead;
		prompt += d.tokens.input + d.tokens.cacheWrite + d.tokens.cacheRead;
		const price = priceFor(d.model);
		saved += (d.tokens.cacheRead * (price.input - price.cacheRead)) / 1e6;
	}
	const svg = await imageOf("cache", appear("cache", "cache"));
	save("cache-ring", svg);
	assert.deepEqual(visible(svg), ["7 DAYS", `${Math.floor((read / prompt) * 100)}%`, "cached", `saved ${formatMoney(saved)}`], "a short word inside the ring");
	const month = await imageOf("cache", await tap("cache", "cache"), (s) => !s.includes("7 DAYS"));
	assert.ok(visible(month).includes("cached"));
});

test("streak: days in a row with Claude Code", async () => {
	const svg = await imageOf("streak", appear("streak", "streak"));
	save("streak-days", svg);
	assert.deepEqual(visible(svg), ["STREAK", "2", "days in a row", "best 2"]);
	const grid = await imageOf("streak", await tap("streak", "streak"), (s) => s.includes("· best"));
	save("streak-calendar", grid);
	assert.equal(visible(grid).at(-1), "2 days · best 2");
});

test("launch key opens a terminal running claude in the chosen folder", async () => {
	const svg = await imageOf("launch", appear("launch", "launch", { folder: "~/work", command: "claude --continue" }));
	save("launch", svg);
	assert.deepEqual(visible(svg), ["CLAUDE CODE", ">_", "claude --continue", "work"]);
	let from = await tap("launch", "launch");
	await sd.waitFor((m) => m.event === "showOk" && m.context === "launch", from);
	assert.deepEqual(fs.readFileSync(launched, "utf8").trim().split("\n"), [path.join(home, "work"), "claude --continue"], "the default account sets no profile");

	// another Claude account: its own Claude Code profile
	fs.mkdirSync(path.join(home, ".claude-work"), { recursive: true });
	fs.writeFileSync(path.join(home, ".claude-work", ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" } }));
	const tagged = await imageOf("launch", settingsFor("launch", "launch", { folder: "~/work", command: "claude", account: "~/.claude-work", tag: "W" }), (svg) => visible(svg).includes("W"));
	assert.deepEqual(visible(tagged), ["CLAUDE CODE", "W", ">_", "claude", "work"]);
	from = await tap("launch", "launch");
	await sd.waitFor((m) => m.event === "showOk" && m.context === "launch", from);
	assert.deepEqual(fs.readFileSync(launched, "utf8").trim().split("\n"), [path.join(home, "work"), "claude", path.join(home, ".claude-work")]);

	from = sd.mark();
	sd.send({ action: `${PREFIX}.launch`, event: "propertyInspectorDidAppear", context: "launch", device: "dev-1" });
	const status = await sd.waitFor((m) => m.event === "sendToPropertyInspector" && m.context === "launch", from);
	assert.equal(Object.fromEntries(status.payload.info).Account, "~/.claude-work · work@example.com");
	assert.deepEqual(status.payload.accounts.slice(0, 2), [
		{ value: "", label: "Default (~/.claude) · you@example.com" },
		{ value: "~/.claude-work", label: "~/.claude-work · work@example.com" },
	]);
});

test("model mix: share of Opus and Sonnet over 7 days", async () => {
	const svg = await imageOf("models", appear("models", "models"));
	save("models-donut", svg);
	const opus = expected("week", (t, d) => (d.model.includes("opus") ? ALL(t) : 0));
	const share = Math.round((opus / expected("week")) * 100);
	assert.ok(visible(svg).includes(`${share}%`), visible(svg).join("|"));
	assert.ok(visible(svg).includes("OPUS"));
});

test("session context of the latest Claude Code session; press shows the next one", async () => {
	const file = path.join(home, ".claude", "projects", "-Users-nick-streamdeck", "ctx.jsonl");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const line = assistantLines({ at: new Date(Date.now() - 2 * 60_000), tokens: { cacheWrite: 1_500, cacheRead: 140_000 }, blocks: ["text"], sessionId: "22222222-2222-4222-8222-222222222222", cwd: "/Users/nick/streamdeck" });
	fs.writeFileSync(file, line.join("\n") + "\n");
	appear("ctx", "context");
	const from = hold("ctx", "context");
	const svg = await imageOf("ctx", from, (s) => s.includes("142K"));
	await sd.waitFor((m) => m.event === "showOk" && m.context === "ctx", from);
	release("ctx", "context");
	save("context-ring", svg);
	assert.deepEqual(visible(svg), ["CONTEXT", "1/2", "142K", "of 1M", "streamdeck · 2m"]);

	const next = await imageOf("ctx", await tap("ctx", "context"), (s) => s.includes("2/2"));
	assert.ok(visible(next).includes("3.2M"), visible(next).join("|"));
	assert.ok(visible(next).includes("project · " + visible(next).at(-1).split(" · ")[1]));
});

test("Claude status: badge, then degraded after a refresh, press opens the incident", async () => {
	const svg = await imageOf("status", appear("status", "status"), (s) => !s.includes("checking"));
	save("status-ok", svg);
	assert.deepEqual(visible(svg), ["CLAUDE", "OK"]);

	// as status.claude.com reported it on 21 Oct 2026
	api.summary = {
		status: { indicator: "minor", description: "Partially Degraded Service" },
		components: [
			{ name: "claude.ai", status: "degraded_performance" },
			{ name: "Claude Console (platform.claude.com)", status: "operational" },
			{ name: "Claude Code", status: "degraded_performance" },
		],
		incidents: [
			{
				name: "Degraded performance for Claude Fable 5",
				status: "investigating",
				impact: "minor",
				shortlink: "https://stspg.io/xyz",
				components: [{ name: "claude.ai" }, { name: "Claude Code" }],
				incident_updates: [{ status: "investigating", body: "We are investigating elevated errors on requests to Claude Fable 5." }],
			},
		],
	};
	const from = hold("status", "status");
	const degraded = await imageOf("status", from, (s) => s.includes("DEGRADED"));
	save("status-degraded", degraded);
	assert.deepEqual(visible(degraded), ["CLAUDE", "DEGRADED", "Fable 5"], "names the model in trouble");
	await sd.waitFor((m) => m.event === "showOk" && m.context === "status", from);
	release("status", "status");
	const open = await sd.waitFor((m) => m.event === "openUrl", await tap("status", "status"));
	assert.equal(open.payload.url, "https://stspg.io/xyz");

	const panel = sd.mark();
	sd.send({ action: `${PREFIX}.status`, event: "propertyInspectorDidAppear", context: "status", device: "dev-1" });
	const status = await sd.waitFor((m) => m.event === "sendToPropertyInspector" && m.context === "status", panel);
	assert.deepEqual(status.payload.info[0], ["Incident", "Degraded performance for Claude Fable 5\nFable 5 · investigating · affects claude.ai, Claude Code"]);

	// a key that watches the Console is fine; one that watches Fable models is not
	const console = await imageOf("console", appear("console", "status", { component: "console" }), (s) => !s.includes("checking"));
	assert.deepEqual(visible(console), ["CONSOLE", "OK"]);
	const fable = await imageOf("fable", appear("fable", "status", { component: "fable", style: "detail" }), (s) => !s.includes("checking"));
	save("status-fable-detail", fable);
	assert.deepEqual(visible(fable), ["FABLE", "DEGRADED", "Fable 5", "Investigating", "claude.ai +1"], "how far the fix is, and where");
});

test("holding a limit key refreshes it; API errors keep the last numbers and show an alert", async () => {
	api.usage.five_hour.utilization = 61;
	let from = hold("five", "limit5h");
	const svg = await imageOf("five", from, (s) => visible(s).includes("61%"));
	assert.ok(visible(svg).includes("61%"));
	await sd.waitFor((m) => m.event === "showOk" && m.context === "five", from);
	release("five", "limit5h");

	api.usageStatus = 500;
	from = hold("five", "limit5h");
	await sd.waitFor((m) => m.event === "showAlert" && m.context === "five", from);
	release("five", "limit5h");
	const stale = await imageOf("five", from);
	assert.ok(visible(stale).includes("61%"), "last known numbers stay");
	api.usageStatus = 200; // before anything can fail: the tests after this one share the fake API
	assert.match(stale, /<circle cx="11" cy="5" r="3" fill="none"/, "with a stale marker");
});

test("holding the token key rescans and picks up new usage", async () => {
	fs.appendFileSync(sessionFile, assistantLines({ at: new Date(), tokens: { output: 5_000_000 }, blocks: ["text", "tool_use"] }).join("\n") + "\n");
	const from = hold("tokens", "usage");
	const svg = await imageOf("tokens", from);
	await sd.waitFor((m) => m.event === "showOk" && m.context === "tokens", from);
	release("tokens", "usage");
	assert.ok(visible(svg).includes(millions(expected("week", IO) + 5_000_000)));
	assert.equal(sd.messages.filter((m) => m.event === "setSettings" && m.context === "tokens").length, 1, "a long press does not switch the period");
});

test("a signed-out account shows what to do", async () => {
	const svg = await imageOf("other", appear("other", "limit5h", { account: "~/.claude-missing" }));
	assert.deepEqual(visible(svg).slice(-2), ["no Claude login", "run claude"]);
});

test("an expired login says so, and the key recovers once Claude Code renews it", async () => {
	const dir = path.join(home, ".claude-old");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "old-token", expiresAt: Date.now() - 5 * 3_600_000 } }));
	const svg = await imageOf("old", appear("old", "limit5h", { account: "~/.claude-old" }), (s) => s.includes("login expired"));
	assert.deepEqual(visible(svg).slice(-2), ["login expired", "run claude"]);
	assert.ok(api.requests.some((r) => r.headers.authorization === "Bearer old-token"), "the old token was tried, the server said no");

	let from = sd.mark();
	sd.send({ action: `${PREFIX}.limit5h`, event: "propertyInspectorDidAppear", context: "old", device: "dev-1" });
	const status = await sd.waitFor((m) => m.event === "sendToPropertyInspector" && m.context === "old", from);
	assert.match(Object.fromEntries(status.payload.info).Login, /^~\/\.claude-old\/\.credentials\.json, expired 5h ago$/);
	assert.match(status.payload.error, /Run `claude` in Terminal/);

	// what `claude` does when it renews its login
	fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "test-token", expiresAt: Date.now() + 8 * 3_600_000 } }));
	from = hold("old", "limit5h");
	const fixed = await imageOf("old", from, (s) => !s.includes("login expired"));
	release("old", "limit5h");
	assert.ok(visible(fixed).includes("left"), visible(fixed).join("|"));
});

test("every key shows its service's logo, unless it is switched off", async () => {
	const mark = /<g transform="translate\([^"]+\) scale\([^"]+\)"><path /;
	const withLogo = await imageOf("logo", appear("logo", "limit7d"));
	assert.match(withLogo, mark, "Claude's mark before the label");
	assert.deepEqual(visible(withLogo).slice(0, 3), ["WEEKLY", "48%", "left"]);
	const without = await imageOf("logo", settingsFor("logo", "limit7d", { logo: "off" }), (svg) => !mark.test(svg));
	assert.deepEqual(visible(without).slice(0, 3), ["WEEKLY", "48%", "left"], "the same key without it");
});

test("a key that went away and came back does not ask the API again", async () => {
	fs.mkdirSync(path.join(home, ".claude-flip"), { recursive: true });
	fs.writeFileSync(path.join(home, ".claude-flip", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "flip-token", expiresAt: Date.now() + 3_600_000 } }));
	const asked = () => api.requests.filter((r) => r.headers.authorization === "Bearer flip-token").length;
	await imageOf("flip", appear("flip", "limit5h", { account: "~/.claude-flip" }));
	assert.equal(asked(), 1);
	// what flipping to another page of the Stream Deck and back does
	sd.send({ action: `${PREFIX}.limit5h`, event: "willDisappear", context: "flip", device: "dev-1", payload: keyPayload({ account: "~/.claude-flip" }) });
	const back = await imageOf("flip", appear("flip", "limit5h", { account: "~/.claude-flip" }));
	assert.ok(visible(back).includes("left"), "the numbers are there at once");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(asked(), 1, "from the data source that was kept, not from the API");
});

test("Codex: the weekly limit of a plan that has only that, credits, and what the settings say", async () => {
	const week = await imageOf("cx-week", appear("cx-week", "codex-limit7d"));
	save("codex-weekly", week);
	assert.deepEqual(visible(week), ["WEEKLY", "92%", "left", "5d18h"]);
	const request = api.requests.find((r) => r.url === "/codex/usage");
	assert.equal(request.headers.authorization, `Bearer ${CODEX_TOKEN}`, "Codex's own login, as it is");
	assert.equal(request.headers["chatgpt-account-id"], "acct-1");

	const five = await imageOf("cx-five", appear("cx-five", "codex-limit5h"));
	assert.deepEqual(visible(five), ["5-HOUR", "—", "not on your plan"]);
	const both = await imageOf("cx-both", appear("cx-both", "codex-limits"));
	assert.deepEqual(visible(both).filter(Boolean), ["5H", "—", "7D", "92%", "5d18h", "left"], "a dash where the plan has no limit");
	const credits = await imageOf("cx-credit", appear("cx-credit", "codex-credit"));
	assert.deepEqual(visible(credits), ["CREDITS", "1,240", "LEFT", "3 limit resets"]);
	assert.equal(api.requests.filter((r) => r.url === "/codex/usage").length, 1, "four keys, one request");

	const from = sd.mark();
	sd.send({ action: `${PREFIX}.codex-limit7d`, event: "propertyInspectorDidAppear", context: "cx-week", device: "dev-1" });
	const status = await sd.waitFor((m) => m.event === "sendToPropertyInspector" && m.context === "cx-week", from);
	const info = Object.fromEntries(status.payload.info);
	assert.equal(info.Plan, "self serve business prolite");
	assert.equal(info["Signed in as"], "you@example.com");
	assert.match(info.Login, /^~\/\.codex\/auth\.json, valid for 9d2\dh$/);
	assert.deepEqual(status.payload.table.rows[0].slice(0, 2), ["Weekly", "8% used · 92% left"]);
	assert.deepEqual(status.payload.table.rows[1], ["Credits", "1,240", "3 limit resets to spend"]);
	assert.match(status.payload.note, /weekly limit only/);
	assert.equal(status.payload.previews.length, 10);
	assert.ok(!JSON.stringify(status.payload).includes(CODEX_TOKEN), "never the login itself");
});

test("Codex tokens and API cost from its session logs", async () => {
	// 432,670 tokens in two responses; the second is long context (over 272K input) with a cache write
	const tokens = await imageOf("cx-tokens", appear("cx-tokens", "codex-usage"));
	save("codex-tokens", tokens);
	assert.deepEqual(visible(tokens), ["7 DAYS", "0.43M", "~0.06M/day"]);
	const cost = openaiRequestCost("gpt-6.1-sol", { input: 10_285, cacheWrite: 0, cacheRead: 13_184, output: 201 }) + openaiRequestCost("gpt-6.1-sol", { input: 50_000, cacheWrite: 50_000, cacheRead: 300_000, output: 9_000 });
	const svg = await imageOf("cx-cost", appear("cx-cost", "codex-cost"));
	assert.deepEqual(visible(svg).slice(0, 2), ["TODAY", `$${cost.toFixed(2)}`]);
	const models = await imageOf("cx-models", appear("cx-models", "codex-models"));
	assert.deepEqual(visible(models), ["7 DAYS", "100%", "SOL", "0.43M tokens"]);

	const from = sd.mark();
	sd.send({ action: `${PREFIX}.codex-usage`, event: "propertyInspectorDidAppear", context: "cx-tokens", device: "dev-1" });
	const status = await sd.waitFor((m) => m.event === "sendToPropertyInspector" && m.context === "cx-tokens", from);
	const rows = Object.fromEntries(status.payload.table.rows.map((r) => [r[0], r[1]]));
	assert.equal(rows.Requests, "2", "a response is counted once, by its record; the token_count event after it is not counted again");
	assert.equal(rows["Cache read"], "0.31M");
	assert.match(Object.fromEntries(status.payload.info).Sources, /^~\/\.codex\/sessions\n~\/\.codex\/archived_sessions$/);
});

test("Kimi: an expired login says so without asking; a renewed one brings the limits", async () => {
	const expired = await imageOf("kimi", appear("kimi", "kimi-limit7d"));
	assert.deepEqual(visible(expired), ["WEEKLY", "!", "login expired", "open Kimi Code"]);
	assert.ok(!api.requests.some((r) => r.url === "/kimi/usages"), "a login that says it is over is not sent");

	let from = sd.mark();
	sd.send({ action: `${PREFIX}.kimi-limit7d`, event: "propertyInspectorDidAppear", context: "kimi", device: "dev-1" });
	let status = await sd.waitFor((m) => m.event === "sendToPropertyInspector" && m.context === "kimi", from);
	assert.match(Object.fromEntries(status.payload.info).Login, /^~\/\.kimi-code\/credentials\/kimi-code-env-test\.json, expired 1h ago$/);
	assert.match(status.payload.note, process.platform === "darwin" ? /security add-generic-password .*-s "AI Usage Meter Kimi API Key" -w$/m : /kimi-api-key$/m, "how to store an API key on this computer");
	assert.deepEqual(status.payload.links, [["Kimi Code console", "https://www.kimi.ai/code/console"]], "the console of the region Kimi Code is set up for");

	// a key set to open its page still does so while it has only a message to show
	await imageOf("kimi-open", appear("kimi-open", "kimi-limit5h", { press: "open" }));
	const opened = await sd.waitFor((m) => m.event === "openUrl", await tap("kimi-open", "kimi-limit5h"));
	assert.equal(opened.payload.url, "https://www.kimi.ai/code/console");
	sd.send({ action: `${PREFIX}.kimi-limit5h`, event: "willDisappear", context: "kimi-open", device: "dev-1", payload: keyPayload() });

	// what Kimi Code does when it is used again
	fs.writeFileSync(kimiLogin, JSON.stringify({ access_token: "kimi-token", refresh_token: "never-read", expires_at: Math.floor(Date.now() / 1000) + 900, token_type: "Bearer", expires_in: 900 }));
	// a key that has only a message to show asks again on a press, instead of switching used and left unseen
	from = await tap("kimi", "kimi-limit7d");
	const week = await imageOf("kimi", from, (svg) => !svg.includes("login expired"));
	await sd.waitFor((m) => m.event === "showOk" && m.context === "kimi", from);
	save("kimi-weekly", week);
	assert.deepEqual(visible(week), ["WEEKLY", "39%", "left", "3d8h"]);
	assert.equal(api.requests.find((r) => r.url === "/kimi/usages").headers.authorization, "Bearer kimi-token");

	assert.match(visible(await imageOf("kimi-5h", appear("kimi-5h", "kimi-limit5h"))).join("|"), /^5-HOUR\|63%\|left\|3h0\dm$/);
	assert.deepEqual(visible(await imageOf("kimi-month", appear("kimi-month", "kimi-month"))).slice(0, 3), ["MONTHLY", "78%", "left"]);
	assert.deepEqual(visible(await imageOf("kimi-extra", appear("kimi-extra", "kimi-extra"))), ["EXTRA", "$37.70", "left", "of $50"]);

	from = sd.mark();
	sd.send({ action: `${PREFIX}.kimi-limit7d`, event: "propertyInspectorDidAppear", context: "kimi", device: "dev-1" });
	status = await sd.waitFor((m) => m.event === "sendToPropertyInspector" && m.context === "kimi" && m.payload.table, from);
	assert.deepEqual(status.payload.table.rows.map((r) => r.slice(0, 2)), [
		["5-hour", "37% used · 63% left"],
		["Weekly", "61% used · 39% left"],
		["Monthly", "22% used · 78% left"],
		["Monthly, coding part", "15% used"],
		["Extra usage", "$37.70 of $50 left"],
	]);
	assert.equal(Object.fromEntries(status.payload.info).Asks, "api.kimi.ai");
	assert.ok(!JSON.stringify(status.payload).includes("kimi-token"), "never the login itself");
});

test("all services on one key", async () => {
	const svg = await imageOf("all", appear("all", "overview"), (s) => ["48%", "92%", "39%"].every((v) => visible(s).includes(v)));
	save("overview-bars", svg);
	assert.deepEqual(visible(svg).filter((t) => t.endsWith("%") || t.includes("·")), ["48%", "92%", "39%", "WEEKLY · left"], "Claude, Codex, Kimi: what is left of the week");
	assert.equal((svg.match(/<g transform="translate/g) ?? []).length, 3, "a mark for each");

	// press: what is used instead of what is left
	const from = await tap("all", "overview");
	const used = await imageOf("all", from, (s) => visible(s).includes("WEEKLY · used"));
	assert.deepEqual(visible(used).filter((t) => t.endsWith("%")), ["52%", "8%", "61%"]);

	// both limits as numbers; Codex has no 5-hour limit on this plan
	const table = await imageOf("all", settingsFor("all", "overview", { style: "table", services: ["codex", "kimi"] }), (s) => visible(s).includes("5H"));
	assert.deepEqual(visible(table), ["left", "5H", "7D", "—", "92%", "63%", "39%"]);
});

test("status of OpenAI and of Kimi, each from its own page", async () => {
	const codex = await imageOf("cx-status", appear("cx-status", "codex-status"), (s) => !s.includes("checking"));
	assert.deepEqual(visible(codex), ["CODEX", "DEGRADED"], "the Codex component, not the page's overall status");
	const openai = await imageOf("cx-status", settingsFor("cx-status", "codex-status", { component: "all" }), (s) => visible(s).includes("OPENAI"));
	assert.deepEqual(visible(openai), ["OPENAI", "OK"]);
	const open = await sd.waitFor((m) => m.event === "openUrl", await tap("cx-status", "codex-status"));
	assert.equal(open.payload.url, "https://status.openai.com");

	const kimi = await imageOf("kimi-status", appear("kimi-status", "kimi-status"), (s) => !s.includes("checking"));
	assert.deepEqual(visible(kimi), ["KIMI CODE", "OK"], "the components of the page's Kimi Code group");
	const api2 = await imageOf("kimi-status", settingsFor("kimi-status", "kimi-status", { component: "api" }), (s) => visible(s).includes("API"));
	assert.deepEqual(visible(api2), ["API", "OUTAGE"]);
});

test("launch keys of Codex and Kimi Code: the app on a Mac, or a command in a terminal", async () => {
	const svg = await imageOf("cx-launch", appear("cx-launch", "codex-launch", { open: "terminal", folder: "~/work", command: "codex" }));
	assert.deepEqual(visible(svg), ["CODEX", ">_", "codex", "work"]);
	let from = await tap("cx-launch", "codex-launch");
	await sd.waitFor((m) => m.event === "showOk" && m.context === "cx-launch", from);
	assert.deepEqual(fs.readFileSync(launched, "utf8").trim().split("\n"), [path.join(home, "work"), "codex"]);

	if (process.platform !== "darwin") return; // opening an app by its bundle id is a Mac's way
	const app = await imageOf("kimi-launch", appear("kimi-launch", "kimi-launch"));
	assert.deepEqual(visible(app), ["KIMI CODE", "Kimi Code", "app"], "a new key opens the app");
	from = await tap("kimi-launch", "kimi-launch");
	await sd.waitFor((m) => m.event === "showOk" && m.context === "kimi-launch", from);
	assert.deepEqual(fs.readFileSync(launched, "utf8").trim().split("\n"), ["app", "com.kimi.code.desktop"]);
});

test("writes a log file inside the plugin folder", () => {
	const log = fs.readFileSync(path.join(pluginDir, "logs", "plugin.log"), "utf8");
	assert.match(log, /connected to Stream Deck/);
	assert.match(log, /scan: .*\.claude\/projects; 1 files/);
	assert.ok(!log.includes("test-token"), "the token is never logged");
	assert.ok(!log.includes(ADMIN_KEY), "nor the Admin key");
	assert.ok(!log.includes(CODEX_TOKEN) && !log.includes("kimi-token"), "nor the logins of Codex and Kimi");
});
