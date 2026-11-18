// All services on one key: Claude, Codex and Kimi side by side, each with its mark and one limit
// (or both limits as numbers).
import { formatDuration, percentParts } from "../format.js";
import { logo } from "./logos.js";
import { COLORS, arc, bar, esc, levelColor, svg, text, valueWithUnit } from "./svg.js";

export const OVERVIEW_STYLES = [
	{ id: "bars", label: "Bars" },
	{ id: "rings", label: "Rings" },
	{ id: "table", label: "Both limits" },
];

/**
 * @typedef {{ used: number, resetsAt: number | null, reset?: boolean } | null} Window
 * @typedef {object} OverviewRow
 * @property {string} id       the service, also the id of its mark
 * @property {string} name     shown instead of the mark when marks are off
 * @property {Window} five     5-hour window; null when the plan has none or nothing is known yet
 * @property {Window} week     weekly window
 * @property {boolean} [dim]   the numbers are no longer current (an expired login, say)
 * @property {boolean} [alert] the service's login needs attention
 *
 * @typedef {object} OverviewView
 * @property {OverviewRow[]} rows
 * @property {"fiveHour" | "sevenDay"} window   the limit that the bars and rings show
 * @property {"used" | "left"} show
 * @property {number} warn
 * @property {number} danger
 * @property {number} now
 * @property {boolean} [marks]  draw the services' marks (else their names)
 * @property {string} [tag]
 */

function cellOf(w, v) {
	if (!w) return { value: "—", unit: "", fraction: 0, color: COLORS.gray, reset: "" };
	const { used, left } = percentParts(w.used);
	const shown = v.show === "left" ? left : used;
	return { value: String(shown), unit: "%", fraction: shown / 100, color: levelColor(w.used, v.warn, v.danger), reset: w.reset ? "reset" : w.resetsAt ? formatDuration(w.resetsAt - v.now) : "" };
}

/** A service's mark in a `size` square at (x, y), or the first letters of its name when marks are off. */
function lead(row, v, x, y, size) {
	const mark = v.marks === false ? text(x, y + size * 0.78, Math.round(size * 0.62), COLORS.text, esc(row.name.slice(0, 2).toUpperCase()), { anchor: "start" }) : logo(row.id, x, y, size);
	// an orange dot by the mark: this service's login needs attention
	return mark + (row.alert ? `<circle cx="${(x + size).toFixed(1)}" cy="${(y + 1).toFixed(1)}" r="3" fill="${COLORS.orange}"/>` : "");
}

const dimmed = (row, parts) => (row.dim ? `<g opacity="0.35">${parts}</g>` : parts);
// the tag (an account letter, say) rides along with the caption: the corners are taken by numbers
const tagged = (words, v) => (v.tag ? `${words} · ${v.tag}` : words);
const caption = (v) => tagged(`${v.window === "fiveHour" ? "5-HOUR" : "WEEKLY"} · ${v.show}`, v);

const STYLES = {
	bars(v) {
		const h = 42;
		const top = Math.max(2, (128 - v.rows.length * h) / 2);
		const out = v.rows.map((row, i) => {
			const y = top + i * h;
			const c = cellOf(v.window === "fiveHour" ? row.five : row.week, v);
			return (
				lead(row, v, 10, y + 5, 22) +
				dimmed(
					row,
					text(40, y + 20, 12, COLORS.gray, esc(c.reset), { anchor: "start" }) + valueWithUnit(134, y + 22, 24, c.color, c.value, c.unit, { anchor: "end" }) + bar(40, y + 28, 94, 7, c.fraction, c.color),
				)
			);
		});
		out.push(text(72, 140, 11, COLORS.gray, esc(caption(v))));
		return out;
	},

	rings(v) {
		const n = v.rows.length;
		const r = n >= 3 ? 18 : n === 2 ? 24 : 30;
		const mark = n >= 3 ? 16 : n === 2 ? 20 : 26;
		const out = [text(72, 19, 13, COLORS.white, esc(caption(v)))];
		v.rows.forEach((row, i) => {
			const cx = (144 / n) * (i + 0.5);
			const cy = 30 + r + 6;
			const c = cellOf(v.window === "fiveHour" ? row.five : row.week, v);
			out.push(dimmed(row, arc(cx, cy, r, 0, 360, COLORS.track, 6) + arc(cx, cy, r, 0, c.fraction * 360, c.color, 6)));
			out.push(lead(row, v, cx - mark / 2, cy - mark / 2, mark));
			out.push(dimmed(row, valueWithUnit(cx, cy + r + 26, n >= 3 ? 18 : 22, c.color, c.value, c.unit) + text(cx, cy + r + 42, 11, COLORS.gray, esc(c.reset))));
		});
		return out;
	},

	table(v) {
		const h = 38;
		const top = Math.max(26, 26 + (114 - v.rows.length * h) / 2);
		const out = [text(10, 17, 11, COLORS.gray, esc(tagged(v.show, v)), { anchor: "start" }), text(84, 17, 12, COLORS.gray, "5H", { anchor: "end" }), text(134, 17, 12, COLORS.gray, "7D", { anchor: "end" })];
		v.rows.forEach((row, i) => {
			const y = top + i * h;
			const five = cellOf(row.five, v);
			const week = cellOf(row.week, v);
			out.push(lead(row, v, 10, y + 4, 22));
			out.push(dimmed(row, valueWithUnit(84, y + 23, 19, five.color, five.value, five.unit, { anchor: "end" }) + valueWithUnit(134, y + 23, 19, week.color, week.value, week.unit, { anchor: "end" })));
		});
		return out;
	},
};

/** @param {OverviewView} view */
export function renderOverview(style, view) {
	return svg((STYLES[style] ?? STYLES.bars)(view));
}
