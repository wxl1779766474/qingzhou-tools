const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

export const ANDROID_ADB_ERROR_CODES = Object.freeze({
  INSECURE_CONTEXT: "insecure-context",
  WEBUSB_UNSUPPORTED: "webusb-unsupported",
  ALREADY_CONNECTED: "already-connected",
  DEVICE_BUSY: "device-busy",
  CONNECTION_FAILED: "connection-failed",
  CONNECTION_CANCELLED: "connection-cancelled",
  CONNECTION_TIMEOUT: "connection-timeout",
  NOT_CONNECTED: "not-connected",
  COMMAND_FAILED: "command-failed",
  OUTPUT_TOO_LARGE: "output-too-large",
  DISCONNECT_FAILED: "disconnect-failed",
});

export class AndroidAdbError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AndroidAdbError";
    this.code = code;
  }
}

function normalizeCommand(command) {
  if (
    !Array.isArray(command)
    || command.length === 0
    || command.some((part) => typeof part !== "string" || part.length === 0 || part.includes("\0"))
  ) {
    throw new TypeError("ADB 命令必须是非空字符串数组");
  }
  return [...command];
}

function normalizeMaxOutputBytes(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("maxOutputBytes 必须是正整数");
  }
  return value;
}

function describeDevice(device) {
  return Object.freeze({
    name: String(device?.name || "Android 设备"),
    serial: String(device?.serial || ""),
  });
}

async function closeUnauthenticatedConnection(connection) {
  const tasks = [];
  if (typeof connection?.writable?.close === "function") {
    tasks.push(Promise.resolve().then(() => connection.writable.close()));
  }
  if (typeof connection?.readable?.cancel === "function") {
    tasks.push(Promise.resolve().then(() => connection.readable.cancel()));
  }
  await Promise.allSettled(tasks);
}

async function closeTransport(transport) {
  if (typeof transport?.close !== "function") return;
  await Promise.resolve().then(() => transport.close()).catch(() => {});
}

function normalizeConnectTimeout(value) {
  const timeoutMs = value ?? DEFAULT_CONNECT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10 * 60_000) {
    throw new TypeError("连接超时必须是 1 到 600000 毫秒之间的数字");
  }
  return timeoutMs;
}

function createConnectAbort(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timeoutId = null;
  let removeParentListener = () => {};

  if (parentSignal) {
    const abortFromParent = () => controller.abort(
      parentSignal.reason instanceof Error
        ? parentSignal.reason
        : new AndroidAdbError(
            ANDROID_ADB_ERROR_CODES.CONNECTION_CANCELLED,
            "Android 设备连接已取消",
          ),
    );
    if (parentSignal.aborted) abortFromParent();
    else {
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
      removeParentListener = () => parentSignal.removeEventListener("abort", abortFromParent);
    }
  }

  timeoutId = setTimeout(() => {
    controller.abort(new AndroidAdbError(
      ANDROID_ADB_ERROR_CODES.CONNECTION_TIMEOUT,
      "等待设备选择或手机授权超时，请保持手机解锁后重试",
    ));
  }, normalizeConnectTimeout(timeoutMs));

  return {
    controller,
    cleanup() {
      clearTimeout(timeoutId);
      removeParentListener();
    },
  };
}

async function raceWithAbort(promise, signal) {
  if (signal.aborted) throw signal.reason;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function readTextStream(stream, budget) {
  if (!stream) return "";

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      budget.used += chunk.byteLength;
      if (budget.used > budget.limit) {
        throw new AndroidAdbError(
          ANDROID_ADB_ERROR_CODES.OUTPUT_TOO_LARGE,
          `ADB 命令输出超过 ${budget.limit} 字节限制`,
        );
      }
      output += decoder.decode(chunk, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function emitSafely(listeners, event) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A consumer callback must not prevent other disconnect listeners from running.
    }
  }
}

/**
 * Creates a testable ADB boundary. Tango-specific classes are injected by the
 * browser entry so collectors and UI code never depend on Tango internals.
 */
