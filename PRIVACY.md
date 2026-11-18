# Privacy

AI Usage Meter is a Stream Deck plugin by Rivo Agency. It runs entirely on your computer.

## What it reads on your computer

- **Your Claude Code login**, from the macOS Keychain or from `~/.claude/.credentials.json`, only to ask Anthropic for your plan's usage limits and credit. It is only read: never refreshed, copied, written to a log, shown in settings or shared.
- **Which account is signed in**, the email in Claude Code's config file (`~/.claude.json`), to label accounts in the settings.
- **Claude Code's logs** (`~/.claude/projects` and `~/.claude-*` profile folders), to count tokens and estimate costs. They never leave your computer.
- **A Claude Console Admin API key**, only if you set up the API Credit key and store the key yourself, in the macOS Keychain or in a file in the plugin's data folder. It is only read.
- **Your Codex login**, from `~/.codex/auth.json`, only if you use a Codex key: to ask OpenAI for your Codex limits and credits. It is only read, like the Claude Code login. The email in it labels the account in the settings.
- **Codex's session logs** (`~/.codex/sessions` and `~/.codex/archived_sessions`), to count tokens and estimate costs. They never leave your computer.
- **Your Kimi Code login**, from `~/.kimi-code/credentials`, or **a Kimi Code API key** you store yourself in the macOS Keychain or in a file in the plugin's data folder, only if you use a Kimi key: to ask Kimi for your plan's limits. Both are only read.

## Where it connects

- **api.anthropic.com**: your plan's usage limits and credit, and, for the API Credit key, your organization's cost report.
- **status.claude.com**: Claude's public service status.
- **chatgpt.com** and **status.openai.com**, only with Codex keys: your Codex limits and credits, and OpenAI's public service status.
- **api.kimi.com** or **api.kimi.ai** (whichever Kimi Code is set up with) and **status.moonshot.cn**, only with Kimi keys: your Kimi plan's limits, and Moonshot AI's public service status.

A login or key is sent only to the service it belongs to, and never follows a redirect to another address.

Nothing else. The plugin has no analytics, no telemetry and no servers of its own, and Rivo Agency receives no data from it.

## What it stores

The latest numbers and a short history for the History display style, in the plugin's data folder: `~/Library/Application Support/agency.rivo.ai-usage-meter` on macOS, `%APPDATA%\agency.rivo.ai-usage-meter` on Windows. Uninstall the plugin and delete that folder to remove them.

## Contact

elgato@rivo.agency
