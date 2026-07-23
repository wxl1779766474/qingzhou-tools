import {
  ANDROID_COMMAND_IDS,
  AndroidCommandError,
  validateAndroidPackageName,
} from "./android-performance-commands.js";
import {
  computeNetworkDelta,
  parseBattery,
  parseCpuInfoCoreCount,
  parseCpuOnlineCoreCount,
  parseCpuInfo,
  parseCurrentUser,
  parseDisplayRefreshRate,
  parseDumpsysServices,
  parseForegroundPackage,
  parseGfxInfo,
  parseIntegerValue,
  parseLogicalCoreCount,
  parseMemInfo,
  parseNetstats,
  parsePackageInfo,
  parsePidof,
  parseProcessList,
  parseTextValue,
  parseThermalStatus,
  parseThirdPartyPackages,
  parseTopHelp,
  parseTopSnapshot,
  summarizeFrameStats,
} from "./android-performance-parsers.js";

const SCHEMA_VERSION = 1;
const METRIC_NAMES = Object.freeze([
  "cpu",
  "memory",
  "frame",
  "network",
  "battery",
  "thermal",
]);
const DEFAULT_INTERVALS = Object.freeze({
  memoryMs: 2_000,
  frameMs: 1_000,
  batteryMs: 5_000,
  thermalMs: 5_000,
  processMs: 5_000,
  cpuFallbackMs: 5_000,
});
const DEFAULT_COMMAND_TIMEOUT_MS = 4_000;
const DEFAULT_MAX_DURATION_MS = 60 * 60 * 1_000;
const DEFAULT_PROCESS_GRACE_MS = 10_000;
const DEFAULT_SAMPLE_LIMIT_PER_METRIC = 3_600;
const DEFAULT_CPU_TOP_WATCHDOG_MS = 3_500;
const DEFAULT_CPU_TOP_INVALID_BLOCK_LIMIT = 3;
const TOP_MAX_LINE_CHARS = 64 * 1_024;
const TOP_MAX_BLOCK_CHARS = 1_000_000;
const TOP_MAX_BUFFER_CHARS = 1_000_000;
const LOGICAL_CORE_COMMAND_IDS = Object.freeze([
  ANDROID_COMMAND_IDS.LOGICAL_CORES,
  ANDROID_COMMAND_IDS.LOGICAL_CORES_NPROC,
  ANDROID_COMMAND_IDS.LOGICAL_CORES_ONLINE,
  ANDROID_COMMAND_IDS.LOGICAL_CORES_CPUINFO,
]);

function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function defaultMonotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function normalizeClock(clock = {}) {
  return {
    now: typeof clock.now === "function" ? () => clock.now() : defaultMonotonicNow,
    wallNow: typeof clock.wallNow === "function" ? () => clock.wallNow() : () => Date.now(),
    setTimeout:
      typeof clock.setTimeout === "function"
        ? (callback, delay) => clock.setTimeout(callback, delay)
        : (callback, delay) => setTimeout(callback, delay),
    clearTimeout:
      typeof clock.clearTimeout === "function"
        ? (timer) => clock.clearTimeout(timer)
        : (timer) => clearTimeout(timer),
  };
}

function commandOutput(result) {
  if (typeof result === "string") return { stdout: result, durationMs: 0 };
  return {
    stdout: typeof result?.stdout === "string" ? result.stdout : "",
    durationMs: Number.isFinite(result?.durationMs) ? Math.max(0, result.durationMs) : 0,
  };
}

function errorReason(error, fallback = "command_failed") {
  if (typeof error?.reasonCode === "string") return error.reasonCode;
  if (typeof error?.code === "string") return error.code;
  return fallback;
}

function isAbortError(error, signal) {
  return Boolean(
    signal?.aborted
      || error?.name === "AbortError"
      || error?.code === "ABORT_ERR",
  );
}

function safeCallback(callback, value) {
  if (typeof callback !== "function") return;
  try {
    callback(value);
  } catch {
    // Consumer callbacks must never interrupt collection.
  }
}

async function inspectField(runner, commandId, args, parser, field, warnings) {
  try {
    const result = commandOutput(
      await runner.exec(commandId, args, {
        timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        maxBytes: 2_000_000,
      }),
    );
    const parsed = parser(result.stdout);
    if (!parsed.ok) {
      warnings.push(`${field}:${parsed.reasonCode}`);
      return null;
    }
    return parsed.value;
  } catch (error) {
    warnings.push(`${field}:${errorReason(error)}`);
    return null;
  }
}

async function discoverLogicalCores(readCommand) {
  let reason = "logical_cores_unavailable";
  for (const commandId of LOGICAL_CORE_COMMAND_IDS) {
    try {
      const result = commandOutput(await readCommand(commandId));
      const parsed = commandId === ANDROID_COMMAND_IDS.LOGICAL_CORES_ONLINE
        ? parseCpuOnlineCoreCount(result.stdout)
        : commandId === ANDROID_COMMAND_IDS.LOGICAL_CORES_CPUINFO
          ? parseCpuInfoCoreCount(result.stdout)
          : parseLogicalCoreCount(result.stdout);
      if (parsed.ok) return { value: parsed.value, commandId, reason: null };
      reason = `${commandId}:${parsed.reasonCode}`;
    } catch (error) {
      reason = `${commandId}:${errorReason(error)}`;
    }
  }
  return { value: null, commandId: null, reason };
}

async function inspectLogicalCores(runner, warnings) {
  const discovered = await discoverLogicalCores((commandId) => (
    runner.exec(commandId, {}, {
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      maxBytes: 2_000_000,
    })
  ));
  if (discovered.value === null) warnings.push(`logicalCores:${discovered.reason}`);
  return discovered.value;
}

/**
 * Reads non-sensitive device/app metadata without making any capability fatal.
 */
