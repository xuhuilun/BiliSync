import type { RuntimeStore } from "../runtime-store.js";
import type { RoomStore } from "../room-store.js";
import { ROOM_EVENT_TYPES, type RoomEventType } from "../room-event-bus.js";

const DEFAULT_HISTOGRAM_BUCKETS_SECONDS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
] as const;

const CORE_EVENT_NAMES = [
  "room_created",
  "room_joined",
  "ws_connection_rejected",
  "rate_limited",
] as const;

export type MonitoredMessageType =
  "video:share" | "playback:update" | "room:join" | "room:leave";

export type WebMediaProxyUpstreamSource = "primary" | "backup";
export type WebMediaProxyUpstreamResult =
  "success" | "http_error" | "network_error" | "timeout";

type LabelValues = Record<string, string>;

type HistogramSample = {
  bucketCounts: number[];
  count: number;
  sum: number;
  labels: LabelValues;
};

type HistogramMetric = {
  help: string;
  buckets: readonly number[];
  samples: Map<string, HistogramSample>;
};

type CounterSample = {
  labels: LabelValues;
  value: number;
};

type CounterMetric = {
  help: string;
  samples: Map<string, CounterSample>;
};

export type MetricsCollector = {
  bindRuntimeStore: (runtimeStore: RuntimeStore) => void;
  recordEvent: (event: string) => void;
  observeMessageHandlerDuration: (
    messageType: MonitoredMessageType,
    durationMs: number,
  ) => void;
  observeRedisRuntimeStoreDuration: (
    operation: string,
    durationMs: number,
  ) => void;
  observeRedisRuntimeStoreFailure: (operation: string) => void;
  observeRedisRoomEventBusPublishDuration: (durationMs: number) => void;
  observeRedisRoomEventBusPublishFailure: () => void;
  recordRoomEventPublishDropped: (eventType: RoomEventType) => void;
  recordWebMediaManifestIssued: (
    mode: "direct-first" | "proxy-only",
    directCandidateCount: number,
  ) => void;
  recordWebMediaProxyRequest: () => void;
  recordWebMediaProxyBytes: (bytes: number) => void;
  observeWebMediaProxyUpstreamAttempt: (
    source: WebMediaProxyUpstreamSource,
    result: WebMediaProxyUpstreamResult,
    durationMs: number,
  ) => void;
  render: () => Promise<string>;
};

