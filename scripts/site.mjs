// The website (GitHub Pages, served from docs/): one page that shows every key and explains how the plugin
// works. Key images are the real renderers' SVG with sample numbers, written to docs/assets/keys/.
// Run `npm run marketplace` first: the cover and the settings-panel screenshot come from marketplace/.
import fs from "node:fs";
import path from "node:path";
import { DUAL_STYLES } from "../src/render/dual.js";
import { logo } from "../src/render/logos.js";
import { MODEL_STYLES } from "../src/render/models.js";
import { OVERVIEW_STYLES } from "../src/render/overview.js";
import { PERCENT_STYLES, renderPercent } from "../src/render/percent.js";
import { pluginIcon } from "./brand.mjs";
import * as k from "./samples.mjs";

process.env.TZ = "America/New_York";

const OUT = "docs";
const PLUGIN = "agency.rivo.ai-usage-meter";
const SITE = "https://developerscompany.github.io/ai-usage-meter/";
const REPO = "https://github.com/developerscompany/ai-usage-meter";
const DOWNLOAD = `${REPO}/releases/latest/download/${PLUGIN}.streamDeckPlugin`;
const manifest = JSON.parse(fs.readFileSync(`${PLUGIN}.sdPlugin/manifest.json`, "utf8"));
const VERSION = manifest.Version.split(".").slice(0, 3).join(".");
const NAMES = Object.fromEntries(manifest.Actions.map((a) => [a.UUID.split(".").pop(), a.Name]));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

fs.mkdirSync(path.join(OUT, "assets", "keys"), { recursive: true });
// the settings panel as marketplace.mjs captured it; its size goes into the page so nothing jumps while it loads
const panel = fs.readFileSync("marketplace/settings-panel.png");
const PANEL = { width: panel.readUInt32BE(16), height: panel.readUInt32BE(20) };

// ---- key images -----------------------------------------------------------------------------------------

const written = new Set();
/** Writes a key image once and returns the <img> for it. `eager` for what is on screen at once. */
function key(name, svg, alt, { eager = false, size = 144 } = {}) {
	if (!written.has(name)) {
		fs.writeFileSync(path.join(OUT, "assets", "keys", `${name}.svg`), svg);
		written.add(name);
	}
	return `<img class="key" src="assets/keys/${name}.svg" width="${size}" height="${size}" alt="${esc(alt)}"${eager ? "" : ' loading="lazy"'} decoding="async">`;
}

const SAMPLES = Object.fromEntries([...k.claudeKeys(), ...k.codexKeys(), ...k.kimiKeys(), ["overview", k.overviewKey("bars")]]);
const sample = (id, options) => key(id, SAMPLES[id], `${NAMES[id]} key with sample numbers`, options);
const mark = (id, size = 28) => `<svg class="mark" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${logo(id, 0, 0, size)}</svg>`;

// ---- what every key shows, and what a press and a hold do -------------------------------------------------

