import { join } from "node:path";
import type { Project, ShotPlan, SliceShot } from "../types";
import { chatJson } from "../providers/llm";
import { extractFrame, probeMedia } from "../util/ffmpeg";
import { ensureDir, exists, nowIso, safeJoin, toProjectPath } from "../util/fs";
import { getManifest, projectDir } from "../store/projects";

export type VerificationDifference = {
  aspect: string;
  detail: string;
  severity: "minor" | "major";
};

export type ShotVerification = NonNullable<ShotPlan["verification"]>;

const ASPECTS = new Set([
  "framing",
  "shotSize",
  "camera",
  "lighting",
  "color",
  "subject",
  "wardrobe",
  "text",
]);

const systemPrompt = `You compare a REFERENCE shot (images first) with a GENERATED shot (images after).
Return strict JSON only:
{"differences":[{"aspect":"framing"|"shotSize"|"camera"|"lighting"|"color"|"subject"|"wardrobe"|"text","detail":"concrete visible difference with location or time","severity":"minor"|"major"}],"summary":"one short sentence"}
Rules:
- Reference frames come first; generated frames come after. Do not reverse them.
- Only report visible differences. detail must point to a place (e.g. upper-left, start/mid/end) or concrete trait.
- Do not invent a fidelity percentage or score.
- Style borrowing is allowed: do not treat different person identity as a defect unless wardrobe/framing clearly diverges.
- If nearly identical, return differences: [] with a brief summary.`;

function sampleFractions(duration: number) {
  if (duration < 1) return [0.5];
  return [0, 0.5, 1];
}

function normalizeDifferences(raw: unknown): VerificationDifference[] {
  if (!Array.isArray(raw)) return [];
  const out: VerificationDifference[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const aspect = typeof row.aspect === "string" ? row.aspect.trim() : "";
    const detail = typeof row.detail === "string" ? row.detail.trim() : "";
    const severity = row.severity === "major" ? "major" : row.severity === "minor" ? "minor" : "";
    if (!aspect || !detail || !severity) continue;
    out.push({
      aspect: ASPECTS.has(aspect) ? aspect : aspect.slice(0, 40),
      detail: detail.slice(0, 400),
      severity,
    });
  }
  return out;
}

async function resolveReferenceShot(project: Project, shot: ShotPlan): Promise<SliceShot> {
  const manifest = await getManifest(project);
  if (!manifest?.shots.length) throw new Error("当前项目还没有参考片切片，无法对照校验");
  const preferredId = shot.referenceShotIds?.[0];
  const ref = (preferredId && manifest.shots.find(item => item.id === preferredId))
    || manifest.shots.find(item => item.id === shot.id)
    || manifest.shots[Math.min(Math.max(shot.index - 1, 0), manifest.shots.length - 1)];
  if (!ref?.keyframe) throw new Error(`参考镜头缺少关键帧，无法校验（shotId=${shot.id}）`);
  return ref;
}

/** 对照参考帧与成片帧；失败抛错，调用方不得污染已有 verification。 */
export async function verifyShot(options: {
  project: Project;
  shotId: string;
  signal?: AbortSignal;
}): Promise<ShotVerification> {
  const { project, shotId, signal } = options;
  const shot = project.plan.find(item => item.id === shotId);
  if (!shot) throw new Error(`分镜不存在：${shotId}`);
  if (shot.status !== "done" || !shot.video) throw new Error(`分镜 ${shotId} 尚未生成完成，无法校验`);

  const root = projectDir(project.id);
  const ref = await resolveReferenceShot(project, shot);
  const refPaths = [ref.keyframe, ...(ref.samples ?? [])].filter(Boolean);
  for (const path of refPaths) {
    if (!(await exists(safeJoin(root, path)))) {
      throw new Error(`参考帧不存在：${path}`);
    }
  }

  const videoAbs = safeJoin(root, shot.video);
  if (!(await exists(videoAbs))) throw new Error(`成片不存在：${shot.video}`);
  const info = await probeMedia(videoAbs, signal);
  const duration = info.duration > 0 ? info.duration : shot.durationSeconds;
  const verifyDir = join(root, "generate", "verify", shotId);
  await ensureDir(verifyDir);

  const framePaths: string[] = [];
  const fractions = sampleFractions(duration);
  for (let index = 0; index < fractions.length; index++) {
    signal?.throwIfAborted();
    const time = Math.min(Math.max(duration * fractions[index], 0), Math.max(0, duration - 0.05));
    const outAbs = join(verifyDir, `gen${index + 1}.jpg`);
    await extractFrame(videoAbs, time, outAbs, 640, signal);
    framePaths.push(toProjectPath(root, outAbs));
  }

  const images = [
    ...refPaths.map(path => safeJoin(root, path)),
    ...framePaths.map(path => safeJoin(root, path)),
  ];

  const { data } = await chatJson<{ differences?: unknown; summary?: unknown }>({
    system: systemPrompt,
    prompt: `Reference images: first ${refPaths.length} (keyframe then samples). Generated images: last ${framePaths.length} (start/mid/end or mid only). Compare framing, shot size, camera move, lighting, color, subject pose, wardrobe, and any on-screen text.`,
    images,
    model: "vision",
    signal,
    timeoutMs: 240_000,
  });

  const differences = normalizeDifferences(data.differences);
  const summary = typeof data.summary === "string" && data.summary.trim()
    ? data.summary.trim().slice(0, 400)
    : (differences.length ? `发现 ${differences.length} 处差异` : "未发现明显差异");

  return {
    at: nowIso(),
    summary,
    differences,
    framePaths: [...refPaths, ...framePaths],
  };
}