export async function inspectAndroidDevice(runner) {
  if (!runner || typeof runner.exec !== "function") {
    throw new TypeError("runner.exec 必须是函数");
  }

  const warnings = [];
  const [manufacturer, model, sdkVersion, androidVersion, logicalCores, currentUserId, displayText,
    foregroundText, topHelp, serviceNames] = await Promise.all([
    inspectField(runner, ANDROID_COMMAND_IDS.MANUFACTURER, {}, parseTextValue, "manufacturer", warnings),
    inspectField(runner, ANDROID_COMMAND_IDS.MODEL, {}, parseTextValue, "model", warnings),
    inspectField(
      runner,
      ANDROID_COMMAND_IDS.SDK_VERSION,
      {},
      (text) => parseIntegerValue(text, { minimum: 1, maximum: 999 }),
      "sdkVersion",
      warnings,
    ),
    inspectField(runner, ANDROID_COMMAND_IDS.ANDROID_VERSION, {}, parseTextValue, "androidVersion", warnings),
    inspectLogicalCores(runner, warnings),
    inspectField(runner, ANDROID_COMMAND_IDS.CURRENT_USER, {}, parseCurrentUser, "currentUserId", warnings),
    inspectField(runner, ANDROID_COMMAND_IDS.DISPLAY_INFO, {}, parseTextValue, "display", warnings),
    inspectField(runner, ANDROID_COMMAND_IDS.FOREGROUND_APP, {}, parseTextValue, "foregroundApp", warnings),
    inspectField(runner, ANDROID_COMMAND_IDS.TOP_HELP, {}, parseTopHelp, "top", warnings),
    inspectField(runner, ANDROID_COMMAND_IDS.DUMPSYS_SERVICES, {}, parseDumpsysServices, "services", warnings),
  ]);

  const refreshRate = displayText === null ? null : parseDisplayRefreshRate(displayText);
  if (refreshRate && !refreshRate.ok) warnings.push(`refreshRateHz:${refreshRate.reasonCode}`);
  const foreground = foregroundText === null ? null : parseForegroundPackage(foregroundText);
  if (foreground && !foreground.ok) warnings.push(`foregroundPackage:${foreground.reasonCode}`);

  const userId = currentUserId ?? 0;
  const thirdPartyPackages = await inspectField(
    runner,
    ANDROID_COMMAND_IDS.THIRD_PARTY_PACKAGES,
    { userId },
    parseThirdPartyPackages,
    "thirdPartyPackages",
    warnings,
  );
  const services = Array.isArray(serviceNames) ? new Set(serviceNames) : null;
  const hasService = (name) => (services === null ? null : services.has(name));

  return {
    schemaVersion: SCHEMA_VERSION,
    manufacturer,
    model,
    sdkVersion,
    androidVersion,
    logicalCores,
    refreshRateHz: refreshRate?.ok ? refreshRate.value : null,
    currentUserId: userId,
    foregroundPackage: foreground?.ok ? foreground.value : null,
    thirdPartyPackages: thirdPartyPackages ?? [],
    capabilities: {
      topStreaming: Boolean(
        typeof runner.open === "function"
          && topHelp?.batch
          && topHelp?.pidFilter
          && topHelp?.outputFields,
      ),
      frameStats: hasService("gfxinfo"),
      networkStats: hasService("netstats"),
      battery: hasService("battery"),
      thermal: hasService("thermalservice"),
    },
    warnings,
  };
}

function emptyMetricState() {
  return {
    state: "pending",
    source: null,
    consecutiveFailures: 0,
    totalFailures: 0,
    sampleCount: 0,
    reason: null,
  };
}

function createInitialSnapshot() {
  return {
    schemaVersion: SCHEMA_VERSION,
    phase: "idle",
    startedAtMs: null,
    endedAtMs: null,
    elapsedMs: 0,
    endReason: null,
    target: { packageName: null, uid: null, pids: [] },
    device: { logicalCores: null, refreshRateHz: null },
    latest: {
      cpuPercent: null,
      cpuRawPercent: null,
      memoryPssKb: null,
      memoryJavaHeapKb: null,
      memoryNativeHeapKb: null,
      memoryRssKb: null,
      frameDurationMs: null,
      frameDurationsMs: null,
      frameP50Ms: null,
      frameP90Ms: null,
      frameP95Ms: null,
      frameP99Ms: null,
      frameCount: null,
      activeFps: null,
      jankyFrames: null,
      jankRate: null,
      frozenFrames: null,
      batteryLevelPercent: null,
      batteryTemperatureC: null,
      batteryVoltageMv: null,
      batteryPowered: null,
      thermalStatus: null,
      networkRxBytes: null,
      networkTxBytes: null,
      networkRxBytesPerSecond: null,
      networkTxBytesPerSecond: null,
    },
    metrics: Object.fromEntries(METRIC_NAMES.map((name) => [name, emptyMetricState()])),
    samples: [],
  };
}

function positiveDuration(value, fallback, { minimum = 1, maximum = DEFAULT_MAX_DURATION_MS } = {}) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
}

function normalizeIntervals(config) {
  const supplied = config.intervals ?? {};
  const read = (name) => supplied[name] ?? config[name];
  return {
    memoryMs: positiveDuration(read("memoryMs"), DEFAULT_INTERVALS.memoryMs),
    frameMs: positiveDuration(read("frameMs"), DEFAULT_INTERVALS.frameMs),
    batteryMs: positiveDuration(read("batteryMs"), DEFAULT_INTERVALS.batteryMs),
    thermalMs: positiveDuration(read("thermalMs"), DEFAULT_INTERVALS.thermalMs),
    processMs: positiveDuration(read("processMs"), DEFAULT_INTERVALS.processMs),
    cpuFallbackMs: positiveDuration(read("cpuFallbackMs"), DEFAULT_INTERVALS.cpuFallbackMs),
  };
}

