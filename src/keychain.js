// Runs macOS's /usr/bin/security to read one secret from the Keychain. The plugin only ever reads.
// USAGE_METER_KEYCHAIN=off turns the Keychain off, so the tests never touch the real one.
import { execFile } from "node:child_process";

/**
 * @param {string[]} args e.g. ["find-generic-password", "-w", "-s", "AI Usage Meter Admin Key"]
 * @returns {Promise<string | null>} what the command printed, or null when there is no such item
 */
export function runSecurity(args) {
	if (process.env.USAGE_METER_KEYCHAIN === "off") return Promise.resolve(null);
	return new Promise((resolve) => {
		execFile("/usr/bin/security", args, { timeout: 5000 }, (err, stdout) => resolve(err ? null : String(stdout)));
	});
}
