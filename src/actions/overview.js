// All Services key: the limits of Claude, Codex and Kimi on one key, a row per service.
import { percentParts } from "../format.js";
import { PROVIDERS, PROVIDER_IDS } from "../providers.js";
import { OVERVIEW_STYLES, renderOverview } from "../render/overview.js";
import { PREFIX, clock, detectProfiles, limitError, normalizeLimitSettings, pick, styleIds } from "./common.js";
import { isStale, longLimit, oldNote } from "./limits.js";

const WINDOWS = ["sevenDay", "fiveHour"];
const DEFAULTS = { style: "bars", show: "left", press: "toggle", account: "", tag: "", warn: 50, danger: 80, refresh: 60, window: "sevenDay", services: PROVIDER_IDS };

/** One service as a row: its two limits, and whether they can still be trusted. */
function rowOf(id, ctx) {
	const svc = ctx.limitsOf[id];
	const now = ctx.now.getTime();
	const known = !!svc?.data;
	const long = known ? longLimit(svc, now) : { window: null, monthly: false };
	return {
		id,
		name: PROVIDERS[id].name,
		five: known ? svc.window("fiveHour", now) : null,
		week: long.window,
		monthly: long.monthly,
		dim: known && !!oldNote(svc, ctx.settings, now, id),
		alert: !!svc?.error && ["signin", "expired", "auth"].includes(svc.error.code),
	};
}

export const overviewAction = {
	id: "overview",
	uuid: `${PREFIX}.overview`,
	styles: OVERVIEW_STYLES,

	normalize(raw) {
		const s = normalizeLimitSettings({ ...DEFAULTS, ...(raw ?? {}) }, OVERVIEW_STYLES);
		// this key can also switch between the weekly and the 5-hour limit on press; it has no page to open
		s.press = pick(raw?.press, ["toggle", "window", "style", "refresh"], "toggle");
		s.window = pick(s.window, WINDOWS, "sevenDay");
		const chosen = Array.isArray(s.services) ? PROVIDER_IDS.filter((id) => s.services.includes(id)) : [];
		s.services = chosen.length ? chosen : [...PROVIDER_IDS];
		return s;
	},

	// only Claude has accounts to choose from
	needs: (s) => s.services.map((provider) => ({ kind: "limits", provider, arg: provider === "claude" ? s.account : "" })),
	refreshSeconds: (s) => s.refresh,

	render(ctx, style = ctx.settings.style) {
		const s = ctx.settings;
		return renderOverview(style, {
			rows: s.services.map((id) => rowOf(id, ctx)),
			window: s.window,
			show: s.show,
			warn: s.warn,
			danger: s.danger,
			now: ctx.now.getTime(),
			marks: s.logo !== "off",
			tag: s.tag,
		});
	},

	press(ctx) {
		const s = ctx.settings;
		if (s.press === "toggle") s.show = s.show === "left" ? "used" : "left";
		else if (s.press === "window") s.window = s.window === "sevenDay" ? "fiveHour" : "sevenDay";
		else if (s.press === "style") {
			const ids = styleIds(OVERVIEW_STYLES);
			s.style = ids[(ids.indexOf(s.style) + 1) % ids.length];
		} else return "refresh";
		return "save";
	},

	info(ctx) {
		const now = ctx.now.getTime();
		const cell = (w) => (w ? `${percentParts(w.used).used}% used` : "—");
		const rows = [];
		const info = [];
		const errors = [];
		for (const id of ctx.settings.services) {
			const svc = ctx.limitsOf[id];
			if (!svc) continue;
			const { name } = PROVIDERS[id];
			const long = svc.data ? longLimit(svc, now) : null;
			rows.push([name, svc.data ? cell(svc.window("fiveHour", now)) : "—", long ? `${cell(long.window)}${long.monthly ? " (monthly)" : ""}` : "—"]);
			const trouble = svc.error ? limitError(id, svc.error.code)[0] : isStale(svc, ctx.settings, now) ? "not current" : "";
			info.push([name, `${svc.fetchedAt ? `updated ${clock(svc.fetchedAt)}` : "no numbers yet"}${trouble ? `, ${trouble}` : ""}`]);
			if (svc.error) errors.push(`${name}: ${svc.error.message}`);
		}
		return { table: { columns: ["5-hour", "Weekly"], rows }, info, error: errors.join("\n") || null, accounts: detectProfiles() };
	},
};
