// Care for the secrets the plugin reads (logins, API keys): they are never changed, shown or logged,
// and only ever sent to the service they belong to.

/**
 * A stored secret as one token: the first line of what was stored, or null when it is not something
 * that can go into a request header (a file with stray text in it, say).
 */
export function cleanSecret(text) {
	const line =
		String(text ?? "")
			.split(/\r?\n/)
			.map((l) => l.trim())
			.find(Boolean) ?? "";
	return /^[\x21-\x7e]+$/.test(line) ? line : null;
}

/** An error's text for the log and the settings panel, with the secret taken out should it be in there. */
export function safeMessage(err, secret) {
	const text = String(err?.message ?? err);
	return secret ? text.split(secret).join("…") : text;
}

/**
 * The address a test gave in an environment variable to stand in for a service: one on this computer
 * only, so a variable can never send a login anywhere else.
 */
export function testUrl(value) {
	return typeof value === "string" && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(value) ? value : null;
}
