# StyleLoom

**A video-generation agent that learns from reference footage — then shoots something new in that style.**

![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%201.3%2B-black)
![Runtime deps: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![Status: alpha](https://img.shields.io/badge/status-alpha-orange)

English · [简体中文](README.zh-CN.md)

Most video generators start from a prompt and hope. StyleLoom starts from a reference video you already trust: it cuts the footage into shots, has a vision model annotate every shot frame by frame, distills that into a structured **style bible** (identity, wardrobe, art direction, camera grammar, rhythm, lighting, sound), and then drives MiniMax H3 to generate new shots from those constraints.

Every study session also produces **portable skills** — "how to move the camera", "how to light a rainy street" — stored with evidence and scored only by independent evidence and real human feedback. Over time the agent accumulates craft, not just prompts.

```
reference video ──ffmpeg──▶ shots / keyframes / reference clips
                              │
                              ▼
                   per-shot vision annotation
                   (framing, angle, movement, lighting, subject, action, sound)
                              │
                              ▼
                   LLM distills a "style bible" + reusable style pack
                              │
                              ▼
                   extracts cross-project skills
                   (evidence, feedback, confidence accumulate)
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   stills / looks      shot plan + H3 prompt   reference clips
        └─────────────────────┼─────────────────────┘
                              ▼
                   icompify / MiniMax H3 renders the video
```

## Why another video agent

- **Structured beats similar.** A shot needs executable constraints — identity anchors, wardrobe, set layout, camera move amplitude and speed, light direction. Those go straight into an H3 prompt and stay readable by humans, so you can correct them.
- **Skills need evidence, not vibes.** A skill's confidence comes only from independent project evidence and real feedback. The model never grades its own homework.
- **Money boundaries are explicit.** Building a prompt is free. Rendering requires an explicit `confirmed=true` after you have seen the plan.

## Quick start

Requirements: macOS or Linux (Windows untested), [Bun](https://bun.sh) 1.3+, local `ffmpeg` and `ffprobe`. Xiaohongshu download additionally needs `yt-dlp` (`brew install yt-dlp`).

```bash
git clone <repo-url> styleloom
cd styleloom
bun install
mkdir -p data && cp settings.example.json data/settings.json
# edit data/settings.json — at minimum an LLM endpoint and an icompify key
bun start
# open http://127.0.0.1:8787
```

Prefer the terminal? `bun run chat`.

Sanity check: `bun run typecheck`.

### Configuration

Everything lives in `data/settings.json` (or the in-app **Settings** dialog). `data/` is git-ignored; keys are masked on read and preserved as `********` when the UI saves.

| Field | Purpose |
| --- | --- |
| `llm.baseUrl` / `apiKey` / `model` | Any OpenAI-compatible text endpoint (default: local LiteLLM at `http://localhost:4000/v1`) |
| `llm.visionModel` | Model that accepts images (default `deepseek-v4.1-flash`); Gemini etc. work too |
| `video.baseUrl` / `apiKey` | icompify open platform, default `https://api.icompify.com` |
| `video.model` / `referenceModel` | `minimax-h3-fl2va` (text / first-last frame), `minimax-h3-ref2va` (reference image / video) |
| `image.*` | Optional OpenAI-compatible `/images/generations` or OpenRouter `/images`, for stills. Leave empty to fall back to reference keyframes |
| `xhs.*` | `ytDlpPath`, `cookiesFromBrowser` (chrome / safari / firefox / edge / empty), referer, UA, timeout |
| `ffmpeg.*` | Binary paths, default `ffmpeg` / `ffprobe` |
| `learning.*` | Scene threshold, minimum shot length, max shots, samples per shot, keep clips |

## Using it

1. **Give it material** — a local video path, a Xiaohongshu note link (full URL with `xsec_token` recommended), or just an idea.
   e.g. *"Study the camera work and lighting of `/path/reference.mp4`, then make an 8-second rainy street dialogue shot."*
2. **The agent studies** — Xiaohongshu links are downloaded first (`download_xhs_video`), then `study_reference_video` slices, annotates, distills and extracts skills, streaming progress to the page.
3. **Review the study** — the agent reports characters, locations, camera grammar and rhythm in plain language; ask for corrections and it will call `update_style_bible`.
4. **Generate stills** — `generate_still` for character/location references (falls back to reference keyframes if no image model is configured, and says so).
5. **Plan shots** — `plan_shots`, 4–15 second integers per shot; set `referenceShotIds` when a shot should inherit a reference camera move.
6. **Preview the prompt** — `build_shot_prompt`, free. The mode (T2VA / I2VA / FL2VA / L2VA / Ref2VA) is chosen automatically from available material.
7. **Render** — `generate_shot(confirmed=true)` only after you have seen and approved the plan.
8. **Give feedback** — say "that shot is good / meh / bad"; the agent calls `record_skill_outcome` to update skill confidence.
9. **Compound** — a second reference video hitting the same skill merges evidence; 3 independent projects or 1 positive review promotes a skill to `active`.

## How it works

### 1. Slicing (`src/learn/slice.ts`)

`ffprobe` reads duration, size, fps and audio. Cut points come from `ffmpeg -vf "select='gt(scene,0.32)',metadata=print:file=-"`. Cuts closer than `minShotSeconds` are dropped; beyond `maxShots` the pipeline degrades to equal-length segments (marked with an `ACT:` note). Each shot yields a mid-point `frame.jpg` (960w), three samples at 15/50/85% (640w) for the vision model, a re-encoded `clip.mp4` usable as a Ref2VA reference, plus one `audio.m4a` for the whole film. Written to `learning/slice.json`.

### 2. Annotation (`src/learn/annotate.ts`)

One vision request per shot, multiple images in temporal order, strict JSON in return: framing, angle, movement, lighting, grade, composition, subject, wardrobe, location, action, expression, dialogue, sound, description, `h3ShotBlock`, style tags. With a single frame, `movement` is forced to `unable to determine` so the model cannot invent camera work. Progress is written back per shot, so a failed run resumes where it stopped (`force` re-annotates).

### 3. Distillation (`src/learn/distill.ts`)

Shot annotations are compressed into observation notes, then a text model emits `style` (with a unified `stylePrefix`), `characters`, `locations`, `cameraGrammar`, `rhythm`, `prompting`, `sound`. Referenced shot ids must exist in the manifest; character/location `refImages` are mapped from ids to keyframes, with a weak text match as fallback. If distillation fails, a rule-based version (frequency statistics) takes over so the slicing work is never wasted — the reason lands in `learning.warning`. Outputs `learning/styleBible.json` and `.md`, plus a reusable pack in `data/library/packs/`.

### 4. Skill extraction (`src/learn/skills.ts`)

Turns "what this film looks like" into "what to do next time a shot looks like this". One text call yields 3–8 candidate skills (kind, Chinese rule, English prompt fragment, use/avoid conditions, evidence shots). Candidates are matched against existing skills (tag Jaccard + text Jaccard + fragment Jaccard, threshold 0.52); a match merges evidence and bumps the version, otherwise a new `candidate` is created. Evidence keyframes are copied into `data/skills/<id>/evidence/` so the skill survives project deletion. LLM failure falls back to rule-based extraction; extraction failure never invalidates the study, it only records a warning.

### Skill lifecycle

```
extract ─▶ candidate (confidence ≈ 0.32)
   ├─ matched by a new reference film → evidence +1, confidence up
   ├─ positive review after rendering → active
   ├─ evidence from 3 independent projects → active
   ├─ ≥2 negative and more negative than positive → deprecated
   └─ merge_skills → source deprecated + mergedInto
```

Confidence = base 0.32 + evidence bonus (≤0.25) + feedback bonus (≤0.40) + usage bonus (≤0.08). Model self-assessment never enters the score.

Before planning, the agent calls `search_skills` and then `read_skill`, dropping prompt fragments into the shot plan. `plan_shots` / `generate_shot` record `skillIds`, and `record_skill_outcome` writes the feedback back.

### Generation modes

`prepareReferences` picks a mode by priority:

| Condition | Mode | icompify task / model |
| --- | --- | --- |
| explicit `firstFrame` + `lastFrame` | FL2VA | `fl2va` / `minimax-h3-fl2va` |
| explicit `firstFrame` | I2VA | `fl2va` / `minimax-h3-fl2va` |
| `referenceShotIds` with clips | Ref2VA | `ref2va` / `minimax-h3-ref2va` |
| only character/location stills | I2VA | `fl2va` / `minimax-h3-fl2va` |
| nothing | T2VA | `t2va` / `minimax-h3-fl2va` |

Reference order: characters (`<Subject N>` / `<Picture N>`) → locations (`<Picture N>`) → reference clips (`<Video N>`). Platform limits: 4 images, 3 videos, 4–15 seconds, ≤140MB per asset.

Prompts come from an LLM director call that must follow the official structure; anything missing, misordered, or over 7000 characters falls back to a deterministic skeleton that is valid by construction. `validatePrompt` enforces field presence and order, verbatim alignment sentences, six sections for Ref2VA, and the length cap.

## Cost and safety guards

- `build_shot_prompt`, `plan_shots`, skill operations: **free**.
- `generate_shot`: **billed**, and refuses to run without `confirmed=true`. The agent must show the shot plan and prompt and get explicit consent first.
- `study_reference_video` and `extract_skills` call paid models; progress is streamed so you can watch spend.
- API keys live only in `data/settings.json` (chmod-friendly, git-ignored, masked in API responses). The repo ships a `pre-commit` hook that rejects staged secrets.
- Reference footage is used for **style, camera work and art direction only**. Replicating a real person's identity is not the default; you are responsible for rights if you explicitly ask for it.

## Project layout

```
src/
├── server.ts             Bun HTTP + SSE + static hosting
├── cli.ts                terminal chat
├── config.ts             settings load/save (masking, secret preservation)
├── types.ts              domain models
├── agent/                conversation loop, system prompt, 20 tool handlers
├── learn/                slice → annotate → distill → extract skills → orchestrate
├── generate/             reference decision, H3 prompt, single shot, stills
├── providers/            llm / image / download(xhs) / video(icompify) — protocol only
├── store/                projects, manifests, sessions, style packs, skills
└── util/                 fs and ffmpeg primitives
web/                      dependency-free HTML/CSS/JS front end
docs/                     skills, xhs download, H3 prompting, examples
```

Data on disk (`data/`, ignored by git):

```
data/
├── settings.json                     # keys — never commit
├── cache/xhs/<noteId>-<ts>/          # raw yt-dlp downloads
├── library/packs/<projectId>.json    # reusable style packs
├── skills/<id>/{skill.json,SKILL.md,evidence/}
└── projects/<projectId>/
    ├── project.json  session.json
    ├── learning/{slice.json,styleBible.json,.md,audio.m4a,shots/s01/...}
    └── assets/{sources,stills,videos}/
```

`Project` is the single source of truth: `brief`, `learning`, `styleBible`, `plan[]`, `assets[]`. Shot plans store only `referenceShotIds`, never duplicated clips.

## Status

Verified end to end:

- Local slicing on a 12-second / 3-shot sample: scene detection, keyframes, samples, clips, audio.
- Study pipeline with `deepseek-v4.1-flash`: 3 shots in ~4 minutes, usable characters / locations / camera / lighting / rhythm output.
- Skill library: 7 skills auto-extracted from one study, written to `skill.json` + `SKILL.md` + evidence images; one positive review moved a candidate to `active` (0.39 → 0.79); Chinese lexical search hits.
- Agent tool chain through LiteLLM: `read_learning_shots → update_brief → plan_shots → build_shot_prompt` produced a valid 6309-character Ref2VA prompt.
- Xiaohongshu download with a real note (9.45s, 720×1280, with audio), including short-link/URL/share-text parsing and failure branches.
- Server, SSE, settings API, project file access, skills API, front-end rendering.
- One real billed H3 T2VA render: 9s, 9:16, 768×1344, with audio, ~141s queue+inference; a VLM three-frame check rated it "highly consistent" with minor camera drift and a slight finger/frame fusion.

Not yet verified: real I2VA / FL2VA / Ref2VA renders (request shape mirrors the Toonflow provider; T2VA is proven).

## Limitations

- Shot detection is heuristic: no gradual transitions, and films longer than `learning.maxShots` degrade to equal segments.
- Annotation is serial: ~10–20 minutes for 40 shots. Failures resume from the last completed shot.
- Skills are retrieved lexically, not by embedding.
- Long-form assembly, subtitles and mixing are not implemented — one shot at a time.
- The image provider is text-to-image only; no image editing or reference-image conditioning.
- Applying a style pack copies only referenced images and clips, not the source project's shot plan.
- Xiaohongshu download depends on `yt-dlp` and your own browser session; private, deleted or region-locked notes fail. Reading Safari cookies requires Full Disk Access for the terminal.

## Roadmap

- Parallel shot annotation with a resumable retry queue
- Vector skill retrieval plus feedback-driven rule rewriting
- Timeline editing and whole-film assembly (ffmpeg concat + transitions)
- Reusing reference audio / dialogue-driven lip sync
- Reference-image editing for stronger character consistency
- Style pack browsing, diffing and incremental merge
- Rendered-output QA (first/last frame drift, identity drift, camera amplitude)

## Documentation

- [Skill library](docs/skills.md) — lifecycle, matching, confidence
- [Xiaohongshu download](docs/xhs-download.md) — login state, failure modes
- [H3 prompting](docs/h3-prompting.md) — official prompt structure
- [Architecture](ARCHITECTURE.md) — request lifecycle and design rationale
- Examples: [style bible](docs/examples/style-bible-example.md) · [Ref2VA prompt](docs/examples/ref2va-prompt-example.txt) · [skill](docs/examples/skill-example.md) · [generated shot](docs/examples/generated-shot-example.md)

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) first. Please read [SECURITY.md](SECURITY.md) before reporting anything that looks like a credential leak.

## License

[MIT](LICENSE).

## Disclaimer

This tool is meant for learning *style, camera language and art direction*. Do not use it to impersonate real people, to redistribute other creators' footage, or to bypass paywalls and login walls. Xiaohongshu downloading relies on your own logged-in browser session and does not store cookies; you are responsible for complying with the platform's terms and with local copyright law. Generated content is your responsibility.
