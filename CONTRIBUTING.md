# Contributing to StyleLoom

Thanks for taking a look. This project is small on purpose: no bundler, no runtime dependencies, no test framework. Keep it that way unless there is a strong reason.

## Before you start

- Read [AGENTS.md](AGENTS.md) and [ARCHITECTURE.md](ARCHITECTURE.md). They hold the conventions the codebase actually follows.
- For anything beyond a typo, open an issue first so we can agree on scope.
- Never commit real API keys. `data/` is git-ignored and a `pre-commit` hook rejects secret patterns and any `data/` path.

## Development setup

```bash
git clone <repo-url> styleloom
cd styleloom
bun install
mkdir -p data && cp settings.example.json data/settings.json
bun run typecheck
git config core.hooksPath .githooks   # 启用密钥/数据守卫钩子
bun start          # http://127.0.0.1:8787
```

`bun run chat` runs the terminal client. You need `ffmpeg` / `ffprobe` on `PATH`; `yt-dlp` is only required for the Xiaohongshu downloader.

## Conventions

- Bun + TypeScript, ES modules, **zero runtime dependencies**. Do not add one without discussing it.
- Chinese for comments, commit messages and user-facing copy; camelCase for variables, functions and file names.
- Double quotes, semicolons, two-space indentation.
- File access goes through `src/util/fs.ts`; ffmpeg through `src/util/ffmpeg.ts`; model calls through `src/providers/`.
- Paths stored in project state are **project-relative POSIX paths**, read and written through `safeJoin`.
- Overwrites use atomic helpers (`writeJson` / `writeText`).
- Mark deliberate simplifications and known ceilings with `ACT:` comments.
- `web/` talks to the backend only through `/api`, `/files` and `/skill-files`.

## Adding a tool

1. Add a `toolSpecs` entry and a handler in `src/agent/tools.ts`.
2. Any billed or slow operation takes `confirmed` and emits progress events.
3. Update the workflow section of `src/agent/prompt.ts` — otherwise the model will never call it correctly.
4. Give billed / download / skill tools a failure message and a recovery path.
5. Update `README.md`, `README.zh-CN.md`, `ARCHITECTURE.md` and the relevant `docs/*.md`.

## Checking your change

There is no test suite. Verify honestly and say what you ran:

1. `bun run typecheck`
2. Start the server and exercise the affected path over HTTP/SSE.
3. For slicing / annotation / skill changes, smoke test with a 10–20 second clip containing at least two cuts. Keep annotation cost small.
4. For the Xiaohongshu downloader, an invalid note id is enough to cover the error branch. Real notes need a link from the user.
5. Do **not** run a real H3 render without explicit approval — it is a billed operation.

## Pull requests

- One concern per PR. Describe the behaviour change, how you verified it, and any cost implications.
- Do not reformat unrelated files, and do not commit anything from `data/`.
- If you add a user-facing string, add it to both READMEs where relevant.
- By contributing you agree your work is licensed under [MIT](LICENSE).
