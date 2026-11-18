// Launch keys: one press opens a terminal running Claude Code in the folder of your choice, with the
// default Claude account or another account's profile; or opens Codex or Kimi Code, as an app or in a terminal.
import path from "node:path";
import { launchCommand } from "../launch.js";
import { accountEmail } from "../login.js";
import { logo } from "../render/logos.js";
import { COLORS, esc, header, svg, text, textWidth } from "../render/svg.js";
import { PREFIX, launchProfiles, logoOf, normalizeLogo, pick, tildify } from "./common.js";

/** What each service's launch key starts: a command in a terminal, or (Codex, Kimi Code) its Mac app. */
const TARGETS = {
	claude: { label: "CLAUDE CODE", command: "claude", color: "#d97757" },
	codex: { label: "CODEX", command: "codex", color: COLORS.white, app: { id: "com.openai.codex", name: "Codex" } },
	kimi: { label: "KIMI CODE", command: "kimi", color: "#1783ff", app: { id: "com.kimi.code.desktop", name: "Kimi Code" } },
};

const folderName = (folder) => (folder === "~" || !folder ? "~" : path.basename(folder.replace(/[\\/]+$/, "")) || folder);

/** A gray line that gets smaller when long, and is cut with an ellipsis when even 10 px is too wide. */
function fitted(y, content) {
	let s = content;
	if (textWidth(s, 10) > 132) {
		while (s.length > 1 && textWidth(`${s}…`, 10) > 132) s = s.slice(0, -1);
		s = `${s}…`;
	}
	return text(72, y, Math.min(13, Math.floor(132 / textWidth(s, 1))), COLORS.gray, esc(s));
}

// the terminal a new key opens: Terminal on a Mac, Command Prompt on Windows
const DEFAULT_TERMINAL = process.platform === "win32" ? "cmd" : "terminal";

const launchKey = (id, provider) => {
	const target = TARGETS[provider];
	// a Mac opens the app unless told otherwise; elsewhere there is only the terminal
	const defaultOpen = target.app && process.platform === "darwin" ? "app" : "terminal";
	const settingsFor = (s) => (s.open === "app" && target.app ? { ...s, app: target.app.id } : s);
	return {
		id,
		uuid: `${PREFIX}.${id}`,
		provider,
		styles: [{ id: "prompt", label: "Prompt" }],

		normalize(raw) {
			const s = { folder: "~", command: target.command, terminal: DEFAULT_TERMINAL, account: "", tag: "", open: defaultOpen, ...(raw ?? {}) };
			normalizeLogo(s);
			s.folder = typeof s.folder === "string" && s.folder.trim() ? s.folder.trim() : "~";
			s.command = typeof s.command === "string" && s.command.trim() ? s.command.trim() : target.command;
			s.terminal = pick(s.terminal, ["terminal", "iterm", "cmd", "wt"], DEFAULT_TERMINAL);
			// only Claude Code has accounts (profile folders) to start with
			s.account = provider === "claude" && typeof s.account === "string" ? s.account.trim() : "";
			s.tag = typeof s.tag === "string" ? s.tag.trim().slice(0, 3) : "";
			s.open = target.app ? pick(s.open, ["app", "terminal"], defaultOpen) : "terminal";
			return s;
		},

		needs: () => [],
		refreshSeconds: () => 3600,

		render(ctx) {
			const s = ctx.settings;
			const mark = logoOf(s, provider);
			if (s.open === "app") {
				// the app's own mark, large, is the button
				return svg([header(target.label, { tag: s.tag }), mark ? logo(provider, 48, 44, 48) : text(72, 92, 46, target.color, "▶"), fitted(116, target.app.name), fitted(136, "app")]);
			}
			return svg([header(target.label, { tag: s.tag, logo: mark }), text(72, 92, 46, target.color, "&gt;_"), fitted(116, s.command), fitted(136, folderName(s.folder))]);
		},

		press(ctx) {
			const exec = launchCommand(settingsFor(ctx.settings));
			return exec ? { exec } : "refresh";
		},

		info(ctx) {
			const exec = launchCommand(settingsFor(ctx.settings));
			if (ctx.settings.open === "app") return { info: [["Opens", exec ? `the ${target.app.name} app` : "not on this system: choose Terminal under Open"]] };
			const where = { terminal: "Terminal", iterm: "iTerm", cmd: "Command Prompt", wt: "Windows Terminal" }[ctx.settings.terminal];
			const email = provider === "claude" ? accountEmail(exec?.profile ?? "") : null;
			return {
				info: [
					["Runs", exec ? `${exec.command}` : "not on this system"],
					["In", exec ? tildify(exec.folder) : "—"],
					...(provider === "claude" ? [["Account", `${exec?.profile ? tildify(exec.profile) : "Default (~/.claude)"}${email ? ` · ${email}` : ""}`]] : []),
					["Opens", where],
				],
				...(provider === "claude" ? { accounts: launchProfiles() } : {}),
			};
		},
	};
};

export const launchAction = launchKey("launch", "claude");
export const codexLaunchAction = launchKey("codex-launch", "codex");
export const kimiLaunchAction = launchKey("kimi-launch", "kimi");
