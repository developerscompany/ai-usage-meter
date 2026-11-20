// Plan limit keys of Claude, Codex and Kimi: 5-hour, weekly (for Claude also per model), both on one key,
// and what each service has besides: Claude's credit balance and extra usage, Codex's credits, Kimi's
// monthly limit and its wallet of extra usage.
import path from "node:path";
import { formatAge, formatDuration, formatMoney, formatUsd, joined, percentParts } from "../format.js";
import { KIMI_KEY_FILE, KIMI_KEY_SERVICE } from "../kimi.js";
import { WINDOW_MS, dataDir } from "../limits.js";
import { accountEmail } from "../login.js";
import { PROVIDERS } from "../providers.js";
import { DUAL_STYLES, renderDual } from "../render/dual.js";
import { PERCENT_STYLES, renderPercent } from "../render/percent.js";
import { COLORS, messageKey } from "../render/svg.js";
import { PREFIX, clock, detectProfiles, limitError, limitPress, logoOf, monthDay, normalizeLimitSettings, pick, when } from "./common.js";

const WINDOW_TITLES = [
	["fiveHour", "5-hour"],
	["sevenDay", "Weekly"],
	["fable", "Weekly Fable"],
	["opus", "Weekly Opus"],
	["sonnet", "Weekly Sonnet"],
	["haiku", "Weekly Haiku"],
];

/** Key shown while there are no numbers yet. */
function waiting(label, svc, s, provider) {
	const mark = logoOf(s, provider);
	if (svc.error) {
		const [message, detail] = limitError(provider, svc.error.code);
		return messageKey(label, message, { big: "!", color: COLORS.orange, tag: s.tag, logo: mark, detail });
	}
	return messageKey(label, "loading…", { tag: s.tag, logo: mark, messageColor: COLORS.gray });
}

export const isStale = (svc, s, now) => !!svc.error || svc.stale(s.refresh, now);

// A login problem makes the numbers useless at once; other trouble only once they are a while old.
const LOGIN_ERRORS = ["signin", "expired", "auth"];
const OLD_AFTER_MS = 15 * 60_000;

/** What a key with numbers that are no longer current says across its bottom, or "" while they are. */
export function oldNote(svc, s, now, provider) {
	if (!isStale(svc, s, now)) return "";
	if (LOGIN_ERRORS.includes(svc.error?.code)) return limitError(provider, svc.error.code)[0];
	const age = now - svc.fetchedAt;
	return svc.fetchedAt && age >= OLD_AFTER_MS ? `${formatAge(age)} old` : "";
}

/** What the image of every limit key needs besides its numbers. */
const frame = (svc, s, now, provider) => ({
	now,
	warn: s.warn,
	danger: s.danger,
	tag: s.tag,
	logo: logoOf(s, provider),
	stale: isStale(svc, s, now),
	old: oldNote(svc, s, now, provider),
});

/**
 * The long limit of a service, beside its 5-hour one: the weekly limit, or the monthly one on a plan that
 * has no weekly limit (Kimi Code has such plans).
 * @returns {{ window: { used: number, resetsAt: number | null, reset?: boolean } | null, monthly: boolean }}
 */
export function longLimit(svc, now) {
	const week = svc.window("sevenDay", now);
	if (week) return { window: week, monthly: false };
	const month = svc.window("month", now);
	return { window: month, monthly: !!month };
}

const validity = (login, now) => (!login.expiresAt ? "no expiry" : login.expiresAt > now ? `valid for ${formatDuration(login.expiresAt - now)}` : `expired ${formatAge(now - login.expiresAt)} ago`);

const resetText = (w, now) => (w.resetsAt ? `in ${formatDuration(w.resetsAt - now)} · ${when(w.resetsAt, now)}` : w.reset ? "reset" : "not started");

/** A limit window as a row of the settings panel's table. */
function windowRow(title, w, now) {
	const { used, left } = percentParts(w.used);
	return [title, `${used}% used · ${left}% left`, resetText(w, now)];
}

