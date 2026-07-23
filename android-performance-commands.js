const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u;
const MAX_PACKAGE_NAME_LENGTH = 255;
const MAX_PID_COUNT = 128;

export const ANDROID_COMMAND_IDS = Object.freeze({
  SDK_VERSION: "sdk-version",
  ANDROID_VERSION: "android-version",
  MANUFACTURER: "manufacturer",
  MODEL: "model",
  LOGICAL_CORES: "logical-cores",
  LOGICAL_CORES_NPROC: "logical-cores-nproc",
  LOGICAL_CORES_ONLINE: "logical-cores-online",
  LOGICAL_CORES_CPUINFO: "logical-cores-cpuinfo",
  CURRENT_USER: "current-user",
  DISPLAY_INFO: "display-info",
  FOREGROUND_APP: "foreground-app",
  THIRD_PARTY_PACKAGES: "third-party-packages",
  PACKAGE_INFO: "package-info",
  PROCESS_LIST: "process-list",
  PROCESS_LIST_LEGACY: "process-list-legacy",
  PIDOF: "pidof",
  TOP_HELP: "top-help",
  TOP_STREAM: "top-stream",
  CPUINFO: "cpuinfo",
  MEMINFO: "meminfo",
  GFXINFO_RESET: "gfxinfo-reset",
  GFXINFO_FRAMESTATS: "gfxinfo-framestats",
  NETSTATS_SNAPSHOT: "netstats-snapshot",
  BATTERY: "battery",
  THERMAL: "thermal",
  DUMPSYS_SERVICES: "dumpsys-services",
});

const KNOWN_COMMAND_IDS = new Set(Object.values(ANDROID_COMMAND_IDS));

export class AndroidCommandError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "AndroidCommandError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function validateAndroidPackageName(value) {
  if (typeof value !== "string") {
    throw new AndroidCommandError("invalid_package", "Android 包名必须是字符串");
  }

  const packageName = value.trim();
  if (
    packageName.length === 0 ||
    packageName.length > MAX_PACKAGE_NAME_LENGTH ||
    !PACKAGE_NAME_PATTERN.test(packageName)
  ) {
    throw new AndroidCommandError("invalid_package", "Android 包名格式无效");
  }
  return packageName;
}

export const validateAndroidPackage = validateAndroidPackageName;

export function validateAndroidPid(value) {
  return validateNonNegativeInteger(value, "PID", { minimum: 1, maximum: 2_147_483_647 });
}

export function validateAndroidUid(value) {
  return validateNonNegativeInteger(value, "UID", { minimum: 0, maximum: 2_147_483_647 });
}

function validateNonNegativeInteger(value, label, { minimum, maximum }) {
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new AndroidCommandError(
      `invalid_${label.toLowerCase()}`,
      `${label} 必须是 ${minimum} 到 ${maximum} 之间的整数`,
    );
  }
  return number;
}

function validatePidList(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PID_COUNT) {
    throw new AndroidCommandError(
      "invalid_pid_list",
      `PID 列表必须包含 1 到 ${MAX_PID_COUNT} 个元素`,
    );
  }
  return [...new Set(value.map(validateAndroidPid))].sort((a, b) => a - b);
}

function requireKnownCommandId(commandId) {
  if (!KNOWN_COMMAND_IDS.has(commandId)) {
    throw new AndroidCommandError("command_not_allowed", "该 Android 命令不在白名单中");
  }
}

export function buildAndroidCommand(commandId, args = {}) {
  requireKnownCommandId(commandId);

  switch (commandId) {
    case ANDROID_COMMAND_IDS.SDK_VERSION:
      return ["getprop", "ro.build.version.sdk"];
    case ANDROID_COMMAND_IDS.ANDROID_VERSION:
      return ["getprop", "ro.build.version.release"];
    case ANDROID_COMMAND_IDS.MANUFACTURER:
      return ["getprop", "ro.product.manufacturer"];
    case ANDROID_COMMAND_IDS.MODEL:
      return ["getprop", "ro.product.model"];
    case ANDROID_COMMAND_IDS.LOGICAL_CORES:
      return ["getconf", "_NPROCESSORS_ONLN"];
    case ANDROID_COMMAND_IDS.LOGICAL_CORES_NPROC:
      return ["nproc"];
    case ANDROID_COMMAND_IDS.LOGICAL_CORES_ONLINE:
      return ["cat", "/sys/devices/system/cpu/online"];
    case ANDROID_COMMAND_IDS.LOGICAL_CORES_CPUINFO:
      return ["cat", "/proc/cpuinfo"];
    case ANDROID_COMMAND_IDS.CURRENT_USER:
      return ["am", "get-current-user"];
    case ANDROID_COMMAND_IDS.DISPLAY_INFO:
      return ["dumpsys", "display"];
    case ANDROID_COMMAND_IDS.FOREGROUND_APP:
      return ["dumpsys", "activity", "activities"];
    case ANDROID_COMMAND_IDS.THIRD_PARTY_PACKAGES: {
      const userId = validateAndroidUid(args.userId ?? 0);
      return ["pm", "list", "packages", "-3", "-U", "--user", String(userId)];
    }
    case ANDROID_COMMAND_IDS.PACKAGE_INFO:
      return ["dumpsys", "package", validateAndroidPackageName(args.packageName)];
    case ANDROID_COMMAND_IDS.PROCESS_LIST:
      return ["ps", "-A", "-o", "PID,UID,NAME"];
    case ANDROID_COMMAND_IDS.PROCESS_LIST_LEGACY:
      return ["ps"];
    case ANDROID_COMMAND_IDS.PIDOF:
      return ["pidof", validateAndroidPackageName(args.packageName)];
    case ANDROID_COMMAND_IDS.TOP_HELP:
      return ["top", "--help"];
    case ANDROID_COMMAND_IDS.TOP_STREAM: {
      const pids = validatePidList(args.pids);
      return ["top", "-b", "-d", "1", "-p", pids.join(","), "-o", "PID,%CPU,ARGS"];
    }
    case ANDROID_COMMAND_IDS.CPUINFO:
      return ["dumpsys", "cpuinfo"];
    case ANDROID_COMMAND_IDS.MEMINFO:
      return ["dumpsys", "meminfo", String(validateAndroidPid(args.pid))];
    case ANDROID_COMMAND_IDS.GFXINFO_RESET:
      return ["dumpsys", "gfxinfo", validateAndroidPackageName(args.packageName), "reset"];
    case ANDROID_COMMAND_IDS.GFXINFO_FRAMESTATS:
      return [
        "dumpsys",
        "gfxinfo",
        validateAndroidPackageName(args.packageName),
        "framestats",
        "reset",
      ];
    case ANDROID_COMMAND_IDS.NETSTATS_SNAPSHOT:
      return ["dumpsys", "netstats", "--poll", "detail"];
    case ANDROID_COMMAND_IDS.BATTERY:
      return ["dumpsys", "battery"];
    case ANDROID_COMMAND_IDS.THERMAL:
      return ["dumpsys", "thermalservice"];
    case ANDROID_COMMAND_IDS.DUMPSYS_SERVICES:
      return ["dumpsys", "-l"];
    default:
      throw new AndroidCommandError("command_not_allowed", "该 Android 命令不在白名单中");
  }
}

