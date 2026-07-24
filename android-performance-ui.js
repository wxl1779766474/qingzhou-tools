import {
  MAX_PERFORMANCE_SAMPLES,
  appendPerformanceSample,
  createPerformanceReport,
  normalizePerformanceSample,
  performanceReportToCsv,
  performanceReportToJson,
} from "./android-performance-core.js?v=20260724-memory-v3";
import { createAndroidShellRunner, validateAndroidPackageName } from "./android-performance-commands.js?v=20260724-memory-v3";
import { createPerformanceChart } from "./android-performance-chart.js?v=20260724-memory-series-v1";
import { createPerformanceSession, inspectAndroidDevice } from "./android-performance-collectors.js?v=20260724-memory-v3";
import {
  ANDROID_MEMORY_SERIES_KEYS,
  readAndroidMemorySeriesPreferences,
  writeAndroidMemorySeriesPreferences,
} from "./android-performance-preferences.js?v=20260724-memory-series-v1";
import { createPerformanceReportRepository } from "./android-performance-storage.js?v=20260724-memory-v3";

const DEFAULT_DURATION_MINUTES = 10;
const MAX_DURATION_MINUTES = 60;
const REPORT_LIST_LIMIT = 20;
const CHART_WINDOW_MS = 10 * 60_000;

export const PERFORMANCE_CHART_FIELDS = Object.freeze({
  cpu: "cpuPercent",
  memory: "memoryPssMb",
  frame: "frameTimeMs",
});

const PERFORMANCE_CHART_SERIES_FIELDS = Object.freeze({
  cpu: Object.freeze(["cpuPercent"]),
  memory: Object.freeze([
    "memoryPssMb",
    "memoryJavaHeapKb",
    "memoryNativeHeapKb",
    "memoryCodeKb",
    "memoryGraphicsKb",
  ]),
  frame: Object.freeze(["frameTimeMs"]),
});

export const PERFORMANCE_MEMORY_CHART_SERIES = Object.freeze([
  Object.freeze({
    key: "memoryPssMb",
    label: "PSS",
    unit: " MB",
    color: "#438cf0",
    scale: 1,
  }),
  Object.freeze({
    key: "memoryJavaHeapKb",
    label: "Java Heap",
    unit: " MB",
    color: "#0d7965",
    scale: 1 / 1024,
  }),
  Object.freeze({
    key: "memoryNativeHeapKb",
    label: "Native Heap",
    unit: " MB",
    color: "#d97832",
    scale: 1 / 1024,
  }),
  Object.freeze({
    key: "memoryCodeKb",
    label: "Code",
    unit: " MB",
    color: "#7b61d1",
    scale: 1 / 1024,
  }),
  Object.freeze({
    key: "memoryGraphicsKb",
    label: "Graphics",
    unit: " MB",
    color: "#b64f8c",
    scale: 1 / 1024,
  }),
]);

const MEMORY_SAMPLE_FIELDS = PERFORMANCE_CHART_SERIES_FIELDS.memory;

const PHASE_LABELS = Object.freeze({
  loading: "正在准备浏览器连接能力",
  unsupported: "当前浏览器不可用",
  idle: "等待连接",
  connecting: "等待选择设备并在手机上授权",
  connected: "设备已连接",
  preparing: "正在准备测试",
  running: "测试进行中",
  stopping: "正在生成报告",
  completed: "测试已完成",
  error: "需要处理后重试",
});

const METRIC_PRESENTATION = Object.freeze({
  cpu: {
    field: "cpuPercent",
    format: (value) => formatNumber(value, 1, "%"),
  },
  memory: {
    field: "memoryPssMb",
    format: (value) => formatNumber(value, 1, " MB"),
  },
  fps: {
    field: "activeFps",
    format: (value) => formatNumber(value, 1, ""),
  },
  jank: {
    field: "jankRate",
    format: (value) => formatNumber(value, 1, "%"),
  },
  network: {
    field: "networkTotalBytes",
    format: formatBytes,
  },
  temperature: {
    field: "batteryTemperatureC",
    format: (value) => formatNumber(value, 1, " °C"),
  },
});