/** The login the numbers were asked with, and other logins found, never the logins themselves. */
function loginRows(login, now) {
	const others = login ? login.logins.filter((l) => l.source !== login.source) : [];
	return [
		["Login", login ? `${login.source}, ${validity(login, now)}` : "not found"],
		...(others.length ? [["Also found", others.map((l) => `${l.source}, ${validity(l, now)}`).join("\n")]] : []),
	];
}

function claudeInfo(ctx) {
	const svc = ctx.limits;
	const now = ctx.now.getTime();
	const rows = [];
	for (const [name, title] of WINDOW_TITLES) {
		const w = svc.window(name, now);
		if (w) rows.push(windowRow(title, w, now));
	}
	for (const m of svc.data?.modelLimits ?? []) {
		const family = ["Fable", "Opus", "Sonnet", "Haiku"].find((f) => m.name.toLowerCase().includes(f.toLowerCase()));
		if (family && rows.some((r) => r[0] === `Weekly ${family}`)) continue; // listed above already
		rows.push([`Weekly ${m.name}`, `${percentParts(m.used).used}% used`, m.resetsAt ? `in ${formatDuration(m.resetsAt - now)} · ${when(m.resetsAt, now)}` : ""]);
	}
	const credit = svc.data?.credit;
	if (credit) {
		const amount = credit.limit !== null ? `${formatMoney(Math.max(0, credit.remaining ?? 0))} of ${formatMoney(credit.limit)} left` : `${percentParts(credit.used).left}% left`;
		rows.push([credit.label ?? "Credit", amount, credit.resetsAt ? `${credit.recurring ? "resets" : "expires"} ${when(credit.resetsAt, now)}` : ""]);
	}
	const code = svc.data?.codeCredit;
	if (code) rows.push(["Claude Code and Cowork credit", `${percentParts(code.used).used}% used`, code.resetsAt ? `expires ${when(code.resetsAt, now)}` : ""]);
	const extra = svc.data?.extra;
	if (extra?.enabled) {
		rows.push(["Extra usage", extra.limit === null ? `${formatMoney(extra.spent ?? 0)} spent` : `${formatMoney(extra.spent ?? 0)} of ${formatMoney(extra.limit)}`, "1st of next month"]);
	}
	const login = svc.loginInfo();
	return {
		table: rows.length ? { columns: ["Now", "Resets"], rows } : null,
		info: [
			["Updated", svc.fetchedAt ? clock(svc.fetchedAt) : "not yet"],
			["Account", ctx.settings.account || "Auto (freshest login)"],
			...(login?.dir && accountEmail(login.dir) ? [["Signed in as", accountEmail(login.dir)]] : []),
			...loginRows(login, now),
		],
		error: svc.error?.message ?? null,
		note: svc.data && !svc.data.fiveHour && svc.data.sevenDay ? "Anthropic sends no 5-hour limit for this account (verified Ultra accounts have none), so a 5-Hour key has nothing to show." : undefined,
		accounts: detectProfiles(),
	};
}

/** Credits as Codex counts them: whole, or with one decimal while they are few. */
const creditCount = (n) => (Number.isInteger(n) || n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(1));

