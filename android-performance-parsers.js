import {
  validateAndroidPackageName,
  validateAndroidPid,
} from "./android-performance-commands.js";

const NUMBER_PATTERN = "[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const PACKAGE_IN_TEXT_PATTERN = /([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/gu;
const ANSI_OSC_PATTERN =
  /\u001B\](?:[^\u0007\u001B]|\u001B(?!\\))*(?:\u0007|\u001B\\)/gu;
const ANSI_CSI_PATTERN = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu;
const ANSI_ESCAPE_PATTERN = /\u001B[@-_]/gu;
const MAX_PROC_PID_COUNT = 128;
const THERMAL_STATUS_NAMES = Object.freeze([
  "NONE",
  "LIGHT",
  "MODERATE",
  "SEVERE",
  "CRITICAL",
  "EMERGENCY",
  "SHUTDOWN",
]);

function success(value, { warnings = [], source = undefined } = {}) {
  return { ok: true, value, warnings, ...(source ? { source } : {}) };
}

function failure(reasonCode, { retryable = true, message = undefined } = {}) {
  return { ok: false, reasonCode, retryable, ...(message ? { message } : {}) };
}

function parseFiniteNumber(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const number = Number(String(value).replaceAll(",", "").replace(/%$/u, ""));
  return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function validPackageName(value) {
  try {
    return validateAndroidPackageName(value);
  } catch {
    return null;
  }
}

export function parseTextValue(text) {
  if (typeof text !== "string") return failure("invalid_output", { retryable: false });
  const value = text.trim();
  return value ? success(value) : failure("empty_output");
}

export function parseIntegerValue(text, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = parseTextValue(text);
  if (!parsed.ok || !/^\d+$/u.test(parsed.value)) return failure("invalid_integer");
  const value = Number(parsed.value);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return failure("invalid_integer");
  }
  return success(value);
}

export function parseLogicalCoreCount(text) {
  return parseIntegerValue(text, { minimum: 1, maximum: 1024 });
}

export function parseCpuOnlineCoreCount(text) {
  const parsedText = parseTextValue(text);
  if (!parsedText.ok) return parsedText;
  const onlineList = parsedText.value.replace(/\s+/gu, "");
  if (
    onlineList.length <= 16_384
    && /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u.test(onlineList)
  ) {
    const indexes = new Set();
    const ranges = onlineList.split(",");
    if (ranges.length <= 1024) {
      for (const range of ranges) {
        const [startText, endText = startText] = range.split("-");
        const start = Number(startText);
        const end = Number(endText);
        if (
          !Number.isSafeInteger(start)
          || !Number.isSafeInteger(end)
          || start < 0
          || end < start
          || end - start >= 1024
        ) {
          return failure("invalid_integer");
        }
        for (let index = start; index <= end; index += 1) {
          indexes.add(index);
          if (indexes.size > 1024) return failure("invalid_integer");
        }
      }
      if (indexes.size > 0) return success(indexes.size);
    }
  }
  return failure("invalid_cpu_online_list");
}

export function parseCpuInfoCoreCount(text) {
  const parsedText = parseTextValue(text);
  if (!parsedText.ok) return parsedText;
  const processorIndexes = new Set();
  for (const match of parsedText.value.matchAll(/^\s*processor\s*:\s*(\d+)\s*$/gimu)) {
    processorIndexes.add(Number(match[1]));
    if (processorIndexes.size > 1024) return failure("invalid_cpuinfo");
  }
  return processorIndexes.size > 0
    ? success(processorIndexes.size)
    : failure("invalid_cpuinfo");
}

export function parseCurrentUser(text) {
  return parseIntegerValue(text, { minimum: 0, maximum: 9999 });
}

export function parseDisplayRefreshRate(text) {
  if (typeof text !== "string" || text.trim() === "") return failure("empty_output");

  const candidates = [];
  const expressions = [
    new RegExp(`(?:mRefreshRate|refreshRate|fps)\\s*[=:]\\s*(${NUMBER_PATTERN})`, "giu"),
    new RegExp(`@(${NUMBER_PATTERN})(?:\\s|Hz|$)`, "giu"),
  ];

  for (const line of text.split(/\r?\n/u)) {
    for (const expression of expressions) {
      expression.lastIndex = 0;
      for (const match of line.matchAll(expression)) {
        const value = parseFiniteNumber(match[1]);
        if (value === null || value < 20 || value > 1000) continue;
        const priority = /\bactive(?:Mode)?\b|mActive/iu.test(line)
          ? 3
          : /\bcurrent\b/iu.test(line)
            ? 2
            : /\bdefault\b/iu.test(line)
              ? 1
              : 0;
        candidates.push({ value, priority });
      }
    }
  }

  candidates.sort((left, right) => right.priority - left.priority);
  return candidates.length === 0
    ? failure("refresh_rate_not_found")
    : success(candidates[0].value);
}