const SWITCH = "switch left / used";
const KEYS = {
	claude: [
		["limit5h", "The 5-hour session limit: what's left or used, and the time until it resets. Says “not on your plan” on an account without one (verified Ultra accounts).", SWITCH, "refresh"],
		["limit7d", "The weekly limit for all models, or just Fable, Opus, Sonnet or Haiku.", SWITCH, "refresh"],
		["limits", "The 5-hour and the weekly limit on one key.", SWITCH, "refresh"],
		["peak", "Whether it's peak time now (weekdays 5–11 AM Pacific), and when it ends or starts, in your time zone.", "next style", ""],
		["credit", "Dollars left of your plan's cloud session credit, and when it expires.", "switch left / spent", "refresh"],
		["apicredit", "What's left of a Claude Console credit, such as $200 of promotional API credit, after your API spend.", "switch left / spent", "refresh"],
		["extra", "Extra usage spent this month, out of your monthly limit.", "open the usage page", "refresh"],
		["usage", "Claude Code tokens today, over 7 days or this month.", "next period", "rescan"],
		["cost", "What that usage would cost at Anthropic's API list prices.", "next period", "rescan"],
		["cache", "The share of input read from the prompt cache, and what it saved.", "next period", "rescan"],
		["models", "The share of Fable, Opus, Sonnet and Haiku in your usage.", "next period", "rescan"],
		["context", "How full the context of your latest Claude Code sessions is.", "next session", "rescan"],
		["streak", "Days in a row with Claude Code, or the last five weeks as a calendar.", "next style", "rescan"],
		["status", "Service status from status.claude.com, naming the model in trouble, such as DEGRADED · Fable 5.", "open the incident", "refresh"],
		["launch", "Opens a terminal running claude in a folder you choose, with any of your Claude accounts.", "launch", ""],
	],
	codex: [
		["codex-limit5h", "Codex's 5-hour limit on your ChatGPT plan. Says “not on your plan” where the plan only has a weekly one.", SWITCH, "refresh"],
		["codex-limit7d", "Codex's weekly limit.", SWITCH, "refresh"],
		["codex-limits", "Both Codex limits on one key.", SWITCH, "refresh"],
		["codex-credit", "Credits bought on top of the plan, and the limit resets your account can spend.", "open the usage page", "refresh"],
		["codex-usage", "Codex tokens today, over 7 days or this month.", "next period", "rescan"],
		["codex-cost", "What that usage would cost at OpenAI's API list prices.", "next period", "rescan"],
		["codex-cache", "The share of input read from the prompt cache, and what it saved.", "next period", "rescan"],
		["codex-models", "The share of each model family: Sol, Astra, Terra, Luna.", "next period", "rescan"],
		["codex-status", "Codex's status from status.openai.com, or all of OpenAI, ChatGPT or the API.", "open the incident", "refresh"],
		["codex-launch", "Opens the Codex app on a Mac, or a terminal running codex in a folder you choose.", "launch", ""],
	],
	kimi: [
		["kimi-limit5h", "The 5-hour limit of your Kimi Code plan.", SWITCH, "refresh"],
		["kimi-limit7d", "The weekly limit of your Kimi Code plan. Says “not on your plan” where the plan has a 5-hour and a monthly limit only.", SWITCH, "refresh"],
		["kimi-limits", "The 5-hour limit and the weekly one on one key, or the monthly one (MO) on a plan without a weekly limit.", SWITCH, "refresh"],
		["kimi-month", "The monthly limit of your Kimi plan, which Kimi Code shares with Kimi chat.", SWITCH, "refresh"],
		["kimi-extra", "The wallet of extra usage on top of the plan: what is left, or this month's spend against the cap you set.", SWITCH, "refresh"],
		["kimi-status", "Kimi Code's status from status.moonshot.cn, or all of Moonshot AI or the API.", "open the incident", "refresh"],
		["kimi-launch", "Opens the Kimi Code app on a Mac, or a terminal running kimi in a folder you choose.", "launch", ""],
	],
};
const SERVICES = [
	{
		id: "claude",
		name: "Claude",
		needs: `<a href="https://code.claude.com/docs/en/setup">Claude Code</a> signed in with a Pro or Max plan.`,
		gets: ["5-hour and weekly limits, for all models or one", "Cloud credit, Console credit and extra usage", "Tokens, API cost, cache hits and model mix", "Session context, streak, peak hours and status"],
	},
	{
		id: "codex",
		name: "Codex",
		needs: "Codex, the app or the CLI, signed in with a ChatGPT account.",
		gets: ["5-hour and weekly limits of your ChatGPT plan", "Credits and limit resets", "Tokens, API cost, cache hits and model mix", "Status from status.openai.com"],
	},
	{
		id: "kimi",
		name: "Kimi Code",
		needs: `The Kimi Code app signed in, or a Kimi Code API key <a href="#kimi-login">stored for the plugin</a>.`,
		gets: ["5-hour, weekly and monthly limits", "The wallet of extra usage", "Status from status.moonshot.cn", "Token keys are on the way"],
	},
];
const short = (id) => NAMES[id].replace(/^(Claude|Codex|Kimi) /, "");

const keyCard = ([id, shows, press, hold]) => `
				<li class="keycard">
					${sample(id, { size: 96 })}
					<div>
						<h4>${esc(short(id))}</h4>
						<p>${esc(shows)}</p>
						<p class="acts"><span><b>Press</b> ${esc(press)}</span>${hold ? `<span><b>Hold</b> ${esc(hold)}</span>` : ""}</p>
					</div>
				</li>`;

const serviceKeys = ({ id, name }) => `
			<section class="service-keys" aria-labelledby="keys-${id}">
				<h3 id="keys-${id}">${mark(id)} ${esc(name)} <span class="count">${KEYS[id].length} keys</span></h3>
				<ul class="keycards">${KEYS[id].map(keyCard).join("")}
				</ul>
			</section>`;

// ---- sections ---------------------------------------------------------------------------------------------

const COVER = ["overview", "limit5h", "codex-limit7d", "kimi-limit7d", "limit7d", "limits", "codex-credit", "kimi-month", "peak", "credit", "usage", "codex-cost", "models", "status", "codex-launch"];

const styles = [
	...PERCENT_STYLES.map((s, i) => [s.label, key(`style-${s.id}`, renderPercent(s.id, i < 7 ? k.fiveView : k.weekView), `A limit key in the ${s.label} style`, { size: 120 })]),
];
const STYLE_NOTES = {
	Pace: "how fast you're using the limit against an even pace, and “limit in 1h12m” when it won't last",
	History: "your usage over the current window, projected to the reset",
	"Reset timer": "the countdown first, the percentage second",
};

const command = (text) => `<div class="cmd"><pre><code>${esc(text)}</code></pre><button type="button" class="copy" data-copy="${esc(text)}">Copy</button></div>`;

const MESSAGES = [
	["no Claude login / run claude", "No Claude Code login was found for this account."],
	["login expired / run claude", "The login expired: run claude and send any message."],
	["no Codex login / open Codex", "Codex isn't signed in with a ChatGPT account on this computer."],
	["no Kimi login / open Kimi Code", "No Kimi Code login and no stored API key were found."],
	["login expired / open Kimi Code", "The 15-minute login of the Kimi Code app ran out: use Kimi Code, or store an API key."],
	["token refused / login refused", "The service didn't accept the login; the key's settings say more."],
	["rate limited / offline / API error", "A temporary problem; the plugin retries."],
	["not on your plan", "Your plan has no such limit: a separate Haiku limit, say, a 5-hour limit on a verified Ultra account of Claude or on a Codex plan that only has a weekly one, or a weekly limit on a Kimi Code plan that has a monthly one."],
	["only on claude.ai / press to open", "The API didn't send the cloud credit; press to open claude.ai."],
	["no Admin key / see settings", "The API Credit key found no Admin key."],
	["Dimmed numbers, “login expired” below", "The last numbers from before the login expired.", true],
	["Dimmed numbers, “3h old” below", "The plugin couldn't update them for that long; the key's settings say why.", true],
	["A small ring in the top left corner", "The last update failed; the numbers may be a few minutes old.", true],
	["An orange dot by a logo, a dimmed row", "On All Services: that service's login needs attention.", true],
];