function codexInfo(ctx) {
	const svc = ctx.limits;
	const data = svc.data;
	const now = ctx.now.getTime();
	const rows = [];
	const pair = (prefix, name) => {
		for (const [key, title] of [["fiveHour", "5-hour"], ["sevenDay", "Weekly"]]) {
			const w = name === null ? svc.window(key, now) : name[key];
			if (w) rows.push(windowRow(prefix ? `${prefix}, ${title.toLowerCase()}` : title, w, now));
		}
	};
	pair("", null);
	if (data?.codeReview) pair("Code review", data.codeReview);
	for (const limit of data?.more ?? []) pair(limit.name, limit);
	if (data?.credits) {
		const c = data.credits;
		rows.push(["Credits", c.unlimited ? "unlimited" : creditCount(c.balance ?? 0), data.resets ? `${data.resets} limit reset${data.resets === 1 ? "" : "s"} to spend` : ""]);
	}
	const login = svc.loginInfo();
	return {
		table: rows.length ? { columns: ["Now", "Resets"], rows } : null,
		info: [
			["Updated", svc.fetchedAt ? clock(svc.fetchedAt) : "not yet"],
			...(data?.plan ? [["Plan", data.plan.replace(/_/g, " ")]] : []),
			...(login?.email ? [["Signed in as", login.email]] : []),
			...loginRows(login, now),
		],
		error: svc.error?.message ?? null,
		note: data && !data.fiveHour && data.sevenDay ? "Your Codex plan has a weekly limit only, so a 5-Hour key has nothing to show." : undefined,
	};
}

/** How to give the plugin a Kimi Code API key on this computer, in short steps. */
function kimiKeySteps(platform = process.platform) {
	const store =
		platform === "darwin"
			? `2. In Terminal, run the line below and paste the key when asked:\nsecurity add-generic-password -a "$USER" -s "${KIMI_KEY_SERVICE}" -w`
			: `2. Save the key as the only line of this file:\n${path.join(dataDir(), KIMI_KEY_FILE)}`;
	return [
		"The login of the Kimi Code app lasts 15 minutes, and Kimi Code renews it only while you use it. With an API key the numbers stay current all the time:",
		"1. In the Kimi Code console, create an API key (link below).",
		store,
		"The plugin only reads the key, and sends it only to Kimi's API.",
	].join("\n");
}

function kimiInfo(ctx) {
	const svc = ctx.limits;
	const data = svc.data;
	const now = ctx.now.getTime();
	const rows = [];
	for (const [name, title] of [["fiveHour", "5-hour"], ["sevenDay", "Weekly"], ["month", "Monthly"]]) {
		const w = svc.window(name, now);
		if (w) rows.push(windowRow(title, w, now));
	}
	if (data?.month && data.monthCode) rows.push(["Monthly, coding part", `${percentParts(data.monthCode.used).used}% used`, ""]);
	const e = data?.extra;
	if (e) {
		const money = moneyIn(e.currency);
		rows.push(["Extra usage", `${money(e.left)} of ${money(e.total)} left`, e.capped && e.cap > 0 ? `${money(e.spent)} of ${money(e.cap)} this month` : ""]);
	}
	const login = svc.loginInfo();
	const notes = [
		data && !data.sevenDay && data.month ? "Your Kimi Code plan has no weekly limit: a Weekly key has nothing to show. The Kimi Monthly Limit key shows the limit your plan has instead." : "",
		// the steps matter until a key is stored
		login?.kind === "key" ? "" : kimiKeySteps(),
	].filter(Boolean);
	return {
		table: rows.length ? { columns: ["Now", "Resets"], rows } : null,
		info: [
			["Updated", svc.fetchedAt ? clock(svc.fetchedAt) : "not yet"],
			...(login?.kind === "key" ? [["Login", `API key, ${login.source}`]] : loginRows(login, now)),
			...(login?.host ? [["Asks", login.host]] : []),
		],
		error: svc.error?.message ?? null,
		note: notes.join("\n\n") || undefined,
		// Kimi has one console for mainland China and one for elsewhere
		links: [["Kimi Code console", pageOf("kimi", svc)]],
	};
}

const INFO = { claude: claudeInfo, codex: codexInfo, kimi: kimiInfo };

/** Where the service shows the same limits; Kimi has one site for mainland China and one for elsewhere. */
function pageOf(provider, svc) {
	if (provider === "kimi" && svc?.loginInfo()?.host === "api.kimi.ai") return "https://www.kimi.ai/code/console";
	return PROVIDERS[provider].usagePage;
}