export function parseForegroundPackage(text) {
  if (typeof text !== "string" || text.trim() === "") return failure("empty_output");
  const preferredLines = text
    .split(/\r?\n/u)
    .filter((line) => /topResumedActivity|mResumedActivity|ResumedActivity|mFocusedApp/u.test(line));
  const candidates = preferredLines.length > 0 ? preferredLines : text.split(/\r?\n/u);

  for (const line of candidates) {
    PACKAGE_IN_TEXT_PATTERN.lastIndex = 0;
    for (const match of line.matchAll(PACKAGE_IN_TEXT_PATTERN)) {
      const packageName = validPackageName(match[1]);
      if (packageName && line.slice(match.index + match[1].length).trimStart().startsWith("/")) {
        return success(packageName);
      }
    }
  }
  return failure("foreground_package_not_found");
}

export function parseThirdPartyPackages(text) {
  if (typeof text !== "string") return failure("invalid_output", { retryable: false });
  const packages = [];
  const seen = new Set();

  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^package:([^\s]+)(?:\s+uid:(\d+))?/u);
    if (!match) continue;
    const packageName = validPackageName(match[1]);
    if (!packageName || seen.has(packageName)) continue;
    seen.add(packageName);
    packages.push({
      packageName,
      uid: match[2] ? Number(match[2]) : null,
    });
  }

  packages.sort((a, b) => a.packageName.localeCompare(b.packageName));
  return success(packages);
}

export function parsePackageInfo(text, packageName = undefined) {
  if (typeof text !== "string" || text.trim() === "") return failure("empty_output");
  if (/Unable to find package|Unknown package|not found/i.test(text)) {
    return failure("package_not_found", { retryable: false });
  }

  const uidMatch = text.match(/\buserId=(\d+)/u);
  const versionNameMatch = text.match(/\bversionName=([^\s]+)/u);
  const versionCodeMatch = text.match(/\bversionCode=(\d+)/u);
  if (!uidMatch) return failure("package_info_parse_failed");

  return success({
    packageName: packageName ? validPackageName(packageName) : null,
    uid: Number(uidMatch[1]),
    versionName: versionNameMatch?.[1] ?? null,
    versionCode: versionCodeMatch ? Number(versionCodeMatch[1]) : null,
  });
}

export function parsePidof(text) {
  if (typeof text !== "string") return failure("invalid_output", { retryable: false });
  const pids = [...new Set(text.match(/\d+/gu)?.map(Number) ?? [])]
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
    .sort((a, b) => a - b);
  return success(pids);
}

function splitColumns(line) {
  return line.trim().split(/\s+/u);
}

function stripAnsiControlSequences(value) {
  return value
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(ANSI_ESCAPE_PATTERN, "");
}

function normalizeTopText(text) {
  return stripAnsiControlSequences(text).replace(/\r\n?|\n/gu, "\n");
}

function splitTopHeaderColumns(line) {
  return splitColumns(
    stripAnsiControlSequences(line)
      .replace(/\r/gu, "")
      .replace(/[\[\]]/gu, " "),
  );
}

export function isTopHeaderLine(line) {
  if (typeof line !== "string") return false;
  const fields = splitTopHeaderColumns(line).map((field) => field.toUpperCase());
  return fields.includes("PID")
    && fields.some((field) => field === "%CPU" || field === "CPU%");
}