function createLabelKey(labels: LabelValues): string {
  return JSON.stringify(
    Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function escapeLabelValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

function formatLabels(labels: LabelValues): string {
  const entries = Object.entries(labels).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) {
    return "";
  }

  return `{${entries
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(",")}}`;
}

function formatMetricLine(
  name: string,
  value: number,
  labels: LabelValues = {},
): string {
  return `${name}${formatLabels(labels)} ${value}`;
}

function ensureCounterSample(
  metric: CounterMetric,
  labels: LabelValues,
): CounterSample {
  const key = createLabelKey(labels);
  const existing = metric.samples.get(key);
  if (existing) {
    return existing;
  }

  const sample: CounterSample = {
    labels,
    value: 0,
  };
  metric.samples.set(key, sample);
  return sample;
}

function ensureHistogramSample(
  metric: HistogramMetric,
  labels: LabelValues,
): HistogramSample {
  const key = createLabelKey(labels);
  const existing = metric.samples.get(key);
  if (existing) {
    return existing;
  }

  const sample: HistogramSample = {
    bucketCounts: Array.from({ length: metric.buckets.length }, () => 0),
    count: 0,
    sum: 0,
    labels,
  };
  metric.samples.set(key, sample);
  return sample;
}

export function createMetricsCollector(options: {
  runtimeStore: RuntimeStore;
  roomStore: RoomStore;
}): MetricsCollector {
  let runtimeStore = options.runtimeStore;
  const eventCounter: CounterMetric = {
    help: "Total structured log events grouped by event name",
    samples: new Map(),
  };
  const redisFailureCounter: CounterMetric = {
    help: "Total Redis metric-instrumented operation failures",
    samples: new Map(),
  };
  const roomEventPublishDroppedCounter: CounterMetric = {
    help: "Total room event publishes dropped after backpressure timeout, grouped by event type",
    samples: new Map(),
  };
  const webMediaManifestCounter: CounterMetric = {
    help: "Total Bilibili playback manifests issued by delivery mode",
    samples: new Map(),
  };
  const webMediaProxyUpstreamAttemptCounter: CounterMetric = {
    help: "Total Bilibili media proxy upstream attempts by source and result",
    samples: new Map(),
  };
  let webMediaDirectCandidateCount = 0;
  let webMediaProxyRequestCount = 0;
  let webMediaProxyBytes = 0;
  const messageDurationHistogram: HistogramMetric = {
    help: "Duration of monitored message handler paths in seconds",
    buckets: DEFAULT_HISTOGRAM_BUCKETS_SECONDS,
    samples: new Map(),
  };
  const redisRuntimeStoreDurationHistogram: HistogramMetric = {
    help: "Duration of Redis runtime store operations in seconds",
    buckets: DEFAULT_HISTOGRAM_BUCKETS_SECONDS,
    samples: new Map(),
  };
  const redisRoomEventBusPublishDurationHistogram: HistogramMetric = {
    help: "Duration of Redis room event bus publish operations in seconds",
    buckets: DEFAULT_HISTOGRAM_BUCKETS_SECONDS,
    samples: new Map(),
  };
  const webMediaProxyUpstreamDurationHistogram: HistogramMetric = {
    help: "Duration of Bilibili media proxy upstream attempts in seconds",
    buckets: DEFAULT_HISTOGRAM_BUCKETS_SECONDS,
    samples: new Map(),
  };

  for (const eventName of CORE_EVENT_NAMES) {
    ensureCounterSample(eventCounter, { event: eventName });
  }

  // Pre-seed every room event type to 0 so dashboards can distinguish
  // "no drops" from "metric never emitted" — drops are rare but the
  // critical room_member_* types must be observable the moment they occur.
  for (const eventType of ROOM_EVENT_TYPES) {
    ensureCounterSample(roomEventPublishDroppedCounter, {
      event_type: eventType,
    });
  }

  function incrementCounter(
    metric: CounterMetric,
    labels: LabelValues,
    value = 1,
  ): void {
    ensureCounterSample(metric, labels).value += value;
  }

  function observeHistogram(
    metric: HistogramMetric,
    labels: LabelValues,
    durationMs: number,
  ): void {
    const sample = ensureHistogramSample(metric, labels);
    const durationSeconds = Math.max(durationMs, 0) / 1_000;
    sample.count += 1;
    sample.sum += durationSeconds;
    for (const [index, bucket] of metric.buckets.entries()) {
      if (durationSeconds <= bucket) {
        sample.bucketCounts[index] += 1;
      }
    }
  }

  async function render(): Promise<string> {
    const totalNonExpired = await options.roomStore.countRooms({
      keyword: undefined,
      includeExpired: false,
    });
    const eventSamples = Array.from(eventCounter.samples.values()).sort(
      (a, b) => (a.labels.event ?? "").localeCompare(b.labels.event ?? ""),
    );
    const redisFailureSamples = Array.from(
      redisFailureCounter.samples.values(),
    ).sort((a, b) => {
      const left = `${a.labels.component}:${a.labels.operation}`;
      const right = `${b.labels.component}:${b.labels.operation}`;
      return left.localeCompare(right);
    });
    const roomEventPublishDroppedSamples = Array.from(
      roomEventPublishDroppedCounter.samples.values(),
    ).sort((a, b) =>
      (a.labels.event_type ?? "").localeCompare(b.labels.event_type ?? ""),
    );
    const histogramMetrics = [
      {
        name: "bili_syncplay_message_handler_duration_seconds",
        metric: messageDurationHistogram,
      },
      {
        name: "bili_syncplay_redis_runtime_store_duration_seconds",
        metric: redisRuntimeStoreDurationHistogram,
      },
      {
        name: "bili_syncplay_redis_room_event_bus_publish_duration_seconds",
        metric: redisRoomEventBusPublishDurationHistogram,
      },
      {
        name: "bili_syncplay_web_media_proxy_upstream_duration_seconds",
        metric: webMediaProxyUpstreamDurationHistogram,
      },
    ] as const;

    const lines = [
      "# HELP bili_syncplay_connections Current websocket connection count",
      "# TYPE bili_syncplay_connections gauge",
      formatMetricLine(
        "bili_syncplay_connections",
        runtimeStore.getConnectionCount(),
      ),
      "# HELP bili_syncplay_active_rooms Current active room count",
      "# TYPE bili_syncplay_active_rooms gauge",
      formatMetricLine(
        "bili_syncplay_active_rooms",
        runtimeStore.getActiveRoomCount(),
      ),
      "# HELP bili_syncplay_rooms_non_expired Current non-expired room count",
      "# TYPE bili_syncplay_rooms_non_expired gauge",
      formatMetricLine("bili_syncplay_rooms_non_expired", totalNonExpired),
      "# HELP bili_syncplay_events_total Total structured log events grouped by event name",
      "# TYPE bili_syncplay_events_total counter",
      ...eventSamples.map((sample) =>
        formatMetricLine(
          "bili_syncplay_events_total",
          sample.value,
          sample.labels,
        ),
      ),
      "# HELP bili_syncplay_room_created_total Total room_created events",
      "# TYPE bili_syncplay_room_created_total counter",
      formatMetricLine(
        "bili_syncplay_room_created_total",
        ensureCounterSample(eventCounter, { event: "room_created" }).value,
      ),
      "# HELP bili_syncplay_room_joined_total Total room_joined events",
      "# TYPE bili_syncplay_room_joined_total counter",
      formatMetricLine(
        "bili_syncplay_room_joined_total",
        ensureCounterSample(eventCounter, { event: "room_joined" }).value,
      ),
      "# HELP bili_syncplay_ws_connection_rejected_total Total rejected websocket upgrades",
      "# TYPE bili_syncplay_ws_connection_rejected_total counter",
      formatMetricLine(
        "bili_syncplay_ws_connection_rejected_total",
        ensureCounterSample(eventCounter, {
          event: "ws_connection_rejected",
        }).value,
      ),
      "# HELP bili_syncplay_rate_limited_total Total rate_limited events",
      "# TYPE bili_syncplay_rate_limited_total counter",
      formatMetricLine(
        "bili_syncplay_rate_limited_total",
        ensureCounterSample(eventCounter, { event: "rate_limited" }).value,
      ),
      "# HELP bili_syncplay_redis_operation_failures_total Total Redis metric-instrumented operation failures",
      "# TYPE bili_syncplay_redis_operation_failures_total counter",
      ...redisFailureSamples.map((sample) =>
        formatMetricLine(
          "bili_syncplay_redis_operation_failures_total",
          sample.value,
          sample.labels,
        ),
      ),
      "# HELP bili_syncplay_room_event_publish_dropped_total Total room event publishes dropped after backpressure timeout, grouped by event type",
      "# TYPE bili_syncplay_room_event_publish_dropped_total counter",
      ...roomEventPublishDroppedSamples.map((sample) =>
        formatMetricLine(
          "bili_syncplay_room_event_publish_dropped_total",
          sample.value,
          sample.labels,
        ),
      ),
      "# HELP bili_syncplay_web_media_manifests_total Total Bilibili playback manifests issued by delivery mode",
      "# TYPE bili_syncplay_web_media_manifests_total counter",
      ...Array.from(webMediaManifestCounter.samples.values())
        .sort((left, right) =>
          (left.labels.mode ?? "").localeCompare(right.labels.mode ?? ""),
        )
        .map((sample) =>
          formatMetricLine(
            "bili_syncplay_web_media_manifests_total",
            sample.value,
            sample.labels,
          ),
        ),
      "# HELP bili_syncplay_web_media_direct_candidates_total Total direct CDN candidates included in issued manifests",
      "# TYPE bili_syncplay_web_media_direct_candidates_total counter",
      formatMetricLine(
        "bili_syncplay_web_media_direct_candidates_total",
        webMediaDirectCandidateCount,
      ),
      "# HELP bili_syncplay_web_media_proxy_requests_total Total media proxy requests",
      "# TYPE bili_syncplay_web_media_proxy_requests_total counter",
      formatMetricLine(
        "bili_syncplay_web_media_proxy_requests_total",
        webMediaProxyRequestCount,
      ),
      "# HELP bili_syncplay_web_media_proxy_bytes_total Total declared upstream bytes served by the media proxy",
      "# TYPE bili_syncplay_web_media_proxy_bytes_total counter",
      formatMetricLine(
        "bili_syncplay_web_media_proxy_bytes_total",
        webMediaProxyBytes,
      ),
      "# HELP bili_syncplay_web_media_proxy_upstream_attempts_total Total Bilibili media proxy upstream attempts by source and result",
      "# TYPE bili_syncplay_web_media_proxy_upstream_attempts_total counter",
      ...Array.from(webMediaProxyUpstreamAttemptCounter.samples.values())
        .sort((left, right) =>
          createLabelKey(left.labels).localeCompare(
            createLabelKey(right.labels),
          ),
        )
        .map((sample) =>
          formatMetricLine(
            "bili_syncplay_web_media_proxy_upstream_attempts_total",
            sample.value,
            sample.labels,
          ),
        ),
    ];

    for (const { name, metric } of histogramMetrics) {
      lines.push(`# HELP ${name} ${metric.help}`);
      lines.push(`# TYPE ${name} histogram`);
      const samples = Array.from(metric.samples.values()).sort((left, right) =>
        createLabelKey(left.labels).localeCompare(createLabelKey(right.labels)),
      );
      for (const sample of samples) {
        for (const [index, bucket] of metric.buckets.entries()) {
          lines.push(
            formatMetricLine(
              `${name}_bucket`,
              sample.bucketCounts[index] ?? 0,
              {
                ...sample.labels,
                le: String(bucket),
              },
            ),
          );
        }
        lines.push(
          formatMetricLine(`${name}_bucket`, sample.count, {
            ...sample.labels,
            le: "+Inf",
          }),
        );
        lines.push(formatMetricLine(`${name}_sum`, sample.sum, sample.labels));
        lines.push(
          formatMetricLine(`${name}_count`, sample.count, sample.labels),
        );
      }
    }

    return `${lines.join("\n")}\n`;
  }

  return {
    bindRuntimeStore(nextRuntimeStore) {
      runtimeStore = nextRuntimeStore;
    },
    recordEvent(event) {
      incrementCounter(eventCounter, { event });
    },
    observeMessageHandlerDuration(messageType, durationMs) {
      observeHistogram(
        messageDurationHistogram,
        { message_type: messageType },
        durationMs,
      );
    },
    observeRedisRuntimeStoreDuration(operation, durationMs) {
      observeHistogram(
        redisRuntimeStoreDurationHistogram,
        { operation },
        durationMs,
      );
    },
    observeRedisRuntimeStoreFailure(operation) {
      incrementCounter(redisFailureCounter, {
        component: "runtime_store",
        operation,
      });
    },
    observeRedisRoomEventBusPublishDuration(durationMs) {
      observeHistogram(
        redisRoomEventBusPublishDurationHistogram,
        { operation: "publish" },
        durationMs,
      );
    },
    observeRedisRoomEventBusPublishFailure() {
      incrementCounter(redisFailureCounter, {
        component: "room_event_bus",
        operation: "publish",
      });
    },
    recordRoomEventPublishDropped(eventType) {
      incrementCounter(roomEventPublishDroppedCounter, {
        event_type: eventType,
      });
    },
    recordWebMediaManifestIssued(mode, directCandidateCount) {
      incrementCounter(webMediaManifestCounter, { mode });
      webMediaDirectCandidateCount += Math.max(0, directCandidateCount);
    },
    recordWebMediaProxyRequest() {
      webMediaProxyRequestCount += 1;
    },
    recordWebMediaProxyBytes(bytes) {
      if (Number.isFinite(bytes) && bytes > 0) {
        webMediaProxyBytes += bytes;
      }
    },
    observeWebMediaProxyUpstreamAttempt(source, result, durationMs) {
      const labels = { source, result };
      incrementCounter(webMediaProxyUpstreamAttemptCounter, labels);
      observeHistogram(
        webMediaProxyUpstreamDurationHistogram,
        labels,
        durationMs,
      );
    },
    render,
  };
}

export function createMetricsService(options: {
  runtimeStore: RuntimeStore;
  roomStore: RoomStore;
}) {
  return createMetricsCollector(options);
}
