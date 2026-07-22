export const ANDROID_PERFORMANCE_REPORT_VERSION = 1;
export const MAX_PERFORMANCE_SAMPLES_PER_METRIC = 3_600;
export const MAX_PERFORMANCE_SAMPLES = 25_200;

export const ANDROID_PERFORMANCE_SAMPLE_FIELDS = Object.freeze([
  "schemaVersion",
  "metric",
  "timestamp",
  "sequence",
  "elapsedMs",
  "durationMs",
  "source",
  "status",
  "diagnostics",
  "cpuPercent",
  "cpuRawPercent",
  "memoryPssMb",
  "memoryJavaHeapKb",
  "memoryNativeHeapKb",
  "memoryRssKb",
  "activeFps",
  "frameTimeMs",
  "frameDurationsMs",
  "frameP50Ms",
  "frameP90Ms",
  "frameP95Ms",
  "frameP99Ms",
  "frameCount",
  "jankyFrames",
  "jankRate",
  "frozenFrames",
  "rxBytes",
  "txBytes",
  "networkRxBytesPerSecond",
  "networkTxBytesPerSecond",
  "batteryLevel",
  "batteryTemperatureC",
  "batteryVoltageMv",
  "batteryPowered",
  "thermalStatus",
  "thermalStatusName",
]);

const METRIC_RANGES = Object.freeze({
  cpuPercent: [0, 100],
  cpuRawPercent: [0, 100_000],
  memoryPssMb: [0, Number.MAX_SAFE_INTEGER],
  memoryJavaHeapKb: [0, Number.MAX_SAFE_INTEGER],
  memoryNativeHeapKb: [0, Number.MAX_SAFE_INTEGER],
  memoryRssKb: [0, Number.MAX_SAFE_INTEGER],
  activeFps: [0, 1_000],
  frameTimeMs: [0, 60_000],
  frameP50Ms: [0, 60_000],
  frameP90Ms: [0, 60_000],
  frameP95Ms: [0, 60_000],
  frameP99Ms: [0, 60_000],
  frameCount: [0, Number.MAX_SAFE_INTEGER],
  jankyFrames: [0, Number.MAX_SAFE_INTEGER],
  jankRate: [0, 100],
  frozenFrames: [0, Number.MAX_SAFE_INTEGER],
  rxBytes: [0, Number.MAX_SAFE_INTEGER],
  txBytes: [0, Number.MAX_SAFE_INTEGER],
  networkRxBytesPerSecond: [0, Number.MAX_SAFE_INTEGER],
  networkTxBytesPerSecond: [0, Number.MAX_SAFE_INTEGER],
  batteryLevel: [0, 100],
  batteryTemperatureC: [-100, 300],
  batteryVoltageMv: [0, 100_000],
  thermalStatus: [0, 10],
});

const METRIC_ALIASES = Object.freeze({
  cpuPercent: ["cpuPercent", "cpu"],
  cpuRawPercent: ["cpuRawPercent", "rawPercent"],
  memoryPssMb: ["memoryPssMb", "memoryPssMB", "memoryMb", "memoryMB"],
  memoryJavaHeapKb: ["memoryJavaHeapKb", "javaHeapKb"],
  memoryNativeHeapKb: ["memoryNativeHeapKb", "nativeHeapKb"],
  memoryRssKb: ["memoryRssKb", "rssKb"],
  activeFps: ["activeFps", "fps"],
  frameTimeMs: ["frameTimeMs", "frameDurationMs"],
  frameP50Ms: ["frameP50Ms"],
  frameP90Ms: ["frameP90Ms"],
  frameP95Ms: ["frameP95Ms"],
  frameP99Ms: ["frameP99Ms"],
  frameCount: ["frameCount"],
  jankyFrames: ["jankyFrames"],
  jankRate: ["jankRate", "jankPercent"],
  frozenFrames: ["frozenFrames"],
  rxBytes: ["rxBytes", "networkRxBytes"],
  txBytes: ["txBytes", "networkTxBytes"],
  networkRxBytesPerSecond: ["networkRxBytesPerSecond", "rxBytesPerSecond"],
  networkTxBytesPerSecond: ["networkTxBytesPerSecond", "txBytesPerSecond"],
  batteryLevel: ["batteryLevel", "batteryLevelPercent", "batteryPercent", "levelPercent"],
  batteryTemperatureC: ["batteryTemperatureC", "temperatureCelsius", "temperatureC"],
  batteryVoltageMv: ["batteryVoltageMv", "voltageMv"],
  thermalStatus: ["thermalStatus", "thermalStatusCode"],
});