const LIMIT_DEFAULTS = { style: "ring", show: "left", press: "toggle", account: "", tag: "", warn: 50, danger: 80, refresh: 60 };

/** Settings of a limit key; only Claude has accounts to choose from. */
function limitSettings(raw, styles, provider, defaults = LIMIT_DEFAULTS) {
	const s = normalizeLimitSettings({ ...defaults, ...(raw ?? {}) }, styles);
	if (provider !== "claude") s.account = "";
	return s;
}

const needsLimits = (provider) => (s) => [{ kind: "limits", provider, arg: s.account }];

function limitAction({ id, provider = "claude", defaults = LIMIT_DEFAULTS, windowOf, labelOf, normalizeMore }) {
	return {
		id,
		uuid: `${PREFIX}.${id}`,
		provider,
		styles: PERCENT_STYLES,
		normalize(raw) {
			const s = limitSettings(raw, PERCENT_STYLES, provider, defaults);
			normalizeMore?.(s);
			return s;
		},
		needs: needsLimits(provider),
		refreshSeconds: (s) => s.refresh,

		render(ctx, style = ctx.settings.style) {
			const s = ctx.settings;
			const svc = ctx.limits;
			const label = labelOf(s);
			if (!svc.data) return waiting(label, svc, s, provider);
			const name = windowOf(s);
			const now = ctx.now.getTime();
			const w = svc.window(name, now);
			if (!w) return messageKey(label, "not on your plan", { big: "—", tag: s.tag, logo: logoOf(s, provider), messageColor: COLORS.gray });
			return renderPercent(style, {
				...frame(svc, s, now, provider),
				label,
				used: w.used,
				show: s.show,
				resetsAt: w.resetsAt,
				reset: w.reset,
				windowMs: w.windowMs ?? WINDOW_MS[name],
				series: svc.series(name),
			});
		},

		press: (ctx) => limitPress(ctx.settings, PERCENT_STYLES, pageOf(provider, ctx.limits)),
		info: INFO[provider],
	};
}

function bothAction({ id, provider }) {
	return {
		id,
		uuid: `${PREFIX}.${id}`,
		provider,
		styles: DUAL_STYLES,
		normalize: (raw) => limitSettings(raw, DUAL_STYLES, provider, { ...LIMIT_DEFAULTS, style: "bars" }),
		needs: needsLimits(provider),
		refreshSeconds: (s) => s.refresh,

		render(ctx, style = ctx.settings.style) {
			const s = ctx.settings;
			const svc = ctx.limits;
			if (!svc.data) return waiting("LIMITS", svc, s, provider);
			const now = ctx.now.getTime();
			const long = longLimit(svc, now);
			return renderDual(style, { ...frame(svc, s, now, provider), five: svc.window("fiveHour", now), week: long.window, labels: long.monthly ? ["5H", "MO"] : undefined, show: s.show });
		},

		press: (ctx) => limitPress(ctx.settings, DUAL_STYLES, pageOf(provider, ctx.limits)),
		info: INFO[provider],
	};
}

export const fiveHourAction = limitAction({ id: "limit5h", windowOf: () => "fiveHour", labelOf: () => "5-HOUR" });

const SCOPES = {
	all: { window: "sevenDay", label: "WEEKLY" },
	fable: { window: "fable", label: "FABLE 7D" },
	opus: { window: "opus", label: "OPUS 7D" },
	sonnet: { window: "sonnet", label: "SONNET 7D" },
	haiku: { window: "haiku", label: "HAIKU 7D" },
};

export const weeklyAction = limitAction({
	id: "limit7d",
	defaults: { ...LIMIT_DEFAULTS, scope: "all" },
	windowOf: (s) => SCOPES[s.scope].window,
	labelOf: (s) => SCOPES[s.scope].label,
	normalizeMore: (s) => {
		s.scope = pick(s.scope, Object.keys(SCOPES), "all");
	},
});

export const bothLimitsAction = bothAction({ id: "limits", provider: "claude" });

