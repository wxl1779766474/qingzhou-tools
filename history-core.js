export const HISTORY_VERSION = 1;
export const HISTORY_STORAGE_KEY = "lightboat-tool-history:v1";
export const HISTORY_LIMIT = 20;
export const MAX_HISTORY_INPUT_BYTES = 200 * 1024;

export const TOOL_HISTORY_RULES = Object.freeze({
  qr: Object.freeze({ actions: Object.freeze(["generate"]) }),
  json: Object.freeze({ actions: Object.freeze(["format", "minify"]) }),
  base64: Object.freeze({ actions: Object.freeze(["encode", "decode"]) }),
  url: Object.freeze({ actions: Object.freeze(["encode", "decode"]) }),
  timestamp: Object.freeze({ actions: Object.freeze(["convert", "now"]) }),
});

const MAX_TIMESTAMP = 8_640_000_000_000_000;
const ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;

export class HistoryValidationError extends Error {
  constructor(message, code = "INVALID_HISTORY_RECORD") {
    super(message);
    this.name = "HistoryValidationError";
    this.code = code;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function utf8ByteLength(value) {
  if (typeof globalThis.TextEncoder === "function") {
    return new globalThis.TextEncoder().encode(value).length;
  }
  if (typeof globalThis.Buffer === "function") {
    return globalThis.Buffer.byteLength(value, "utf8");
  }

  try {
    return encodeURIComponent(value).replace(/%[0-9A-F]{2}|./gu, "x").length;
  } catch {
    throw new HistoryValidationError(
      "记录输入包含无法编码的字符",
      "INVALID_INPUT",
    );
  }
}

function fail(message, code = "INVALID_HISTORY_RECORD") {
  throw new HistoryValidationError(message, code);
}

function assertNoUnknownOptions(options, allowedKeys) {
  if (!isPlainObject(options)) {
    fail("使用记录选项格式无效", "INVALID_OPTIONS");
  }
  if (Object.keys(options).some((key) => !allowedKeys.includes(key))) {
    fail("使用记录包含未知选项", "INVALID_OPTIONS");
  }
}

function normalizeOptions(tool, options, { defaults = false } = {}) {
  const source = options ?? (defaults ? {} : null);

  if (tool === "json") {
    assertNoUnknownOptions(source, ["indent", "sortKeys"]);
    const indent = source.indent ?? (defaults ? "2" : undefined);
    const sortKeys = source.sortKeys ?? (defaults ? false : undefined);
    if (!["2", "4", "tab"].includes(indent) || typeof sortKeys !== "boolean") {
      fail("JSON 使用记录选项无效", "INVALID_OPTIONS");
    }
    return { indent, sortKeys };
  }

  if (tool === "url") {
    assertNoUnknownOptions(source, ["mode"]);
    const mode = source.mode ?? (defaults ? "full" : undefined);
    if (mode !== "full" && mode !== "component") {
      fail("URL 使用记录模式无效", "INVALID_OPTIONS");
    }
    return { mode };
  }

  assertNoUnknownOptions(source, []);
  return {};
}

function normalizeTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > MAX_TIMESTAMP
  ) {
    fail("使用记录时间无效", "INVALID_TIMESTAMP");
  }
  return timestamp;
}