const SUMMARY_METRIC_FIELDS = Object.freeze([
  "cpuPercent",
  "cpuRawPercent",
  "memoryPssMb",
  "memoryJavaHeapKb",
  "memoryNativeHeapKb",
  "memoryRssKb",
  "activeFps",
  "frameTimeMs",
  "frameP50Ms",
  "frameP90Ms",
  "frameP95Ms",
  "frameP99Ms",
  "frameCount",
  "jankyFrames",
  "jankRate",
  "frozenFrames",
  "networkRxBytesPerSecond",
  "networkTxBytesPerSecond",
  "batteryLevel",
  "batteryTemperatureC",
  "batteryVoltageMv",
  "thermalStatus",
]);

const REPORT_STATUSES = new Set([
  "completed",
  "stopped",
  "interrupted",
  "running",
  "failed",
]);

const REPORT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const PACKAGE_NAME_PATTERN = /^(?:[A-Za-z][A-Za-z0-9_]*)(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
export const ANDROID_PERFORMANCE_REPORT_NOTICE = "快速诊断数据，仅供开发定位参考，不属于实验室功耗测试。";

export class PerformanceValidationError extends Error {
  constructor(message, code = "INVALID_PERFORMANCE_DATA") {
    super(message);
    this.name = "PerformanceValidationError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new PerformanceValidationError(message, code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function firstDefined(source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

function valueAtPath(source, path) {
  let current = source;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function firstValueAtPaths(source, paths) {
  for (const path of paths) {
    const value = valueAtPath(source, path);
    if (value !== undefined) return value;
  }
  return undefined;
}

function metricSpecificValue(source, field) {
  const metric = typeof source.metric === "string"
    ? source.metric.toLowerCase().replace(/[^a-z]/gu, "")
    : "";
  const matches = {
    cpuPercent: new Set(["cpu", "cpupercent"]),
    cpuRawPercent: new Set(["cpu", "cpurawpercent"]),
    memoryPssMb: new Set(["memory", "meminfo", "memorypss", "memorypssmb"]),
    memoryJavaHeapKb: new Set(["memory", "meminfo", "javaheap"]),
    memoryNativeHeapKb: new Set(["memory", "meminfo", "nativeheap"]),
    memoryRssKb: new Set(["memory", "meminfo", "rss"]),
    activeFps: new Set(["fps", "frame", "frames", "gfx", "activefps"]),
    frameTimeMs: new Set(["frame", "frames", "gfx", "frametime", "frameduration"]),
    frameP50Ms: new Set(["frame", "frames", "gfx", "framep50"]),
    frameP90Ms: new Set(["frame", "frames", "gfx", "framep90"]),
    frameP95Ms: new Set(["frame", "frames", "gfx", "framep95"]),
    frameP99Ms: new Set(["frame", "frames", "gfx", "framep99"]),
    frameCount: new Set(["frame", "frames", "gfx", "framecount"]),
    jankyFrames: new Set(["frame", "frames", "gfx", "jankyframes"]),
    jankRate: new Set(["frame", "frames", "gfx", "jank", "jankrate"]),
    frozenFrames: new Set(["frame", "frames", "gfx", "frozenframes"]),
    rxBytes: new Set(["network", "netstats", "rx", "rxbytes"]),
    txBytes: new Set(["network", "netstats", "tx", "txbytes"]),
    networkRxBytesPerSecond: new Set(["network", "netstats", "rxbytespersecond"]),
    networkTxBytesPerSecond: new Set(["network", "netstats", "txbytespersecond"]),
    batteryLevel: new Set(["battery", "batterylevel"]),
    batteryTemperatureC: new Set(["battery", "batterytemperature", "temperature"]),
    batteryVoltageMv: new Set(["battery", "batteryvoltage", "voltage"]),
    thermalStatus: new Set(["thermal", "thermalstatus"]),
  };
  if (!matches[field]?.has(metric)) return undefined;
  if (isPlainObject(source.value)) {
    return firstDefined(source.value, METRIC_ALIASES[field]);
  }
  return source.value;
}

function collectorMetricValue(source, field) {
  const direct = firstDefined(source, METRIC_ALIASES[field]);
  if (direct !== undefined) {
    if (isPlainObject(direct)) {
      if (field === "thermalStatus" && direct.code !== undefined) return direct.code;
      const nestedDirect = firstDefined(direct, METRIC_ALIASES[field]);
      if (nestedDirect !== undefined) return nestedDirect;
    } else {
      return direct;
    }
  }

  const paths = {
    cpuPercent: [["cpu", "cpuPercent"], ["cpu", "value", "cpuPercent"]],
    cpuRawPercent: [["cpu", "cpuRawPercent"], ["cpu", "rawPercent"]],
    memoryPssMb: [["memory", "memoryPssMb"], ["memInfo", "memoryPssMb"]],
    memoryJavaHeapKb: [["memory", "memoryJavaHeapKb"], ["memory", "javaHeapKb"], ["memInfo", "javaHeapKb"]],
    memoryNativeHeapKb: [["memory", "memoryNativeHeapKb"], ["memory", "nativeHeapKb"], ["memInfo", "nativeHeapKb"]],
    memoryRssKb: [["memory", "memoryRssKb"], ["memory", "rssKb"], ["memInfo", "rssKb"]],
    activeFps: [["frame", "activeFps"], ["frames", "activeFps"], ["gfx", "activeFps"]],
    frameTimeMs: [["frame", "frameDurationMs"], ["frames", "frameDurationMs"], ["gfx", "frameDurationMs"]],
    frameP50Ms: [["frame", "frameP50Ms"], ["frames", "frameP50Ms"], ["gfx", "frameP50Ms"]],
    frameP90Ms: [["frame", "frameP90Ms"], ["frames", "frameP90Ms"], ["gfx", "frameP90Ms"]],
    frameP95Ms: [["frame", "frameP95Ms"], ["frames", "frameP95Ms"], ["gfx", "frameP95Ms"]],
    frameP99Ms: [["frame", "frameP99Ms"], ["frames", "frameP99Ms"], ["gfx", "frameP99Ms"]],
    frameCount: [["frame", "frameCount"], ["frames", "frameCount"], ["gfx", "frameCount"]],
    jankyFrames: [["frame", "jankyFrames"], ["frames", "jankyFrames"], ["gfx", "jankyFrames"]],
    jankRate: [["frame", "jankRate"], ["frames", "jankRate"], ["gfx", "jankRate"]],
    frozenFrames: [["frame", "frozenFrames"], ["frames", "frozenFrames"], ["gfx", "frozenFrames"]],
    rxBytes: [["network", "networkRxBytes"], ["network", "rxBytes"], ["netstats", "rxBytes"]],
    txBytes: [["network", "networkTxBytes"], ["network", "txBytes"], ["netstats", "txBytes"]],
    networkRxBytesPerSecond: [["network", "networkRxBytesPerSecond"], ["network", "rxBytesPerSecond"], ["netstats", "networkRxBytesPerSecond"]],
    networkTxBytesPerSecond: [["network", "networkTxBytesPerSecond"], ["network", "txBytesPerSecond"], ["netstats", "networkTxBytesPerSecond"]],
    batteryLevel: [["battery", "batteryLevelPercent"], ["battery", "levelPercent"], ["battery", "batteryLevel"]],
    batteryTemperatureC: [["battery", "batteryTemperatureC"], ["battery", "temperatureC"]],
    batteryVoltageMv: [["battery", "batteryVoltageMv"], ["battery", "voltageMv"]],
    thermalStatus: [["thermal", "code"], ["thermalStatus", "code"]],
  };
  const nested = firstValueAtPaths(source, paths[field] ?? []);
  if (nested !== undefined) return nested;
  if (
    field === "thermalStatus" &&
    source.code !== undefined &&
    typeof source.name === "string" &&
    /^(?:NONE|LIGHT|MODERATE|SEVERE|CRITICAL|EMERGENCY|SHUTDOWN)$/iu.test(source.name)
  ) {
    return source.code;
  }
  return metricSpecificValue(source, field);
}

function collectorMemoryPssMb(source) {
  const megabytes = collectorMetricValue(source, "memoryPssMb");
  if (megabytes !== undefined) return megabytes;
  const kilobytes = firstValueAtPaths(source, [
    ["memoryPssKb"],
    ["pssKb"],
    ["memory", "memoryPssKb"],
    ["memory", "pssKb"],
    ["memInfo", "pssKb"],
    ["value", "pssKb"],
  ]);
  return typeof kilobytes === "number" && Number.isFinite(kilobytes)
    ? kilobytes / 1024
    : kilobytes;
}

function normalizeTimestamp(value, fieldName = "timestamp") {
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    fail(`${fieldName} 必须是非负毫秒时间戳`, "INVALID_TIMESTAMP");
  }
  return timestamp;
}

function normalizeSequence(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeSchemaVersion(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number.isSafeInteger(value) && value >= 1 && value <= 1_000
    ? value
    : null;
}

function normalizeNonNegativeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function normalizeShortText(value, maximumLength = 128) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, maximumLength) : null;
}

function normalizeFrameDurations(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  return value
    .filter(
      (duration) =>
        typeof duration === "number" &&
        Number.isFinite(duration) &&
        duration >= 0 &&
        duration <= 60_000,
    );
}

function normalizeBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function normalizeMetric(value, field) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const [minimum, maximum] = METRIC_RANGES[field];
  if (value < minimum || value > maximum) return null;
  return value;
}

function round(value, precision = 3) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** precision;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function safeClone(value) {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function sanitizeMetadata(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.slice(0, 2_000);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 6) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizeMetadata(item, depth + 1));
  }
  if (!isPlainObject(value)) return null;

  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    result[String(key).slice(0, 128)] = sanitizeMetadata(item, depth + 1);
  }
  return result;
}

