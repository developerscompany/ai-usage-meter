// The services the keys report on: Claude (Anthropic), Codex (OpenAI) and Kimi Code (Moonshot AI).
import { CODEX_LOGS } from "./codex-logs.js";
import { CODEX_LIMITS } from "./codex.js";
import { KIMI_LIMITS } from "./kimi.js";
import { CLAUDE_LIMITS } from "./limits.js";
import { CLAUDE_LOGS } from "./usage-index.js";

/**
 * @typedef {object} Provider
 * @property {string} id         also the id of its mark in render/logos.js
 * @property {string} name       as keys and the settings panel call it
 * @property {string} app        the program whose login and logs the plugin reads
 * @property {string} todo       what to do about a missing or expired login, in two or three words for a key
 * @property {string} usagePage  where the service shows the same limits
 * @property {import("./limits.js").LimitsSource} limits
 * @property {import("./usage-index.js").LogFormat} [logs]  how the program writes its session logs, where the plugin reads them
 */

/** @type {Record<string, Provider>} */
export const PROVIDERS = {
	claude: { id: "claude", name: "Claude", app: "Claude Code", todo: "run claude", usagePage: "https://claude.ai/settings/usage", limits: CLAUDE_LIMITS, logs: CLAUDE_LOGS },
	codex: { id: "codex", name: "Codex", app: "Codex", todo: "open Codex", usagePage: "https://chatgpt.com/codex/settings/usage", limits: CODEX_LIMITS, logs: CODEX_LOGS },
	kimi: { id: "kimi", name: "Kimi", app: "Kimi Code", todo: "open Kimi Code", usagePage: "https://www.kimi.com/code/console", limits: KIMI_LIMITS },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);