function normalizePidList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number))]
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
    .sort((a, b) => a - b);
}

function samePidList(left, right) {
  return left.length === right.length && left.every((pid, index) => pid === right[index]);
}

function metricFields(metric, value) {
  switch (metric) {
    case "cpu":
      return {
        cpuPercent: value.cpuPercent,
        cpuRawPercent: value.rawPercent,
      };
    case "memory":
      return {
        memoryPssKb: value.pssKb,
        memoryJavaHeapKb: value.javaHeapKb,
        memoryNativeHeapKb: value.nativeHeapKb,
        memoryRssKb: value.rssKb,
      };
    case "frame":
      return {
        frameDurationMs: value.frameDurationMs,
        frameDurationsMs: value.frameDurationsMs,
        frameP50Ms: value.frameP50Ms,
        frameP90Ms: value.frameP90Ms,
        frameP95Ms: value.frameP95Ms,
        frameP99Ms: value.frameP99Ms,
        frameCount: value.frameCount,
        activeFps: value.activeFps,
        jankyFrames: value.jankyFrames,
        jankRate: value.jankRate,
        frozenFrames: value.frozenFrames,
      };
    case "battery":
      return {
        batteryLevelPercent: value.levelPercent,
        batteryTemperatureC: value.temperatureC,
        batteryVoltageMv: value.voltageMv,
        batteryPowered: value.powered,
      };
    case "thermal":
      return { thermalStatus: value };
    case "network":
      return value;
    default:
      return {};
  }
}

function streamSource(handle) {
  return handle?.stdout ?? handle?.readable ?? handle;
}

async function* textChunks(source) {
  if (!source) return;
  if (typeof source === "string") {
    yield source;
    return;
  }

  const decoder = new TextDecoder();
  if (typeof source.getReader === "function") {
    const reader = source.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (typeof value === "string") yield value;
        else yield decoder.decode(value, { stream: true });
      }
      const tail = decoder.decode();
      if (tail) yield tail;
    } finally {
      reader.releaseLock?.();
    }
    return;
  }

  if (typeof source[Symbol.asyncIterator] === "function") {
    for await (const value of source) {
      if (typeof value === "string") yield value;
      else if (value !== undefined && value !== null) yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
    return;
  }

  throw new AndroidCommandError("streaming_unsupported", "ADB 流不是可读取的标准流");
}

function isTopHeader(line) {
  const fields = line.trim().split(/\s+/u).map((field) => field.toUpperCase());
  return fields.includes("PID") && fields.some((field) => field === "%CPU" || field === "CPU%");
}

function createTopBlockDecoder(onBlock) {
  let partial = "";
  let lines = [];
  let hasHeader = false;
  let blockChars = 0;

  const failTooLarge = (kind) => {
    partial = "";
    lines = [];
    hasHeader = false;
    blockChars = 0;
    throw new AndroidCommandError(
      "top_output_too_large",
      `top ${kind}超过安全上限`,
    );
  };

  const flush = () => {
    if (hasHeader && lines.length > 0) onBlock(lines.join("\n"));
    lines = [];
    hasHeader = false;
    blockChars = 0;
  };

  const addLine = (line) => {
    if (line.length > TOP_MAX_LINE_CHARS) failTooLarge("单行");
    if (isTopHeader(line) && hasHeader) flush();
    blockChars += line.length + 1;
    if (blockChars > TOP_MAX_BLOCK_CHARS) failTooLarge("采样块");
    lines.push(line);
    if (isTopHeader(line)) hasHeader = true;
    if (line.trim() === "" && hasHeader) flush();
  };

  return {
    push(chunk) {
      if (partial.length + chunk.length > TOP_MAX_BUFFER_CHARS) failTooLarge("缓冲区");
      partial += chunk;
      const complete = partial.split(/\r?\n/u);
      partial = complete.pop() ?? "";
      for (const line of complete) addLine(line);
    },
    finish() {
      if (partial) addLine(partial);
      flush();
      partial = "";
    },
  };
}

function sumNullable(values, key) {
  const present = values.map((value) => value[key]).filter(Number.isFinite);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : null;
}

async function findTargetProcesses(runner, packageName, uid, options = {}) {
  const signal = options.signal;
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const tryList = async (commandId) => {
    try {
      const result = commandOutput(
        await runner.exec(commandId, {}, { signal, timeoutMs, maxBytes: 2_000_000 }),
      );
      return parseProcessList(result.stdout, { packageName, uid });
    } catch (error) {
      return { ok: false, reasonCode: errorReason(error), retryable: true };
    }
  };

  let parsed = await tryList(ANDROID_COMMAND_IDS.PROCESS_LIST);
  if (!parsed.ok) parsed = await tryList(ANDROID_COMMAND_IDS.PROCESS_LIST_LEGACY);
  if (parsed.ok && parsed.value.pids.length > 0) return parsed.value;

  try {
    const result = commandOutput(
      await runner.exec(
        ANDROID_COMMAND_IDS.PIDOF,
        { packageName },
        { signal, timeoutMs, maxBytes: 64_000 },
      ),
    );
    const pidof = parsePidof(result.stdout);
    if (pidof.ok) {
      return {
        pids: pidof.value,
        processes: pidof.value.map((pid) => ({ pid, uid: uid ?? null, name: packageName })),
      };
    }
  } catch {
    // The empty result below is the portable representation for a stopped app.
  }
  return { pids: [], processes: [] };
}

/**
 * Coordinates one Android performance session. A session instance is single-use.
 */