function generateReportId(now) {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `android-performance-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeReportId(value, now) {
  const id = value ?? generateReportId(now);
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 128 ||
    !REPORT_ID_PATTERN.test(id)
  ) {
    fail("性能报告 ID 无效", "INVALID_REPORT_ID");
  }
  return id;
}

function normalizePackageName(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 255 || !PACKAGE_NAME_PATTERN.test(value)) {
    fail("应用包名无效", "INVALID_PACKAGE_NAME");
  }
  return value;
}

function normalizeReportStatus(value) {
  const status = value ?? "completed";
  if (!REPORT_STATUSES.has(status)) {
    fail("性能报告状态无效", "INVALID_REPORT_STATUS");
  }
  return status;
}

function reportStatusFromData(data) {
  if (data.status !== undefined) return data.status;
  const endReason = data.endReason ?? data.session?.endReason;
  if (["device-disconnected", "disconnected", "connection-error", "process-exited"].includes(endReason)) {
    return "interrupted";
  }
  if (endReason === "manual") return "stopped";
  const phase = data.phase ?? data.session?.phase;
  if (phase === "error") return "failed";
  if (phase === "running" || phase === "preparing") return "running";
  if (phase === "stopping") return "stopped";
  return "completed";
}

function normalizeSamples(samples, { limit = MAX_PERFORMANCE_SAMPLES } = {}) {
  if (!Array.isArray(samples)) {
    fail("性能采样必须是数组", "INVALID_SAMPLES");
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    fail("性能采样上限无效", "INVALID_SAMPLE_LIMIT");
  }

  const normalized = samples.map(normalizePerformanceSample);
  normalized.sort(
    (left, right) =>
      left.timestamp - right.timestamp ||
      (left.sequence ?? Number.MAX_SAFE_INTEGER) -
        (right.sequence ?? Number.MAX_SAFE_INTEGER),
  );

  const byIdentity = new Map();
  for (const sample of normalized) {
    const identity = sample.sequence === null
      ? `timestamp:${sample.timestamp}`
      : `sequence:${sample.sequence}`;
    const previous = byIdentity.get(identity);
    if (!previous) {
      byIdentity.set(identity, sample);
      continue;
    }

    const merged = {
      timestamp: sample.timestamp,
      sequence: sample.sequence ?? previous.sequence,
    };
    for (const field of ANDROID_PERFORMANCE_SAMPLE_FIELDS) {
      if (field === "timestamp" || field === "sequence") continue;
      if (
        field === "diagnostics" &&
        isPlainObject(previous.diagnostics) &&
        isPlainObject(sample.diagnostics)
      ) {
        merged.diagnostics = {
          ...previous.diagnostics,
          ...sample.diagnostics,
        };
      } else {
        merged[field] = sample[field] ?? previous[field];
      }
    }
    byIdentity.set(
      identity,
      Object.fromEntries(
        ANDROID_PERFORMANCE_SAMPLE_FIELDS.map((field) => [field, merged[field] ?? null]),
      ),
    );
  }

  return [...byIdentity.values()]
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp ||
        (left.sequence ?? Number.MAX_SAFE_INTEGER) -
          (right.sequence ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(-limit);
}

export function normalizePerformanceSample(value) {
  if (!isPlainObject(value)) {
    fail("性能采样格式无效", "INVALID_SAMPLE");
  }

  const timestamp = normalizeTimestamp(
    value.timestamp ?? value.timestampMs ?? value.time ?? value.ts,
  );
  const normalized = {
    schemaVersion: normalizeSchemaVersion(value.schemaVersion),
    metric: normalizeShortText(value.metric, 64),
    timestamp,
    sequence: normalizeSequence(value.sequence ?? value.seq),
    elapsedMs: normalizeNonNegativeNumber(value.elapsedMs),
    durationMs: normalizeNonNegativeNumber(value.durationMs),
    source: normalizeShortText(value.source),
    status: normalizeShortText(value.status, 64),
    diagnostics: value.diagnostics === undefined
      ? null
      : sanitizeMetadata(value.diagnostics),
  };

  for (const field of Object.keys(METRIC_ALIASES)) {
    const rawValue = field === "memoryPssMb"
      ? collectorMemoryPssMb(value)
      : collectorMetricValue(value, field);
    normalized[field] = normalizeMetric(rawValue, field);
  }

  normalized.frameDurationsMs = normalizeFrameDurations(
    value.frameDurationsMs ??
      value.value?.frameDurationsMs ??
      value.frame?.frameDurationsMs ??
      value.frames?.frameDurationsMs,
  );
  normalized.batteryPowered = normalizeBoolean(
    value.batteryPowered ??
      value.powered ??
      value.value?.batteryPowered ??
      value.value?.powered ??
      value.battery?.batteryPowered ??
      value.battery?.powered,
  );

  const rawThermal = value.thermalStatus ?? value.thermal;
  normalized.thermalStatusName = normalizeShortText(
    isPlainObject(rawThermal)
      ? rawThermal.name
      : value.thermalStatusName ?? (
          typeof value.name === "string" &&
          /^(?:NONE|LIGHT|MODERATE|SEVERE|CRITICAL|EMERGENCY|SHUTDOWN)$/iu.test(value.name)
            ? value.name
            : null
        ),
    64,
  );

  return Object.fromEntries(
    ANDROID_PERFORMANCE_SAMPLE_FIELDS.map((field) => [
      field,
      normalized[field] ?? null,
    ]),
  );
}

export function validatePerformanceSample(value) {
  try {
    normalizePerformanceSample(value);
    return true;
  } catch {
    return false;
  }
}

export function appendPerformanceSample(
  samples,
  candidate,
  { limit = MAX_PERFORMANCE_SAMPLES } = {},
) {
  return normalizeSamples([...(Array.isArray(samples) ? samples : []), candidate], {
    limit,
  });
}

export function downsamplePerformanceSamples(samples, maxPoints = 300) {
  const normalized = normalizeSamples(samples, {
    limit: Math.max(MAX_PERFORMANCE_SAMPLES, samples?.length ?? 0, 1),
  });
  if (!Number.isSafeInteger(maxPoints) || maxPoints < 2) {
    fail("图表采样点上限必须至少为 2", "INVALID_DOWNSAMPLE_LIMIT");
  }
  if (normalized.length <= maxPoints) return normalized;

  const result = [];
  const lastIndex = normalized.length - 1;
  for (let index = 0; index < maxPoints; index += 1) {
    const sourceIndex = Math.round((index * lastIndex) / (maxPoints - 1));
    result.push(normalized[sourceIndex]);
  }
  return result;
}

function metricStatistics(samples, field) {
  const values = samples
    .map((sample) => sample[field])
    .filter((value) => value !== null);

  if (!values.length) {
    return {
      sampleCount: 0,
      first: null,
      latest: null,
      minimum: null,
      maximum: null,
      average: null,
      change: null,
      p50: null,
      p90: null,
      p95: null,
      p99: null,
    };
  }

  const sorted = [...values].sort((left, right) => left - right);
  const sum = values.reduce((total, value) => total + value, 0);
  const percentile = (quantile) => sorted[
    Math.max(0, Math.ceil(sorted.length * quantile) - 1)
  ];
  return {
    sampleCount: values.length,
    first: values[0],
    latest: values.at(-1),
    minimum: sorted[0],
    maximum: sorted.at(-1),
    average: round(sum / values.length),
    change: round(values.at(-1) - values[0]),
    p50: percentile(0.5),
    p90: percentile(0.9),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function sumAvailable(samples, field) {
  const values = samples
    .map((sample) => sample[field])
    .filter((value) => value !== null);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function latestAvailable(samples, field) {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index][field] !== null) return samples[index][field];
  }
  return null;
}

function weightedAverageRate(samples, field) {
  const available = samples.filter((sample) => sample[field] !== null);
  if (!available.length) return null;
  const weighted = available.filter(
    (sample) => typeof sample.durationMs === "number" && sample.durationMs > 0,
  );
  if (weighted.length === available.length) {
    const totalDuration = weighted.reduce((total, sample) => total + sample.durationMs, 0);
    return round(
      weighted.reduce(
        (total, sample) => total + sample[field] * sample.durationMs,
        0,
      ) / totalDuration,
    );
  }
  return round(
    available.reduce((total, sample) => total + sample[field], 0) /
      available.length,
  );
}

function cumulativeDelta(samples, field) {
  const values = samples
    .map((sample) => sample[field])
    .filter((value) => value !== null);
  if (values.length < 2) return null;

  let total = 0;
  let observedDelta = false;
  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    if (delta >= 0) {
      total += delta;
      observedDelta = true;
    }
  }
  return observedDelta ? total : null;
}

export function summarizePerformanceSamples(samples) {
  const normalized = normalizeSamples(samples, {
    limit: Math.max(MAX_PERFORMANCE_SAMPLES, samples?.length ?? 0, 1),
  });
  const first = normalized[0] ?? null;
  const last = normalized.at(-1) ?? null;
  const summary = {
    sampleCount: normalized.length,
    startedAt: first?.timestamp ?? null,
    endedAt: last?.timestamp ?? null,
    durationMs: first && last ? last.timestamp - first.timestamp : null,
  };

  for (const field of SUMMARY_METRIC_FIELDS) {
    summary[field] = metricStatistics(normalized, field);
  }

  summary.cpu = {
    averagePercent: summary.cpuPercent.average,
    p90Percent: summary.cpuPercent.p90,
    peakPercent: summary.cpuPercent.maximum,
  };
  summary.memory = {
    startPssMb: summary.memoryPssMb.first,
    endPssMb: summary.memoryPssMb.latest,
    changePssMb: summary.memoryPssMb.change,
    averagePssMb: summary.memoryPssMb.average,
    peakPssMb: summary.memoryPssMb.maximum,
  };

  const frameSamples = normalized.filter(
    (sample) =>
      sample.metric === "frame" ||
      sample.frameDurationsMs !== null ||
      sample.frameTimeMs !== null,
  );
  const frameDurations = frameSamples.flatMap(
    (sample) => sample.frameDurationsMs ?? [],
  );
  const frameCount = sumAvailable(frameSamples, "frameCount") ?? (
    frameDurations.length ? frameDurations.length : null
  );
  const jankyFrames = sumAvailable(frameSamples, "jankyFrames");
  const frozenFrames = sumAvailable(frameSamples, "frozenFrames");
  const weightedJankSamples = frameSamples.filter(
    (sample) => sample.jankRate !== null && sample.frameCount !== null,
  );
  const jankRate = frameCount && jankyFrames !== null
    ? round((jankyFrames / frameCount) * 100)
    : weightedJankSamples.length
      ? round(
          weightedJankSamples.reduce(
            (total, sample) => total + sample.jankRate * sample.frameCount,
            0,
          ) / weightedJankSamples.reduce(
            (total, sample) => total + sample.frameCount,
            0,
          ),
        )
      : summary.jankRate.average;
  summary.frames = {
    frameCount,
    activeFps: summary.activeFps.average,
    frameP50Ms: percentile(frameDurations, 0.5) ?? latestAvailable(frameSamples, "frameP50Ms"),
    frameP90Ms: percentile(frameDurations, 0.9) ?? latestAvailable(frameSamples, "frameP90Ms"),
    frameP95Ms: percentile(frameDurations, 0.95) ?? latestAvailable(frameSamples, "frameP95Ms"),
    frameP99Ms: percentile(frameDurations, 0.99) ?? latestAvailable(frameSamples, "frameP99Ms"),
    jankyFrames,
    jankRate,
    frozenFrames,
  };

  const networkSamples = normalized.filter((sample) => sample.metric === "network");
  const rxBytes = networkSamples.length
    ? sumAvailable(networkSamples, "rxBytes")
    : cumulativeDelta(normalized, "rxBytes");
  const txBytes = networkSamples.length
    ? sumAvailable(networkSamples, "txBytes")
    : cumulativeDelta(normalized, "txBytes");
  const rxBytesPerSecond = weightedAverageRate(
    networkSamples.length ? networkSamples : normalized,
    "networkRxBytesPerSecond",
  );
  const txBytesPerSecond = weightedAverageRate(
    networkSamples.length ? networkSamples : normalized,
    "networkTxBytesPerSecond",
  );
  summary.networkDelta = {
    rxBytes,
    txBytes,
    totalBytes: rxBytes === null && txBytes === null
      ? null
      : (rxBytes ?? 0) + (txBytes ?? 0),
  };
  summary.network = {
    ...summary.networkDelta,
    rxBytesPerSecond,
    txBytesPerSecond,
  };

  const batteryValues = normalized
    .map((sample) => sample.batteryLevel)
    .filter((value) => value !== null);
  summary.batteryDelta = batteryValues.length >= 2
    ? round(batteryValues.at(-1) - batteryValues[0])
    : null;
  summary.battery = {
    startLevel: summary.batteryLevel.first,
    endLevel: summary.batteryLevel.latest,
    levelChange: summary.batteryDelta,
    temperatureC: summary.batteryTemperatureC.latest,
    peakTemperatureC: summary.batteryTemperatureC.maximum,
    voltageMv: summary.batteryVoltageMv.latest,
    powered: latestAvailable(normalized, "batteryPowered"),
  };

  return summary;
}

function mergeSummary(computed, collectorSummary) {
  if (collectorSummary === null || collectorSummary === undefined) {
    return computed;
  }
  if (!isPlainObject(collectorSummary)) {
    fail("性能汇总格式无效", "INVALID_SUMMARY");
  }
  const sanitized = sanitizeMetadata(collectorSummary);
  return { ...computed, ...sanitized };
}

export function createPerformanceReport(data, options = {}) {
  if (!isPlainObject(data)) {
    fail("性能报告格式无效", "INVALID_REPORT");
  }
  if (
    data.samples === undefined &&
    data.timeSeries === undefined &&
    data.summary === undefined
  ) {
    fail("性能报告缺少采样或汇总数据", "INVALID_REPORT_DATA");
  }
  if (
    data.version !== undefined &&
    data.version !== ANDROID_PERFORMANCE_REPORT_VERSION
  ) {
    fail("性能报告版本不受支持", "UNSUPPORTED_REPORT_VERSION");
  }

  const now = normalizeTimestamp(options.now ?? data.createdAt ?? Date.now(), "createdAt");
  const rawSamples = data.samples ?? data.timeSeries ?? [];
  const samples = normalizeSamples(rawSamples);
  const computedSummary = summarizePerformanceSamples(samples);
  const startedAt = normalizeTimestamp(
    data.startedAt ?? data.startedAtMs ?? computedSummary.startedAt ?? now,
    "startedAt",
  );
  const endedAt = normalizeTimestamp(
    data.endedAt ?? data.endedAtMs ?? computedSummary.endedAt ?? startedAt,
    "endedAt",
  );
  if (endedAt < startedAt) {
    fail("性能报告结束时间不能早于开始时间", "INVALID_REPORT_RANGE");
  }

  const packageName = normalizePackageName(
    data.packageName ?? data.app?.packageName ?? data.target?.packageName,
  );
  const appMetadata = {
    ...(isPlainObject(data.target) ? sanitizeMetadata(data.target) : {}),
    ...(isPlainObject(data.app) ? sanitizeMetadata(data.app) : {}),
  };
  const deviceMetadata = isPlainObject(data.device)
    ? sanitizeMetadata(data.device)
    : {};
  delete deviceMetadata.serialNumber;
  delete deviceMetadata.serial;

  return {
    version: ANDROID_PERFORMANCE_REPORT_VERSION,
    id: normalizeReportId(options.id ?? data.id, now),
    createdAt: now,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    status: normalizeReportStatus(reportStatusFromData(data)),
    endReason: normalizeShortText(data.endReason ?? data.session?.endReason, 128),
    device: deviceMetadata,
    app: { ...appMetadata, packageName },
    config: isPlainObject(data.config) ? sanitizeMetadata(data.config) : {},
    capabilities: isPlainObject(data.capabilities)
      ? sanitizeMetadata(data.capabilities)
      : {},
    metrics: isPlainObject(data.metrics) ? sanitizeMetadata(data.metrics) : {},
    session: {
      phase: normalizeShortText(data.phase ?? data.session?.phase, 64),
      elapsedMs: normalizeNonNegativeNumber(data.elapsedMs ?? data.session?.elapsedMs),
      latest: isPlainObject(data.latest ?? data.session?.latest)
        ? sanitizeMetadata(data.latest ?? data.session.latest)
        : {},
    },
    summary: mergeSummary(computedSummary, data.summary),
    samples,
    notice: normalizeShortText(data.notice, 500) ?? ANDROID_PERFORMANCE_REPORT_NOTICE,
  };
}

export function validatePerformanceReport(value) {
  try {
    createPerformanceReport(value, {
      now: value?.createdAt,
      id: value?.id,
    });
    return true;
  } catch {
    return false;
  }
}

export function parsePerformanceReport(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      fail("性能报告 JSON 无法解析", "INVALID_REPORT_JSON");
    }
  }
  return createPerformanceReport(parsed, {
    now: parsed?.createdAt,
    id: parsed?.id,
  });
}

export function performanceReportToJson(report, { pretty = true } = {}) {
  const normalized = parsePerformanceReport(report);
  return JSON.stringify(normalized, null, pretty ? 2 : 0);
}

export function escapePerformanceCsvCell(value) {
  if (value === null || value === undefined) return "";
  let text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (typeof value === "string" && /^[=+\-@]/u.test(text.trimStart())) {
    text = `'${text}`;
  }
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function performanceReportToCsv(report, { includeBom = false } = {}) {
  const normalized = parsePerformanceReport(report);
  const headers = ANDROID_PERFORMANCE_SAMPLE_FIELDS;
  const rows = [headers.join(",")];
  for (const sample of normalized.samples) {
    rows.push(headers.map((field) => escapePerformanceCsvCell(sample[field])).join(","));
  }
  const csv = rows.join("\r\n");
  return includeBom ? `\uFEFF${csv}` : csv;
}

export function clonePerformanceReport(report) {
  return safeClone(parsePerformanceReport(report));
}

export const summarizePerformanceSession = summarizePerformanceSamples;
export const downsampleSeries = downsamplePerformanceSamples;
export const serializePerformanceReport = performanceReportToJson;
export const createPerformanceCsv = performanceReportToCsv;
