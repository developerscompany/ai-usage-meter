# Security

The plugin reads the logins of Claude Code, Codex and Kimi Code and, if you set them up, a Claude Console Admin API key and a Kimi Code API key. It never writes, refreshes, logs or shares them, and sends each only to the service it belongs to: `api.anthropic.com`, `chatgpt.com`, or Kimi's API (`api.kimi.com` or `api.kimi.ai`).

If you find a way it could leak or misuse any of them, or any other security problem, please email **elgato@rivo.agency** instead of opening a public issue. We'll answer within a few days and credit you in the release notes if you like.

Security fixes go into the latest release only.