export function parseProcessList(text, { packageName, uid = undefined } = {}) {
  if (typeof text !== "string" || text.trim() === "") return failure("empty_output");
  const targetPackage = validPackageName(packageName);
  if (!targetPackage) return failure("invalid_package", { retryable: false });

  const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== "");
  const headerIndex = lines.findIndex((line) => {
    const fields = splitColumns(line).map((field) => field.toUpperCase());
    return fields.includes("PID") && (fields.includes("NAME") || fields.includes("CMDLINE"));
  });

  if (headerIndex < 0) return failure("process_header_not_found");
  const headers = splitColumns(lines[headerIndex]).map((field) => field.toUpperCase());
  const pidIndex = headers.indexOf("PID");
  const uidIndex = headers.includes("UID") ? headers.indexOf("UID") : headers.indexOf("USER");
  const nameIndex = headers.includes("NAME")
    ? headers.indexOf("NAME")
    : headers.includes("CMDLINE")
      ? headers.indexOf("CMDLINE")
      : headers.length - 1;
  const processes = [];

  for (const line of lines.slice(headerIndex + 1)) {
    const fields = splitColumns(line);
    if (fields.length <= Math.max(pidIndex, nameIndex)) continue;
    const pid = Number(fields[pidIndex]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const name = fields.slice(nameIndex).join(" ").split(/\s/u)[0];
    if (name !== targetPackage && !name.startsWith(`${targetPackage}:`)) continue;

    const parsedUid = uidIndex >= 0 && /^\d+$/u.test(fields[uidIndex]) ? Number(fields[uidIndex]) : null;
    if (uid !== undefined && parsedUid !== null && parsedUid !== Number(uid)) continue;
    processes.push({ pid, uid: parsedUid, name });
  }

  processes.sort((a, b) => a.pid - b.pid);
  return success({
    processes,
    pids: processes.map((process) => process.pid),
  });
}

export function parseTopHelp(text) {
  if (typeof text !== "string" || text.trim() === "") return failure("empty_output");
  const supports = (flag) => new RegExp(
    `(?:^|[\\s[,])-${flag}(?:[\\s,\\]]|$)`,
    "mu",
  ).test(text);
  return success({
    batch: supports("b"),
    pidFilter: supports("p"),
    outputFields: supports("o"),
    iterations: supports("n"),
  });
}

function normalizeCpuPercent(rawPercent, { logicalCores, cpuMode, capacityPercent }) {
  let mode = cpuMode;
  if (mode === "auto") {
    if (capacityPercent > 100 || rawPercent > 100) mode = "per-core";
    else mode = "ambiguous";
  }

  if (mode === "device") {
    return { cpuPercent: clamp(rawPercent, 0, 100), normalization: "device" };
  }
  if (mode === "per-core" && Number.isFinite(logicalCores) && logicalCores > 0) {
    return {
      cpuPercent: clamp(rawPercent / logicalCores, 0, 100),
      normalization: "per-core",
    };
  }
  if (mode === "per-core" && Number.isFinite(capacityPercent) && capacityPercent >= 100) {
    return {
      cpuPercent: clamp((rawPercent / capacityPercent) * 100, 0, 100),
      normalization: "capacity",
    };
  }
  return { cpuPercent: null, normalization: "ambiguous" };
}

function parseTopBlock(lines, options, capacityPercent) {
  const headerIndex = lines.findIndex(isTopHeaderLine);
  if (headerIndex < 0) return null;

  const headers = splitTopHeaderColumns(lines[headerIndex])
    .map((field) => field.toUpperCase());
  const pidIndex = headers.indexOf("PID");
  const cpuIndex = headers.findIndex((field) => field === "%CPU" || field === "CPU%");
  const targetPids = options.targetPids ? new Set(options.targetPids.map(Number)) : null;
  const matchedPids = [];
  let rawPercent = 0;

  for (const line of lines.slice(headerIndex + 1)) {
    const fields = splitColumns(line);
    if (fields.length <= Math.max(pidIndex, cpuIndex)) continue;
    const pid = Number(fields[pidIndex]);
    const percent = parseFiniteNumber(fields[cpuIndex]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || percent === null || percent < 0) continue;
    if (targetPids && !targetPids.has(pid)) continue;
    matchedPids.push(pid);
    rawPercent += percent;
  }

  const normalized = normalizeCpuPercent(rawPercent, {
    logicalCores: options.logicalCores,
    cpuMode: options.cpuMode ?? "auto",
    capacityPercent,
  });
  return {
    rawPercent,
    ...normalized,
    capacityPercent: Number.isFinite(capacityPercent) ? capacityPercent : null,
    matchedPids: [...new Set(matchedPids)].sort((a, b) => a - b),
    found: matchedPids.length > 0,
  };
}