const FAQ = [
	["Do I need all three services?", "No. Add the keys of the services you use. The All Services key shows the ones you tick under Services, and a key of a service that isn't set up simply says so."],
	["Is it free?", "Yes. AI Usage Meter is open source under the MIT license. There is no account, no subscription and nothing to pay for."],
	["Does it send my data anywhere?", "No. Everything runs on your computer. The plugin reads the logins your tools already keep, asks each service for your own numbers, and has no analytics, no telemetry and no server of its own."],
	["The Kimi keys say “login expired” most of the time.", "That is the Kimi Code app's 15-minute login running out between your sessions. Store a Kimi Code API key for the plugin and the numbers stay current all the time."],
	["My Codex 5-Hour key says “not on your plan”.", "Some ChatGPT plans give Codex a weekly limit only. Use the Weekly key; the key's settings tell you which limits your plan has."],
	["My Claude 5-Hour key says “not on your plan”.", "Verified Ultra accounts have no 5-hour session limit, only the weekly ones; Pro and Max plans have both. Use the Weekly key."],
	["My Kimi Weekly key says “not on your plan”.", "Some Kimi Code plans have a 5-hour and a monthly limit only. Use the Monthly Limit key; Both Limits and All Services show the monthly limit in the weekly one's place by themselves."],
	["I stored a Kimi API key and the key still shows a message.", "The plugin notices a new key or login within a minute; pressing a key that shows a message asks at once. “login refused” means Kimi did not accept what was stored: store the key again, pasting the key itself when Terminal asks."],
	["The Codex token numbers look too low.", "Codex compresses its older session logs, and the plugin can't open those yet. The key's settings say how many logs were not read."],
	["Do the token keys count other computers or the web apps?", "No, only this computer's logs. The limit keys do count everything: those numbers come from the service itself."],
	["Can I hide the logos?", "Yes, per key: Logo in its settings. The All Services key then shows two letters per service."],
	["How often are the numbers updated?", "Every minute by default (Refresh in the settings); hold a key to update it now. Flipping between pages of your Stream Deck doesn't ask the services again."],
	["Does it work on Windows?", "The code is there and the tests cover it, but it hasn't been tried on a real PC yet. Reports are welcome."],
	["I used Usage Meter for Claude. What changes?", "It is the same plugin under a new name and a new identifier, so Stream Deck installs it next to the old one. Add your keys once from the AI Usage Meter category, then uninstall the old plugin."],
];