export function createPerformanceSession({ runner, clock, onSample, onStatus } = {}) {
  if (!runner || typeof runner.exec !== "function") {
    throw new TypeError("runner.exec 必须是函数");
  }

  const timing = normalizeClock(clock);
  const snapshot = createInitialSnapshot();
  let config = null;
  let intervals = DEFAULT_INTERVALS;
  let sequence = 0;
  let startedAtMonotonic = null;
  let timer = null;
  let schedulerRunning = false;
  let schedulerPromise = null;
  let stopPromise = null;
  let sessionController = null;
  let tasks = [];
  let networkBaseline = null;
  let cpuHandle = null;
  let cpuController = null;
  let cpuGeneration = 0;
  let cpuConsumer = null;
  let cpuWatchdogTimer = null;
  let missingProcessSince = null;

  const elapsed = () => (
    startedAtMonotonic === null ? 0 : Math.max(0, timing.now() - startedAtMonotonic)
  );

  const getSnapshot = () => {
    if (snapshot.phase === "running" || snapshot.phase === "stopping") {
      snapshot.elapsedMs = Math.round(elapsed());
    }
    return clone(snapshot);
  };

  const emitStatus = (event) => {
    safeCallback(onStatus, { ...event, snapshot: getSnapshot() });
  };

  const markMetric = (metric, patch) => {
    Object.assign(snapshot.metrics[metric], patch);
    emitStatus({
      type: "metric",
      metric,
      state: snapshot.metrics[metric].state,
      reason: snapshot.metrics[metric].reason,
    });
  };

  const metricFailure = (metric, reason, { retryable = true, allowPause = true } = {}) => {
    const state = snapshot.metrics[metric];
    state.consecutiveFailures += 1;
    state.totalFailures += 1;
    state.reason = reason;
    if (!retryable) state.state = "unsupported";
    else if (allowPause && state.consecutiveFailures >= 3) state.state = "paused";
    else state.state = "degraded";
    emitStatus({ type: "metric", metric, state: state.state, reason });
    return state.state;
  };

  const metricSuccess = (metric, source, { degraded = false } = {}) => {
    const state = snapshot.metrics[metric];
    state.state = degraded ? "degraded" : "supported";
    state.source = source;
    state.consecutiveFailures = 0;
    state.reason = degraded ? state.reason : null;
  };

  const appendSample = (metric, source, value, durationMs, diagnostics = undefined, options = {}) => {
    metricSuccess(metric, source, options);
    const state = snapshot.metrics[metric];
    state.sampleCount += 1;
    const fields = metricFields(metric, value);
    const sampleElapsedMs = Math.round(elapsed());
    const sample = {
      schemaVersion: SCHEMA_VERSION,
      sequence: ++sequence,
      metric,
      timestampMs: Math.round(snapshot.startedAtMs + sampleElapsedMs),
      elapsedMs: sampleElapsedMs,
      durationMs: Math.max(0, Number(durationMs) || 0),
      source,
      status: options.degraded ? "degraded" : "ok",
      ...fields,
      ...(diagnostics ? { diagnostics } : {}),
    };
    Object.assign(snapshot.latest, fields);
    snapshot.samples.push(sample);

    const limit = config.sampleLimitPerMetric;
    const metricIndexes = [];
    for (let index = 0; index < snapshot.samples.length; index += 1) {
      if (snapshot.samples[index].metric === metric) metricIndexes.push(index);
    }
    if (metricIndexes.length > limit) snapshot.samples.splice(metricIndexes[0], 1);
    safeCallback(onSample, clone(sample));
  };

  const exec = async (commandId, args = {}, { final = false, maxBytes = 2_000_000 } = {}) => (
    commandOutput(
      await runner.exec(commandId, args, {
        signal: final ? undefined : sessionController?.signal,
        timeoutMs: config.commandTimeoutMs,
        maxBytes,
      }),
    )
  );

  const taskEnabled = (metric) => !["paused", "unsupported"].includes(snapshot.metrics[metric].state);

  const collectMemory = async (options = {}) => {
    if (!taskEnabled("memory") || snapshot.target.pids.length === 0) return;
    const results = [];
    let totalDuration = 0;
    let failures = 0;
    for (const pid of snapshot.target.pids) {
      try {
        const result = await exec(ANDROID_COMMAND_IDS.MEMINFO, { pid }, options);
        totalDuration += result.durationMs;
        const parsed = parseMemInfo(result.stdout);
        if (parsed.ok) results.push(parsed.value);
        else failures += 1;
      } catch (error) {
        if (!isAbortError(error, sessionController?.signal)) failures += 1;
      }
    }
    if (results.length === 0) {
      if (snapshot.phase === "running" || options.final) metricFailure("memory", "meminfo_unavailable");
      return;
    }
    appendSample(
      "memory",
      "meminfo",
      {
        pssKb: sumNullable(results, "pssKb"),
        javaHeapKb: sumNullable(results, "javaHeapKb"),
        nativeHeapKb: sumNullable(results, "nativeHeapKb"),
        rssKb: sumNullable(results, "rssKb"),
      },
      totalDuration,
      failures > 0 ? { partial: true, failedProcessCount: failures } : undefined,
    );
  };

  const collectFrames = async (options = {}) => {
    if (!taskEnabled("frame")) return;
    try {
      const result = await exec(
        ANDROID_COMMAND_IDS.GFXINFO_FRAMESTATS,
        { packageName: snapshot.target.packageName },
        options,
      );
      const parsed = parseGfxInfo(result.stdout);
      if (!parsed.ok) {
        metricFailure("frame", parsed.reasonCode, { retryable: parsed.retryable });
        return;
      }
      const summary = summarizeFrameStats(parsed.value.frames, {
        refreshRateHz: snapshot.device.refreshRateHz,
      });
      appendSample(
        "frame",
        "gfxinfo",
        summary,
        result.durationMs,
        parsed.warnings.length > 0 ? { warnings: parsed.warnings } : undefined,
      );
    } catch (error) {
      if (!isAbortError(error, sessionController?.signal)) metricFailure("frame", errorReason(error));
    }
  };

  const collectBattery = async (options = {}) => {
    if (!taskEnabled("battery")) return;
    try {
      const result = await exec(ANDROID_COMMAND_IDS.BATTERY, {}, options);
      const parsed = parseBattery(result.stdout);
      if (!parsed.ok) {
        metricFailure("battery", parsed.reasonCode, { retryable: parsed.retryable });
        return;
      }
      appendSample("battery", "battery", parsed.value, result.durationMs);
    } catch (error) {
      if (!isAbortError(error, sessionController?.signal)) metricFailure("battery", errorReason(error));
    }
  };

  const collectThermal = async (options = {}) => {
    if (!taskEnabled("thermal")) return;
    try {
      const result = await exec(ANDROID_COMMAND_IDS.THERMAL, {}, options);
      const parsed = parseThermalStatus(result.stdout);
      if (!parsed.ok) {
        metricFailure("thermal", parsed.reasonCode, { retryable: parsed.retryable });
        return;
      }
      appendSample("thermal", "thermalservice", parsed.value, result.durationMs);
    } catch (error) {
      if (!isAbortError(error, sessionController?.signal)) metricFailure("thermal", errorReason(error));
    }
  };

  const collectCpuFallback = async () => {
    if (!taskEnabled("cpu") || snapshot.target.pids.length === 0) return;
    try {
      const result = await exec(ANDROID_COMMAND_IDS.CPUINFO);
      const parsed = parseCpuInfo(result.stdout, {
        targetPids: snapshot.target.pids,
        logicalCores: snapshot.device.logicalCores,
      });
      if (!parsed.ok || !parsed.value.found) {
        metricFailure("cpu", parsed.reasonCode ?? "target_not_in_cpuinfo");
        return;
      }
      appendSample(
        "cpu",
        "cpuinfo",
        parsed.value,
        result.durationMs,
        { pids: parsed.value.matchedPids, normalization: parsed.value.normalization },
        { degraded: true },
      );
    } catch (error) {
      if (!isAbortError(error, sessionController?.signal)) metricFailure("cpu", errorReason(error));
    }
  };

  const clearCpuWatchdog = () => {
    if (cpuWatchdogTimer !== null) timing.clearTimeout(cpuWatchdogTimer);
    cpuWatchdogTimer = null;
  };

  const enableCpuFallback = (reason) => {
    clearCpuWatchdog();
    const fallback = tasks.find((task) => task.name === "cpu-fallback");
    if (fallback) {
      fallback.enabled = true;
      fallback.nextDue = Math.min(fallback.nextDue, timing.now());
    }
    markMetric("cpu", {
      state: "degraded",
      source: "cpuinfo",
      reason,
    });
  };

  const disableCpuFallback = () => {
    const fallback = tasks.find((task) => task.name === "cpu-fallback");
    if (fallback) fallback.enabled = false;
  };

  const transitionTopToFallback = async (generationState, reason) => {
    if (
      generationState.fallbackTriggered
      || generationState.generation !== cpuGeneration
      || snapshot.phase !== "running"
    ) {
      return;
    }
    generationState.fallbackTriggered = true;
    const stoppedGeneration = generationState.generation + 1;
    await stopCpuStream();
    if (snapshot.phase !== "running" || cpuGeneration !== stoppedGeneration) return;
    enableCpuFallback(reason);
    armScheduler();
  };

  const recordInvalidTopBlock = (generationState) => {
    generationState.invalidBlocks += 1;
    if (generationState.invalidBlocks >= config.cpuTopInvalidBlockLimit) {
      void transitionTopToFallback(generationState, "top_invalid_blocks");
    }
  };

  const processTopBlock = (text, generationState) => {
    if (snapshot.phase !== "running" || generationState.generation !== cpuGeneration) return;
    const parsed = parseTopSnapshot(text, {
      targetPids: snapshot.target.pids,
      logicalCores: snapshot.device.logicalCores,
      cpuMode: "per-core",
    });
    if (
      !parsed.ok
      || !parsed.value.found
      || !Number.isFinite(parsed.value.cpuPercent)
    ) {
      recordInvalidTopBlock(generationState);
      return;
    }
    generationState.invalidBlocks = 0;
    if (!generationState.hasBaseline) {
      generationState.hasBaseline = true;
      return;
    }
    appendSample(
      "cpu",
      "top",
      parsed.value,
      0,
      {
        pids: parsed.value.matchedPids,
        normalization: parsed.value.normalization,
        capacityPercent: parsed.value.capacityPercent,
      },
    );
    generationState.hasSample = true;
    clearCpuWatchdog();
    disableCpuFallback();
  };

  const stopCpuStream = async () => {
    clearCpuWatchdog();
    cpuGeneration += 1;
    cpuController?.abort(new AndroidCommandError("stream_stopped", "CPU 采集流已停止"));
    const handle = cpuHandle;
    const consumer = cpuConsumer;
    cpuHandle = null;
    cpuController = null;
    try {
      await handle?.kill?.();
    } catch {
      // A closed transport is already the desired state.
    }
    try {
      handle?.__androidRunnerCleanup?.();
    } catch {
      // Cleanup is best effort and idempotent.
    }
    if (consumer) await consumer;
    if (cpuConsumer === consumer) cpuConsumer = null;
  };

  const startCpuStream = async () => {
    if (typeof runner.open !== "function" || snapshot.target.pids.length === 0) {
      enableCpuFallback("top_stream_unavailable");
      return false;
    }

    await stopCpuStream();
    const generation = cpuGeneration;
    const controller = new AbortController();
    cpuController = controller;
    try {
      cpuHandle = await runner.open(
        ANDROID_COMMAND_IDS.TOP_STREAM,
        { pids: snapshot.target.pids },
        { signal: controller.signal, maxBytes: 4_000_000 },
      );
    } catch (error) {
      if (generation === cpuGeneration) enableCpuFallback(errorReason(error, "top_stream_unavailable"));
      return false;
    }

    const handle = cpuHandle;
    const generationState = {
      generation,
      hasBaseline: false,
      hasSample: false,
      invalidBlocks: 0,
      fallbackTriggered: false,
    };
    const decoder = createTopBlockDecoder((block) => processTopBlock(block, generationState));
    let streamFailureReason = null;
    const stderrConsumer = handle?.stderr
      ? (async () => {
          for await (const _chunk of textChunks(handle.stderr)) {
            // shell_v2 stdout and stderr are separate streams. stderr must be
            // drained concurrently or its backpressure can stall the device.
          }
        })().catch(() => {})
      : Promise.resolve();
    const stdoutConsumer = (async () => {
      try {
        for await (const chunk of textChunks(streamSource(handle))) decoder.push(chunk);
        decoder.finish();
      } catch (error) {
        if (!isAbortError(error, controller.signal) && generation === cpuGeneration) {
          streamFailureReason = errorReason(error, "top_stream_failed");
          metricFailure("cpu", streamFailureReason, { allowPause: false });
          controller.abort(error);
          try {
            await handle?.kill?.();
          } catch {
            // The stream is already unusable; fallback collection will take over.
          }
        }
      }
    })();
    cpuConsumer = Promise.allSettled([stdoutConsumer, stderrConsumer]).then(() => {
      try {
        handle?.__androidRunnerCleanup?.();
      } catch {
        // Runner cleanup is best effort and may already have run during stop.
      }
      if (generation === cpuGeneration && snapshot.phase === "running") {
        clearCpuWatchdog();
        if (streamFailureReason || !controller.signal.aborted) {
          enableCpuFallback(streamFailureReason ?? "top_stream_closed");
          armScheduler();
        }
      }
    });
    Promise.resolve(handle?.exited).catch(() => {});
    markMetric("cpu", {
      state: "probing",
      source: "top",
      reason: "top_waiting_for_sample",
    });
    cpuWatchdogTimer = timing.setTimeout(() => {
      cpuWatchdogTimer = null;
      if (!generationState.hasSample) {
        void transitionTopToFallback(generationState, "top_first_sample_timeout");
      }
    }, config.cpuTopWatchdogMs);
    return true;
  };

  const refreshProcesses = async () => {
    if (snapshot.phase !== "running") return;
    const found = await findTargetProcesses(
      runner,
      snapshot.target.packageName,
      snapshot.target.uid,
      { signal: sessionController.signal, timeoutMs: config.commandTimeoutMs },
    );
    if (found.pids.length === 0) {
      if (missingProcessSince === null) {
        missingProcessSince = timing.now();
        emitStatus({ type: "target", reason: "process-restarting", pids: [] });
      }
      if (timing.now() - missingProcessSince >= config.processRestartGraceMs) {
        void stop("process-exited");
      }
      return;
    }

    missingProcessSince = null;
    if (!samePidList(snapshot.target.pids, found.pids)) {
      snapshot.target.pids = found.pids;
      emitStatus({ type: "target", pids: [...found.pids] });
      await startCpuStream();
    }
  };

  const addTask = (name, intervalMs, offsetMs, priority, run, enabled = true) => {
    tasks.push({
      name,
      intervalMs,
      nextDue: startedAtMonotonic + offsetMs,
      priority,
      run,
      enabled,
      oneShot: false,
    });
  };

  const clearScheduler = () => {
    if (timer !== null) timing.clearTimeout(timer);
    timer = null;
  };

  const runScheduler = async () => {
    if (schedulerRunning || snapshot.phase !== "running") return;
    schedulerRunning = true;
    clearScheduler();
    try {
      while (snapshot.phase === "running") {
        const now = timing.now();
        const due = tasks
          .filter((task) => task.enabled && task.nextDue <= now)
          .sort((left, right) => left.priority - right.priority || left.nextDue - right.nextDue);
        if (due.length === 0) break;

        for (const task of due) {
          if (snapshot.phase !== "running" || !task.enabled) break;
          if (task.oneShot) task.enabled = false;
          try {
            await task.run();
          } catch (error) {
            if (!isAbortError(error, sessionController?.signal)) {
              emitStatus({ type: "scheduler", reason: errorReason(error) });
            }
          } finally {
            // Schedule from completion, so a slow ADB command never triggers a
            // catch-up burst that increases measurement overhead.
            if (!task.oneShot) task.nextDue = timing.now() + task.intervalMs;
          }
        }
      }
    } finally {
      schedulerRunning = false;
      armScheduler();
    }
  };

  function armScheduler() {
    clearScheduler();
    if (snapshot.phase !== "running" || schedulerRunning) return;
    const enabled = tasks.filter((task) => task.enabled);
    if (enabled.length === 0) return;
    const nextDue = Math.min(...enabled.map((task) => task.nextDue));
    timer = timing.setTimeout(() => {
      timer = null;
      const active = runScheduler();
      schedulerPromise = active;
      void active.then(
        () => {
          if (schedulerPromise === active) schedulerPromise = null;
        },
        () => {
          if (schedulerPromise === active) schedulerPromise = null;
        },
      );
    }, Math.max(0, nextDue - timing.now()));
  }

  const readPackageInfo = async (packageName) => {
    try {
      const result = await exec(ANDROID_COMMAND_IDS.PACKAGE_INFO, { packageName });
      const parsed = parsePackageInfo(result.stdout, packageName);
      return parsed.ok ? parsed.value : null;
    } catch {
      return null;
    }
  };

  const readNetworkSnapshot = async (options = {}) => {
    if (!Number.isSafeInteger(snapshot.target.uid)) return null;
    try {
      const result = await exec(ANDROID_COMMAND_IDS.NETSTATS_SNAPSHOT, {}, options);
      const parsed = parseNetstats(result.stdout, { uid: snapshot.target.uid });
      if (!parsed.ok) {
        metricFailure("network", parsed.reasonCode, { retryable: parsed.retryable });
        return null;
      }
      return { value: parsed.value, durationMs: result.durationMs };
    } catch (error) {
      metricFailure("network", errorReason(error));
      return null;
    }
  };

  const start = async (startConfig = {}) => {
    if (snapshot.phase !== "idle") {
      throw new AndroidCommandError("session_already_started", "性能会话实例只能启动一次");
    }
    const packageName = validateAndroidPackageName(startConfig.packageName);
    intervals = normalizeIntervals(startConfig);
    config = {
      packageName,
      commandTimeoutMs: positiveDuration(
        startConfig.commandTimeoutMs,
        DEFAULT_COMMAND_TIMEOUT_MS,
        { minimum: 50, maximum: 60_000 },
      ),
      maxDurationMs: positiveDuration(startConfig.maxDurationMs, DEFAULT_MAX_DURATION_MS),
      processRestartGraceMs: positiveDuration(
        startConfig.processRestartGraceMs,
        DEFAULT_PROCESS_GRACE_MS,
        { minimum: 1, maximum: 5 * 60_000 },
      ),
      sampleLimitPerMetric: Math.max(
        1,
        Math.min(
          100_000,
          Number.isSafeInteger(startConfig.sampleLimitPerMetric)
            ? startConfig.sampleLimitPerMetric
            : DEFAULT_SAMPLE_LIMIT_PER_METRIC,
        ),
      ),
      cpuTopWatchdogMs: positiveDuration(
        startConfig.cpuTopWatchdogMs,
        DEFAULT_CPU_TOP_WATCHDOG_MS,
        { minimum: 10, maximum: 60_000 },
      ),
      cpuTopInvalidBlockLimit: Math.max(
        1,
        Math.min(
          100,
          Number.isSafeInteger(startConfig.cpuTopInvalidBlockLimit)
            ? startConfig.cpuTopInvalidBlockLimit
            : DEFAULT_CPU_TOP_INVALID_BLOCK_LIMIT,
        ),
      ),
    };
    sessionController = new AbortController();
    const ensurePreparing = () => {
      if (snapshot.phase !== "preparing" || sessionController.signal.aborted) {
        throw new AndroidCommandError("session_stopped", "性能会话已在准备期间停止");
      }
    };
    snapshot.phase = "preparing";
    snapshot.target.packageName = packageName;
    emitStatus({ type: "session", phase: "preparing" });

    const suppliedCores = Number(startConfig.logicalCores ?? startConfig.device?.logicalCores);
    const suppliedRefresh = Number(startConfig.refreshRateHz ?? startConfig.device?.refreshRateHz);
    if (Number.isFinite(suppliedCores) && suppliedCores > 0) snapshot.device.logicalCores = suppliedCores;
    if (Number.isFinite(suppliedRefresh) && suppliedRefresh > 0) snapshot.device.refreshRateHz = suppliedRefresh;

    if (snapshot.device.logicalCores === null) {
      const discovered = await discoverLogicalCores((commandId) => exec(commandId));
      snapshot.device.logicalCores = discovered.value;
      ensurePreparing();
    }
    if (snapshot.device.refreshRateHz === null) {
      try {
        const parsed = parseDisplayRefreshRate((await exec(ANDROID_COMMAND_IDS.DISPLAY_INFO)).stdout);
        if (parsed.ok) snapshot.device.refreshRateHz = parsed.value;
      } catch {
        // Frame durations remain useful without a refresh-rate-derived budget.
      }
      ensurePreparing();
    }

    const packageInfo = await readPackageInfo(packageName);
    ensurePreparing();
    const hasSuppliedUid = startConfig.uid !== null
      && startConfig.uid !== undefined
      && startConfig.uid !== "";
    const suppliedUid = hasSuppliedUid ? Number(startConfig.uid) : Number.NaN;
    snapshot.target.uid = Number.isSafeInteger(suppliedUid) && suppliedUid >= 0
      ? suppliedUid
      : packageInfo?.uid ?? null;
    let pids = normalizePidList(startConfig.pids);
    if (pids.length === 0) {
      const found = await findTargetProcesses(
        runner,
        packageName,
        snapshot.target.uid,
        { signal: sessionController.signal, timeoutMs: config.commandTimeoutMs },
      );
      pids = found.pids;
    }
    ensurePreparing();
    if (pids.length === 0) {
      snapshot.phase = "error";
      snapshot.endReason = "target-not-running";
      emitStatus({ type: "session", phase: "error", reason: snapshot.endReason });
      throw new AndroidCommandError("target_not_running", "目标 App 当前没有运行中的进程");
    }
    snapshot.target.pids = pids;

    if (snapshot.target.uid === null) {
      markMetric("network", {
        state: "unsupported",
        reason: "uid_unavailable",
      });
    } else {
      networkBaseline = await readNetworkSnapshot();
      ensurePreparing();
      if (networkBaseline) metricSuccess("network", "netstats");
    }

    try {
      await exec(ANDROID_COMMAND_IDS.GFXINFO_RESET, { packageName });
    } catch (error) {
      metricFailure("frame", errorReason(error));
    }
    ensurePreparing();

    startedAtMonotonic = timing.now();
    snapshot.startedAtMs = Math.round(timing.wallNow());
    snapshot.phase = "running";
    emitStatus({ type: "session", phase: "running" });

    addTask("memory", intervals.memoryMs, 0, 20, collectMemory);
    addTask("frame", intervals.frameMs, Math.min(250, intervals.frameMs), 30, collectFrames);
    addTask("battery", intervals.batteryMs, Math.min(500, intervals.batteryMs), 40, collectBattery);
    addTask("thermal", intervals.thermalMs, Math.min(750, intervals.thermalMs), 50, collectThermal);
    addTask("process", intervals.processMs, intervals.processMs, 10, refreshProcesses);
    addTask("cpu-fallback", intervals.cpuFallbackMs, intervals.cpuFallbackMs, 15, collectCpuFallback, false);
    tasks.push({
      name: "auto-stop",
      intervalMs: config.maxDurationMs,
      nextDue: startedAtMonotonic + config.maxDurationMs,
      priority: 0,
      run: async () => {
        // Yield once so armScheduler has published the active scheduler
        // promise before stop waits for it.
        await Promise.resolve();
        void stop("max-duration");
      },
      enabled: true,
      oneShot: true,
    });

    await startCpuStream();
    armScheduler();
    return getSnapshot();
  };

  async function stop(reason = "manual") {
    if (stopPromise) return stopPromise;
    if (snapshot.phase === "completed" || snapshot.phase === "error") return getSnapshot();
    if (snapshot.phase !== "running" && snapshot.phase !== "preparing") return getSnapshot();

    stopPromise = (async () => {
      const wasRunning = snapshot.phase === "running";
      const activeScheduler = schedulerPromise;
      snapshot.phase = "stopping";
      snapshot.endReason = reason;
      snapshot.elapsedMs = Math.round(elapsed());
      clearScheduler();
      sessionController?.abort(new AndroidCommandError("session_stopped", "性能采集会话已停止"));
      await stopCpuStream();
      if (activeScheduler) await activeScheduler;
      emitStatus({ type: "session", phase: "stopping", reason });

      const transportAvailable = !["device-disconnected", "disconnected", "connection-error"].includes(reason);
      if (transportAvailable && wasRunning) {
        await collectMemory({ final: true });
        await collectFrames({ final: true });
        const networkEnd = await readNetworkSnapshot({ final: true });
        if (networkBaseline && networkEnd) {
          const delta = computeNetworkDelta(
            networkBaseline.value,
            networkEnd.value,
            snapshot.elapsedMs,
          );
          if (delta.ok) {
            appendSample(
              "network",
              "netstats",
              delta.value,
              networkEnd.durationMs,
              { uid: snapshot.target.uid },
            );
          } else {
            metricFailure("network", delta.reasonCode, { retryable: delta.retryable });
          }
        }
      }

      snapshot.elapsedMs = Math.round(elapsed());
      snapshot.endedAtMs = snapshot.startedAtMs === null
        ? Math.round(timing.wallNow())
        : Math.round(snapshot.startedAtMs + snapshot.elapsedMs);
      snapshot.phase = "completed";
      emitStatus({ type: "session", phase: "completed", reason });
      return getSnapshot();
    })();
    return stopPromise;
  }

  return Object.freeze({ start, stop, getSnapshot });
}