export function parseTopSnapshots(text, options = {}) {
  if (typeof text !== "string" || text.trim() === "") return failure("empty_output");
  const lines = normalizeTopText(text).split("\n");
  const blocks = [];
  let current = [];
  let capacityPercent = null;
  let currentCapacity = null;

  const flush = () => {
    if (current.length === 0) return;
    const parsed = parseTopBlock(current, options, currentCapacity);
    if (parsed) blocks.push(parsed);
    current = [];
    currentCapacity = capacityPercent;
  };

  for (const line of lines) {
    const capacityMatch = line.match(/\b(\d+)%cpu\b/iu);
    if (capacityMatch) capacityPercent = Number(capacityMatch[1]);
    const isHeader = isTopHeaderLine(line);
    if (isHeader && current.some(isTopHeaderLine)) flush();
    if (current.length === 0) currentCapacity = capacityPercent;
    current.push(line);
    if (line.trim() === "" && current.some(isTopHeaderLine)) flush();
  }
  flush();

  return blocks.length > 0 ? success(blocks, { source: "top" }) : failure("top_parse_failed");
}

export function parseTopSnapshot(text, options = {}) {
  const parsed = parseTopSnapshots(text, options);
  if (!parsed.ok) return parsed;
  return success(parsed.value.at(-1), { source: "top" });
}

function normalizeProcTargetPids(targetPids) {
  if (!Array.isArray(targetPids) || targetPids.length === 0
    || targetPids.length > MAX_PROC_PID_COUNT) {
    return null;
  }
  try {
    return [...new Set(targetPids.map(validateAndroidPid))].sort((a, b) => a - b);
  } catch {
    return null;
  }
}

