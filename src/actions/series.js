// Token Usage and API Cost keys of Claude Code and Codex: a total for today / 7 days / this month with
// bars per day or hour.
import { formatTokens, formatUsd, joined } from "../format.js";
import { getPeriod } from "../periods.js";
import { PROVIDERS } from "../providers.js";
import { SERIES_STYLES, renderSeries } from "../render/series.js";
import { startOfDay } from "../usage-index.js";
import { PREFIX, clampNumber, clock, currentPeriod, logoOf, nextPeriod, normalizeLogo, normalizePeriods, pick, styleIds, tildify } from "./common.js";

export const TOKEN_COUNTS = {
	all: (t) => t.input + t.output + t.cacheWrite + t.cacheRead,
	"no-cache-read": (t) => t.input + t.output + t.cacheWrite,
	io: (t) => t.input + t.output,
};

const millions = (n) => (n >= 1e8 ? `${Math.round(n / 1e6).toLocaleString("en-US")}M` : `${(n / 1e6).toFixed(n >= 1e6 ? 1 : 2)}M`);
const dollars = (v) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Where a key's numbers come from, for the settings panel; says so when some logs could not be read. */
export function sources(ctx) {
	const index = ctx.usage;
	const scan = index.lastScan;
	const app = index.format?.app ?? "Claude Code";
	return [
		["Sources", index.roots.length ? index.roots.map((r) => tildify(r)).join("\n") : `No ${app} folders found`],
		["Scanned", scan ? `${scan.files.toLocaleString("en-US")} log files at ${clock(scan.at)} in ${scan.ms} ms${scan.errors ? `; ${scan.errors} could not be read` : ""}` : "scanning…"],
		...(scan?.unread ? [["Not read", `${scan.unread.toLocaleString("en-US")} compressed logs (.zst): this version of Stream Deck cannot open them, so the numbers leave out the sessions ${app} has compressed`]] : []),
	];
}

function seriesAction({ id, provider = "claude", defaults, value, format }) {
	const { name } = PROVIDERS[provider];
	return {
		id,
		uuid: `${PREFIX}.${id}`,
		provider,
		styles: SERIES_STYLES,

		normalize(raw) {
			const s = { ...defaults, ...(raw ?? {}) };
			normalizeLogo(s);
			normalizePeriods(s, defaults.periods);
			s.style = pick(s.style, styleIds(SERIES_STYLES), "classic");
			if ("count" in defaults) s.count = pick(s.count, Object.keys(TOKEN_COUNTS), "all");
			s.refresh = clampNumber(s.refresh, 15, 3600, 60);
			return s;
		},

		needs: (s) => [{ kind: "usage", provider, arg: s.paths }],
		refreshSeconds: (s) => s.refresh,

		render(ctx, style = ctx.settings.style) {
			const s = ctx.settings;
			const period = currentPeriod(s, ctx.now);
			const base = { label: period.label, dots: s.periods.length, dot: s.periodIndex, logo: logoOf(s, provider) };
			const index = ctx.usage;
			if (!index.lastScan) return renderSeries(style, { ...base, state: "loading", message: "scanning…" });
			if (ctx.usageError && !index.days.size) return renderSeries(style, { ...base, state: "error", message: "read error" });
			if (!index.roots.length) return renderSeries(style, { ...base, state: "empty", message: `no ${name} logs` });

			const total = value(index.sum(period.days), s);
			const hours = Math.max(1, (ctx.now - startOfDay(ctx.now)) / 3_600_000);
			const rate = period.hourly ? `~${joined(format(total / hours))}/h` : `~${joined(format(total / period.days.length))}/day`;
			const bars = period.slots.map((slot) => ({
				value: value(period.hourly ? index.hour(slot) : index.day(slot), s),
				today: slot === period.today,
				future: slot > period.today,
			}));
			return renderSeries(style, { ...base, value: format(total), rate, bars });
		},

		press: (ctx) => nextPeriod(ctx.settings),

		info(ctx) {
			const s = ctx.settings;
			const index = ctx.usage;
			const periods = s.periods.map((p) => getPeriod(p, s, ctx.now));
			const sums = periods.map((p) => index.sum(p.days));
			const rows = [
				["On key", ...sums.map((t) => joined(format(value(t, s))))],
				["Input", ...sums.map((t) => millions(t.input))],
				["Output", ...sums.map((t) => millions(t.output))],
				["Cache write", ...sums.map((t) => millions(t.cacheWrite))],
				["Cache read", ...sums.map((t) => millions(t.cacheRead))],
				["Requests", ...sums.map((t) => t.requests.toLocaleString("en-US"))],
				["API cost", ...sums.map((t) => dollars(t.cost))],
			];
			return { table: { columns: periods.map((p) => p.label), rows, highlight: 0 }, info: sources(ctx), error: ctx.usageError };
		},
	};
}

const TOKEN_DEFAULTS = { periods: ["week", "month"], weekMode: "rolling", monthMode: "calendar", count: "all", paths: "", refresh: 60, periodIndex: 0, style: "classic" };
const COST_DEFAULTS = { periods: ["today", "week", "month"], weekMode: "rolling", monthMode: "calendar", paths: "", refresh: 60, periodIndex: 0, style: "classic" };

const tokensFor = (id, provider) => seriesAction({ id, provider, defaults: TOKEN_DEFAULTS, value: (t, s) => TOKEN_COUNTS[s.count](t), format: formatTokens });
const costFor = (id, provider) => seriesAction({ id, provider, defaults: COST_DEFAULTS, value: (t) => t.cost, format: formatUsd });

export const tokensAction = tokensFor("usage", "claude");
export const costAction = costFor("cost", "claude");
export const codexTokensAction = tokensFor("codex-usage", "codex");
export const codexCostAction = costFor("codex-cost", "codex");
