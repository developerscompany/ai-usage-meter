// Renders the static PNG images referenced by manifest.json (needs Playwright's Chromium).
// With arguments, only the images whose path contains one of them: `npm run icons -- codex- kimi-`.
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { messageKey } from "../src/render/svg.js";
import { pluginIcon } from "./brand.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(execSync("npm root -g").toString().trim(), "playwright"));

const root = "agency.rivo.usage-meter-for-claude.sdPlugin/imgs";
const W = 'fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';

// Monochrome glyphs (white on transparent) drawn on a 20×20 grid.
const GLYPHS = {
	usage: `<rect x="2.5" y="11" width="4" height="6.5" rx="1" fill="#fff"/><rect x="8" y="7" width="4" height="10.5" rx="1" fill="#fff"/><rect x="13.5" y="2.5" width="4" height="15" rx="1" fill="#fff"/>`,
	cost: `<text x="10" y="16" font-family="Arial" font-weight="bold" font-size="17" text-anchor="middle" fill="#fff">$</text>`,
	limit5h: `<circle cx="10" cy="10" r="7" ${W} stroke-opacity="0.35"/><path d="M10 3 A7 7 0 1 1 3.4 12.4" ${W}/>`,
	limit7d: `<rect x="3" y="4" width="14" height="13" rx="2" ${W}/><path d="M3 8 H17 M7 2.5 V5.5 M13 2.5 V5.5" ${W}/><rect x="6" y="11" width="3" height="3" fill="#fff"/>`,
	limits: `<path d="M3 6.5 H17" ${W} stroke-opacity="0.35"/><path d="M3 6.5 H12" ${W}/><path d="M3 13.5 H17" ${W} stroke-opacity="0.35"/><path d="M3 13.5 H7" ${W}/>`,
	extra: `<circle cx="10" cy="10" r="7.2" ${W}/><path d="M10 6.5 V13.5 M6.5 10 H13.5" ${W}/>`,
	credit: `<rect x="2.5" y="5" width="15" height="11" rx="2.2" ${W}/><path d="M2.5 8.5 H17.5" ${W}/><circle cx="13.5" cy="12.5" r="1.4" fill="#fff"/>`,
	models: `<path d="M10 10 L10 2.8 A7.2 7.2 0 1 1 3.2 12.4 Z" fill="#fff"/><path d="M10 10 L3.2 12.4 A7.2 7.2 0 0 1 10 2.8 Z" fill="#fff" fill-opacity="0.4"/>`,
	context: `<rect x="4" y="2.8" width="12" height="14.4" rx="2" ${W}/><rect x="6.2" y="9" width="7.6" height="6" rx="1" fill="#fff"/>`,
	status: `<path d="M2.5 10.5 H6 L8 5 L11.5 15 L13.5 10.5 H17.5" ${W}/>`,
	peak: `<path d="M2.5 16 L7.5 6.5 L11 12 L13.5 8.5 L17.5 16 Z" ${W}/>`,
	cache: `<path d="M11.2 2 L4.5 11 H9.4 L8.6 18 L15.5 8.6 H10.4 Z" fill="#fff"/>`,
	streak: `<path d="M10 2.2 C10.4 6 14.6 7.6 14.6 12.2 A4.6 4.6 0 0 1 5.4 12.2 C5.4 9.6 6.9 8.4 7.5 6.6 C8.6 8.2 9.6 8.4 10 2.2 Z" fill="#fff"/>`,
	launch: `<rect x="2.5" y="3.5" width="15" height="13" rx="2.2" ${W}/><path d="M5.8 8 L8.6 10.4 L5.8 12.8 M10 13.2 H14" ${W}/>`,
	apicredit: `<rect x="2.5" y="5" width="15" height="11" rx="2.2" ${W}/><path d="M7.6 8.2 L5.6 10.5 L7.6 12.8 M12.4 8.2 L14.4 10.5 L12.4 12.8" ${W}/>`,
	// three services, a bar each
	overview: `<circle cx="4" cy="4.5" r="1.6" fill="#fff"/><path d="M8 4.5 H17" ${W}/><circle cx="4" cy="10" r="1.6" fill="#fff"/><path d="M8 10 H13.5" ${W}/><circle cx="4" cy="15.5" r="1.6" fill="#fff"/><path d="M8 15.5 H15.5" ${W}/>`,
	// a month of days
	month: `<rect x="3" y="4" width="14" height="13" rx="2" ${W}/><path d="M3 8 H17 M7 2.5 V5.5 M13 2.5 V5.5" ${W}/><path d="M6.4 11 H7.6 M9.4 11 H10.6 M12.4 11 H13.6 M6.4 14 H7.6 M9.4 14 H10.6" ${W}/>`,
	// a stack of coins
	coins: `<path d="M4 6 C4 3.6 16 3.6 16 6 C16 8.4 4 8.4 4 6 Z M4 6 V14 C4 16.4 16 16.4 16 14 V6 M4 10 C4 12.4 16 12.4 16 10" ${W}/>`,
};