function parseUnsignedSafeInteger(value) {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function parseProcSystemStatLine(line) {
  const fields = splitColumns(line);
  const counterFields = fields.slice(1);
  if (fields[0] !== "cpu" || counterFields.length < 8 || counterFields.length > 10) {
    return null;
  }
  const values = counterFields.map(parseUnsignedSafeInteger);
  if (values.some((value) => value === null)) return null;
  const totalTicks = values.slice(0, 8).reduce((total, value) => total + value, 0);
  return Number.isSafeInteger(totalTicks) && totalTicks > 0 ? totalTicks : null;
}

function parseProcProcessStatLine(line) {
  const match = line.match(/^\s*(\d+)\s+\((.*)\)\s+([A-Za-z])\s+(.+?)\s*$/u);
  if (!match) return null;
  let pid;
  try {
    pid = validateAndroidPid(match[1]);
  } catch {
    return null;
  }

  const trailingFields = match[4].split(/\s+/u);
  if (trailingFields.length < 19) return null;
  const utimeTicks = parseUnsignedSafeInteger(trailingFields[10]);
  const stimeTicks = parseUnsignedSafeInteger(trailingFields[11]);
  const starttimeTicks = parseUnsignedSafeInteger(trailingFields[18]);
  if (utimeTicks === null || stimeTicks === null || starttimeTicks === null) return null;
  const processTicks = utimeTicks + stimeTicks;
  if (!Number.isSafeInteger(processTicks)) return null;

  return {
    pid,
    name: match[2],
    state: match[3],
    utimeTicks,
    stimeTicks,
    processTicks,
    starttimeTicks,
  };
}

export function parseProcCpuSnapshot(text, { targetPids } = {}) {
  if (typeof text !== "string" || text.trim() === "") return failure("empty_output");
  const normalizedTargetPids = normalizeProcTargetPids(targetPids);
  if (!normalizedTargetPids) {
    return failure("invalid_pid_list", { retryable: false });
  }

  const targetSet = new Set(normalizedTargetPids);
  const processesByPid = new Map();
  let systemTotalTicks = null;
  let systemStatLineCount = 0;
  for (const line of text.split(/\r\n?|\n/u)) {
    if (/^\s*cpu(?:\s|$)/u.test(line)) {
      systemStatLineCount += 1;
      if (systemStatLineCount === 1) systemTotalTicks = parseProcSystemStatLine(line);
      continue;
    }
    const process = parseProcProcessStatLine(line);
    if (!process || !targetSet.has(process.pid) || processesByPid.has(process.pid)) continue;
    processesByPid.set(process.pid, process);
  }

  if (systemStatLineCount === 0) return failure("proc_stat_unavailable");
  if (systemStatLineCount !== 1 || systemTotalTicks === null) {
    return failure("proc_stat_invalid");
  }
  const processes = [...processesByPid.values()].sort((a, b) => a.pid - b.pid);
  if (processes.length === 0) return failure("proc_process_stats_unavailable");
  const foundPids = new Set(processes.map((process) => process.pid));
  const missingPids = normalizedTargetPids.filter((pid) => !foundPids.has(pid));
  const partial = missingPids.length > 0;

  return success(
    {
      systemTotalTicks,
      processes,
      targetPids: normalizedTargetPids,
      missingPids,
      partial,
    },
    {
      warnings: partial ? ["proc_process_partial"] : [],
      source: "proc",
    },
  );
}

function isValidProcCpuSnapshot(snapshot) {
  if (
    !snapshot
    || !Number.isSafeInteger(snapshot.systemTotalTicks)
    || snapshot.systemTotalTicks <= 0
    || !Array.isArray(snapshot.processes)
    || snapshot.processes.length === 0
  ) {
    return false;
  }
  const seenPids = new Set();
  return snapshot.processes.every((process) => {
    if (
      !Number.isSafeInteger(process?.pid)
      || process.pid <= 0
      || seenPids.has(process.pid)
      || !Number.isSafeInteger(process.starttimeTicks)
      || process.starttimeTicks < 0
      || !Number.isSafeInteger(process.processTicks)
      || process.processTicks < 0
    ) {
      return false;
    }
    seenPids.add(process.pid);
    return true;
  });
}

export function computeProcCpuDelta(previous, current) {
  if (!isValidProcCpuSnapshot(current)) {
    return failure("invalid_proc_snapshot", { retryable: false });
  }
  if (previous === null || previous === undefined) {
    return success(
      {
        baseline: true,
        cpuPercent: null,
        rawPercent: null,
        normalization: "device",
        processDeltaTicks: null,
        systemDeltaTicks: null,
        matchedPids: [],
        skippedPids: [],
        partial: Boolean(current.partial),
      },
      { source: "proc" },
    );
  }
  if (!isValidProcCpuSnapshot(previous)) {
    return failure("invalid_proc_baseline", { retryable: false });
  }

  const systemDeltaTicks = current.systemTotalTicks - previous.systemTotalTicks;
  if (!Number.isSafeInteger(systemDeltaTicks) || systemDeltaTicks <= 0) {
    return failure("proc_counter_reset");
  }

  const previousByPid = new Map(
    previous.processes.map((process) => [process.pid, process]),
  );
  const matchedPids = [];
  const skippedPids = [];
  let regressed = false;
  let processDeltaTicks = 0;

  for (const process of current.processes) {
    const baseline = previousByPid.get(process.pid);
    if (!baseline || baseline.starttimeTicks !== process.starttimeTicks) {
      skippedPids.push(process.pid);
      continue;
    }
    const deltaTicks = process.processTicks - baseline.processTicks;
    if (!Number.isSafeInteger(deltaTicks) || deltaTicks < 0) {
      regressed = true;
      skippedPids.push(process.pid);
      continue;
    }
    processDeltaTicks += deltaTicks;
    if (!Number.isSafeInteger(processDeltaTicks)) {
      return failure("proc_counter_reset");
    }
    matchedPids.push(process.pid);
  }

  if (matchedPids.length === 0) {
    return failure(regressed ? "proc_counter_reset" : "proc_process_delta_unavailable");
  }
  const partial = Boolean(
    previous.partial
    || current.partial
    || skippedPids.length > 0,
  );
  const cpuPercent = clamp((processDeltaTicks / systemDeltaTicks) * 100, 0, 100);
  return success(
    {
      baseline: false,
      cpuPercent,
      rawPercent: cpuPercent,
      normalization: "device",
      processDeltaTicks,
      systemDeltaTicks,
      matchedPids,
      skippedPids,
      partial,
    },
    {
      warnings: partial ? ["proc_process_partial"] : [],
      source: "proc",
    },
  );
}

export function parseCpuInfo(text, { targetPids = undefined, logicalCores = undefined } = {}) {
  if (typeof text !== "string" || text.trim() === "") return failure("empty_output");
  const targets = targetPids ? new Set(targetPids.map(Number)) : null;
  const matchedPids = [];
  let rawPercent = 0;
  const linePattern = new RegExp(
    `^\\s*[+-]?\\s*(${NUMBER_PATTERN})%\\s+(\\d+)\\/(.+?):\\s`,
    "u",
  );

  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(linePattern);
    if (!match) continue;
    const pid = Number(match[2]);
    if (targets && !targets.has(pid)) continue;
    rawPercent += Number(match[1]);
    matchedPids.push(pid);
  }

  const normalized = normalizeCpuPercent(rawPercent, {
    logicalCores,
    cpuMode: "per-core",
    capacityPercent: Number.isFinite(logicalCores) ? logicalCores * 100 : null,
  });
  return success(
    {
      rawPercent,
      ...normalized,
      matchedPids: [...new Set(matchedPids)].sort((a, b) => a - b),
      found: matchedPids.length > 0,
    },
    { source: "cpuinfo" },
  );
}

