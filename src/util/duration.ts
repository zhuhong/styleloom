export const MIN_SHOT_SECONDS = 1;
export const H3_SAFE_MIN_SECONDS = 4;
export const MAX_SHOT_SECONDS = 15;

/** 分镜/生成共用的时长校验：允许 1-15 秒整数，低于 4 秒由生成层决定裁剪或实验直发。 */
export function normalizeShotDuration(value: unknown, context = "镜头") {
  const seconds = Math.round(Number(value));
  if (!Number.isInteger(seconds) || seconds < MIN_SHOT_SECONDS || seconds > MAX_SHOT_SECONDS) {
    throw new Error(`${context}时长必须是 ${MIN_SHOT_SECONDS}-${MAX_SHOT_SECONDS} 秒整数`);
  }
  return seconds;
}

export function isShortShot(seconds: number) {
  return seconds < H3_SAFE_MIN_SECONDS;
}

/** 默认把短镜头抬到 H3 常规下限，生成后裁剪；experimental=true 才把短时长直接发给平台。 */
export function providerDurationFor(seconds: number, experimental = false) {
  return isShortShot(seconds) && !experimental ? H3_SAFE_MIN_SECONDS : seconds;
}