const END_REASON_LABELS = Object.freeze({
  user: "用户停止",
  "max-duration": "达到设定时长",
  "device-disconnected": "设备断开",
  "process-exited": "目标 App 进程退出",
  "tool-switched": "切换工具",
  error: "采集异常",
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function memoryKilobytesToMegabytes(value) {
  const kilobytes = finite(value);
  return kilobytes === null ? null : kilobytes / 1024;
}

function formatNumber(value, digits = 1, suffix = "") {
  const number = finite(value);
  return number === null ? "—" : `${number.toFixed(digits)}${suffix}`;
}

function formatMemoryKilobytes(value) {
  return formatNumber(memoryKilobytesToMegabytes(value), 1, " MB");
}

function formatBytes(value) {
  const bytes = finite(value);
  if (bytes === null) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((finite(milliseconds) ?? 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatLocalDate(timestamp) {
  if (!Number.isFinite(timestamp)) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function safeFilePart(value) {
  return String(value || "android-app")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80) || "android-app";
}

export function maskAndroidSerial(serial) {
  const value = String(serial || "").trim();
  if (!value) return "未提供";
  if (value.length <= 4) return "••••";
  return `${value.slice(0, 2)}${"•".repeat(Math.min(6, value.length - 4))}${value.slice(-2)}`;
}

export function deriveAndroidPerformanceSupport({
  secureContext = globalThis.isSecureContext === true,
  usb = globalThis.navigator?.usb,
} = {}) {
  if (!secureContext) {
    return {
      supported: false,
      code: "insecure-context",
      message: "请通过 HTTPS 或 localhost 打开页面后再连接 Android 设备。",
    };
  }
  if (!usb) {
    return {
      supported: false,
      code: "webusb-unsupported",
      message: "请使用桌面版 Chrome 或 Edge。Safari、Firefox 和手机浏览器暂不支持 WebUSB ADB。",
    };
  }
  return { supported: true, code: null, message: "浏览器支持 WebUSB，可以连接设备。" };
}

function packageNameOf(item) {
  if (typeof item === "string") return item;
  return String(item?.packageName || item?.name || "");
}

function packageUidOf(item) {
  const uid = Number(item?.uid);
  return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
}

function normalizePackages(items) {
  const byName = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const packageName = packageNameOf(item);
    if (!packageName) continue;
    byName.set(packageName, { packageName, uid: packageUidOf(item) });
  }
  return [...byName.values()].sort((left, right) => left.packageName.localeCompare(right.packageName));
}

function statusMessage(error) {
  const code = error?.code;
  if (code === "device-busy") {
    return "USB 接口正被 Android Studio 或本机 adb 占用。请关闭相关程序，必要时运行 adb kill-server 后重新插拔。";
  }
  if (code === "connection-failed") {
    return "连接或授权失败。请确认 USB 调试已开启，并在手机弹窗中允许这台电脑调试。";
  }
  if (code === "connection-timeout") return "等待设备选择或手机授权超时，请保持手机解锁后重试。";
  if (code === "connection-cancelled") return "设备连接已取消。";
  if (code === "insecure-context") return "Android 设备连接需要 HTTPS 或 localhost。";
  if (code === "webusb-unsupported") return deriveAndroidPerformanceSupport().message;
  if (code === "command_timeout") return "设备响应超时，请保持手机解锁后重试。";
  return error instanceof Error && error.message
    ? error.message
    : "操作未完成，请检查数据线、USB 调试和设备授权后重试。";
}

function reportStatusForReason(reason) {
  if (reason === "max-duration") return "completed";
  if (reason === "user") return "stopped";
  if (reason === "error") return "failed";
  return "interrupted";
}

export function appendPerformanceMetricSample(samples, rawSample) {
  const source = Array.isArray(samples) ? samples : [];
  const sample = normalizePerformanceSample(rawSample);
  const previous = source.at(-1);
  const sequenceAdvances = (
    !previous ||
    sample.sequence === null ||
    previous?.sequence === null ||
    sample.sequence > previous.sequence
  );
  if (
    !previous ||
    (sample.timestamp > previous.timestamp && sequenceAdvances) ||
    (
      sample.timestamp === previous.timestamp &&
      sample.sequence !== null &&
      (previous.sequence === null || sample.sequence > previous.sequence)
    )
  ) {
    return [...source, sample]
      .slice(-MAX_PERFORMANCE_SAMPLES);
  }
  return appendPerformanceSample(source, sample);
}

function normalizePerformanceMetricSamples(source) {
  let samples = [];
  for (const rawSample of Array.isArray(source) ? source : []) {
    try {
      samples = appendPerformanceMetricSample(samples, rawSample);
    } catch {
      // Optional malformed metrics do not invalidate the rest of a partial report.
    }
  }
  return samples;
}

export function selectPerformanceChartSamples(samples, fieldOrFields) {
  const fields = Array.isArray(fieldOrFields) ? fieldOrFields : [fieldOrFields];
  const knownFields = new Set(Object.values(PERFORMANCE_CHART_SERIES_FIELDS).flat());
  if (
    fields.length === 0 ||
    fields.some((field) => !knownFields.has(field))
  ) {
    throw new TypeError("未知的性能图表字段");
  }
  return normalizePerformanceMetricSamples(samples)
    .filter((sample) => fields.some((field) => finite(sample[field]) !== null));
}

function latestFieldValue(samples, field) {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const value = finite(samples[index]?.[field]);
    if (value !== null) return value;
  }
  return null;
}

function latestCpuSource(samples, report) {
  const reportSource = report?.metrics?.cpu?.source;
  if (typeof reportSource === "string" && reportSource) return reportSource;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    if (
      (finite(sample?.cpuPercent) !== null || finite(sample?.cpuRawPercent) !== null)
      && typeof sample?.source === "string"
      && sample.source
    ) {
      return sample.source;
    }
  }
  return null;
}

function latestCpuState(report, source) {
  const reportState = report?.metrics?.cpu?.state;
  if (typeof reportState === "string" && reportState) return reportState;
  return normalizeCpuSource(source) === "top" ? "supported" : "degraded";
}

function normalizeCpuSource(source) {
  const normalized = typeof source === "string" ? source.trim().toLowerCase() : "";
  if (normalized === "top") return "top";
  if (["proc", "proc-stat", "procfs"].includes(normalized)) return "proc";
  if (normalized === "cpuinfo") return "cpuinfo";
  return null;
}

export function getPerformanceCpuStatusLabel({
  source = null,
  state = null,
  status = null,
  report = false,
} = {}) {
  if (report) {
    if (normalizeCpuSource(source) === null) return "报告最终值";
    const sourceLabel = getPerformanceCpuStatusLabel({ source, state, status });
    return sourceLabel === "等待首个 CPU 样本"
      ? "报告最终值"
      : `报告最终值 · ${sourceLabel}`;
  }
  if (["probing", "pending"].includes(state)) return "等待首个 CPU 样本";
  if (state === "paused" || status === "temporarily-unavailable") return "CPU 暂时无数据";
  if (state === "unsupported" || status === "unsupported") return "CPU 采集不可用";

  const normalizedSource = normalizeCpuSource(source);
  if (normalizedSource === "top") return "正常采集";
  if (normalizedSource === "proc") return "已切换到 1 秒兼容采集";
  if (normalizedSource === "cpuinfo") return "低频兜底采集";
  if (state === "supported" || status === "ok") return "正常采集";
  if (state === "degraded" || status === "degraded") return "兼容采集中";
  return "CPU 状态更新";
}

export function getPerformanceMemoryStatusLabel(rawSample = {}) {
  const diagnostics = rawSample?.diagnostics;
  if (
    diagnostics?.partial === true ||
    Number(diagnostics?.failedProcessCount) > 0
  ) {
    return "部分进程数据";
  }
  if (Array.isArray(diagnostics?.missingFields) && diagnostics.missingFields.length > 0) {
    return "部分分类不可用";
  }
  if (rawSample?.status === "unsupported") return "设备不支持";
  if (rawSample?.status === "degraded") return "已降级采集";
  if (rawSample?.status === "temporarily-unavailable") return "暂时无数据";
  return "采集中";
}

export function createPerformanceReportView(report) {
  const samples = normalizePerformanceMetricSamples(report?.samples);
  const charts = Object.fromEntries(
    Object.entries(PERFORMANCE_CHART_SERIES_FIELDS).map(([key, fields]) => [
      key,
      samples.filter(
        (sample) => fields.some((field) => finite(sample[field]) !== null),
      ),
    ]),
  );
  const latest = Object.fromEntries(
    Object.values(METRIC_PRESENTATION).map(({ field }) => [
      field,
      latestFieldValue(samples, field),
    ]),
  );
  const latestMemorySample = [...samples]
    .reverse()
    .find(
      (sample) =>
        sample.metric === "memory" ||
        MEMORY_SAMPLE_FIELDS.some((field) => finite(sample[field]) !== null),
    );
  for (const field of MEMORY_SAMPLE_FIELDS) {
    latest[field] = finite(latestMemorySample?.[field]);
  }
  latest.cpuRawPercent = latestFieldValue(samples, "cpuRawPercent");
  latest.networkTotalBytes = finite(report?.summary?.networkDelta?.totalBytes);
  const cpuSource = latestCpuSource(samples, report);
  return {
    samples,
    charts,
    latest,
    cpuSource,
    cpuState: latestCpuState(report, cpuSource),
    cpuUsesRawValue: latest.cpuPercent === null && latest.cpuRawPercent !== null,
  };
}

function createMarkup() {
  return `
    <div class="android-performance" data-performance-root>
      <section class="performance-connection panel" aria-labelledby="performance-connect-title">
        <div class="panel-header performance-panel-heading">
          <div><p class="eyebrow">浏览器直连 ADB</p><h2 id="performance-connect-title">连接 Android 设备</h2><p>无需安装助手，浏览器通过 USB 直接读取已授权设备。</p></div>
          <span class="performance-phase" data-performance-phase>正在检测</span>
        </div>
        <div class="panel-body performance-connection-body">
          <div class="performance-support" data-performance-support role="status"></div>
          <ol class="performance-steps" aria-label="连接前准备">
            <li><span>1</span><div><strong>开启 USB 调试</strong><small>手机设置 → 开发者选项 → USB 调试</small></div></li>
            <li><span>2</span><div><strong>使用可传数据的线缆</strong><small>连接后保持手机解锁</small></div></li>
            <li><span>3</span><div><strong>允许调试授权</strong><small>在手机 RSA 弹窗中点击允许</small></div></li>
          </ol>
          <div class="performance-actions">
            <button class="primary-button" type="button" data-performance-action="connect" disabled>连接 Android 设备</button>
            <button class="ghost-button" type="button" data-performance-action="disconnect" hidden>断开设备</button>
          </div>
          <p class="performance-help">如果浏览器选择器里没有设备，请切换 USB 用途为“传输文件”，或更换数据线。本站不会把设备信息和采样数据上传云端。</p>
        </div>
      </section>

      <section class="performance-device panel" aria-labelledby="performance-device-title">
        <div class="panel-header performance-panel-heading">
          <div><h2 id="performance-device-title">设备与目标 App</h2><p>默认识别当前前台应用，也可搜索或手动输入包名。</p></div>
          <button class="ghost-button performance-compact-button" type="button" data-performance-action="refresh-device" disabled>重新识别</button>
        </div>
        <div class="panel-body performance-device-body">
          <dl class="performance-device-facts">
            <div><dt>设备</dt><dd data-device-field="model">未连接</dd></div>
            <div><dt>系统</dt><dd data-device-field="android">—</dd></div>
            <div><dt>刷新率</dt><dd data-device-field="refresh">—</dd></div>
            <div><dt>序列号</dt><dd data-device-field="serial">—</dd></div>
          </dl>
          <div class="performance-app-picker">
            <label class="field-label" for="performance-package">目标 App 包名</label>
            <div class="performance-package-row">
              <input class="field code-field" id="performance-package" data-performance-field="package" list="performance-packages" autocomplete="off" placeholder="com.example.app" disabled />
              <datalist id="performance-packages"></datalist>
              <button class="secondary-button" type="button" data-performance-action="use-foreground" disabled>使用前台 App</button>
            </div>
            <p class="performance-field-hint" data-package-hint>连接后自动识别。只允许标准 Android 包名，不会执行任意 Shell。</p>
          </div>
        </div>
      </section>

      <section class="performance-controls panel" aria-labelledby="performance-control-title">
        <div class="panel-header performance-panel-heading">
          <div><h2 id="performance-control-title">测试控制</h2><p>开始后在手机上手动操作 App，最长可测试 60 分钟。</p></div>
          <time class="performance-timer" data-performance-timer aria-label="测试计时">00:00</time>
        </div>
        <div class="panel-body performance-control-body">
          <label class="performance-duration"><span>计划时长</span><select class="field" data-performance-field="duration" disabled>
            <option value="5">5 分钟</option>
            <option value="10" selected>10 分钟</option>
            <option value="15">15 分钟</option>
            <option value="30">30 分钟</option>
            <option value="60">60 分钟</option>
          </select></label>
          <div class="performance-actions">
            <button class="primary-button" type="button" data-performance-action="start" disabled>开始测试</button>
            <button class="performance-stop-button" type="button" data-performance-action="stop" disabled>停止并生成报告</button>
          </div>
          <p class="performance-control-message" data-performance-message aria-live="polite">请先连接设备。</p>
        </div>
      </section>

      <section class="performance-live" aria-labelledby="performance-live-title">
        <div class="performance-section-heading"><div><p class="eyebrow">实时采样</p><h2 id="performance-live-title">性能概览</h2></div><span>缺失项显示“—”，不会伪装成 0</span></div>
        <div class="performance-metric-grid">
          ${metricCard("cpu", "应用 CPU", "整机占比", "%")}
          ${memoryMetricCard()}
          ${metricCard("fps", "活动渲染 FPS", "仅有新帧时估算", "FPS")}
          ${metricCard("jank", "卡顿率", "按设备刷新预算", "%")}
          ${metricCard("network", "网络区间流量", "开始与结束快照", "RX + TX")}
          ${metricCard("temperature", "设备电池温度", "不是 CPU/GPU 温度", "°C")}
        </div>
        <div class="performance-chart-grid">
          ${chartCard("cpu", "CPU 曲线", "整机占比 0–100%")}
          ${chartCard("memory", "App 内存曲线", "PSS 总内存与 App Summary 主要归因分类")}
          ${chartCard("frame", "帧耗时曲线", "普通 View/HWUI App")}
        </div>
      </section>

      <section class="performance-report panel" aria-labelledby="performance-report-title">
        <div class="panel-header performance-panel-heading">
          <div><h2 id="performance-report-title">本次报告</h2><p>停止、断连或到达时长后生成；报告只保存在当前浏览器。</p></div>
          <div class="performance-report-actions">
            <button class="secondary-button performance-compact-button" type="button" data-performance-action="export-json" disabled>导出 JSON</button>
            <button class="ghost-button performance-compact-button" type="button" data-performance-action="export-csv" disabled>导出 CSV</button>
          </div>
        </div>
        <div class="panel-body performance-report-body" data-performance-report>
          <div class="performance-report-empty"><span aria-hidden="true">⌁</span><strong>完成一次测试后查看汇总</strong><p>当前报告即使未能写入浏览器存储，仍可立即导出。</p></div>
        </div>
      </section>

      <section class="performance-recent panel" aria-labelledby="performance-recent-title">
        <div class="panel-header performance-panel-heading">
          <div><h2 id="performance-recent-title">最近报告</h2><p>最多保留 20 份，点击即可恢复查看，不会重新连接或采集。</p></div>
          <button class="ghost-button performance-compact-button" type="button" data-performance-action="clear-reports" disabled>清空报告</button>
        </div>
        <div class="panel-body performance-recent-body" data-performance-reports>
          <p class="performance-reports-empty">暂无本地报告。</p>
        </div>
      </section>

      <aside class="performance-limitations" aria-label="指标边界">
        <strong>快速诊断边界</strong>
        <p>Unity、Unreal、OpenGL 或 Vulkan 游戏可能没有可靠帧数据；USB 通常会充电，因此电量变化不能代表 App 精确功耗。若需重置网页 ADB 凭据，请清除本站浏览器数据。</p>
      </aside>
    </div>`;
}

function metricCard(key, title, hint, unit) {
  return `<article class="performance-metric-card" data-metric-card="${key}">
    <div><span class="performance-metric-label">${title}</span><small>${hint}</small></div>
    <strong data-metric-value="${key}">—</strong>
    <span class="performance-metric-unit">${unit}</span>
    <p data-metric-status="${key}">等待测试</p>
  </article>`;
}

function memoryMetricCard() {
  return `<article class="performance-metric-card performance-memory-card" data-metric-card="memory">
    <div><span class="performance-metric-label">App 内存</span><small>PSS 总内存 · 目标全部进程</small></div>
    <strong data-metric-value="memory">—</strong>
    <span class="performance-metric-unit">MB</span>
    <div class="performance-memory-breakdown" aria-label="App 内存分类">
      <span class="performance-memory-breakdown-item is-java">
        <span>Java Heap</span>
        <strong data-memory-value="java">—</strong>
      </span>
      <span class="performance-memory-breakdown-item is-native">
        <span>Native Heap</span>
        <strong data-memory-value="native">—</strong>
      </span>
      <span class="performance-memory-breakdown-item is-code">
        <span>Code</span>
        <strong data-memory-value="code">—</strong>
      </span>
      <span class="performance-memory-breakdown-item is-graphics">
        <span>Graphics</span>
        <strong data-memory-value="graphics">—</strong>
      </span>
    </div>
    <p data-metric-status="memory">等待测试</p>
  </article>`;
}

function memoryGuide() {
  return `<div class="performance-memory-guide" aria-label="App 内存指标说明">
    <p>分类来自 Android App Summary；当前展示主要分类，PSS 还包含 Stack、Private Other 和 System，因此分类之和不等于 PSS。</p>
    <fieldset class="performance-memory-series">
      <legend>选择曲线显示项</legend>
      <div class="performance-memory-series-grid">
        ${memorySeriesOption("memoryPssMb", "PSS", "is-pss", "目标 App 全部进程的总内存权重；独占内存全部计入，共享内存按比例计入。")}
        ${memorySeriesOption("memoryJavaHeapKb", "Java Heap", "is-java", "Java/Kotlin 对象相关的 ART/Dalvik 堆归因内存，不是 Heap Alloc。")}
        ${memorySeriesOption("memoryNativeHeapKb", "Native Heap", "is-native", "C/C++、JNI 等 native malloc 堆的归因内存，不是 Heap Alloc。")}
        ${memorySeriesOption("memoryCodeKb", "Code", "is-code", "已载入的 APK、DEX/OAT、SO、字体与代码缓存等静态代码和资源。")}
        ${memorySeriesOption("memoryGraphicsKb", "Graphics", "is-graphics", "图形缓冲、纹理及 EGL/GL 等图形私有内存；部分机型可能受驱动上报影响。")}
      </div>
    </fieldset>
  </div>`;
}

function memorySeriesOption(key, label, className, description) {
  return `<label class="performance-memory-series-option ${className}" data-memory-series-option="${key}">
    <input type="checkbox" name="performance-memory-series" value="${key}" data-performance-memory-series="${key}" aria-controls="performance-chart-memory" checked>
    <span class="performance-memory-series-copy">
      <strong><span class="performance-memory-series-dot" aria-hidden="true"></span>${label}</strong>
      <span class="performance-memory-series-state" data-memory-series-state aria-hidden="true">显示中</span>
      <small>${description}</small>
    </span>
  </label>`;
}

function chartCard(key, title, hint) {
  const guide = key === "memory" ? memoryGuide() : "";
  return `<article class="performance-chart-card" data-performance-chart-card="${key}"><header><div><h3>${title}</h3><p>${hint}</p></div><span data-chart-latest="${key}">—</span></header><canvas id="performance-chart-${key}" data-performance-chart="${key}" height="240"></canvas>${guide}</article>`;
}

function normalizeDurationMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return DEFAULT_DURATION_MINUTES;
  return Math.min(MAX_DURATION_MINUTES, Math.max(1, Math.round(minutes)));
}

function currentSampleNetworkTotal(rawSample, normalized) {
  const explicit = finite(rawSample?.networkRxBytes) ?? finite(rawSample?.rxBytes);
  const explicitTx = finite(rawSample?.networkTxBytes) ?? finite(rawSample?.txBytes);
  if (explicit !== null || explicitTx !== null) return (explicit ?? 0) + (explicitTx ?? 0);
  const rx = finite(normalized.rxBytes);
  const tx = finite(normalized.txBytes);
  return rx === null && tx === null ? null : (rx ?? 0) + (tx ?? 0);
}

function createDownload(content, type, filename) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function createAndroidPerformanceTool({
  showToast = () => {},
  confirmLeave = (message) => globalThis.confirm?.(message) !== false,
  loadAdbModule = () => import("./android-performance-adb.bundle.js"),
  repository = null,
} = {}) {
  const runtime = {
    root: null,
    mounted: false,
    phase: "loading",
    adapter: null,
    runner: null,
    session: null,
    device: null,
    packages: [],
    foregroundPackage: "",
    selectedPackage: "",
    startedAt: null,
    latest: {},
    samples: [],
    currentReport: null,
    reports: [],
    charts: {},
    memorySeriesVisibility: new Set(ANDROID_MEMORY_SERIES_KEYS),
    memorySeriesPreferenceLoaded: false,
    memorySeriesPreferenceStorage: null,
    timerId: null,
    stopPromise: null,
    loadToken: 0,
    disconnectUnsubscribe: null,
    repository: repository ?? createPerformanceReportRepository(),
    storagePersistent: repository ? repository.persistent !== false : true,
  };

  const refs = {};

  function loadMemorySeriesPreferenceOnce() {
    if (runtime.memorySeriesPreferenceLoaded) return;
    runtime.memorySeriesPreferenceLoaded = true;
    try {
      runtime.memorySeriesPreferenceStorage = globalThis.localStorage ?? null;
    } catch {
      runtime.memorySeriesPreferenceStorage = null;
    }

    try {
      const stored = readAndroidMemorySeriesPreferences(
        runtime.memorySeriesPreferenceStorage,
      );
      if (Array.isArray(stored)) runtime.memorySeriesVisibility = new Set(stored);
    } catch {
      // Storage access must never prevent the tool from mounting with safe defaults.
    }
  }

  function syncMemorySeriesControl(key) {
    if (!runtime.root) return;
    const control = runtime.root.querySelector(
      `[data-performance-memory-series="${key}"]`,
    );
    if (!control) return;
    const visible = runtime.memorySeriesVisibility.has(key);
    const option = control.closest("[data-memory-series-option]");
    control.checked = visible;
    option?.classList.toggle("is-series-hidden", !visible);
    const state = option?.querySelector("[data-memory-series-state]");
    if (state) state.textContent = visible ? "显示中" : "已隐藏";
  }

  function applyMemorySeriesVisibility() {
    for (const key of ANDROID_MEMORY_SERIES_KEYS) {
      const visible = runtime.memorySeriesVisibility.has(key);
      runtime.charts.memory?.setSeriesVisible(key, visible);
      syncMemorySeriesControl(key);
    }
  }

  function setMemorySeriesVisibility(key, visible) {
    if (!ANDROID_MEMORY_SERIES_KEYS.includes(key)) return false;
    if (visible) runtime.memorySeriesVisibility.add(key);
    else runtime.memorySeriesVisibility.delete(key);

    runtime.charts.memory?.setSeriesVisible(key, visible);
    syncMemorySeriesControl(key);

    try {
      writeAndroidMemorySeriesPreferences(
        runtime.memorySeriesPreferenceStorage,
        [...runtime.memorySeriesVisibility],
      );
    } catch {
      // The in-memory choice stays active even when browser persistence is unavailable.
    }
    return true;
  }

  function captureRefs() {
    refs.phase = runtime.root.querySelector("[data-performance-phase]");
    refs.support = runtime.root.querySelector("[data-performance-support]");
    refs.connect = runtime.root.querySelector('[data-performance-action="connect"]');
    refs.disconnect = runtime.root.querySelector('[data-performance-action="disconnect"]');
    refs.refresh = runtime.root.querySelector('[data-performance-action="refresh-device"]');
    refs.start = runtime.root.querySelector('[data-performance-action="start"]');
    refs.stop = runtime.root.querySelector('[data-performance-action="stop"]');
    refs.package = runtime.root.querySelector('[data-performance-field="package"]');
    refs.duration = runtime.root.querySelector('[data-performance-field="duration"]');
    refs.packages = runtime.root.querySelector("#performance-packages");
    refs.message = runtime.root.querySelector("[data-performance-message]");
    refs.timer = runtime.root.querySelector("[data-performance-timer]");
    refs.report = runtime.root.querySelector("[data-performance-report]");
    refs.reports = runtime.root.querySelector("[data-performance-reports]");
    refs.clearReports = runtime.root.querySelector('[data-performance-action="clear-reports"]');
    refs.exportJson = runtime.root.querySelector('[data-performance-action="export-json"]');
    refs.exportCsv = runtime.root.querySelector('[data-performance-action="export-csv"]');
  }

  function setPhase(phase, message = "") {
    runtime.phase = phase;
    if (!runtime.mounted) return;
    refs.phase.textContent = PHASE_LABELS[phase] ?? phase;
    refs.phase.dataset.state = phase;
    if (message) refs.message.textContent = message;
    updateControls();
  }

  function updateControls() {
    if (!runtime.mounted) return;
    const connected = Boolean(runtime.adapter?.connected && runtime.runner);
    const connecting = Boolean(runtime.adapter?.connecting);
    const busy = ["connecting", "preparing", "running", "stopping"].includes(runtime.phase);
    const running = runtime.phase === "running" || runtime.phase === "stopping";
    refs.connect.hidden = connected || connecting;
    refs.disconnect.hidden = !connected && !connecting;
    refs.connect.disabled = runtime.phase !== "idle" && runtime.phase !== "error";
    refs.disconnect.disabled = runtime.phase === "stopping";
    refs.refresh.disabled = !connected || busy;
    refs.package.disabled = !connected || running || runtime.phase === "preparing";
    refs.duration.disabled = !connected || running || runtime.phase === "preparing";
    runtime.root.querySelector('[data-performance-action="use-foreground"]').disabled = !connected || running || !runtime.foregroundPackage;
    refs.start.disabled = !connected || busy || !runtime.selectedPackage;
    refs.stop.disabled = runtime.phase !== "running";
    refs.exportJson.disabled = !runtime.currentReport;
    refs.exportCsv.disabled = !runtime.currentReport;
    refs.clearReports.disabled = !runtime.reports.length;
    for (const button of runtime.root.querySelectorAll('[data-performance-action="open-report"]')) {
      button.disabled = running || runtime.phase === "preparing";
    }
  }

  function updateDevice() {
    if (!runtime.mounted) return;
    const device = runtime.device;
    const set = (field, value) => {
      const node = runtime.root.querySelector(`[data-device-field="${field}"]`);
      if (node) node.textContent = value;
    };
    set("model", device ? [device.manufacturer, device.model].filter(Boolean).join(" ") || "Android 设备" : "未连接");
    set("android", device ? `Android ${device.androidVersion || "未知"} · API ${device.sdkVersion || device.sdk || "—"}` : "—");
    set("refresh", device?.refreshRateHz ? `${Number(device.refreshRateHz).toFixed(0)} Hz` : "—");
    set("serial", runtime.adapter?.device?.serial ? maskAndroidSerial(runtime.adapter.device.serial) : "—");
    refs.packages.innerHTML = runtime.packages
      .map((item) => `<option value="${escapeHtml(item.packageName)}"></option>`)
      .join("");
    refs.package.value = runtime.selectedPackage;
    const hint = runtime.root.querySelector("[data-package-hint]");
    if (hint) {
      hint.textContent = runtime.foregroundPackage
        ? `已识别前台 App：${runtime.foregroundPackage}`
        : "未自动识别前台 App，请搜索或手动输入标准包名。";
    }
    updateControls();
  }

  function resetMetrics({ starting = false } = {}) {
    runtime.latest = {};
    runtime.samples = [];
    for (const [key] of Object.entries(METRIC_PRESENTATION)) {
      if (key !== "memory") updateMetric(key, null, "等待测试");
    }
    updateMemoryMetric(null, "等待测试");
    if (starting) updateMetric("cpu", null, "等待首个 CPU 样本");
    for (const chart of Object.values(runtime.charts)) chart.setSamples([]);
    for (const node of runtime.root?.querySelectorAll("[data-chart-latest]") ?? []) node.textContent = "—";
  }

  function updateMetric(key, value, status = "采集中") {
    if (!runtime.mounted) return;
    const presentation = METRIC_PRESENTATION[key];
    const valueNode = runtime.root.querySelector(`[data-metric-value="${key}"]`);
    const statusNode = runtime.root.querySelector(`[data-metric-status="${key}"]`);
    const card = runtime.root.querySelector(`[data-metric-card="${key}"]`);
    if (valueNode) valueNode.textContent = presentation.format(value);
    if (statusNode) statusNode.textContent = status;
    card?.classList.toggle("is-unavailable", finite(value) === null);
  }

  function updateMemoryMetric(sample, status = "采集中") {
    if (!runtime.mounted) return;
    const pss = finite(sample?.memoryPssMb);
    const javaHeap = finite(sample?.memoryJavaHeapKb);
    const nativeHeap = finite(sample?.memoryNativeHeapKb);
    const code = finite(sample?.memoryCodeKb);
    const graphics = finite(sample?.memoryGraphicsKb);
    const pssNode = runtime.root.querySelector('[data-metric-value="memory"]');
    const javaNode = runtime.root.querySelector('[data-memory-value="java"]');
    const nativeNode = runtime.root.querySelector('[data-memory-value="native"]');
    const codeNode = runtime.root.querySelector('[data-memory-value="code"]');
    const graphicsNode = runtime.root.querySelector('[data-memory-value="graphics"]');
    const statusNode = runtime.root.querySelector('[data-metric-status="memory"]');
    const card = runtime.root.querySelector('[data-metric-card="memory"]');
    if (pssNode) pssNode.textContent = formatNumber(pss, 1);
    if (javaNode) javaNode.textContent = formatMemoryKilobytes(javaHeap);
    if (nativeNode) nativeNode.textContent = formatMemoryKilobytes(nativeHeap);
    if (codeNode) codeNode.textContent = formatMemoryKilobytes(code);
    if (graphicsNode) graphicsNode.textContent = formatMemoryKilobytes(graphics);
    if (statusNode) statusNode.textContent = status;
    card?.classList.toggle(
      "is-unavailable",
      pss === null &&
        javaHeap === null &&
        nativeHeap === null &&
        code === null &&
        graphics === null,
    );
  }

  function metricStateLabel(rawSample) {
    if (rawSample?.metric === "cpu") {
      return getPerformanceCpuStatusLabel({
        source: rawSample.source,
        status: rawSample.status,
      });
    }
    if (rawSample?.metric === "memory" || rawSample?.source === "meminfo") {
      return getPerformanceMemoryStatusLabel(rawSample);
    }
    if (rawSample?.status === "unsupported") return "设备不支持";
    if (rawSample?.status === "degraded") return "已降级采集";
    if (rawSample?.status === "temporarily-unavailable") return "暂时无数据";
    return "采集中";
  }

  function receiveSample(rawSample) {
    if (!runtime.mounted || !["preparing", "running"].includes(runtime.phase)) return;
    let sample;
    try {
      sample = normalizePerformanceSample(rawSample);
      runtime.samples = appendPerformanceMetricSample(runtime.samples, rawSample);
    } catch {
      return;
    }

    const status = metricStateLabel(rawSample);
    for (const [key, presentation] of Object.entries(METRIC_PRESENTATION)) {
      if (key === "network" || key === "memory") continue;
      const value = sample[presentation.field];
      if (value !== null) {
        runtime.latest[presentation.field] = value;
        updateMetric(key, value, status);
      }
    }
    const isMemorySample = (
      sample.metric === "memory" ||
      rawSample?.source === "meminfo" ||
      MEMORY_SAMPLE_FIELDS.some((field) => finite(sample[field]) !== null)
    );
    if (isMemorySample) {
      for (const field of MEMORY_SAMPLE_FIELDS) runtime.latest[field] = finite(sample[field]);
      updateMemoryMetric(sample, status);
    }
    if (sample.cpuPercent === null && sample.cpuRawPercent !== null) {
      runtime.latest.cpuRawPercent = sample.cpuRawPercent;
      updateMetric("cpu", sample.cpuRawPercent, "原始核占用，未归一化");
    }
    const networkTotal = currentSampleNetworkTotal(rawSample, sample);
    if (networkTotal !== null) {
      runtime.latest.networkTotalBytes = networkTotal;
      updateMetric("network", networkTotal, rawSample?.metric === "network" ? "区间快照" : status);
    }

    if (sample.cpuPercent !== null) runtime.charts.cpu?.appendSample(sample);
    if (MEMORY_SAMPLE_FIELDS.some((field) => finite(sample[field]) !== null)) {
      runtime.charts.memory?.appendSample(sample);
    }
    if (sample.frameTimeMs !== null) runtime.charts.frame?.appendSample(sample);
    const cpuLatest = runtime.root.querySelector('[data-chart-latest="cpu"]');
    const memoryLatest = runtime.root.querySelector('[data-chart-latest="memory"]');
    const frameLatest = runtime.root.querySelector('[data-chart-latest="frame"]');
    if (sample.cpuPercent !== null && cpuLatest) cpuLatest.textContent = formatNumber(sample.cpuPercent, 1, "%");
    if (isMemorySample && memoryLatest) {
      memoryLatest.textContent = formatNumber(sample.memoryPssMb, 1, " MB");
    }
    if (sample.frameTimeMs !== null && frameLatest) frameLatest.textContent = formatNumber(sample.frameTimeMs, 1, " ms");
  }

  function handleCollectorStatus(event) {
    if (!runtime.mounted || !event) return;
    if (event.type === "metric" && event.metric && event.state) {
      const keys = event.metric === "frame"
        ? ["fps", "jank"]
        : event.metric === "battery"
          ? ["temperature"]
          : METRIC_PRESENTATION[event.metric]
            ? [event.metric]
            : [];
      const label = event.metric === "cpu"
        ? getPerformanceCpuStatusLabel({
            source: event.source ?? event.snapshot?.metrics?.cpu?.source,
            state: event.state,
            status: event.status,
          })
        : (
            event.state === "supported" ? "采集中"
              : event.state === "degraded" ? "已降级采集"
                : event.state === "paused" ? "暂时无数据"
                  : event.state === "unsupported" ? "设备不支持"
                    : event.reason || event.state
          );
      for (const key of keys) {
        const node = runtime.root.querySelector(`[data-metric-status="${key}"]`);
        if (node) node.textContent = label;
      }
    }
    if (event.type === "target" && event.reason === "process-restarting") {
      refs.message.textContent = "目标 App 进程暂时消失，正在等待重新启动…";
    }
    if (
      event.type === "session"
      && event.phase === "completed"
      && (runtime.phase === "running" || runtime.phase === "preparing")
      && !runtime.stopPromise
    ) {
      void stop(event.reason || event.snapshot?.endReason || "error");
    }
  }

  function startTimer() {
    stopTimer();
    runtime.timerId = setInterval(() => {
      if (!runtime.startedAt || !runtime.mounted) return;
      refs.timer.textContent = formatDuration(Date.now() - runtime.startedAt);
    }, 1_000);
  }

  function stopTimer() {
    if (runtime.timerId !== null) clearInterval(runtime.timerId);
    runtime.timerId = null;
  }

  async function loadReports() {
    try {
      runtime.reports = await runtime.repository.listReports({ limit: REPORT_LIST_LIMIT });
      runtime.storagePersistent = runtime.repository.persistent !== false;
    } catch {
      runtime.reports = [];
      runtime.storagePersistent = false;
    }
    renderReports();
  }

  function renderReports() {
    if (!runtime.mounted) return;
    refs.clearReports.disabled = !runtime.reports.length;
    const reportSwitchDisabled = ["preparing", "running", "stopping"].includes(runtime.phase);
    refs.reports.innerHTML = runtime.reports.length
      ? `<div class="performance-report-list">${runtime.reports.map((report) => {
          const packageName = report.app?.packageName || "未知应用";
          return `<article class="performance-report-row">
            <button type="button" data-performance-action="open-report" data-report-id="${escapeHtml(report.id)}"${reportSwitchDisabled ? " disabled" : ""}>
              <span><strong>${escapeHtml(packageName)}</strong><small>${escapeHtml(formatLocalDate(report.createdAt))} · ${escapeHtml(formatDuration(report.endedAt - report.startedAt))}</small></span>
              <span>${escapeHtml(report.status === "completed" ? "完成" : report.status === "stopped" ? "已停止" : "部分报告")}</span>
            </button>
            <button class="performance-report-delete" type="button" data-performance-action="delete-report" data-report-id="${escapeHtml(report.id)}" aria-label="删除 ${escapeHtml(packageName)} 报告">×</button>
          </article>`;
        }).join("")}</div>`
      : `<p class="performance-reports-empty">${runtime.storagePersistent ? "暂无本地报告。" : "浏览器存储不可用，当前报告仍可导出。"}</p>`;
  }

  function reportMetric(label, value, hint) {
    return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(hint)}</small></div>`;
  }

  function reportMemoryMetric(summary) {
    const pss = summary?.memoryPssMb || {};
    const javaHeap = summary?.memoryJavaHeapKb || {};
    const nativeHeap = summary?.memoryNativeHeapKb || {};
    const code = summary?.memoryCodeKb || {};
    const graphics = summary?.memoryGraphicsKb || {};
    return `<div class="performance-report-memory">
      <span>App 内存</span>
      <strong>${escapeHtml(formatNumber(pss.average, 1, " MB"))}</strong>
      <small>PSS 平均 · 峰值 ${escapeHtml(formatNumber(pss.maximum, 1, " MB"))}</small>
      <div class="performance-report-memory-breakdown">
        <span class="is-java"><span>Java Heap</span><b>平均 ${escapeHtml(formatMemoryKilobytes(javaHeap.average))}</b><small>峰值 ${escapeHtml(formatMemoryKilobytes(javaHeap.maximum))}</small></span>
        <span class="is-native"><span>Native Heap</span><b>平均 ${escapeHtml(formatMemoryKilobytes(nativeHeap.average))}</b><small>峰值 ${escapeHtml(formatMemoryKilobytes(nativeHeap.maximum))}</small></span>
        <span class="is-code"><span>Code</span><b>平均 ${escapeHtml(formatMemoryKilobytes(code.average))}</b><small>峰值 ${escapeHtml(formatMemoryKilobytes(code.maximum))}</small></span>
        <span class="is-graphics"><span>Graphics</span><b>平均 ${escapeHtml(formatMemoryKilobytes(graphics.average))}</b><small>峰值 ${escapeHtml(formatMemoryKilobytes(graphics.maximum))}</small></span>
      </div>
    </div>`;
  }

  function renderCurrentReport() {
    if (!runtime.mounted || !runtime.currentReport) return;
    const report = runtime.currentReport;
    const summary = report.summary || {};
    const reason = report.endReason || report.config?.endReason;
    refs.report.innerHTML = `
      <div class="performance-report-intro">
        <div><span class="performance-report-status">${escapeHtml(END_REASON_LABELS[reason] || "测试报告")}</span><h3>${escapeHtml(report.app?.packageName || "Android App")}</h3><p>${escapeHtml(formatLocalDate(report.startedAt))} · ${escapeHtml(formatDuration(report.endedAt - report.startedAt))} · ${summary.sampleCount || 0} 个采样点</p></div>
        <span>${escapeHtml(report.device?.model || "Android 设备")}</span>
      </div>
      <div class="performance-report-summary">
        ${reportMetric("平均 CPU", formatNumber(summary.cpuPercent?.average, 1, "%"), `峰值 ${formatNumber(summary.cpuPercent?.maximum, 1, "%")}`)}
        ${reportMemoryMetric(summary)}
        ${reportMetric("帧耗时 P95", formatNumber(summary.frames?.frameP95Ms ?? summary.frameTimeMs?.p95, 1, " ms"), `卡顿率 ${formatNumber(summary.frames?.jankRate ?? summary.jankRate?.average, 1, "%")}`)}
        ${reportMetric("网络增量", formatBytes(summary.networkDelta?.totalBytes), "RX + TX 区间差值")}
        ${reportMetric("最高电池温度", formatNumber(summary.batteryTemperatureC?.maximum, 1, " °C"), "设备电池传感器")}
        ${reportMetric("数据状态", report.status === "completed" || report.status === "stopped" ? "完整" : "部分", runtime.storagePersistent ? "已尝试保存到本浏览器" : "请立即导出")}
      </div>
      <div class="performance-report-notes"><strong>结果说明</strong><p>这是快速诊断数据，不是实验室级功耗测试。缺失指标表示设备或目标渲染方式未提供相应数据。</p></div>`;
    refs.exportJson.disabled = false;
    refs.exportCsv.disabled = false;
  }

  function applyReportToView(report) {
    const view = createPerformanceReportView(report);
    runtime.currentReport = report;
    runtime.samples = view.samples;
    runtime.latest = { ...view.latest };

    for (const [key, presentation] of Object.entries(METRIC_PRESENTATION)) {
      if (key === "memory") continue;
      const value = key === "network"
        ? view.latest.networkTotalBytes
        : view.latest[presentation.field];
      const status = value === null
        ? "报告无数据"
        : key === "cpu"
          ? getPerformanceCpuStatusLabel({
              source: view.cpuSource,
              state: view.cpuState,
              report: true,
            })
        : key === "network"
          ? "测试区间 RX + TX"
          : "报告最终值";
      updateMetric(key, value, status);
    }
    const hasMemoryValue = MEMORY_SAMPLE_FIELDS.some(
      (field) => finite(view.latest[field]) !== null,
    );
    updateMemoryMetric(
      view.latest,
      hasMemoryValue ? "报告最终值" : "报告无数据",
    );
    if (view.cpuUsesRawValue) {
      updateMetric("cpu", view.latest.cpuRawPercent, "原始核占用，未归一化");
    }

    for (const [key, samples] of Object.entries(view.charts)) {
      runtime.charts[key]?.setSamples(samples);
    }
    const latestLabels = {
      cpu: view.latest.cpuPercent === null ? "—" : formatNumber(view.latest.cpuPercent, 1, "%"),
      memory: view.latest.memoryPssMb === null ? "—" : formatNumber(view.latest.memoryPssMb, 1, " MB"),
      frame: view.latest.frameTimeMs === null ? "—" : formatNumber(view.latest.frameTimeMs, 1, " ms"),
    };
    for (const [key, label] of Object.entries(latestLabels)) {
      const node = runtime.root.querySelector(`[data-chart-latest="${key}"]`);
      if (node) node.textContent = label;
    }

    renderCurrentReport();
    updateControls();
  }

  async function saveReport(report) {
    try {
      await runtime.repository.saveReport(report);
      runtime.storagePersistent = runtime.repository.persistent !== false;
    } catch {
      runtime.storagePersistent = false;
      showToast("报告未能保存，请立即导出当前报告");
    }
    await loadReports();
  }

  function snapshotSamples(snapshot) {
    const source = Array.isArray(snapshot?.samples) ? snapshot.samples : runtime.samples;
    return normalizePerformanceMetricSamples(source);
  }

  async function finishReport(snapshot, reason) {
    const endedAt = Number.isFinite(snapshot?.endedAtMs) ? snapshot.endedAtMs : Date.now();
    const startedAt = Number.isFinite(snapshot?.startedAtMs)
      ? snapshot.startedAtMs
      : runtime.startedAt ?? endedAt;
    const target = snapshot?.target || {};
    const packageName = target.packageName || runtime.selectedPackage;
    const samples = snapshotSamples(snapshot);
    const report = createPerformanceReport({
      createdAt: endedAt,
      startedAt,
      endedAt,
      status: reportStatusForReason(reason),
      endReason: reason,
      phase: snapshot?.phase || "completed",
      elapsedMs: snapshot?.elapsedMs ?? endedAt - startedAt,
      latest: snapshot?.latest || {},
      device: {
        manufacturer: runtime.device?.manufacturer || null,
        model: runtime.device?.model || runtime.adapter?.device?.name || "Android 设备",
        androidVersion: runtime.device?.androidVersion || null,
        sdkVersion: runtime.device?.sdkVersion ?? runtime.device?.sdk ?? null,
        logicalCores: runtime.device?.logicalCores || null,
        refreshRateHz: runtime.device?.refreshRateHz || null,
        serialMasked: maskAndroidSerial(runtime.adapter?.device?.serial),
      },
      app: {
        packageName,
        uid: target.uid ?? runtime.packages.find((item) => item.packageName === packageName)?.uid ?? null,
        pids: target.pids ?? [],
      },
      config: {
        endReason: reason,
        plannedDurationMinutes: normalizeDurationMinutes(refs.duration?.value),
        localOnly: true,
      },
      capabilities: runtime.device?.capabilities || snapshot?.metrics || {},
      metrics: snapshot?.metrics || {},
      summary: {
        endReason: reason,
        metricStates: snapshot?.metrics || {},
      },
      samples,
    }, { now: endedAt });
    applyReportToView(report);
    await saveReport(report);
    return report;
  }

  async function inspectConnectedDevice() {
    if (!runtime.runner) return;
    refs.message.textContent = "正在读取设备、系统与前台 App 信息…";
    const inspected = await inspectAndroidDevice(runtime.runner);
    runtime.device = inspected;
    runtime.packages = normalizePackages(inspected.thirdPartyPackages);
    runtime.foregroundPackage = inspected.foregroundPackage || "";
    runtime.selectedPackage = runtime.foregroundPackage
      || runtime.selectedPackage
      || runtime.packages[0]?.packageName
      || "";
    updateDevice();
    const warning = inspected.warnings?.length ? `；${inspected.warnings[0]}` : "";
    setPhase("connected", `设备已连接，确认目标 App 后即可开始${warning}`);
  }

  async function connect() {
    if (!runtime.adapter || !["idle", "error"].includes(runtime.phase)) return false;
    setPhase("connecting", "请在浏览器中选择 Android 设备，并查看手机上的 USB 调试授权弹窗。 ");
    let selected;
    try {
      // connect() calls requestDevice as its first awaited operation. The bundle
      // was preloaded on mount, so the WebUSB chooser keeps this click activation.
      const connectionPromise = runtime.adapter.connect();
      updateControls();
      selected = await connectionPromise;
      if (!selected) {
        setPhase("idle", "已取消设备选择，可以随时重新连接。");
        return false;
      }
      runtime.disconnectUnsubscribe?.();
      runtime.disconnectUnsubscribe = runtime.adapter.onDisconnect((event) => {
        void handleDeviceDisconnect(event);
      });
      runtime.runner = createAndroidShellRunner(runtime.adapter);
      await inspectConnectedDevice();
      return true;
    } catch (error) {
      if (runtime.adapter?.connected) await disconnect({ quiet: true });
      if (!runtime.mounted) return false;
      if (error?.code === "connection-cancelled") {
        setPhase("idle", "设备连接已取消，可以随时重新连接。");
        return false;
      }
      setPhase("error", statusMessage(error));
      return false;
    }
  }

  async function handleDeviceDisconnect(event) {
    if (runtime.phase === "running" || runtime.phase === "preparing") {
      await stop("device-disconnected");
    }
    runtime.runner = null;
    runtime.device = null;
    runtime.packages = [];
    runtime.foregroundPackage = "";
    updateDevice();
    if (event?.reason !== "manual") {
      setPhase("idle", "设备已断开，已保留现有数据并释放连接。重新插入后可再次连接。");
    }
  }

  async function disconnect({ quiet = false } = {}) {
    if (runtime.phase === "running" || runtime.phase === "preparing") await stop("user");
    const adapter = runtime.adapter;
    runtime.disconnectUnsubscribe?.();
    runtime.disconnectUnsubscribe = null;
    runtime.runner = null;
    if (adapter?.connected) {
      try {
        await adapter.disconnect();
      } catch (error) {
        if (!quiet) showToast(statusMessage(error));
      }
    }
    runtime.device = null;
    runtime.packages = [];
    runtime.foregroundPackage = "";
    runtime.selectedPackage = "";
    updateDevice();
    setPhase("idle", quiet ? "连接已释放。" : "设备已断开，浏览器已释放 USB 接口。");
  }

  async function start() {
    if (!runtime.runner || !["connected", "completed", "error"].includes(runtime.phase)) return false;
    let packageName;
    try {
      packageName = validateAndroidPackageName(runtime.selectedPackage);
    } catch (error) {
      refs.message.textContent = statusMessage(error);
      refs.package.focus();
      return false;
    }

    const durationMinutes = normalizeDurationMinutes(refs.duration.value);
    resetMetrics({ starting: true });
    setPhase("preparing", "正在确认目标进程、记录网络基线并重置帧统计…");
    runtime.session = createPerformanceSession({
      runner: runtime.runner,
      onSample: receiveSample,
      onStatus: handleCollectorStatus,
    });
    try {
      const started = await runtime.session.start({
        packageName,
        uid: runtime.packages.find((item) => item.packageName === packageName)?.uid ?? undefined,
        logicalCores: runtime.device?.logicalCores,
        refreshRateHz: runtime.device?.refreshRateHz,
        maxDurationMs: durationMinutes * 60_000,
      });
      runtime.startedAt = Number.isFinite(started?.startedAtMs) ? started.startedAtMs : Date.now();
      setPhase("running", `正在测试 ${packageName}。请在手机上手动操作，完成后点击“停止并生成报告”。`);
      startTimer();
      return true;
    } catch (error) {
      runtime.session = null;
      setPhase("connected", statusMessage(error));
      return false;
    }
  }

  async function stop(reason = "user") {
    if (runtime.stopPromise) return runtime.stopPromise;
    if (!runtime.session) return null;
    runtime.stopPromise = (async () => {
      stopTimer();
      setPhase("stopping", "正在停止采集并计算区间网络流量…");
      let snapshot;
      try {
        snapshot = await runtime.session.stop(reason);
      } catch {
        snapshot = runtime.session.getSnapshot?.() || null;
        reason = reason === "user" ? "error" : reason;
      }
      runtime.session = null;
      await finishReport(snapshot, reason);
      refs.timer.textContent = formatDuration((snapshot?.endedAtMs ?? Date.now()) - (snapshot?.startedAtMs ?? runtime.startedAt));
      setPhase(runtime.adapter?.connected ? "completed" : "idle", `报告已生成：${END_REASON_LABELS[reason] || "测试结束"}。`);
      showToast("Android 性能报告已生成");
      return runtime.currentReport;
    })().finally(() => {
      runtime.stopPromise = null;
    });
    return runtime.stopPromise;
  }

  async function openReport(id) {
    if (["preparing", "running", "stopping"].includes(runtime.phase)) {
      showToast("请先停止当前测试，再查看历史报告");
      return;
    }
    try {
      const report = await runtime.repository.getReport(id);
      if (!report) throw new Error("报告不存在");
      applyReportToView(report);
      refs.report.scrollIntoView?.({ behavior: "smooth", block: "start" });
    } catch {
      showToast("这份报告已不存在或无法读取");
      await loadReports();
    }
  }

  async function deleteReport(id) {
    try {
      await runtime.repository.deleteReport(id);
      if (runtime.currentReport?.id === id) runtime.currentReport = null;
      await loadReports();
      showToast("报告已删除");
    } catch {
      showToast("报告删除失败，请重试");
    }
  }

  async function clearReports() {
    if (!runtime.reports.length) return;
    if (!confirmLeave("确定清空全部 Android 性能报告吗？此操作无法撤销。")) return;
    try {
      await runtime.repository.clearReports();
      runtime.reports = [];
      renderReports();
      showToast("Android 性能报告已清空");
    } catch {
      showToast("报告清空失败，请重试");
    }
  }

  function exportReport(kind) {
    const report = runtime.currentReport;
    if (!report) return;
    const stamp = new Date(report.startedAt).toISOString().replaceAll(":", "-").slice(0, 19);
    const base = `android-performance-${safeFilePart(report.app?.packageName)}-${stamp}`;
    if (kind === "json") {
      createDownload(performanceReportToJson(report), "application/json;charset=utf-8", `${base}.json`);
    } else {
      createDownload(performanceReportToCsv(report, { includeBom: true }), "text/csv;charset=utf-8", `${base}.csv`);
    }
  }

  async function handleClick(event) {
    const button = event.target.closest("[data-performance-action]");
    if (!button || !runtime.root.contains(button)) return;
    const action = button.dataset.performanceAction;
    if (action === "connect") await connect();
    if (action === "disconnect") await disconnect();
    if (action === "refresh-device") {
      button.disabled = true;
      try {
        await inspectConnectedDevice();
      } catch (error) {
        setPhase("connected", statusMessage(error));
      }
    }
    if (action === "use-foreground") {
      runtime.selectedPackage = runtime.foregroundPackage;
      refs.package.value = runtime.selectedPackage;
      updateControls();
    }
    if (action === "start") await start();
    if (action === "stop") await stop("user");
    if (action === "open-report" && !button.disabled) await openReport(button.dataset.reportId);
    if (action === "delete-report") await deleteReport(button.dataset.reportId);
    if (action === "clear-reports") await clearReports();
    if (action === "export-json") exportReport("json");
    if (action === "export-csv") exportReport("csv");
  }

  function handleInput(event) {
    const field = event.target.closest("[data-performance-field]");
    if (!field) return;
    if (field.dataset.performanceField === "package") {
      runtime.selectedPackage = field.value.trim();
      const hint = runtime.root.querySelector("[data-package-hint]");
      try {
        validateAndroidPackageName(runtime.selectedPackage);
        field.removeAttribute("aria-invalid");
        hint.textContent = "包名格式有效；开始时会确认 App 进程和 UID。";
      } catch {
        field.setAttribute("aria-invalid", "true");
        hint.textContent = runtime.selectedPackage ? "请输入类似 com.example.app 的标准包名。" : "请选择或输入目标 App 包名。";
      }
      updateControls();
    }
  }

  function handleChange(event) {
    const control = event.target.closest("[data-performance-memory-series]");
    if (!control || !runtime.root.contains(control)) return;
    setMemorySeriesVisibility(
      control.dataset.performanceMemorySeries,
      control.checked,
    );
  }

  function handleBeforeUnload(event) {
    if (runtime.phase !== "running" && runtime.phase !== "preparing") return;
    event.preventDefault();
    event.returnValue = "";
  }

  function createCharts() {
    runtime.charts.cpu = createPerformanceChart(runtime.root.querySelector('[data-performance-chart="cpu"]'), {
      title: "CPU 曲线",
      series: [{ key: "cpuPercent", label: "CPU", unit: "%", color: "#0d7965" }],
      minimum: 0,
      maximum: 100,
      windowMs: CHART_WINDOW_MS,
    });
    runtime.charts.memory = createPerformanceChart(runtime.root.querySelector('[data-performance-chart="memory"]'), {
      title: "App 内存曲线",
      series: PERFORMANCE_MEMORY_CHART_SERIES,
      showLegend: false,
      noVisibleSeriesText: "请选择至少一条内存曲线",
      noVisibleSeriesAriaText: "当前没有启用的内存曲线",
      minimum: 0,
      windowMs: CHART_WINDOW_MS,
    });
    runtime.charts.frame = createPerformanceChart(runtime.root.querySelector('[data-performance-chart="frame"]'), {
      title: "帧耗时曲线",
      series: [{ key: "frameTimeMs", label: "帧耗时", unit: " ms", color: "#d97832" }],
      minimum: 0,
      windowMs: CHART_WINDOW_MS,
    });
  }

  async function initializeAdapter() {
    const token = ++runtime.loadToken;
    const support = deriveAndroidPerformanceSupport();
    refs.support.className = `performance-support ${support.supported ? "is-supported" : "is-unsupported"}`;
    refs.support.innerHTML = `<strong>${support.supported ? "浏览器可用" : "暂不支持"}</strong><span>${escapeHtml(support.message)}</span>`;
    if (!support.supported) {
      setPhase("unsupported", support.message);
      return;
    }
    setPhase("loading", "正在加载本地 WebUSB ADB 模块…");
    try {
      const module = await loadAdbModule();
      if (!runtime.mounted || token !== runtime.loadToken) return;
      runtime.adapter = module.createBrowserAndroidPerformanceAdbAdapter();
      const adapterSupport = runtime.adapter.getSupport();
      if (!adapterSupport.supported) {
        setPhase("unsupported", statusMessage({ code: adapterSupport.code }));
        return;
      }
      setPhase("idle", "准备就绪。点击连接后，浏览器将打开系统设备选择器。 ");
    } catch {
      if (!runtime.mounted || token !== runtime.loadToken) return;
      setPhase("error", "WebUSB ADB 模块加载失败，请刷新页面后重试。");
    }
  }

  async function mount(root) {
    if (!root) throw new TypeError("Android 性能工具需要挂载容器");
    if (runtime.mounted && runtime.root === root) return;
    if (runtime.mounted) await unmount();
    runtime.root = root;
    runtime.root.innerHTML = createMarkup();
    runtime.mounted = true;
    captureRefs();
    runtime.root.addEventListener("click", handleClick);
    runtime.root.addEventListener("input", handleInput);
    runtime.root.addEventListener("change", handleChange);
    globalThis.addEventListener?.("beforeunload", handleBeforeUnload);
    loadMemorySeriesPreferenceOnce();
    createCharts();
    applyMemorySeriesVisibility();
    resetMetrics();
    await Promise.all([initializeAdapter(), loadReports()]);
  }

  async function beforeLeave() {
    if (runtime.phase === "running" || runtime.phase === "preparing") {
      const accepted = confirmLeave("Android 性能测试正在进行。离开后将停止采集并生成部分报告，是否继续？");
      if (!accepted) return false;
      await stop("tool-switched");
    }
    await disconnect({ quiet: true });
    await unmount();
    return true;
  }

  async function unmount() {
    if (!runtime.mounted) return;
    stopTimer();
    runtime.loadToken += 1;
    runtime.root.removeEventListener("click", handleClick);
    runtime.root.removeEventListener("input", handleInput);
    runtime.root.removeEventListener("change", handleChange);
    globalThis.removeEventListener?.("beforeunload", handleBeforeUnload);
    for (const chart of Object.values(runtime.charts)) chart.destroy();
    runtime.charts = {};
    runtime.mounted = false;
    runtime.root = null;
  }

  async function handleShortcut() {
    if (["connected", "completed", "error"].includes(runtime.phase)) return start();
    return false;
  }

  return Object.freeze({
    mount,
    beforeLeave,
    unmount,
    handleShortcut,
    get isRunning() {
      return runtime.phase === "running" || runtime.phase === "preparing" || runtime.phase === "stopping";
    },
    get phase() {
      return runtime.phase;
    },
  });
}