function nowMilliseconds() {
  if (globalThis.performance?.now) return globalThis.performance.now();
  return Date.now();
}

function utf8ByteLength(value) {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(value).byteLength;
  return value.length;
}

function normalizeCommandResult(result, durationMs, maxBytes) {
  const stdout =
    typeof result === "string"
      ? result
      : typeof result?.stdout === "string"
        ? result.stdout
        : typeof result?.text === "string"
          ? result.text
          : "";

  if (Number.isFinite(maxBytes) && maxBytes > 0 && utf8ByteLength(stdout) > maxBytes) {
    throw new AndroidCommandError("output_too_large", "Android 命令输出超过安全上限", {
      maxBytes,
    });
  }

  return {
    stdout,
    ...(typeof result?.stderr === "string" ? { stderr: result.stderr } : {}),
    ...(typeof result?.separated === "boolean" ? { separated: result.separated } : {}),
    durationMs:
      typeof result?.durationMs === "number" && Number.isFinite(result.durationMs)
        ? result.durationMs
        : Math.max(0, durationMs),
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
  };
}

function createLinkedAbort(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timeoutId = null;
  let removeParentListener = () => {};

  if (parentSignal) {
    const abortFromParent = () => controller.abort(parentSignal.reason);
    if (parentSignal.aborted) abortFromParent();
    else {
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
      removeParentListener = () => parentSignal.removeEventListener("abort", abortFromParent);
    }
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      controller.abort(new AndroidCommandError("command_timeout", "Android 命令执行超时"));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup() {
      if (timeoutId !== null) clearTimeout(timeoutId);
      removeParentListener();
    },
  };
}

/**
 * 将底层 Tango/WebUSB 适配器包装成只接受白名单 commandId 的采集 Runner。
 * adapter.runCommandText(argv, options) 应返回字符串或 {stdout, exitCode}。
 * adapter.startCommand(argv, options) 可返回流句柄、Promise 或 AsyncIterable。
 */
export function createAndroidShellRunner(adapter) {
  if (!adapter || typeof adapter.runCommandText !== "function") {
    throw new TypeError("adapter.runCommandText 必须是函数");
  }

  let closed = false;

  return {
    async exec(commandId, args = {}, options = {}) {
      if (closed) {
        throw new AndroidCommandError("runner_closed", "Android Shell Runner 已关闭");
      }
      const command = buildAndroidCommand(commandId, args);
      const linkedAbort = createLinkedAbort(options.signal, options.timeoutMs);
      const startedAt = nowMilliseconds();
      try {
        const result = await adapter.runCommandText(command, {
          signal: linkedAbort.signal,
          maxOutputBytes: options.maxBytes,
        });
        return normalizeCommandResult(result, nowMilliseconds() - startedAt, options.maxBytes);
      } finally {
        linkedAbort.cleanup();
      }
    },

    async open(commandId, args = {}, options = {}) {
      if (closed) {
        throw new AndroidCommandError("runner_closed", "Android Shell Runner 已关闭");
      }
      if (typeof adapter.startCommand !== "function") {
        throw new AndroidCommandError("streaming_unsupported", "当前 ADB 适配器不支持流式命令");
      }
      const command = buildAndroidCommand(commandId, args);
      const linkedAbort = createLinkedAbort(options.signal, options.timeoutMs);
      try {
        const stream = await adapter.startCommand(command, {
          signal: linkedAbort.signal,
          maxOutputBytes: options.maxBytes,
        });
        if (stream && typeof stream === "object") {
          // The ADB adapter deliberately returns frozen handles. Keep its
          // streams/cancellation methods while adding a private lifecycle hook
          // for the collector instead of mutating the adapter-owned object.
          const wrapped = {
            ...stream,
            __androidRunnerCleanup: linkedAbort.cleanup,
          };
          if (typeof stream[Symbol.asyncIterator] === "function") {
            wrapped[Symbol.asyncIterator] = () => stream[Symbol.asyncIterator]();
          }
          return wrapped;
        }
        linkedAbort.cleanup();
        return stream;
      } catch (error) {
        linkedAbort.cleanup();
        throw error;
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      if (typeof adapter.disconnect === "function") await adapter.disconnect();
      else if (typeof adapter.close === "function") await adapter.close();
    },
  };
}
