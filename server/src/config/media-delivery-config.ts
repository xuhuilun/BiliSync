import { readTrimmedEnv, type EnvSource } from "./env.js";

export type BilibiliMediaDeliveryMode = "direct-first" | "proxy-only";

export type MediaDeliveryConfig = {
  mode: BilibiliMediaDeliveryMode;
};

export function loadMediaDeliveryConfig(
  env: EnvSource = process.env,
): MediaDeliveryConfig {
  const mode = readTrimmedEnv(env, "BILIBILI_MEDIA_DELIVERY_MODE");
  if (mode === undefined || mode === "direct-first") {
    return { mode: "direct-first" };
  }
  if (mode === "proxy-only") {
    return { mode };
  }
  throw new Error(
    'Environment variable BILIBILI_MEDIA_DELIVERY_MODE must be "direct-first" or "proxy-only".',
  );
}