const jsonLd = {
	"@context": "https://schema.org",
	"@type": "SoftwareApplication",
	name: "AI Usage Meter",
	description: "A Stream Deck plugin with 33 keys for the plan limits, credits, tokens, costs and status of Claude, Codex and Kimi Code.",
	applicationCategory: "DeveloperApplication",
	operatingSystem: "macOS 12+, Windows 10+",
	softwareVersion: VERSION,
	softwareRequirements: "Elgato Stream Deck 6.9 or later",
	downloadUrl: DOWNLOAD,
	url: SITE,
	image: `${SITE}assets/og.png`,
	license: "https://opensource.org/license/mit",
	offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
	author: { "@type": "Organization", name: "Rivo Agency", url: "https://rivo.agency" },
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Usage Meter: Claude, Codex and Kimi limits on your Stream Deck</title>
<meta name="description" content="A free, open-source Stream Deck plugin. 33 keys show the plan limits, credits, tokens, costs and status of Claude, Codex and Kimi Code. Everything runs on your computer.">
<link rel="canonical" href="${SITE}">
<meta name="theme-color" content="#0b0b0c">
<meta name="color-scheme" content="dark">
<link rel="icon" type="image/svg+xml" href="assets/icon.svg">
<meta property="og:type" content="website">
<meta property="og:title" content="AI Usage Meter: Claude, Codex and Kimi limits on your Stream Deck">
<meta property="og:description" content="33 keys for the plan limits, credits, tokens, costs and status of Claude, Codex and Kimi Code. Free and open source.">
<meta property="og:url" content="${SITE}">
<meta property="og:image" content="${SITE}assets/og.png">
<meta property="og:image:width" content="1920">
<meta property="og:image:height" content="960">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<link rel="stylesheet" href="assets/site.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>

<header class="top">
	<div class="wrap bar">
		<a class="brand" href="#top" aria-label="AI Usage Meter, to the top">${pluginIcon(30)}<span>AI Usage Meter</span></a>
		<nav aria-label="Sections">
			<a href="#services">Services</a>
			<a href="#keys">Keys</a>
			<a href="#styles">Styles</a>
			<a href="#how">How it works</a>
			<a href="#setup">Setup</a>
			<a href="#faq">FAQ</a>
		</nav>
		<div class="bar-actions">
			<a class="ghost" href="${REPO}">GitHub</a>
			<a class="button small" href="${DOWNLOAD}">Download</a>
		</div>
	</div>
</header>

<main id="main">
<section class="hero" id="top">
	<div class="wrap hero-grid">
		<div>
			<p class="eyebrow">Stream Deck plugin · version ${VERSION} · free and open source</p>
			<h1>Your AI coding limits, <em>on your Stream Deck</em></h1>
			<p class="lead">One plugin, 33 keys, three services: Claude, Codex and Kimi Code. See what is left of each plan before you hit a limit, what your work would cost through the API, and whether the service is up.</p>
			<div class="cta">
				<a class="button" href="${DOWNLOAD}">Download for Stream Deck</a>
				<a class="ghost big" href="${REPO}">View on GitHub</a>
			</div>
			<p class="fine">Double-click the file to install. Stream Deck 6.9 or later, macOS 12+ or Windows 10+.</p>
		</div>
		<figure class="device" aria-label="Fifteen of the plugin's keys on a Stream Deck, with sample numbers">
			<div class="device-grid">${COVER.map((id) => key(id, SAMPLES[id], "", { eager: true })).join("")}</div>
		</figure>
	</div>
</section>

<section class="facts" aria-label="At a glance">
	<div class="wrap facts-grid">
		<div><b>33</b><span>keys</span></div>
		<div><b>3</b><span>services</span></div>
		<div><b>10</b><span>display styles</span></div>
		<div><b>0</b><span>data collected</span></div>
	</div>
</section>

<section id="services" class="block">
	<div class="wrap">
		<h2>Three services, <em>one plugin</em></h2>
		<p class="sub">A key works as soon as its service is signed in on the same computer. Nothing is typed into the plugin, and you only need the services you use.</p>
		<div class="cards">
			${SERVICES.map(
				(s) => `<article class="card">
				<h3>${mark(s.id, 32)} ${esc(s.name)}</h3>
				<ul class="ticks">${s.gets.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>
				<p class="needs"><b>Needs</b> ${s.needs}</p>
			</article>`,
			).join("\n\t\t\t")}
		</div>
	</div>
</section>

<section id="all" class="block alt">
	<div class="wrap split">
		<div>
			<h2>All three <em>on one key</em></h2>
			<p class="sub">The All Services key puts Claude, Codex and Kimi side by side, each with its logo. Pick the weekly or the 5-hour limit as bars or rings, or both limits as numbers.</p>
			<ul class="ticks">
				<li>Press to switch between what's left and what's used, or between weekly and 5-hour.</li>
				<li>A service whose plan has no weekly limit shows its monthly one in that place, marked MO.</li>
				<li>An orange dot by a logo means that service's login needs attention.</li>
				<li>A dimmed row has numbers that are no longer current.</li>
				<li>Choose which services the key shows.</li>
			</ul>
		</div>
		<div class="row3">
			${OVERVIEW_STYLES.map((s) => `<figure>${key(`overview-${s.id}`, k.overviewKey(s.id), `The All Services key in the ${s.label} style`)}<figcaption>${esc(s.label)}</figcaption></figure>`).join("\n\t\t\t")}
		</div>
	</div>
</section>

<section id="keys" class="block">
	<div class="wrap">
		<h2>Every key, <em>explained</em></h2>
		<p class="sub">In Stream Deck's action list every key carries its service's name, such as Claude 5-Hour Limit or Codex Weekly Limit. A short press does what is listed here, and most of it can be changed in the key's settings. Holding a key for a moment refreshes it, and a key that has only a message on it asks again when pressed.</p>
		${SERVICES.map(serviceKeys).join("")}
	</div>
</section>

<section id="styles" class="block alt">
	<div class="wrap">
		<h2>Ten display styles, <em>your levels</em></h2>
		<p class="sub">Every limit key can show what's left or what's used, in any of ten styles. Colours go green, then yellow from 50% used, then red from 80%; both levels can be changed per key.</p>
		<ul class="stylegrid">
			${styles.map(([label, img]) => `<li>${img}<b>${esc(label)}</b>${STYLE_NOTES[label] ? `<span>${esc(STYLE_NOTES[label])}</span>` : ""}</li>`).join("\n\t\t\t")}
		</ul>
		<p class="fine center">Both Limits has ${DUAL_STYLES.length} styles, All Services ${OVERVIEW_STYLES.length}, Model Mix ${MODEL_STYLES.length}, and the credit keys eight. Every key shows the logo of its service before its label; Logo in the key's settings turns it off.</p>
	</div>
</section>

<section id="settings" class="block">
	<div class="wrap split">
		<div>
			<h2>Set up <em>in a click</em></h2>
			<p class="sub">Click a key in the Stream Deck app to open its settings.</p>
			<ul class="ticks">
				<li><b>Display style:</b> live previews with your own numbers; click one to use it.</li>
				<li><b>Show</b> what's left or what's used, and choose what a short press does.</li>
				<li><b>Yellow from</b> and <b>Red from:</b> your own warning levels.</li>
				<li><b>Account</b> for Claude keys, with a short tag in the corner to tell two accounts apart.</li>
				<li><b>Logo:</b> with or without the service's logo.</li>
				<li>Under the settings: the current numbers, when they were updated, which login was used (never the login itself), any error in full, and help links.</li>
			</ul>
		</div>
		<figure class="panel"><img src="assets/settings.png" width="${PANEL.width}" height="${PANEL.height}" alt="The settings panel of a 5-Hour Limit key: a grid of ten style previews, then Show, On press, Account, Tag, Yellow from, Red from, Refresh and Logo" loading="lazy" decoding="async"></figure>
	</div>
</section>

<section id="how" class="block alt">
	<div class="wrap">
		<h2>Where the numbers <em>come from</em></h2>
		<p class="sub">There are two kinds of numbers, and it helps to know which is which.</p>
		<div class="cards two">
			<article class="card">
				<h3>For your whole account</h3>
				<p>Limits, credits and extra usage come from the service itself. They include every computer you use and the service's own apps.</p>
				<ul class="reqs">
					<li><b>${mark("claude", 20)} Claude</b><code>GET api.anthropic.com/api/oauth/usage</code><span>The same request as Claude Code's <kbd>/usage</kbd> command, with Claude Code's login.</span></li>
					<li><b>${mark("codex", 20)} Codex</b><code>GET chatgpt.com/backend-api/wham/usage</code><span>The same request as the Codex app's usage panel, with Codex's ChatGPT login.</span></li>
					<li><b>${mark("kimi", 20)} Kimi Code</b><code>GET api.kimi.com/coding/v1/usages</code><span>Or api.kimi.ai, whichever Kimi Code is set up with. The same request as the Kimi Code app, with a stored API key or the app's login.</span></li>
				</ul>
			</article>
			<article class="card">
				<h3>For this computer only</h3>
				<p>Tokens, API cost, cache hits, model mix, session context and streak come from the tool's own session logs. Neither Anthropic nor OpenAI publishes token counts per model for subscription accounts.</p>
				<ul class="ticks">
					<li><b>Claude Code:</b> <code>~/.claude/projects</code> and any <code>~/.claude-*</code> profile folders. Each response is counted once.</li>
					<li><b>Codex:</b> <code>~/.codex/sessions</code> and <code>~/.codex/archived_sessions</code>. Older logs that Codex has compressed can't be opened yet; the key's settings say how many.</li>
					<li><b>Costs</b> use the API list prices of Anthropic and OpenAI, cache writes, cache reads and long context included. They estimate what the same work would cost through the API; they aren't your subscription bill.</li>
				</ul>
			</article>
		</div>
	</div>
</section>

<section id="setup" class="block">
	<div class="wrap">
		<h2>Set up <em>in five minutes</em></h2>
		<ol class="steps">
			<li>
				<h3>Install the plugin</h3>
				<p><a href="${DOWNLOAD}">Download the file</a> and double-click it. Stream Deck installs the plugin; later versions install the same way and keep your keys and their settings.</p>
			</li>
			<li>
				<h3>Add keys</h3>
				<p>In Stream Deck's action list, open the <b>AI Usage Meter</b> category and drag the keys you want onto your Stream Deck. Click a key to choose its display style.</p>
			</li>
			<li>
				<h3>Check the logins of your tools</h3>
				<div class="logins">
					<article>
						<h4>${mark("claude", 22)} Claude</h4>
						<p>The plugin reads the login Claude Code keeps, in the macOS Keychain or in <code>~/.claude/.credentials.json</code>. The first time, macOS may ask to allow it: choose <b>Always Allow</b>. If a key says <code>login expired</code>, run <code>claude</code> and send any message.</p>
						<p>A second Claude account lives in its own profile folder:</p>
						${command("CLAUDE_CONFIG_DIR=~/.claude-work claude")}
						<p>Sign in there, then pick <code>~/.claude-work</code> under <b>Account</b> in the key's settings.</p>
					</article>
					<article>
						<h4>${mark("codex", 22)} Codex</h4>
						<p>Sign in with your ChatGPT account in the Codex app or with <code>codex login</code>. The plugin reads the login Codex keeps in <code>~/.codex/auth.json</code>. It lasts about ten days and Codex renews it whenever it runs.</p>
						<p>A Codex set up with an API key alone has no plan limits to show.</p>
					</article>
					<article id="kimi-login">
						<h4>${mark("kimi", 22)} Kimi Code</h4>
						<p>Best with a Kimi Code API key, which does not expire. Create one in the Kimi Code console and store it in the macOS Keychain; paste the key when asked:</p>
						${command('security add-generic-password -a "$USER" -s "AI Usage Meter Kimi API Key" -w')}
						<p>Without a key, the plugin reads the login of the Kimi Code app. That one lasts 15 minutes and is renewed only while you use Kimi Code, so the keys go stale between your sessions.</p>
					</article>
				</div>
			</li>
		</ol>
		<details class="more">
			<summary>The API Credit key: a Claude Console credit</summary>
			<p>Anthropic has no API for the Console credit balance, so this key takes your API spend since the credit was granted off the amount granted. Create an Admin key in the <a href="https://platform.claude.com/settings/admin-keys">Claude Console</a> and store it in the Keychain:</p>
			${command('security add-generic-password -a "$USER" -s "AI Usage Meter Admin Key" -w')}
			<p>Then enter the credit's amount and dates in the key's settings. An Admin key can administer your organization, so keep it in the Keychain; you can revoke it in the Console at any time.</p>
		</details>
		<details class="more">
			<summary>Coming from Usage Meter for Claude 3.x</summary>
			<p>AI Usage Meter has a new plugin identifier, so Stream Deck installs it next to the old plugin instead of over it. Add your keys once from the new category, then right-click the old plugin in Stream Deck's plugin list and choose Uninstall. An Admin key you stored under the old name is still found.</p>
		</details>
		<p class="fine">On Windows, keys are stored as files instead of in the Keychain. The <a href="${REPO}#setup">README</a> has every step for both systems.</p>
	</div>
</section>

<section id="messages" class="block alt">
	<div class="wrap">
		<h2>What the keys <em>say</em></h2>
		<p class="sub">A key never shows old numbers as if they were new. When something is wrong, it says what, and its settings say why.</p>
		<div class="tablewrap"><table class="messages">
			<thead><tr><th scope="col">On the key</th><th scope="col">Meaning</th></tr></thead>
			<tbody>
				${MESSAGES.map(([m, meaning, look]) => `<tr><th scope="row">${look ? esc(m) : `<code>${esc(m)}</code>`}</th><td>${esc(meaning)}</td></tr>`).join("\n\t\t\t\t")}
			</tbody>
		</table></div>
	</div>
</section>

<section id="privacy" class="block">
	<div class="wrap split">
		<div>
			<h2>Private <em>by design</em></h2>
			<p class="sub">The plugin is a reader. It never changes, refreshes, copies or logs a login.</p>
		</div>
		<ul class="ticks big">
			<li>Everything runs on your computer. No analytics, no telemetry, no server of ours.</li>
			<li>It talks only to the services themselves and their public status pages.</li>
			<li>Each login or key is sent only to the service it belongs to, and never follows a redirect to another address.</li>
			<li>The source is open: read it, build it, change it. <a href="${REPO}/blob/main/PRIVACY.md">Privacy</a> and <a href="${REPO}/blob/main/SECURITY.md">security</a> notes are in the repository.</li>
		</ul>
	</div>
</section>

<section id="faq" class="block alt">
	<div class="wrap narrow">
		<h2>Questions <em>and answers</em></h2>
		${FAQ.map(([q, a]) => `<details class="qa"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("\n\t\t")}
	</div>
</section>

<section class="block final">
	<div class="wrap narrow center">
		<h2>Put your limits <em>where you can see them</em></h2>
		<p class="sub">Free, open source, and installed with a double click.</p>
		<div class="cta center">
			<a class="button" href="${DOWNLOAD}">Download AI Usage Meter ${VERSION}</a>
			<a class="ghost big" href="${REPO}/releases">All releases</a>
		</div>
	</div>
</section>
</main>

<footer class="foot">
	<div class="wrap">
		<p><a href="${REPO}">GitHub</a> · <a href="${REPO}/blob/main/CHANGELOG.md">What's new</a> · <a href="${REPO}/issues">Issues</a> · <a href="${REPO}/blob/main/README.uk.md">Українською</a> · <a href="${REPO}/blob/main/LICENSE">MIT license</a></p>
		<p class="fine">Unofficial plugin by <a href="https://rivo.agency">Rivo Agency</a>. Not affiliated with or endorsed by Anthropic, OpenAI or Moonshot AI. Claude is a trademark of Anthropic, PBC. OpenAI, ChatGPT and Codex are trademarks of OpenAI. Kimi is a trademark of Moonshot AI. Elgato and Stream Deck are trademarks of Corsair Memory, Inc. The logos on the keys only name the service a key shows. All numbers on this page are samples.</p>
	</div>
</footer>

<script>
// Copy buttons of the commands; the page works the same without them.
for (const button of document.querySelectorAll(".copy")) {
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(button.dataset.copy);
			button.textContent = "Copied";
		} catch {
			button.textContent = "Select and copy";
		}
		setTimeout(() => (button.textContent = "Copy"), 2000);
	});
}
</script>
</body>
</html>
`;

const css = `:root {
	--bg: #0b0b0c;
	--bg-alt: #111113;
	--surface: #17171a;
	--border: #2c2c2e;
	--text: #f2f2f7;
	--muted: #a1a1a6;
	--accent: #30d158;
	--accent-ink: #04130a;
	--orange: #ff9f0a;
	--radius: 16px;
	--wrap: 1120px;
	--font: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
	--mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 76px; -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 17px/1.6 var(--font); }
img, svg { max-width: 100%; height: auto; }
a { color: var(--accent); text-underline-offset: 3px; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 6px; }
code { font: 0.88em var(--mono); background: #1f1f23; border: 1px solid var(--border); border-radius: 6px; padding: 0.1em 0.38em; overflow-wrap: anywhere; }
h1, h2, h3, h4 { margin: 0; line-height: 1.12; letter-spacing: -0.02em; }
h1 { font-size: clamp(2.3rem, 5.4vw, 4rem); font-weight: 800; }
h2 { font-size: clamp(1.8rem, 3.6vw, 2.7rem); font-weight: 800; }
h3 { font-size: 1.3rem; font-weight: 700; }
h4 { font-size: 1.05rem; font-weight: 700; letter-spacing: 0; }
h1 em, h2 em { font-style: normal; color: var(--accent); }
p { margin: 0; }
.wrap { width: min(var(--wrap), 100% - 40px); margin-inline: auto; }
.narrow { width: min(780px, 100% - 40px); }
.center { text-align: center; }
.sub { color: var(--muted); font-size: 1.12rem; max-width: 62ch; margin-top: 14px; }
.center .sub, .sub.center { margin-inline: auto; }
.fine { color: var(--muted); font-size: 0.92rem; margin-top: 18px; }
.skip { position: absolute; left: -999px; top: 8px; background: var(--accent); color: var(--accent-ink); padding: 10px 14px; border-radius: 8px; z-index: 100; font-weight: 700; }
.skip:focus { left: 12px; }

/* header */
.top { position: sticky; top: 0; z-index: 40; background: rgba(11, 11, 12, 0.86); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); }
.bar { display: flex; align-items: center; gap: 20px; min-height: 62px; }
.brand { display: flex; align-items: center; gap: 10px; color: var(--text); font-weight: 700; text-decoration: none; white-space: nowrap; }
.brand svg { border-radius: 8px; flex: none; }
.top nav { display: flex; gap: 4px; margin-left: auto; }
.top nav a { color: var(--muted); text-decoration: none; padding: 10px 10px; border-radius: 8px; font-size: 0.95rem; transition: color 0.2s; }
.top nav a:hover { color: var(--text); }
.bar-actions { display: flex; align-items: center; gap: 8px; }
.button { display: inline-flex; align-items: center; justify-content: center; min-height: 52px; padding: 0 26px; border-radius: 14px; background: var(--accent); color: var(--accent-ink); font-weight: 700; text-decoration: none; transition: transform 0.15s ease-out, background 0.2s; }
.button:hover { background: #4ade72; }
.button:active { transform: scale(0.98); }
.button.small { min-height: 44px; padding: 0 16px; border-radius: 11px; font-size: 0.95rem; }
.ghost { display: inline-flex; align-items: center; min-height: 44px; padding: 0 12px; border-radius: 11px; color: var(--text); text-decoration: none; font-weight: 600; font-size: 0.95rem; transition: background 0.2s; }
.ghost:hover { background: #1f1f23; }
.ghost.big { min-height: 52px; padding: 0 22px; border: 1px solid var(--border); border-radius: 14px; font-size: 1rem; justify-content: center; }

/* hero */
.hero { padding: 72px 0 56px; background: radial-gradient(900px 520px at 78% 40%, rgba(48, 209, 88, 0.13), transparent 70%); }
.hero-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr); gap: 56px; align-items: center; }
.eyebrow { color: var(--muted); font-size: 0.92rem; font-weight: 600; margin-bottom: 18px; }
.lead { color: var(--muted); font-size: 1.2rem; margin-top: 20px; max-width: 54ch; }
.cta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 30px; }
.cta.center { justify-content: center; }
.device { margin: 0; padding: clamp(14px, 2.6vw, 28px); border-radius: clamp(22px, 4vw, 40px); border: 1px solid var(--border); background: linear-gradient(180deg, #242427, #17171a); box-shadow: 0 40px 80px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.07); }
.device-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: clamp(8px, 1.5vw, 16px); }
.key { display: block; border-radius: 18%; background: #000; box-shadow: 0 0 0 2px #000, 0 0 0 3px var(--border); }
.device .key { width: 100%; }

/* facts */
.facts { border-block: 1px solid var(--border); background: var(--bg-alt); }
.facts-grid { display: grid; grid-template-columns: repeat(4, 1fr); padding-block: 26px; text-align: center; }
.facts-grid b { display: block; font-size: 2.2rem; font-weight: 800; line-height: 1.1; color: var(--accent); font-variant-numeric: tabular-nums; }
.facts-grid span { color: var(--muted); font-size: 0.95rem; }

/* blocks */
.block { padding: 88px 0; }
.block.alt { background: var(--bg-alt); border-block: 1px solid var(--border); }
.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 56px; align-items: center; }
.cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; margin-top: 40px; }
.cards.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 26px; }
.card h3 { display: flex; align-items: center; gap: 12px; }
.card > p { color: var(--muted); margin-top: 12px; }
.mark { flex: none; }
.ticks { list-style: none; padding: 0; margin: 18px 0 0; display: grid; gap: 10px; }
.ticks li { position: relative; padding-left: 26px; color: #d7d7dc; }
.ticks li::before { content: ""; position: absolute; left: 2px; top: 0.62em; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
.ticks.big { font-size: 1.08rem; gap: 16px; margin: 0; }
.needs { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.95rem; }
.needs b { color: var(--text); margin-right: 6px; }
.row3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
.row3 figure, .stylegrid li { margin: 0; text-align: center; }
.row3 .key { width: 100%; }
figcaption { color: var(--muted); font-size: 0.92rem; margin-top: 10px; }

/* keys */
.service-keys { margin-top: 56px; }
.service-keys h3 { display: flex; align-items: center; gap: 12px; font-size: 1.5rem; }
.count { color: var(--muted); font-size: 0.95rem; font-weight: 500; letter-spacing: 0; margin-left: 4px; }
.keycards { list-style: none; padding: 0; margin: 22px 0 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; }
.keycard { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 18px; align-items: start; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
.keycard p { color: var(--muted); font-size: 0.95rem; line-height: 1.5; margin-top: 6px; }
.keycard .acts { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 10px; font-size: 0.86rem; }
.acts b { color: var(--text); font-weight: 600; margin-right: 4px; }

/* styles */
.stylegrid { list-style: none; padding: 0; margin: 40px 0 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 26px 18px; }
.stylegrid .key { margin-inline: auto; }
.stylegrid b { display: block; margin-top: 12px; }
.stylegrid span { display: block; color: var(--muted); font-size: 0.86rem; line-height: 1.45; margin-top: 4px; }

/* settings panel */
.panel { margin: 0; max-height: 700px; overflow: hidden; border-radius: 20px; border: 1px solid var(--border); background: #2d2d2d; box-shadow: 0 30px 70px rgba(0, 0, 0, 0.55); position: relative; }
.panel img { display: block; width: 100%; }
.panel::after { content: ""; position: absolute; inset: auto 0 0; height: 110px; background: linear-gradient(rgba(45, 45, 45, 0), #2d2d2d 85%); }

/* the three requests */
.reqs { list-style: none; padding: 0; margin: 18px 0 0; display: grid; gap: 14px; }
.reqs li { display: grid; gap: 6px; padding: 14px; background: #131315; border: 1px solid var(--border); border-radius: 12px; }
.reqs b { display: flex; align-items: center; gap: 8px; }
.reqs code { justify-self: start; font-size: 0.84rem; }
.reqs span { color: var(--muted); font-size: 0.93rem; line-height: 1.5; }
kbd { font: 0.88em var(--mono); }

/* tables */
.tablewrap { overflow-x: auto; margin-top: 18px; border: 1px solid var(--border); border-radius: 12px; }
table { border-collapse: collapse; width: 100%; font-size: 0.95rem; }
th, td { text-align: left; vertical-align: top; padding: 12px 14px; border-bottom: 1px solid var(--border); }
tbody tr:last-child > * { border-bottom: 0; }
thead th { color: var(--muted); font-weight: 600; font-size: 0.86rem; background: #131315; }
tbody th { font-weight: 600; white-space: nowrap; }
td { color: #d7d7dc; }
.messages { margin-top: 0; }
.messages tbody th { white-space: normal; width: 40%; }
#messages .tablewrap { margin-top: 36px; background: var(--surface); }

/* setup */
.steps { list-style: none; counter-reset: step; padding: 0; margin: 40px 0 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
.steps > li { counter-increment: step; position: relative; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 26px 26px 26px 84px; }
.steps > li::before { content: counter(step); position: absolute; left: 26px; top: 24px; width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center; background: var(--accent); color: var(--accent-ink); font-weight: 800; }
.steps > li > p { color: var(--muted); margin-top: 8px; max-width: 70ch; }
.logins { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-top: 18px; }
.logins article { background: #131315; border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
.logins h4 { display: flex; align-items: center; gap: 10px; }
.logins p { color: var(--muted); font-size: 0.95rem; line-height: 1.55; margin-top: 10px; }
.cmd { position: relative; margin-top: 12px; }
.cmd pre { margin: 0; padding: 14px 14px 62px; background: #0b0b0c; border: 1px solid var(--border); border-radius: 10px; overflow-x: auto; }
.cmd code { background: none; border: 0; padding: 0; font-size: 0.86rem; color: #d7f5df; white-space: pre-wrap; overflow-wrap: anywhere; }
.copy { position: absolute; right: 8px; bottom: 8px; min-height: 44px; padding: 0 16px; border-radius: 8px; border: 1px solid var(--border); background: #1f1f23; color: var(--text); font: 600 0.82rem var(--font); cursor: pointer; transition: background 0.2s; }
.copy:hover { background: #2a2a2f; }
.more, .qa { margin-top: 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
.more summary, .qa summary { cursor: pointer; padding: 16px 20px; font-weight: 600; min-height: 44px; list-style-position: outside; margin-left: 18px; }
.more > *:not(summary), .qa > *:not(summary) { padding: 0 20px 16px; color: var(--muted); }
.more .cmd { margin: 0 20px 14px; padding: 0; }
.qa:first-of-type { margin-top: 36px; }
#setup .more:first-of-type { margin-top: 22px; }

/* final + footer */
.final { background: radial-gradient(700px 360px at 50% 60%, rgba(48, 209, 88, 0.14), transparent 70%); }
.foot { border-top: 1px solid var(--border); padding: 36px 0 48px; color: var(--muted); font-size: 0.95rem; }
.foot a { color: var(--text); }

@media (max-width: 1024px) {
	.top nav { display: none; }
	.bar-actions { margin-left: auto; }
	.hero-grid, .split { grid-template-columns: minmax(0, 1fr); gap: 40px; }
	.hero { padding: 48px 0 40px; }
	.cards, .cards.two, .logins { grid-template-columns: minmax(0, 1fr); }
	.stylegrid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
	.block { padding: 64px 0; }
	.panel { max-height: 520px; max-width: 520px; }
}
@media (max-width: 640px) {
	body { font-size: 16px; }
	.wrap, .narrow { width: calc(100% - 32px); }
	.facts-grid { grid-template-columns: repeat(2, 1fr); gap: 18px 0; }
	.stylegrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	.keycards { grid-template-columns: minmax(0, 1fr); }
	.keycard { grid-template-columns: 80px minmax(0, 1fr); gap: 14px; }
	.keycard .key { width: 80px; height: 80px; }
	.steps > li { padding: 70px 18px 20px; }
	.steps > li::before { left: 18px; top: 18px; }
	.cta .button, .cta .ghost.big { width: 100%; }
	.brand span { display: none; }
	.messages tbody th { width: 46%; }
}
@media (prefers-reduced-motion: reduce) {
	html { scroll-behavior: auto; }
	* { transition: none !important; }
}
`;

// ---- write --------------------------------------------------------------------------------------------------

fs.writeFileSync(path.join(OUT, "index.html"), html);
fs.writeFileSync(path.join(OUT, "assets", "site.css"), css);
fs.writeFileSync(path.join(OUT, "assets", "icon.svg"), pluginIcon(256));
fs.copyFileSync("marketplace/thumbnail.png", path.join(OUT, "assets", "og.png"));
fs.writeFileSync(path.join(OUT, "assets", "settings.png"), panel);
// GitHub Pages serves the folder as it is, without Jekyll
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");
fs.writeFileSync(path.join(OUT, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}sitemap.xml\n`);
fs.writeFileSync(path.join(OUT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n\t<url><loc>${SITE}</loc></url>\n</urlset>\n`);
console.log(`wrote ${OUT}/index.html (${(html.length / 1024).toFixed(0)} KB), ${written.size} key images`);
