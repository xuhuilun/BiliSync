import assert from "node:assert/strict";
import test from "node:test";
import { createMetricsCollector } from "../src/admin/metrics.js";
import { createInMemoryRuntimeStore } from "../src/runtime-store.js";

test("metrics collector renders event counters, histograms, and redis failure counters", async () => {
  const runtimeStore = createInMemoryRuntimeStore(() => 0);
  const metrics = createMetricsCollector({
    runtimeStore,
    roomStore: {
      async countRooms() {
        return 2;
      },
    } as never,
  });

  runtimeStore.registerSession({
    id: "session-1",
    connectionState: "detached",
    socket: null,
    instanceId: "instance-1",
    remoteAddress: "127.0.0.1",
    origin: "chrome-extension://allowed-extension",
    roomCode: null,
    memberId: null,
    displayName: "Alice",
    memberToken: null,
    joinedAt: null,
    invalidMessageCount: 0,
    rateLimitState: {
      roomCreate: { windowStart: 0, count: 0 },
      roomJoin: { windowStart: 0, count: 0 },
      videoShare: { windowStart: 0, count: 0 },
      playbackUpdate: { tokens: 0, lastRefillAt: 0 },
      syncRequest: { windowStart: 0, count: 0 },
      syncPing: { tokens: 0, lastRefillAt: 0 },
    },
  });
  runtimeStore.markSessionJoinedRoom("session-1", "ROOM01");

  metrics.recordEvent("room_created");
  metrics.observeMessageHandlerDuration("room:join", 12);
  metrics.observeRedisRuntimeStoreDuration("register_session", 8);
  metrics.observeRedisRuntimeStoreFailure("register_session");
  metrics.observeRedisRoomEventBusPublishDuration(5);
  metrics.observeRedisRoomEventBusPublishFailure();
  metrics.recordRoomEventPublishDropped("room_member_changed");
  metrics.recordRoomEventPublishDropped("room_member_changed");
  metrics.recordWebMediaManifestIssued("direct-first", 2);
  metrics.recordWebMediaProxyRequest();
  metrics.recordWebMediaProxyBytes(1_024);

  const rendered = await metrics.render();

  assert.equal(rendered.includes("bili_syncplay_connections 1"), true);
  assert.equal(rendered.includes("bili_syncplay_active_rooms 1"), true);
  assert.equal(rendered.includes("bili_syncplay_rooms_non_expired 2"), true);
  assert.equal(
    rendered.includes('bili_syncplay_events_total{event="room_created"} 1'),
    true,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_message_handler_duration_seconds_count{message_type="room:join"} 1',
    ),
    true,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_redis_runtime_store_duration_seconds_count{operation="register_session"} 1',
    ),
    true,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_redis_room_event_bus_publish_duration_seconds_count{operation="publish"} 1',
    ),
    true,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_redis_operation_failures_total{component="room_event_bus",operation="publish"} 1',
    ),
    true,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_redis_operation_failures_total{component="runtime_store",operation="register_session"} 1',
    ),
    true,
  );
  // Member-affecting drops are counted under their own event_type label so a
  // critical room_member_changed drop is never hidden behind high-frequency
  // room_state_updated drops.
  assert.equal(
    rendered.includes(
      'bili_syncplay_room_event_publish_dropped_total{event_type="room_member_changed"} 2',
    ),
    true,
  );
  // Pre-seeded to 0 so "no drops" is distinguishable from "metric absent".
  assert.equal(
    rendered.includes(
      'bili_syncplay_room_event_publish_dropped_total{event_type="room_state_updated"} 0',
    ),
    true,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_web_media_manifests_total{mode="direct-first"} 1',
    ),
    true,
  );
  assert.equal(
    rendered.includes("bili_syncplay_web_media_direct_candidates_total 2"),
    true,
  );
  assert.equal(
    rendered.includes("bili_syncplay_web_media_proxy_requests_total 1"),
    true,
  );
  assert.equal(
    rendered.includes("bili_syncplay_web_media_proxy_bytes_total 1024"),
    true,
  );
});

test("metrics collector counts primary upstream HTTP errors", async () => {
  const metrics = createMetricsCollector({
    runtimeStore: createInMemoryRuntimeStore(() => 0),
    roomStore: {
      async countRooms() {
        return 0;
      },
    } as never,
  });

  metrics.observeWebMediaProxyUpstreamAttempt("primary", "http_error", 100);

  const rendered = await metrics.render();

  assert.equal(
    rendered.includes(
      'bili_syncplay_web_media_proxy_upstream_attempts_total{result="http_error",source="primary"} 1',
    ),
    true,
  );
});

test("metrics collector observes backup upstream success duration", async () => {
  const metrics = createMetricsCollector({
    runtimeStore: createInMemoryRuntimeStore(() => 0),
    roomStore: {
      async countRooms() {
        return 0;
      },
    } as never,
  });

  metrics.observeWebMediaProxyUpstreamAttempt("backup", "success", 500);

  const rendered = await metrics.render();

  assert.equal(
    rendered.includes(
      'bili_syncplay_web_media_proxy_upstream_duration_seconds_bucket{le="0.5",result="success",source="backup"} 1',
    ),
    true,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_web_media_proxy_upstream_duration_seconds_count{result="success",source="backup"} 1',
    ),
    true,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_web_media_proxy_upstream_duration_seconds_sum{result="success",source="backup"} 0.5',
    ),
    true,
  );
});

test("metrics collector can rebind to the effective runtime store", async () => {
  const localRuntimeStore = createInMemoryRuntimeStore(() => 0);
  const sharedRuntimeStore = createInMemoryRuntimeStore(() => 0);
  const metrics = createMetricsCollector({
    runtimeStore: localRuntimeStore,
    roomStore: {
      async countRooms() {
        return 0;
      },
    } as never,
  });

  sharedRuntimeStore.registerSession({
    id: "shared-session",
    connectionState: "detached",
    socket: null,
    instanceId: "instance-shared",
    remoteAddress: "127.0.0.1",
    origin: "chrome-extension://allowed-extension",
    roomCode: null,
    memberId: null,
    displayName: "Bob",
    memberToken: null,
    joinedAt: null,
    invalidMessageCount: 0,
    rateLimitState: {
      roomCreate: { windowStart: 0, count: 0 },
      roomJoin: { windowStart: 0, count: 0 },
      videoShare: { windowStart: 0, count: 0 },
      playbackUpdate: { tokens: 0, lastRefillAt: 0 },
      syncRequest: { windowStart: 0, count: 0 },
      syncPing: { tokens: 0, lastRefillAt: 0 },
    },
  });
  sharedRuntimeStore.markSessionJoinedRoom("shared-session", "ROOM99");

  metrics.bindRuntimeStore(sharedRuntimeStore);

  const rendered = await metrics.render();

  assert.equal(rendered.includes("bili_syncplay_connections 1"), true);
  assert.equal(rendered.includes("bili_syncplay_active_rooms 1"), true);
});