// The keys of Codex and Kimi Code: the glyph of each (the same as Claude's for the same number), and
// the words on its default image. No third-party logos in the plugin's own images, as Marketplace asks.
const OTHERS = {
	"codex-limit5h": ["limit5h", "5-HOUR", "Codex"],
	"codex-limit7d": ["limit7d", "WEEKLY", "Codex"],
	"codex-limits": ["limits", "LIMITS", "Codex"],
	"codex-credit": ["coins", "CREDITS", "Codex"],
	"codex-usage": ["usage", "TOKENS", "Codex"],
	"codex-cost": ["cost", "API COST", "Codex"],
	"codex-cache": ["cache", "CACHE", "Codex"],
	"codex-models": ["models", "MODELS", "Codex"],
	"codex-status": ["status", "CODEX", "status"],
	"codex-launch": ["launch", "CODEX", "open"],
	"kimi-limit5h": ["limit5h", "5-HOUR", "Kimi"],
	"kimi-limit7d": ["limit7d", "WEEKLY", "Kimi"],
	"kimi-limits": ["limits", "LIMITS", "Kimi"],
	"kimi-month": ["month", "MONTHLY", "Kimi"],
	"kimi-extra": ["extra", "EXTRA", "Kimi"],
	"kimi-status": ["status", "KIMI CODE", "status"],
	"kimi-launch": ["launch", "KIMI CODE", "open"],
	overview: ["overview", "ALL SERVICES", "limits"],
};

const glyph = (name, size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 20 20">${GLYPHS[name]}</svg>`;


const KEY_LABELS = {
	usage: "TOKENS",
	cost: "API COST",
	limit5h: "5-HOUR",
	limit7d: "WEEKLY",
	limits: "LIMITS",
	credit: "CLOUD CREDIT",
	extra: "EXTRA",
	models: "MODELS",
	context: "CONTEXT",
	status: "STATUS",
	peak: "PEAK HOURS",
	cache: "CACHE",
	streak: "STREAK",
	launch: "CLAUDE CODE",
	apicredit: "API CREDIT",
};
const sized = (svg, size) => svg.replace('width="144" height="144"', `width="${size}" height="${size}"`);
const keyImage = (name, size) => sized(messageKey(KEY_LABELS[name], "Claude", { messageColor: "#8e8e93" }), size);

const images = [
	["plugin/icon.png", pluginIcon(256), 256],
	["plugin/icon@2x.png", pluginIcon(512), 512],
	["plugin/category-icon.png", glyph("limit5h", 28), 28],
	["plugin/category-icon@2x.png", glyph("limit5h", 56), 56],
];
for (const name of Object.keys(KEY_LABELS)) {
	images.push([`actions/${name}/icon.png`, glyph(name, 20), 20], [`actions/${name}/icon@2x.png`, glyph(name, 40), 40]);
	images.push([`actions/${name}/key.png`, keyImage(name, 72), 72], [`actions/${name}/key@2x.png`, keyImage(name, 144), 144]);
}
for (const [name, [shape, label, word]] of Object.entries(OTHERS)) {
	const key = (size) => sized(messageKey(label, word, { messageColor: "#8e8e93" }), size);
	images.push([`actions/${name}/icon.png`, glyph(shape, 20), 20], [`actions/${name}/icon@2x.png`, glyph(shape, 40), 40]);
	images.push([`actions/${name}/key.png`, key(72), 72], [`actions/${name}/key@2x.png`, key(144), 144]);
}

const only = process.argv.slice(2);
const wanted = images.filter(([file]) => !only.length || only.some((part) => file.includes(part)));

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, svg, size] of wanted) {
	await page.setViewportSize({ width: size, height: size });
	await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
	const out = path.join(root, file);
	mkdirSync(path.dirname(out), { recursive: true });
	await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
console.log(`wrote ${wanted.length} images`);
