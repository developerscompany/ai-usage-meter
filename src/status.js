// Service status from the public status pages of Claude (status.claude.com), OpenAI (status.openai.com)
// and Moonshot AI, who make Kimi (status.moonshot.cn). All three speak the Atlassian Statuspage API.
import { testUrl } from "./secrets.js";

export const STATUS_PAGE = "https://status.claude.com";

/** What a Claude key can watch: everything, one component of the status page, or one model family. */
export const COMPONENTS = {
	all: { label: "CLAUDE", match: null },
	code: { label: "CODE", match: /claude code/i },
	app: { label: "CLAUDE.AI", match: /^claude\.ai/i },
	api: { label: "API", match: /claude api/i },
	console: { label: "CONSOLE", match: /console/i },
	cowork: { label: "COWORK", match: /cowork/i },
	fable: { label: "FABLE", model: "Fable" },
	opus: { label: "OPUS", model: "Opus" },
	sonnet: { label: "SONNET", model: "Sonnet" },
	haiku: { label: "HAIKU", model: "Haiku" },
};

/**
 * A status page and what its keys can watch. A scope is everything (`match: null`), the components whose
 * name matches, those of a group of the page (`group`), or a model family named in incidents (`model`).
 * @typedef {{ label: string, match?: RegExp | null, group?: RegExp, model?: string }} Scope
 * @typedef {{ url: string, page: string, watch: string, components: Record<string, Scope>, models?: (text: string) => string[] }} StatusPage
 */

/** @type {Record<string, StatusPage>} */
export const STATUS_PAGES = {
	claude: {
		url: testUrl(process.env.CLAUDE_STATUS_URL) ?? "https://status.claude.com/api/v2/summary.json",
		page: STATUS_PAGE,
		watch: "all",
		components: COMPONENTS,
		models: modelsIn,
	},
	codex: {
		url: testUrl(process.env.OPENAI_STATUS_URL) ?? "https://status.openai.com/api/v2/summary.json",
		page: "https://status.openai.com",
		watch: "codex",
		components: {
			codex: { label: "CODEX", match: /codex/i },
			all: { label: "OPENAI", match: null },
			chatgpt: { label: "CHATGPT", match: /chatgpt|^conversations$|^gpts$/i },
			api: { label: "API", match: /^(responses|chat completions)$/i },
		},
	},
	kimi: {
		url: testUrl(process.env.KIMI_STATUS_URL) ?? "https://status.moonshot.cn/api/v2/summary.json",
		page: "https://status.moonshot.cn",
		watch: "code",
		components: {
			code: { label: "KIMI CODE", group: /^kimi code$/i },
			all: { label: "KIMI", match: null },
			api: { label: "API", match: /^(open api|api service)$/i },
		},
	},
};

// 0 operational, 1 maintenance, 2 degraded, 3 partial outage, 4 major outage
const COMPONENT_LEVEL = { operational: 0, under_maintenance: 1, degraded_performance: 2, partial_outage: 3, major_outage: 4 };
const PAGE_LEVEL = { none: 0, maintenance: 1, minor: 2, major: 3, critical: 4 };
const IMPACT_LEVEL = { none: 0, minor: 2, major: 3, critical: 4 };

// Models as incident titles name them: "Claude Fable 5", "Opus 5.5", and the older "Claude 3.5 Sonnet".
const MODEL_NAME = /\b(Fable|Opus|Sonnet|Haiku)(?:\s+(\d+(?:\.\d+)?)\b)?|\b(\d+(?:\.\d+)?)\s+(Fable|Opus|Sonnet|Haiku)\b/gi;

/** Claude models named in a text, such as ["Fable 5"]; a bare family only when no version of it is named. */
export function modelsIn(text) {
	const found = [];
	for (const m of String(text ?? "").matchAll(MODEL_NAME)) {
		const family = (m[1] ?? m[4]).toLowerCase();
		const version = m[2] ?? m[3];
		found.push(`${family[0].toUpperCase()}${family.slice(1)}${version ? ` ${version}` : ""}`);
	}
	const names = [...new Set(found)];
	return names.filter((name) => name.includes(" ") || !names.some((other) => other.startsWith(`${name} `)));
}

/** A status page component in a few letters: "Claude API (api.anthropic.com)" is "API". */
export function shortService(name) {
	if (/claude code/i.test(name)) return "Claude Code";
	if (/^claude\.ai/i.test(name)) return "claude.ai";
	if (/claude api/i.test(name)) return "API";
	if (/console/i.test(name)) return "Console";
	if (/cowork/i.test(name)) return "Cowork";
	if (/government/i.test(name)) return "Government";
	return String(name);
}