function generateId(now) {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function normalizeRecord(value, { defaults = false, now, id } = {}) {
  if (!isPlainObject(value)) {
    fail("使用记录格式无效");
  }

  const version = defaults ? HISTORY_VERSION : value.version;
  if (version !== HISTORY_VERSION) {
    fail("使用记录版本不受支持", "UNSUPPORTED_VERSION");
  }

  const tool = value.tool;
  const rule = TOOL_HISTORY_RULES[tool];
  if (!rule) {
    fail("使用记录工具无效", "INVALID_TOOL");
  }

  if (!rule.actions.includes(value.action)) {
    fail("使用记录操作无效", "INVALID_ACTION");
  }

  if (typeof value.input !== "string") {
    fail("使用记录输入必须是文本", "INVALID_INPUT");
  }
  if (utf8ByteLength(value.input) > MAX_HISTORY_INPUT_BYTES) {
    fail("内容较大，本次未保存记录", "INPUT_TOO_LARGE");
  }

  if (
    tool === "timestamp" &&
    (value.action === "now"
      ? !/^\d{13}$/u.test(value.input)
      : !/^\d{10}(?:\d{3})?$/u.test(value.input))
  ) {
    fail("时间戳使用记录输入无效", "INVALID_INPUT");
  }

  const createdAt = normalizeTimestamp(value.createdAt ?? now);
  const recordId = value.id ?? id ?? generateId(createdAt);
  if (
    typeof recordId !== "string" ||
    recordId.length === 0 ||
    recordId.length > 128 ||
    !ID_PATTERN.test(recordId)
  ) {
    fail("使用记录 ID 无效", "INVALID_ID");
  }

  return {
    version: HISTORY_VERSION,
    id: recordId,
    tool,
    createdAt,
    input: value.input,
    action: value.action,
    options: normalizeOptions(tool, value.options, { defaults }),
  };
}

function tryNormalizeRecord(value) {
  try {
    return normalizeRecord(value);
  } catch {
    return null;
  }
}

function recordSignature(record) {
  return JSON.stringify([
    record.input,
    record.action,
    record.options,
  ]);
}

function normalizeRecordList(records) {
  if (!Array.isArray(records)) return [];

  const sorted = records
    .map(tryNormalizeRecord)
    .filter(Boolean)
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt || right.id.localeCompare(left.id),
    );
  const ids = new Set();
  const counts = new Map();
  const lastSignatureByTool = new Map();
  const result = [];

  for (const record of sorted) {
    if (ids.has(record.id)) continue;
    const count = counts.get(record.tool) ?? 0;
    if (count >= HISTORY_LIMIT) continue;

    const signature = recordSignature(record);
    if (lastSignatureByTool.get(record.tool) === signature) continue;

    ids.add(record.id);
    counts.set(record.tool, count + 1);
    lastSignatureByTool.set(record.tool, signature);
    result.push(record);
  }

  return result;
}

export function createHistoryRecord(data, { now = Date.now(), id } = {}) {
  return normalizeRecord(data, { defaults: true, now, id });
}

export function validateHistoryRecord(value) {
  return tryNormalizeRecord(value) !== null;
}

export function addHistoryRecord(records, candidate, options) {
  const current = normalizeRecordList(records);
  const incoming =
    tryNormalizeRecord(candidate) ?? createHistoryRecord(candidate, options);
  const latestForTool = current.find((record) => record.tool === incoming.tool);

  let nextRecord = incoming;
  if (
    latestForTool &&
    recordSignature(latestForTool) === recordSignature(incoming)
  ) {
    nextRecord = { ...latestForTool, createdAt: incoming.createdAt };
  }

  return normalizeRecordList([
    nextRecord,
    ...current.filter(
      (record) =>
        record.id !== nextRecord.id &&
        (!latestForTool ||
          latestForTool.id !== nextRecord.id ||
          record.id !== latestForTool.id),
    ),
  ]);
}

export function filterHistoryRecords(records, tool = null) {
  const normalized = normalizeRecordList(records);
  if (tool === null || tool === undefined || tool === "all") return normalized;
  if (!TOOL_HISTORY_RULES[tool]) return [];
  return normalized.filter((record) => record.tool === tool);
}

export function deleteHistoryRecord(records, id) {
  return normalizeRecordList(records).filter((record) => record.id !== id);
}

export function clearHistoryRecords() {
  return [];
}

export function parseHistoryWithStatus(serialized) {
  if (serialized === null || serialized === undefined || serialized === "") {
    return { records: [], reset: false, discarded: 0 };
  }
  if (typeof serialized !== "string") {
    return { records: [], reset: true, discarded: 0 };
  }

  try {
    const payload = JSON.parse(serialized);
    if (
      !isPlainObject(payload) ||
      payload.version !== HISTORY_VERSION ||
      !Array.isArray(payload.records)
    ) {
      return { records: [], reset: true, discarded: 0 };
    }

    const records = normalizeRecordList(payload.records);
    return {
      records,
      reset: false,
      discarded: Math.max(0, payload.records.length - records.length),
    };
  } catch {
    return { records: [], reset: true, discarded: 0 };
  }
}

export function parseHistory(serialized) {
  return parseHistoryWithStatus(serialized).records;
}

export function serializeHistory(records) {
  return JSON.stringify({
    version: HISTORY_VERSION,
    records: normalizeRecordList(records),
  });
}

export function createRestoreSnapshot(record) {
  const normalized = normalizeRecord(record);
  return {
    tool: normalized.tool,
    input: normalized.input,
    action: normalized.action,
    options: { ...normalized.options },
  };
}
