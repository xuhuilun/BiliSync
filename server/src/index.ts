import { createSyncServer } from "./app.js";
import {
  assertMetricsPortDoesNotCollide,
  loadRuntimeConfig,
} from "./config/runtime-config.js";
import { logEffectiveOriginPolicy } from "./config/security-config.js";
import { loadMediaDeliveryConfig } from "./config/media-delivery-config.js";
import { loadTrtcConfig } from "./config/trtc-config.js";
import { createFileWebAuthSessionStore } from "./web-routes.js";
import { loadCachedVideoConfig } from "./config/cached-video-config.js";
import { createCachedVideoCatalog } from "./cached-videos/catalog.js";
import TLSSigAPIv2 from "tls-sig-api-v2";

const {
  port,
  metricsPort,
  logLevel,
  securityConfig,
  persistenceConfig,
  adminConfig,
  adminUiConfig,
} = await loadRuntimeConfig();
const trtcConfig = loadTrtcConfig();
const mediaDeliveryConfig = loadMediaDeliveryConfig();
const cachedVideoConfig = loadCachedVideoConfig();
const cachedVideoCatalog = createCachedVideoCatalog({
  ...cachedVideoConfig,
  onError: (error) => {
    console.error(
      "Cached video directory scan failed:",
      error instanceof Error ? error.message : String(error),
    );
  },
});
cachedVideoCatalog.start();

assertMetricsPortDoesNotCollide(metricsPort, port, "PORT");
logEffectiveOriginPolicy(securityConfig);

const { httpServer, metricsHttpServer } = await createSyncServer(
  securityConfig,
  persistenceConfig,
  {
    adminConfig,
    adminUiConfig,
    logLevel,
    metricsPort,
    webRouteDependencies: {
      authSessionStore: createFileWebAuthSessionStore(),
      cachedVideoCatalog,
      mediaDeliveryMode: mediaDeliveryConfig.mode,
      ...(trtcConfig
        ? {
            trtc: {
              sdkAppId: trtcConfig.sdkAppId,
              expireSeconds: trtcConfig.expireSeconds,
              generateUserSig: (userId: string) =>
                new TLSSigAPIv2.Api(
                  trtcConfig.sdkAppId,
                  trtcConfig.secretKey,
                ).genUserSig(userId, trtcConfig.expireSeconds),
              generatePrivateMapKey: (userId: string, roomId: string) =>
                new TLSSigAPIv2.Api(
                  trtcConfig.sdkAppId,
                  trtcConfig.secretKey,
                ).genPrivateMapKeyWithStringRoomID(
                  userId,
                  trtcConfig.expireSeconds,
                  roomId,
                  15,
                ),
            },
          }
        : {}),
    },
  },
);
httpServer.listen(port, () => {
  console.log(`Bili-SyncPlay server listening on http://localhost:${port}`);
});
if (metricsHttpServer && metricsPort !== undefined) {
  metricsHttpServer.on("error", (error) => {
    console.error(
      `Bili-SyncPlay metrics server failed to listen on ${metricsPort}:`,
      error,
    );
    process.exit(1);
  });
  metricsHttpServer.listen(metricsPort, () => {
    console.log(
      `Bili-SyncPlay metrics listening on http://localhost:${metricsPort}/metrics`,
    );
  });
}