const EXTRA_STYLES = PERCENT_STYLES.filter((st) => st.id !== "history");

export const extraAction = {
	id: "extra",
	uuid: `${PREFIX}.extra`,
	provider: "claude",
	styles: EXTRA_STYLES,
	normalize: (raw) => normalizeLimitSettings({ ...LIMIT_DEFAULTS, show: "used", press: "open", ...(raw ?? {}) }, EXTRA_STYLES),
	needs: needsLimits("claude"),
	refreshSeconds: (s) => s.refresh,

	render(ctx, style = ctx.settings.style) {
		const s = ctx.settings;
		const svc = ctx.limits;
		if (!svc.data) return waiting("EXTRA", svc, s, "claude");
		const e = svc.data.extra;
		if (!e?.enabled) return messageKey("EXTRA", "not enabled", { big: "OFF", tag: s.tag, logo: logoOf(s, "claude"), messageColor: COLORS.gray });
		const d = ctx.now;
		const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
		const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
		const spent = e.spent ?? 0;
		const common = { ...frame(svc, s, d.getTime(), "claude"), label: "EXTRA", resetsAt: nextMonth, windowMs: nextMonth - monthStart };
		if (e.limit === null) {
			return renderPercent(style, { ...common, used: 0, show: "used", display: { value: joined(formatUsd(spent)), unit: "", caption: "spent" }, footer: "no limit" });
		}
		const used = e.used ?? (e.limit > 0 ? (spent / e.limit) * 100 : 0);
		return renderPercent(style, { ...common, used, show: s.show, footer: `${formatMoney(spent)} / ${formatMoney(e.limit)}` });
	},

	press: (ctx) => limitPress(ctx.settings, EXTRA_STYLES),
	info: claudeInfo,
};

const CREDIT_STYLES = PERCENT_STYLES.filter((st) => st.id !== "history" && st.id !== "pace");

/** The cloud session credit in dollars, or the Claude Code and Cowork credit (a percentage) when chosen. */
function pickCredit(data, which) {
	if (which === "code") return data?.codeCredit ? { kind: "percent", ...data.codeCredit } : null;
	return data?.credit ? { kind: "dollars", ...data.credit } : null;
}

const NO_CREDIT_NOTE =
	"Anthropic's usage API does not send your cloud session credit, so the key cannot read it. claude.ai shows it in Settings → Usage: press the key to open that page. The key shows the credit by itself as soon as the API sends it.";
const CODE_CREDIT_SENT = " The API does send a Claude Code and Cowork credit, as a percentage: choose it under Credit to show that one.";
const NO_CODE_CREDIT_NOTE = "Anthropic's usage API does not send a Claude Code and Cowork credit for this account.";

function creditInfo(ctx) {
	const out = claudeInfo(ctx);
	const data = ctx.limits.data;
	if (!data) return out;
	out.info.push(["API fields", data.fields?.length ? data.fields.join(", ") : "—"]);
	if (!pickCredit(data, ctx.settings.which)) {
		out.note = ctx.settings.which === "code" ? NO_CODE_CREDIT_NOTE : NO_CREDIT_NOTE + (data.codeCredit ? CODE_CREDIT_SENT : "");
	}
	return out;
}

