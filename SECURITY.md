# Security Policy

## Reporting a vulnerability

Do **not** open a public issue for anything that could expose credentials or allow remote code execution.

Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. If that is unavailable, contact the maintainer directly and mention "StyleLoom security" in the subject.

Please include: affected file or tool, reproduction steps, and what an attacker gains. Expect a first response within a few days. This is a spare-time project, so timelines are best effort.

## Scope and threat model

StyleLoom is a **local-first tool**. It binds to `127.0.0.1` by default and assumes a single trusted user on that machine.

In scope:

- Path traversal through `/files/:projectId/*`, `/skill-files/:id/*`, or `safeJoin` bypasses.
- Command injection through ffmpeg / yt-dlp invocation.
- Credential leakage: API keys printed to logs, returned by an API, embedded in SSE events, or written into project assets.
- Prompt-injection paths where model output reaches the filesystem or shell.

Out of scope:

- Anyone with local access to `data/settings.json` — it stores keys in plaintext by design, readable only by your user (`chmod` it if you like).
- Exposing the server to the public internet. If you do, put an authenticating reverse proxy in front; there is no application login.
- Issues in third-party models, the icompify platform, or `yt-dlp`.

## Handling keys

- Keys live only in `data/settings.json`, which is git-ignored. `data/` is excluded wholesale.
- The API masks keys as `********` and preserves them when the UI saves settings.
- `.githooks/pre-commit` rejects staged secrets and any `data/` path. Enable it with `git config core.hooksPath .githooks`.
- If a key ever reaches a commit or a public issue, **rotate it first**, then clean history. Treat the repository as compromised for that key.

## Supported versions

The project is pre-1.0; only `main` receives fixes.