export function createAndroidPerformanceAdbAdapter({
  deviceManager,
  secureContext = true,
  createCredentialStore,
  authenticate,
  createAdb,
  isDeviceBusyError = () => false,
}) {
  let client = null;
  let currentDevice = null;
  let connectOperation = null;
  let connectAbortController = null;
  let pendingConnection = null;
  let pendingTransport = null;
  let connectionGeneration = 0;
  const disconnectListeners = new Set();

  function getSupport() {
    if (!secureContext) {
      return Object.freeze({
        supported: false,
        code: ANDROID_ADB_ERROR_CODES.INSECURE_CONTEXT,
      });
    }
    if (!deviceManager) {
      return Object.freeze({
        supported: false,
        code: ANDROID_ADB_ERROR_CODES.WEBUSB_UNSUPPORTED,
      });
    }
    return Object.freeze({ supported: true, code: null });
  }

  function assertSupported() {
    const support = getSupport();
    if (support.supported) return;

    const message = support.code === ANDROID_ADB_ERROR_CODES.INSECURE_CONTEXT
      ? "Android 设备连接需要 HTTPS 或 localhost 安全环境"
      : "当前浏览器不支持 WebUSB，请使用桌面版 Chrome 或 Edge";
    throw new AndroidAdbError(support.code, message);
  }

  function assertConnected() {
    if (!client) {
      throw new AndroidAdbError(
        ANDROID_ADB_ERROR_CODES.NOT_CONNECTED,
        "请先连接 Android 设备",
      );
    }
    return client;
  }

  function observeDisconnect(adb, generation) {
    if (!adb?.disconnected || typeof adb.disconnected.then !== "function") return;

    void Promise.resolve(adb.disconnected).then(
      () => handleRemoteDisconnect(generation),
      (error) => handleRemoteDisconnect(generation, error),
    );
  }

  function handleRemoteDisconnect(generation, error) {
    if (!client || generation !== connectionGeneration) return;

    client = null;
    currentDevice = null;
    connectionGeneration += 1;
    emitSafely(disconnectListeners, Object.freeze({
      reason: "device",
      error,
    }));
  }

  async function connect({ requestOptions, signal, timeoutMs } = {}) {
    assertSupported();
    if (client || connectOperation) {
      throw new AndroidAdbError(
        ANDROID_ADB_ERROR_CODES.ALREADY_CONNECTED,
        client ? "Android 设备已经连接" : "Android 设备正在连接，请勿重复操作",
      );
    }
    if (
      typeof createCredentialStore !== "function"
      || typeof authenticate !== "function"
      || typeof createAdb !== "function"
    ) {
      throw new TypeError("ADB adapter dependencies are incomplete");
    }

    const linkedAbort = createConnectAbort(signal, timeoutMs);
    connectAbortController = linkedAbort.controller;

    // requestDevice is intentionally invoked synchronously before the first
    // await so a click handler keeps its WebUSB user activation.
    let requestedDevice;
    try {
      requestedDevice = Promise.resolve(deviceManager.requestDevice(requestOptions));
    } catch (error) {
      linkedAbort.cleanup();
      connectAbortController = null;
      throw new AndroidAdbError(
        ANDROID_ADB_ERROR_CODES.CONNECTION_FAILED,
        "无法打开 Android 设备选择器",
        { cause: error },
      );
    }
    let operation;
    operation = (async () => {
      let selectedDevice;
      let connection;
      let transport;
      let nextClient;
      try {
        selectedDevice = await raceWithAbort(requestedDevice, linkedAbort.controller.signal);
        if (!selectedDevice) return null;

        connection = await raceWithAbort(
          Promise.resolve(selectedDevice.connect()),
          linkedAbort.controller.signal,
        );
        pendingConnection = connection;
        if (linkedAbort.controller.signal.aborted) throw linkedAbort.controller.signal.reason;

        const credentialStore = await raceWithAbort(
          Promise.resolve(createCredentialStore()),
          linkedAbort.controller.signal,
        );
        const authentication = Promise.resolve(authenticate({
          serial: selectedDevice.serial,
          connection,
          credentialStore,
        })).then(async (value) => {
          if (linkedAbort.controller.signal.aborted) {
            await closeTransport(value);
            throw linkedAbort.controller.signal.reason;
          }
          return value;
        });
        transport = await raceWithAbort(authentication, linkedAbort.controller.signal);
        pendingTransport = transport;

        const adbCreation = Promise.resolve(createAdb(transport)).then(async (value) => {
          if (linkedAbort.controller.signal.aborted) {
            await Promise.resolve().then(() => value?.close?.()).catch(() => {});
            throw linkedAbort.controller.signal.reason;
          }
          return value;
        });
        nextClient = await raceWithAbort(adbCreation, linkedAbort.controller.signal);
      } catch (error) {
        if (nextClient && typeof nextClient.close === "function") {
          await Promise.resolve().then(() => nextClient.close()).catch(() => {});
        } else if (transport && pendingTransport === transport) {
          await closeTransport(transport);
          pendingTransport = null;
        } else if (connection && pendingConnection === connection) {
          await closeUnauthenticatedConnection(connection);
          pendingConnection = null;
        }

        if (linkedAbort.controller.signal.aborted) {
          const reason = linkedAbort.controller.signal.reason;
          if (reason instanceof Error) throw reason;
          throw new AndroidAdbError(
            ANDROID_ADB_ERROR_CODES.CONNECTION_CANCELLED,
            "Android 设备连接已取消",
          );
        }
        if (isDeviceBusyError(error)) {
          throw new AndroidAdbError(
            ANDROID_ADB_ERROR_CODES.DEVICE_BUSY,
            "USB 接口正被 Android Studio、adb 或其他程序占用",
            { cause: error },
          );
        }
        throw new AndroidAdbError(
          ANDROID_ADB_ERROR_CODES.CONNECTION_FAILED,
          "无法连接或授权 Android 设备",
          { cause: error },
        );
      }

      client = nextClient;
      pendingConnection = null;
      pendingTransport = null;
      currentDevice = describeDevice(selectedDevice);
      const generation = ++connectionGeneration;
      observeDisconnect(client, generation);
      return currentDevice;
    })();
    connectOperation = operation;

    try {
      return await operation;
    } finally {
      linkedAbort.cleanup();
      if (connectOperation === operation) {
        connectOperation = null;
        connectAbortController = null;
        pendingConnection = null;
        pendingTransport = null;
      }
    }
  }

  async function startCommand(command, { signal } = {}) {
    const adb = assertConnected();
    const normalizedCommand = normalizeCommand(command);

    try {
      if (adb.subprocess?.shellProtocol) {
        const process = await adb.subprocess.shellProtocol.spawn(normalizedCommand, signal);
        return Object.freeze({
          stdout: process.stdout,
          stderr: process.stderr,
          separated: true,
          exited: process.exited,
          kill: () => process.kill(),
        });
      }

      const process = await adb.subprocess.noneProtocol.spawn(normalizedCommand, signal);
      return Object.freeze({
        stdout: process.output,
        stderr: null,
        separated: false,
        exited: Promise.resolve(process.exited).then(() => null),
        kill: () => process.kill(),
      });
    } catch (error) {
      if (signal?.aborted && error === signal.reason) throw error;
      throw new AndroidAdbError(
        ANDROID_ADB_ERROR_CODES.COMMAND_FAILED,
        "无法启动 ADB 命令",
        { cause: error },
      );
    }
  }

  async function runCommandText(
    command,
    { signal, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {},
  ) {
    const budget = {
      used: 0,
      limit: normalizeMaxOutputBytes(maxOutputBytes),
    };
    const process = await startCommand(command, { signal });
    const stdoutPromise = readTextStream(process.stdout, budget);
    const stderrPromise = readTextStream(process.stderr, budget);
    const exitedPromise = Promise.resolve(process.exited);

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        stdoutPromise,
        stderrPromise,
        exitedPromise,
      ]);
      return Object.freeze({
        stdout,
        stderr,
        exitCode,
        separated: process.separated,
      });
    } catch (error) {
      await Promise.resolve().then(() => process.kill()).catch(() => {});
      await Promise.allSettled([stdoutPromise, stderrPromise, exitedPromise]);
      if (error instanceof AndroidAdbError) throw error;
      if (signal?.aborted && error === signal.reason) throw error;
      throw new AndroidAdbError(
        ANDROID_ADB_ERROR_CODES.COMMAND_FAILED,
        "ADB 命令执行失败",
        { cause: error },
      );
    }
  }

  function onDisconnect(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("disconnect listener 必须是函数");
    }
    disconnectListeners.add(listener);
    return () => disconnectListeners.delete(listener);
  }

  async function disconnect() {
    const hadPendingConnection = Boolean(connectOperation);
    if (connectAbortController && !connectAbortController.signal.aborted) {
      connectAbortController.abort(new AndroidAdbError(
        ANDROID_ADB_ERROR_CODES.CONNECTION_CANCELLED,
        "Android 设备连接已取消",
      ));
    }
    if (pendingTransport) {
      const transport = pendingTransport;
      pendingTransport = null;
      await closeTransport(transport);
    } else if (pendingConnection) {
      const connection = pendingConnection;
      pendingConnection = null;
      await closeUnauthenticatedConnection(connection);
    }

    if (!client) return hadPendingConnection;

    const activeClient = client;
    client = null;
    currentDevice = null;
    connectionGeneration += 1;
    let closeError;
    try {
      await activeClient.close();
    } catch (error) {
      closeError = error;
    }

    emitSafely(disconnectListeners, Object.freeze({
      reason: "manual",
      error: closeError,
    }));
    if (closeError) {
      throw new AndroidAdbError(
        ANDROID_ADB_ERROR_CODES.DISCONNECT_FAILED,
        "Android 设备连接未能正常关闭",
        { cause: closeError },
      );
    }
    return true;
  }

  return Object.freeze({
    get connected() {
      return Boolean(client);
    },
    get connecting() {
      return Boolean(connectOperation);
    },
    get device() {
      return currentDevice;
    },
    getSupport,
    connect,
    startCommand,
    runCommandText,
    onDisconnect,
    disconnect,
  });
}
