import { loadSettings } from "../../config";
import { generateVideoJob as generateViaIcompify } from "./icompify";
import { generateLocalVideoJob } from "./local";
import type { VideoJob, VideoResult } from "./types";

/** 按 video.provider 分流：local 走本地网关（免费），icompify 走远程计费接口。 */
export async function generateVideoJob(request: VideoJob): Promise<VideoResult> {
  const settings = await loadSettings();
  if (settings.video.provider === "local") return generateLocalVideoJob(request, settings);
  return generateViaIcompify(request);
}

export type { VideoJob, VideoResult } from "./types";