export const creditAction = {
	id: "credit",
	uuid: `${PREFIX}.credit`,
	provider: "claude",
	styles: CREDIT_STYLES,
	normalize(raw) {
		const s = normalizeLimitSettings({ ...LIMIT_DEFAULTS, which: "cloud", ...(raw ?? {}) }, CREDIT_STYLES);
		// "auto" from 2.2.0 showed the percentage credit when there was no dollar one, which read as money
		s.which = pick(s.which, ["cloud", "code"], "cloud");
		return s;
	},
	needs: needsLimits("claude"),
	refreshSeconds: (s) => s.refresh,

	render(ctx, style = ctx.settings.style) {
		const s = ctx.settings;
		const svc = ctx.limits;
		const code = s.which === "code";
		const label = code ? "CODE CREDIT" : "CLOUD CREDIT";
		const mark = logoOf(s, "claude");
		if (!svc.data) return waiting(label, svc, s, "claude");
		const c = pickCredit(svc.data, s.which);
		if (!c && code) return messageKey(label, "none", { big: "—", tag: s.tag, logo: mark, messageColor: COLORS.gray, detail: "on this account" });
		if (!c) return messageKey(label, "only on claude.ai", { big: "—", tag: s.tag, logo: mark, messageColor: COLORS.gray, detail: "press to open" });
		const now = ctx.now.getTime();
		// numbers fetched before the credit ran out or renewed
		const over = c.resetsAt !== null && now >= c.resetsAt;
		const used = !over ? c.used : c.recurring ? 0 : 100;
		let date = "";
		if (c.resetsAt && code) date = `${over ? "ended" : "until"} ${monthDay(c.resetsAt)}`;
		else if (c.resetsAt) date = `${over ? (c.recurring ? "reset" : "expired") : c.recurring ? "resets" : "exp"} ${monthDay(c.resetsAt)}`;
		const common = {
			...frame(svc, s, now, "claude"),
			label,
			used,
			show: s.show,
			resetsAt: over ? null : c.resetsAt,
			windowMs: 30 * 86_400_000,
			footer: date,
			until: code ? "until it ends" : c.recurring ? "until reset" : "until it expires",
		};
		if (c.kind === "dollars" && c.limit !== null) {
			// an expired credit is gone, a renewed one is full again
			const [left, spent] = !over ? [c.remaining, c.spent] : c.recurring ? [c.limit, 0] : [0, c.spent];
			return renderPercent(style, {
				...common,
				display: { value: formatMoney(Math.max(0, s.show === "left" ? left : spent)), unit: "", caption: s.show === "left" ? "left" : "spent" },
				footer: [`of ${formatMoney(c.limit)}`, date].filter(Boolean).join(" · "),
			});
		}
		return renderPercent(style, common);
	},

	press(ctx) {
		// nothing to switch: open the page that shows the credit
		if (ctx.limits.data && !pickCredit(ctx.limits.data, ctx.settings.which)) return { url: PROVIDERS.claude.usagePage };
		return limitPress(ctx.settings, CREDIT_STYLES);
	},
	info: creditInfo,
};

// Codex

const codexFiveHourAction = limitAction({ id: "codex-limit5h", provider: "codex", windowOf: () => "fiveHour", labelOf: () => "5-HOUR" });
const codexWeeklyAction = limitAction({ id: "codex-limit7d", provider: "codex", windowOf: () => "sevenDay", labelOf: () => "WEEKLY" });
const codexBothAction = bothAction({ id: "codex-limits", provider: "codex" });

const NUMBER_ONLY = PERCENT_STYLES.filter((st) => st.id === "number");

/** Credits bought on top of a ChatGPT plan, and the "limit resets" an account can spend. */
const codexCreditAction = {
	id: "codex-credit",
	uuid: `${PREFIX}.codex-credit`,
	provider: "codex",
	styles: NUMBER_ONLY,
	normalize(raw) {
		const s = limitSettings(raw, NUMBER_ONLY, "codex", { ...LIMIT_DEFAULTS, press: "open" });
		s.press = pick(s.press, ["refresh", "open"], "open");
		return s;
	},
	needs: needsLimits("codex"),
	refreshSeconds: (s) => s.refresh,

	render(ctx) {
		const s = ctx.settings;
		const svc = ctx.limits;
		if (!svc.data) return waiting("CREDITS", svc, s, "codex");
		const c = svc.data.credits;
		if (!c) return messageKey("CREDITS", "none", { big: "—", tag: s.tag, logo: logoOf(s, "codex"), messageColor: COLORS.gray, detail: "on this account" });
		const resets = svc.data.resets;
		const balance = c.balance ?? 0;
		return renderPercent("number", {
			...frame(svc, s, ctx.now.getTime(), "codex"),
			label: "CREDITS",
			used: 0,
			show: "left",
			// no credits is the usual state of a plan, not an alarm
			display: { value: c.unlimited ? "∞" : creditCount(balance), unit: "", caption: c.unlimited ? "unlimited" : "left", color: c.unlimited || balance > 0 ? COLORS.green : COLORS.gray },
			footer: resets ? `${resets} limit reset${resets === 1 ? "" : "s"}` : "",
			resetsAt: null,
			windowMs: 1,
		});
	},

	press: (ctx) => limitPress(ctx.settings, NUMBER_ONLY, PROVIDERS.codex.usagePage),
	info: codexInfo,
};