/** @param {StatusPage} [page] whose status this is; Claude's when left out */
export function parseSummary(json, page = STATUS_PAGES.claude) {
	const all = Array.isArray(json?.components) ? json.components : [];
	const groups = new Map(all.filter((c) => c.group).map((c) => [c.id, String(c.name)]));
	const models = page.models ?? (() => []);
	// a link from the page's own data is opened in the browser: only ever an https one
	const link = (url) => (typeof url === "string" && /^https:\/\//i.test(url) ? url : page.page);
	return {
		level: PAGE_LEVEL[json?.status?.indicator] ?? 0,
		description: json?.status?.description ?? "",
		components: all
			.filter((c) => !c.group)
			.map((c) => ({ name: String(c.name), group: groups.get(c.group_id) ?? "", level: COMPONENT_LEVEL[c.status] ?? 0, status: String(c.status) })),
		incidents: (json?.incidents ?? [])
			.filter((i) => i.status !== "resolved" && i.status !== "postmortem")
			.map((i) => {
				const named = models(i.name);
				return {
					name: String(i.name),
					impact: String(i.impact ?? ""),
					status: String(i.status ?? ""),
					url: link(i.shortlink),
					components: (i.components ?? []).map((c) => String(c.name)),
					// the title usually names the model; else the latest update may
					models: named.length ? named : models(i.incident_updates?.[0]?.body),
					updatedAt: Date.parse(i.updated_at ?? "") || 0,
				};
			}),
	};
}

/** The open incident that matters most: the highest impact, then the latest update. */
const worst = (incidents) => [...incidents].sort((a, b) => (IMPACT_LEVEL[b.impact] ?? 0) - (IMPACT_LEVEL[a.impact] ?? 0) || b.updatedAt - a.updatedAt)[0] ?? null;

const scopeOf = (page, componentId) => page.components[componentId] ?? page.components.all;

/**
 * Level, text and the incident behind it, for one key setting.
 * @param {StatusPage} [page] Claude's when left out
 */
export function statusFor(summary, componentId, page = STATUS_PAGES.claude) {
	const scope = scopeOf(page, componentId);
	if (scope.model) {
		const incident = worst(summary.incidents.filter((i) => i.models.some((m) => m.startsWith(scope.model))));
		// an open incident about the model is at least "degraded"
		return { level: incident ? Math.max(2, IMPACT_LEVEL[incident.impact] ?? 0) : 0, text: incident?.name ?? "no open incidents", incident };
	}
	if (!scope.match && !scope.group) return { level: summary.level, text: summary.description, incident: worst(summary.incidents) };
	// the watched components; when several are, the one in most trouble speaks for them
	const watched = summary.components.filter((c) => (scope.group ? scope.group.test(c.group) : scope.match.test(c.name)));
	const found = [...watched].sort((a, b) => b.level - a.level)[0];
	const names = new Set(watched.map((c) => c.name));
	const hits = (name) => (scope.group ? names.has(name) : scope.match.test(name));
	const incident = worst(summary.incidents.filter((i) => !i.components.length || i.components.some(hits)));
	return { level: found?.level ?? 0, text: found ? found.status.replace(/_/g, " ") : "unknown", incident };
}

/** Where an incident stands, in two short lines: "Investigating", "claude.ai +3". */
export function progressOf(incident) {
	const status = incident.status ? `${incident.status[0].toUpperCase()}${incident.status.slice(1)}` : "";
	const [first, ...rest] = incident.components.map(shortService);
	return [status, first ? `${first}${rest.length ? ` +${rest.length}` : ""}` : ""].filter(Boolean);
}

/**
 * What is in trouble, in a few words for the key: the models an incident names ("Fable 5"),
 * else the one service it hits when the key watches everything; "" when neither is known.
 */
export function troubleOf(incident, componentId, page = STATUS_PAGES.claude) {
	if (!incident) return "";
	const scope = scopeOf(page, componentId);
	const models = scope.model ? incident.models.filter((m) => m.startsWith(scope.model)) : incident.models;
	if (models.length) {
		const all = models.join(", ");
		return all.length <= 17 ? all : `${models[0]} +${models.length - 1}`;
	}
	if (!scope.match && !scope.group && !scope.model && incident.components.length === 1) return shortService(incident.components[0]);
	return "";
}

export class StatusService {
	/** @param {{ page?: StatusPage }} [options] page: whose status to ask for; Claude's when left out */
	constructor({ page = STATUS_PAGES.claude, fetchImpl = globalThis.fetch, now = Date.now, log = null } = {}) {
		this.page = page;
		this.fetchImpl = fetchImpl;
		this.now = now;
		this.log = log;
		this.summary = null;
		this.fetchedAt = 0;
		this.error = null;
		this.inflight = null;
	}

	refresh() {
		this.inflight ??= this.fetchNow().finally(() => {
			this.inflight = null;
		});
		return this.inflight;
	}

	async fetchNow() {
		try {
			const res = await this.fetchImpl(this.page.url, { signal: AbortSignal.timeout(10_000) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			this.summary = parseSummary(await res.json(), this.page);
			this.fetchedAt = this.now();
			this.error = null;
		} catch (err) {
			this.error = { code: "network", message: `Status page unavailable: ${err?.message ?? err}` };
		}
	}
}
