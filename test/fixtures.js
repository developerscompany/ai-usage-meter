// Builders for Claude Code transcript lines, shaped like real ~/.claude/projects/*.jsonl entries, and
// for Codex session logs and logins, shaped like the real ones in ~/.codex.
import crypto from "node:crypto";

const id = (prefix) => `${prefix}_${crypto.randomBytes(12).toString("hex")}`;

export function usage({ input = 0, output = 0, cacheWrite = 0, cacheRead = 0 } = {}) {
	return {
		input_tokens: input,
		cache_creation_input_tokens: cacheWrite,
		cache_read_input_tokens: cacheRead,
		output_tokens: output,
		service_tier: "standard",
		cache_creation: { ephemeral_1h_input_tokens: cacheWrite, ephemeral_5m_input_tokens: 0 },
	};
}

export const SESSION_ID = "11111111-1111-4111-8111-111111111111";

/** One API response, logged as one line per content block like Claude Code does. */
export function assistantLines({ at, tokens, blocks = ["thinking", "text", "tool_use"], messageId = id("msg"), requestId = id("req"), text = "ok", sessionId = SESSION_ID, model = "claude-opus-5-5", cwd = "/Users/nick/project" }) {
	return blocks.map((type) =>
		JSON.stringify({
			parentUuid: crypto.randomUUID(),
			isSidechain: false,
			userType: "external",
			cwd,
			sessionId,
			version: "2.1.42",
			gitBranch: "main",
			message: {
				id: messageId,
				type: "message",
				role: "assistant",
				model,
				content: [type === "tool_use" ? { type, id: id("toolu"), name: "Bash", input: { command: "ls" } } : { type, text }],
				stop_reason: null,
				stop_sequence: null,
				usage: usage(tokens),
			},
			requestId,
			type: "assistant",
			uuid: crypto.randomUUID(),
			timestamp: new Date(at).toISOString(),
		}),
	);
}

/** A sub-agent's tool result: carries a usage summary that must not be counted. */
export function taskResultLine({ at, tokens }) {
	return JSON.stringify({
		parentUuid: crypto.randomUUID(),
		type: "user",
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: id("toolu"), content: "done" }] },
		toolUseResult: { status: "completed", totalTokens: 999, usage: usage(tokens) },
		uuid: crypto.randomUUID(),
		timestamp: new Date(at).toISOString(),
	});
}

export function userLine({ at, text = "hello" }) {
	return JSON.stringify({ type: "user", message: { role: "user", content: text }, uuid: crypto.randomUUID(), timestamp: new Date(at).toISOString() });
}

/** A JWT like those in Codex's auth.json: the plugin only reads the expiry and the email from the payload. */
export function jwt(payload) {
	const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
	return `${part({ alg: "RS256", typ: "JWT" })}.${part(payload)}.signature`;
}

/**
 * A Codex session log (rollout): the model in a turn_context line, then for every response its
 * token_usage_record and the token_count event Codex writes right after, with the session's running total.
 * `records: false` gives the log of a Codex from before those records.
 */
export function codexLines({ at, model = "gpt-6.1-sol", responses, records = true, threadId = crypto.randomUUID() }) {
	const timestamp = new Date(at).toISOString();
	const line = (ordinal, type, payload) => JSON.stringify({ timestamp, ordinal, type, payload });
	const lines = [line(0, "session_meta", { id: threadId, cwd: "/Users/nick/project", originator: "Codex Desktop" }), line(1, "turn_context", { turn_id: "t1", cwd: "/Users/nick/project", model })];
	const total = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
	responses.forEach((usage, i) => {
		for (const k of Object.keys(total)) total[k] += usage[k] ?? 0;
		if (records) lines.push(line(2 + 2 * i, "token_usage_record", { thread_id: threadId, turn_id: "t1", response_id: id("resp"), usage, turn_token_usage: usage, thread_token_usage: { ...total } }));
		lines.push(
			line(3 + 2 * i, "event_msg", {
				type: "token_count",
				info: { total_token_usage: { ...total }, last_token_usage: usage, model_context_window: 475_000 },
				rate_limits: { limit_id: "codex", primary: { used_percent: 9, window_minutes: 300, resets_at: 1 }, plan_type: "team" },
			}),
		);
	});
	return lines;
}