export const CODEX_LIMIT_ACTIONS = [codexFiveHourAction, codexWeeklyAction, codexBothAction, codexCreditAction];

// Kimi

const kimiFiveHourAction = limitAction({ id: "kimi-limit5h", provider: "kimi", windowOf: () => "fiveHour", labelOf: () => "5-HOUR" });
const kimiWeeklyAction = limitAction({ id: "kimi-limit7d", provider: "kimi", windowOf: () => "sevenDay", labelOf: () => "WEEKLY" });
const kimiMonthAction = limitAction({ id: "kimi-month", provider: "kimi", windowOf: () => "month", labelOf: () => "MONTHLY" });
const kimiBothAction = bothAction({ id: "kimi-limits", provider: "kimi" });

/** Dollar amounts, or yuan for an account in mainland China. */
function moneyIn(currency) {
	if (currency === "USD") return formatMoney;
	return (v) => (currency === "CNY" ? formatMoney(v).replace("$", "¥") : `${formatMoney(v).replace("$", "")} ${currency}`);
}

// the wallet has no reset to count down to or pace against
const WALLET_STYLES = PERCENT_STYLES.filter((st) => !["history", "pace", "countdown"].includes(st.id));

/** Kimi's wallet of extra usage ("booster"): what is left of it, or the month's spend against a cap the user set. */
const kimiExtraAction = {
	id: "kimi-extra",
	uuid: `${PREFIX}.kimi-extra`,
	provider: "kimi",
	styles: WALLET_STYLES,
	normalize: (raw) => limitSettings(raw, WALLET_STYLES, "kimi"),
	needs: needsLimits("kimi"),
	refreshSeconds: (s) => s.refresh,

	render(ctx, style = ctx.settings.style) {
		const s = ctx.settings;
		const svc = ctx.limits;
		if (!svc.data) return waiting("EXTRA", svc, s, "kimi");
		const e = svc.data.extra;
		if (!e) return messageKey("EXTRA", "not enabled", { big: "OFF", tag: s.tag, logo: logoOf(s, "kimi"), messageColor: COLORS.gray });
		const money = moneyIn(e.currency);
		const common = { ...frame(svc, s, ctx.now.getTime(), "kimi"), label: "EXTRA", show: s.show, resetsAt: null, windowMs: 1 };
		if (e.capped && e.cap > 0) return renderPercent(style, { ...common, used: (e.spent / e.cap) * 100, footer: `${money(e.spent)} / ${money(e.cap)}` });
		const spent = Math.max(0, e.total - e.left);
		return renderPercent(style, {
			...common,
			used: e.total > 0 ? (spent / e.total) * 100 : 0,
			display: { value: money(s.show === "left" ? e.left : spent), unit: "", caption: s.show === "left" ? "left" : "spent" },
			footer: `of ${money(e.total)}`,
		});
	},

	press: (ctx) => limitPress(ctx.settings, WALLET_STYLES, pageOf("kimi", ctx.limits)),
	info: kimiInfo,
};

export const KIMI_LIMIT_ACTIONS = [kimiFiveHourAction, kimiWeeklyAction, kimiBothAction, kimiMonthAction, kimiExtraAction];
