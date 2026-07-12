import {
  parsePositiveIntegerEnv,
  readTrimmedEnv,
  type EnvSource,
} from "./env.js";

const DEFAULT_TRTC_USER_SIG_TTL_SECONDS = 900;
const MIN_TRTC_USER_SIG_TTL_SECONDS = 300;
const MAX_TRTC_USER_SIG_TTL_SECONDS = 86_400;

export type TrtcConfig = {
  sdkAppId: number;
  secretKey: string;
  expireSeconds: number;
};

export function loadTrtcConfig(
  env: EnvSource = process.env,
): TrtcConfig | null {
  const sdkAppIdRaw = readTrimmedEnv(env, "TRTC_SDK_APP_ID");
  const secretKey = readTrimmedEnv(env, "TRTC_SECRET_KEY");
  if (!sdkAppIdRaw && !secretKey) {
    return null;
  }
  if (!sdkAppIdRaw) {
    throw new Error(
      "Environment variable TRTC_SDK_APP_ID is required when TRTC_SECRET_KEY is set.",
    );
  }
  if (!secretKey) {
    throw new Error(
      "Environment variable TRTC_SECRET_KEY is required when TRTC_SDK_APP_ID is set.",
    );
  }

  const sdkAppId = parsePositiveIntegerEnv(
    env,
    "TRTC_SDK_APP_ID",
    Number(sdkAppIdRaw),
  );
  const expireSeconds = parsePositiveIntegerEnv(
    env,
    "TRTC_USER_SIG_TTL_SECONDS",
    DEFAULT_TRTC_USER_SIG_TTL_SECONDS,
  );
  if (
    expireSeconds < MIN_TRTC_USER_SIG_TTL_SECONDS ||
    expireSeconds > MAX_TRTC_USER_SIG_TTL_SECONDS
  ) {
    throw new Error(
      `Environment variable TRTC_USER_SIG_TTL_SECONDS must be between ${MIN_TRTC_USER_SIG_TTL_SECONDS} and ${MAX_TRTC_USER_SIG_TTL_SECONDS}.`,
    );
  }

  return { sdkAppId, secretKey, expireSeconds };
}