function asyncChunkStream(chunks, { signal, keepOpen = false } = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        if (signal?.aborted) return;
        yield chunk;
      }
      if (!keepOpen || signal?.aborted) return;
      await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
    },
  };
}

function scriptedValue(source, index, context) {
  let value = source;
  if (Array.isArray(source)) value = source[Math.min(index, source.length - 1)];
  if (typeof value === "function") value = value(context);
  return value;
}

/**
 * Deterministic fake used by collector tests and UI demos.
 * `commands[id]` may be a value, function or response queue.
 * `streams[id]` may be a handle or `{ chunks, keepOpen }`.
 */
export function createFakeRunner(script = {}) {
  const commands = { ...(script.commands ?? {}) };
  const streams = { ...(script.streams ?? {}) };
  const calls = [];
  const indexes = new Map();
  let closed = false;

  const next = async (kind, id, args, options) => {
    const key = `${kind}:${id}`;
    const index = indexes.get(key) ?? 0;
    indexes.set(key, index + 1);
    const table = kind === "open" ? streams : commands;
    const source = table[id] ?? (kind === "exec" ? script[id] : undefined);
    const value = await scriptedValue(source, index, { id, args, options, index, calls });
    if (value instanceof Error) throw value;
    if (value?.error instanceof Error) throw value.error;
    return value;
  };

  const fake = {
    calls,
    async exec(id, args = {}, options = {}) {
      if (closed) throw new AndroidCommandError("runner_closed", "Fake runner 已关闭");
      calls.push({ type: "exec", id, args: clone(args), options });
      const value = await next("exec", id, args, options);
      if (typeof value === "string") return { stdout: value, durationMs: 0, exitCode: 0 };
      return value ?? { stdout: "", durationMs: 0, exitCode: 0 };
    },
    async open(id, args = {}, options = {}) {
      if (closed) throw new AndroidCommandError("runner_closed", "Fake runner 已关闭");
      calls.push({ type: "open", id, args: clone(args), options });
      const value = await next("open", id, args, options);
      if (value === undefined) {
        throw new AndroidCommandError("streaming_unsupported", "未配置 Fake 流");
      }
      if (value?.stdout || typeof value?.[Symbol.asyncIterator] === "function") return value;
      const chunks = Array.isArray(value?.chunks) ? value.chunks : [String(value)];
      return {
        stdout: asyncChunkStream(chunks, {
          signal: options.signal,
          keepOpen: Boolean(value?.keepOpen),
        }),
        kill: async () => {},
      };
    },
    set(id, value, { stream = false } = {}) {
      (stream ? streams : commands)[id] = value;
      indexes.delete(`${stream ? "open" : "exec"}:${id}`);
    },
    async close() {
      closed = true;
    },
  };
  return fake;
}