function matchKilobytes(text, expression) {
  const match = text.match(expression);
  return match ? parseFiniteNumber(match[1]) : null;
}

export function parseMemInfo(text) {
  if (typeof text !== "string" || text.trim() === "") return failure("empty_output");
  if (/No process found|No process matching|Unknown package/i.test(text)) {
    return failure("no_process");
  }

  let pssKb = matchKilobytes(text, /^\s*TOTAL PSS:\s*([\d,]+)/imu);
  if (pssKb === null) pssKb = matchKilobytes(text, /^\s*TOTAL\s+([\d,]+)\b/mu);
  if (pssKb === null) pssKb = matchKilobytes(text, /^\s*TOTAL:\s*([\d,]+)\b/mu);
  if (pssKb === null) return failure("meminfo_parse_failed");

  const rssKb = matchKilobytes(text, /\bTOTAL RSS:\s*([\d,]+)/iu);
  const javaHeapKb = matchKilobytes(text, /^\s*Java Heap:\s*([\d,]+)/imu);
  const nativeHeapKb = matchKilobytes(text, /^\s*Native Heap:\s*([\d,]+)/imu);
  return success(
    { pssKb, rssKb, javaHeapKb, nativeHeapKb },
    { source: "meminfo" },
  );
}

function normalizeFrameColumn(column) {
  return column.replace(/[^A-Za-z0-9]/gu, "").toUpperCase();
}

