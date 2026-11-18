# Changelog

## 3.2.0 — 2026-11-18

- **Codex keys**: 5-hour and weekly limits (and both on one key), credits and limit resets, token usage, API cost at OpenAI's list prices, cache hits, model mix, service status from status.openai.com, and a key that opens Codex.
- **Kimi Code keys**: 5-hour, weekly and monthly limits (5-hour and weekly also on one key), extra usage, service status from status.moonshot.cn, and a key that opens Kimi Code. With a Kimi Code API key in the Keychain the numbers are always current; without one the keys read the 15-minute login of the Kimi Code app.
- **All Services**: Claude, Codex and Kimi on one key, as bars, rings, or both limits as numbers.
- Every key shows the logo of its service before its label; **Logo** in a key's settings turns it off. In Stream Deck's action list every key is named with its service, such as `Claude 5-Hour Limit`.
- Flipping pages, folders or profiles of the Stream Deck no longer asks the APIs again or reads all the logs again: a data source is kept for ten minutes after its last key went away.
- Fixed: Model Mix in the Bars and Stacked styles drew nothing when a model's share was under 1%.
- Fixed: a key set to Auto and a key set to `~/.claude` shared one cache, so one could show the other account's numbers after a restart.
- Fixed: after signing in with another account, the keys kept the earlier login until it expired. A login is now read again every five minutes.
- Fixed: a tag in the corner no longer sits on top of a long label, or of the first number of Both Limits.
- A minor version of Fable or Opus that is newer than the price table takes the family's latest price, not the oldest sibling's.
- Logins and keys are never sent on along a redirect and cannot get into an error message; a key file with stray lines is read by its first line. The environment variables the tests use to stand in for the APIs only accept addresses on this computer.
- After midnight the token keys keep their totals until the new day's are complete; a log file replaced by another under the same name is read from the start; log files that could not be read are named in the key's settings.

## 3.1.1 — 2026-10-28

First public release on GitHub.

- Keys whose numbers are no longer current say so plainly: the numbers are dimmed, and an orange note at the bottom gives the reason, such as `login expired`, or their age, such as `3h old`. Before, only a small ring in the corner showed it.
- The plugin's website and support links point to this repository.

## 3.1.0 — 2026-10-21

- Claude Status names the model in trouble, such as `DEGRADED · Fable 5`, and can watch one model family: Fable, Opus, Sonnet or Haiku. Keys that watch one service count only the incidents that hit it.
- The Details style of Claude Status shows how far the fix is and which services are hit.
- Account pickers show the email signed in to each Claude Code profile, with a step-by-step guide for adding another Claude account.
- Launch Claude Code opens Claude Code with any of your accounts, and takes a tag.
- The Cache Hits ring says "cached", which fits inside the ring.

## 3.0.0 — 2026-10-21

- New name, Usage Meter for Claude, and a new plugin UUID, `agency.rivo.usage-meter-for-claude`. Keys of earlier versions have to be added again once.
- Built on Elgato's Stream Deck SDK; needs Stream Deck 6.9 or later.
- Help links in the settings of every key, and setup steps for the API Credit key on each platform.
- A new plugin icon.

## Before 3.0

Private builds named Rivo Claude Usage: token, cost and limit keys, then Cloud Credit, API Credit, Peak Hours, Cache Hits, Streak, Session Context, Model Mix and Launch Claude Code.