export function parseGfxInfo(text) {
  if (typeof text !== "string" || text.trim() === "") return failure("empty_output");
  if (/No process found|No process matching/i.test(text)) return failure("no_process");

  const lines = text.split(/\r?\n/u);
  const frames = [];
  const seen = new Set();
  const warnings = [];
  let header = null;
  let profileIndex = 0;
  let invalidFrameCount = 0;

  for (const line of lines) {
    if (/---PROFILEDATA---/u.test(line)) {
      profileIndex += 1;
      header = null;
      continue;
    }
    if (line.includes(",")) {
      const columns = line.split(",").map((column) => column.trim());
      const normalized = columns.map(normalizeFrameColumn);
      if (
        normalized.includes("FLAGS") &&
        normalized.includes("INTENDEDVSYNC") &&
        normalized.includes("FRAMECOMPLETED")
      ) {
        header = normalized;
        continue;
      }
      if (!header || !/^\s*\d/u.test(line)) continue;
      const flagsIndex = header.indexOf("FLAGS");
      const intendedIndex = header.indexOf("INTENDEDVSYNC");
      const completedIndex = header.indexOf("FRAMECOMPLETED");
      const flags = Number(columns[flagsIndex]);
      const intendedVsyncNs = Number(columns[intendedIndex]);
      const frameCompletedNs = Number(columns[completedIndex]);
      if (
        !Number.isFinite(flags) ||
        !Number.isFinite(intendedVsyncNs) ||
        !Number.isFinite(frameCompletedNs) ||
        flags !== 0 ||
        intendedVsyncNs <= 0 ||
        frameCompletedNs < intendedVsyncNs
      ) {
        invalidFrameCount += 1;
        continue;
      }
      const key = `${profileIndex}:${intendedVsyncNs}:${frameCompletedNs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      frames.push({
        profileIndex,
        intendedVsyncNs,
        frameCompletedNs,
        durationMs: (frameCompletedNs - intendedVsyncNs) / 1_000_000,
      });
    }
  }

  const totalMatch = text.match(/Total frames rendered:\s*(\d+)/iu);
  const jankyMatch = text.match(/Janky frames:\s*(\d+)\s*\(([^)%]+)%/iu);
  if (invalidFrameCount > 0) warnings.push("ignored_invalid_frames");
  if (!lines.some((line) => normalizeFrameColumn(line).includes("INTENDEDVSYNC"))) {
    return failure("framestats_not_supported", { retryable: false });
  }

  frames.sort((a, b) => a.intendedVsyncNs - b.intendedVsyncNs);
  return success(
    {
      frames,
      invalidFrameCount,
      platformTotalFrames: totalMatch ? Number(totalMatch[1]) : null,
      platformJankyFrames: jankyMatch ? Number(jankyMatch[1]) : null,
      platformJankRate: jankyMatch ? Number(jankyMatch[2]) : null,
    },
    { warnings, source: "gfxinfo" },
  );
}

function percentile(sortedValues, quantile) {
  if (sortedValues.length === 0) return null;
  const index = Math.max(0, Math.ceil(sortedValues.length * quantile) - 1);
  return sortedValues[index];
}

export function summarizeFrameStats(frames, { refreshRateHz = undefined } = {}) {
  const safeFrames = Array.isArray(frames)
    ? frames.filter(
        (frame) =>
          Number.isFinite(frame?.durationMs) &&
          frame.durationMs >= 0 &&
          Number.isFinite(frame?.intendedVsyncNs),
      )
    : [];
  const durations = safeFrames.map((frame) => frame.durationMs).sort((a, b) => a - b);
  const budgetMs = Number.isFinite(refreshRateHz) && refreshRateHz > 0 ? 1000 / refreshRateHz : null;
  const jankyFrames = budgetMs === null ? null : durations.filter((duration) => duration > budgetMs).length;
  const frozenFrames = durations.filter((duration) => duration > 700).length;
  let activeFps = null;

  if (safeFrames.length >= 3) {
    const intended = [...new Set(safeFrames.map((frame) => frame.intendedVsyncNs))].sort(
      (a, b) => a - b,
    );
    const spanSeconds = (intended.at(-1) - intended[0]) / 1_000_000_000;
    if (intended.length >= 3 && spanSeconds > 0) {
      activeFps = (intended.length - 1) / spanSeconds;
      if (Number.isFinite(refreshRateHz) && refreshRateHz > 0) {
        activeFps = Math.min(activeFps, refreshRateHz);
      }
    }
  }

  return {
    frameCount: durations.length,
    frameDurationsMs: safeFrames.map((frame) => frame.durationMs),
    frameDurationMs: safeFrames.at(-1)?.durationMs ?? null,
    frameP50Ms: percentile(durations, 0.5),
    frameP90Ms: percentile(durations, 0.9),
    frameP95Ms: percentile(durations, 0.95),
    frameP99Ms: percentile(durations, 0.99),
    budgetMs,
    activeFps,
    jankyFrames,
    jankRate:
      jankyFrames === null || durations.length === 0 ? null : (jankyFrames / durations.length) * 100,
    frozenFrames,
  };
}

function readKeyValueNumber(line, key) {
  const match = line.match(new RegExp(`(?:^|\\s)${key}=([\\d,]+)(?:\\s|$)`, "u"));
  return match ? parseFiniteNumber(match[1]) : null;
}

export function parseNetstats(text, { uid } = {}) {
  if (typeof text !== "string" || text.trim() === "") return failure("empty_output");
  const targetUid = Number(uid);
  if (!Number.isSafeInteger(targetUid) || targetUid < 0) {
    return failure("invalid_uid", { retryable: false });
  }

  let inUidStats = false;
  let activeIdentity = false;
  let foundUid = false;
  let rxBytes = 0;
  let txBytes = 0;

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (/^UID stats:/iu.test(line)) {
      inUidStats = true;
      activeIdentity = false;
      continue;
    }
    if (/^UID tag stats:/iu.test(line)) {
      inUidStats = false;
      activeIdentity = false;
      continue;
    }
    if (!inUidStats) continue;

    if (/\buid=\d+/u.test(line)) {
      const lineUid = readKeyValueNumber(line, "uid");
      const tagMatch = line.match(/\btag=([^\s]+)/u);
      const tag = tagMatch?.[1]?.toLowerCase();
      activeIdentity = lineUid === targetUid && (tag === undefined || tag === "0" || tag === "0x0");
      if (activeIdentity) {
        foundUid = true;
        const sameLineRx = readKeyValueNumber(line, "rb") ?? readKeyValueNumber(line, "rxBytes");
        const sameLineTx = readKeyValueNumber(line, "tb") ?? readKeyValueNumber(line, "txBytes");
        if (sameLineRx !== null) rxBytes += sameLineRx;
        if (sameLineTx !== null) txBytes += sameLineTx;
      }
      continue;
    }

    if (!activeIdentity) continue;
    const bucketRx = readKeyValueNumber(line, "rb") ?? readKeyValueNumber(line, "rxBytes");
    const bucketTx = readKeyValueNumber(line, "tb") ?? readKeyValueNumber(line, "txBytes");
    if (bucketRx !== null) rxBytes += bucketRx;
    if (bucketTx !== null) txBytes += bucketTx;
  }

  if (!/UID stats:/iu.test(text)) return failure("netstats_uid_section_missing");
  return success({ uid: targetUid, foundUid, rxBytes, txBytes }, { source: "netstats" });
}

export function computeNetworkDelta(start, end, durationMs) {
  if (!start || !end || start.uid !== end.uid) return failure("network_snapshot_mismatch");
  const elapsedMs = Number(durationMs);
  const rxBytes = end.rxBytes - start.rxBytes;
  const txBytes = end.txBytes - start.txBytes;
  if (rxBytes < 0 || txBytes < 0) return failure("network_counter_regressed", { retryable: false });
  return success({
    networkRxBytes: rxBytes,
    networkTxBytes: txBytes,
    networkRxBytesPerSecond: elapsedMs > 0 ? rxBytes / (elapsedMs / 1000) : null,
    networkTxBytesPerSecond: elapsedMs > 0 ? txBytes / (elapsedMs / 1000) : null,
  });
}

function parseBoolean(value) {
  if (/^true$/iu.test(value)) return true;
  if (/^false$/iu.test(value)) return false;
  return null;
}

export function parseBattery(text) {
  if (typeof text !== "string" || text.trim() === "") return failure("empty_output");
  const values = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*([^:]+):\s*(.*?)\s*$/u);
    if (match) values.set(match[1].trim().toLowerCase(), match[2]);
  }

  const level = parseFiniteNumber(values.get("level"));
  const scale = parseFiniteNumber(values.get("scale"));
  const temperatureTenthsC = parseFiniteNumber(values.get("temperature"));
  const voltageMv = parseFiniteNumber(values.get("voltage"));
  const powerFields = ["ac powered", "usb powered", "wireless powered"]
    .filter((key) => values.has(key))
    .map((key) => parseBoolean(values.get(key)));
  if (level === null && temperatureTenthsC === null && voltageMv === null) {
    return failure("battery_parse_failed");
  }

  return success(
    {
      levelPercent: level !== null && scale && scale > 0 ? (level / scale) * 100 : null,
      temperatureC: temperatureTenthsC === null ? null : temperatureTenthsC / 10,
      voltageMv,
      powered: powerFields.length > 0 && powerFields.every((value) => value !== null)
        ? powerFields.some(Boolean)
        : null,
    },
    { source: "battery" },
  );
}

export function parseThermalStatus(text) {
  if (typeof text !== "string" || text.trim() === "") return failure("empty_output");
  const numericPatterns = [
    /\bmStatus\s*[=:]\s*(\d+)/iu,
    /current thermal status\s*[=:]\s*(\d+)/iu,
    /thermal status\s*[=:]\s*(\d+)/iu,
  ];
  for (const pattern of numericPatterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const code = Number(match[1]);
    if (code >= 0 && code < THERMAL_STATUS_NAMES.length) {
      return success({ code, name: THERMAL_STATUS_NAMES[code] }, { source: "thermalservice" });
    }
  }

  const nameMatch = text.match(/(?:current\s+)?thermal status\s*[=:]\s*(NONE|LIGHT|MODERATE|SEVERE|CRITICAL|EMERGENCY|SHUTDOWN)/iu);
  if (nameMatch) {
    const name = nameMatch[1].toUpperCase();
    return success({ code: THERMAL_STATUS_NAMES.indexOf(name), name }, { source: "thermalservice" });
  }
  return failure("thermal_status_not_found", { retryable: false });
}

export function parseDumpsysServices(text) {
  if (typeof text !== "string" || text.trim() === "") return failure("empty_output");
  const services = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9_.-]+$/u.test(line));
  return success([...new Set(services)]);
}
