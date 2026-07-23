import {
  appendPerformanceSample,
  downsamplePerformanceSamples,
  normalizePerformanceSample,
} from "./android-performance-core.js";

const DEFAULT_WINDOW_MS = 10 * 60 * 1_000;

const DEFAULT_SERIES = Object.freeze([
  Object.freeze({
    key: "cpuPercent",
    label: "CPU",
    unit: "%",
    color: "#0d7965",
  }),
]);

function normalizeSeries(series) {
  const source = series ?? DEFAULT_SERIES;
  if (!Array.isArray(source) || !source.length) {
    throw new TypeError("图表至少需要一个指标序列");
  }
  return source.map((item, index) => {
    if (!item || typeof item.key !== "string" || !item.key) {
      throw new TypeError("图表指标 key 无效");
    }
    return {
      key: item.key,
      label: String(item.label ?? item.key),
      unit: String(item.unit ?? ""),
      color: String(item.color ?? ["#0d7965", "#438cf0", "#d97832"][index % 3]),
    };
  });
}

function finiteValues(samples, series) {
  const values = [];
  for (const sample of samples) {
    for (const item of series) {
      const value = sample[item.key];
      if (typeof value === "number" && Number.isFinite(value)) values.push(value);
    }
  }
  return values;
}

function hasSeriesValue(sample, series) {
  return series.some((item) => {
    const value = sample[item.key];
    return typeof value === "number" && Number.isFinite(value);
  });
}

function normalizeWindowMs(value) {
  if (value === Number.POSITIVE_INFINITY) return value;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_WINDOW_MS;
}

function trimToWindow(samples, windowMs) {
  if (!samples.length || windowMs === Number.POSITIVE_INFINITY) return samples;
  const cutoff = samples.at(-1).timestamp - windowMs;
  return samples.filter((sample) => sample.timestamp >= cutoff);
}

function normalizeChartSamples(samples, series, windowMs) {
  const source = samples ?? [];
  const normalized = downsamplePerformanceSamples(
    source,
    Math.max(2, Array.isArray(source) ? source.length : 2),
  );
  return trimToWindow(
    normalized.filter((sample) => hasSeriesValue(sample, series)),
    windowMs,
  );
}

function compareSamples(left, right) {
  return left.timestamp - right.timestamp ||
    (left.sequence ?? Number.MAX_SAFE_INTEGER) -
      (right.sequence ?? Number.MAX_SAFE_INTEGER);
}

function sampleProminence(sample, first, last, series) {
  const duration = last.timestamp - first.timestamp;
  const elapsedRatio = duration > 0
    ? (sample.timestamp - first.timestamp) / duration
    : 0;
  let prominence = 0;

  for (const item of series) {
    const value = sample[item.key];
    if (!Number.isFinite(value)) continue;
    const firstValue = first[item.key];
    const lastValue = last[item.key];
    const expected = Number.isFinite(firstValue) && Number.isFinite(lastValue)
      ? firstValue + (lastValue - firstValue) * elapsedRatio
      : 0;
    prominence = Math.max(prominence, Math.abs(value - expected));
  }

  return prominence;
}

function selectBucketSamples(bucket, series) {
  if (!bucket.length) return [];
  const selected = new Set([bucket[0], bucket.at(-1)]);

  for (const item of series) {
    let minimum = null;
    let maximum = null;
    for (const sample of bucket) {
      const value = sample[item.key];
      if (!Number.isFinite(value)) continue;
      if (minimum === null || value < minimum[item.key]) minimum = sample;
      if (maximum === null || value > maximum[item.key]) maximum = sample;
    }
    if (minimum) selected.add(minimum);
    if (maximum) selected.add(maximum);
  }

  return [...selected].sort(compareSamples);
}

function downsampleChartSamples(samples, series, maxPoints) {
  if (samples.length <= maxPoints) return samples;

  const first = samples[0];
  const last = samples.at(-1);
  if (maxPoints === 2) return [first, last];

  const interior = samples.slice(1, -1);
  const interiorBudget = maxPoints - 2;
  const maximumSamplesPerBucket = 2 + series.length * 2;
  const bucketCount = Math.max(
    1,
    Math.floor(interiorBudget / maximumSamplesPerBucket),
  );
  const buckets = Array.from({ length: bucketCount }, () => []);
  const duration = last.timestamp - first.timestamp;

  for (let index = 0; index < interior.length; index += 1) {
    const sample = interior[index];
    const bucketIndex = duration > 0
      ? Math.min(
          bucketCount - 1,
          Math.floor(((sample.timestamp - first.timestamp) / duration) * bucketCount),
        )
      : Math.min(
          bucketCount - 1,
          Math.floor((index / Math.max(1, interior.length)) * bucketCount),
        );
    buckets[bucketIndex].push(sample);
  }

  const candidates = [
    first,
    ...buckets.flatMap((bucket) => selectBucketSamples(bucket, series)),
    last,
  ];
  if (candidates.length <= maxPoints) return candidates;

  const selectedInterior = candidates
    .slice(1, -1)
    .map((sample, index) => ({
      sample,
      index,
      prominence: sampleProminence(sample, first, last, series),
    }))
    .sort(
      (left, right) =>
        right.prominence - left.prominence ||
        left.index - right.index,
    )
    .slice(0, interiorBudget)
    .map(({ sample }) => sample);

  return [first, ...selectedInterior, last].sort(compareSamples);
}

function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  if (Math.abs(value) >= 100) return String(Math.round(value));
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function formatElapsed(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "0s";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function schedule(callback) {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return { kind: "animation-frame", id: globalThis.requestAnimationFrame(callback) };
  }
  callback();
  return null;
}

function cancelSchedule(handle) {
  if (handle?.kind === "animation-frame") {
    globalThis.cancelAnimationFrame?.(handle.id);
  }
}

export function createPerformanceChart(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== "function") {
    throw new TypeError("需要有效的 Canvas 元素");
  }
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法创建 Canvas 2D 上下文");

  const series = normalizeSeries(options.series);
  const maxPoints = Number.isSafeInteger(options.maxPoints) && options.maxPoints >= 2
    ? options.maxPoints
    : 300;
  const windowMs = normalizeWindowMs(options.windowMs);
  const defaultWidth = Math.max(240, Number(options.width) || 640);
  const defaultHeight = Math.max(160, Number(options.height) || 260);
  const emptyText = String(options.emptyText ?? "开始测试后显示实时曲线");
  const title = String(options.title ?? series.map((item) => item.label).join(" / "));
  let samples = [];
  let destroyed = false;
  let scheduledDraw = null;
  let cssWidth = defaultWidth;
  let cssHeight = defaultHeight;

  canvas.setAttribute?.("role", "img");
  canvas.setAttribute?.("aria-label", `${title}，暂无数据`);

  function resize() {
    if (destroyed) return;
    const rectangle = typeof canvas.getBoundingClientRect === "function"
      ? canvas.getBoundingClientRect()
      : null;
    cssWidth = Math.max(240, Math.round(rectangle?.width || canvas.clientWidth || defaultWidth));
    cssHeight = Math.max(160, Math.round(rectangle?.height || canvas.clientHeight || defaultHeight));
    const ratio = Math.min(
      3,
      Math.max(1, Number(globalThis.devicePixelRatio) || 1),
    );
    const pixelWidth = Math.round(cssWidth * ratio);
    const pixelHeight = Math.round(cssHeight * ratio);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    requestDraw();
  }

  function requestDraw() {
    if (destroyed || scheduledDraw) return;
    scheduledDraw = schedule(() => {
      scheduledDraw = null;
      draw();
    });
  }

  function drawEmptyState() {
    canvas.setAttribute?.("aria-label", `${title}，暂无数据`);
    context.fillStyle = options.mutedColor ?? "#607571";
    context.font = '13px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(emptyText, cssWidth / 2, cssHeight / 2);
  }

  function draw() {
    if (destroyed) return;
    context.clearRect(0, 0, cssWidth, cssHeight);
    context.fillStyle = options.backgroundColor ?? "#f8fbfa";
    context.fillRect(0, 0, cssWidth, cssHeight);

    const points = downsampleChartSamples(samples, series, maxPoints);
    const values = finiteValues(points, series);
    if (!points.length || !values.length) {
      drawEmptyState();
      return;
    }

    const padding = { top: 42, right: 18, bottom: 30, left: 48 };
    const plotWidth = Math.max(1, cssWidth - padding.left - padding.right);
    const plotHeight = Math.max(1, cssHeight - padding.top - padding.bottom);
    let minimum = Number.isFinite(options.minimum) ? options.minimum : Math.min(...values);
    let maximum = Number.isFinite(options.maximum) ? options.maximum : Math.max(...values);
    if (options.includeZero !== false) minimum = Math.min(0, minimum);
    if (minimum === maximum) maximum = minimum + 1;
    const range = maximum - minimum;
    const startedAt = points[0].timestamp;
    const endedAt = points.at(-1).timestamp;
    const duration = Math.max(1, endedAt - startedAt);

    context.lineWidth = 1;
    context.strokeStyle = options.gridColor ?? "#dbe8e5";
    context.fillStyle = options.mutedColor ?? "#607571";
    context.font = '11px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (let index = 0; index <= 4; index += 1) {
      const ratio = index / 4;
      const y = padding.top + plotHeight * ratio;
      context.beginPath();
      context.moveTo(padding.left, y);
      context.lineTo(padding.left + plotWidth, y);
      context.stroke();
      const labelValue = maximum - range * ratio;
      context.fillText(formatNumber(labelValue), padding.left - 8, y);
    }

    context.textBaseline = "alphabetic";
    context.textAlign = "left";
    context.fillText("0s", padding.left, cssHeight - 8);
    context.textAlign = "right";
    context.fillText(formatElapsed(endedAt - startedAt), padding.left + plotWidth, cssHeight - 8);

    let legendX = padding.left;
    context.textAlign = "left";
    context.textBaseline = "middle";
    for (const item of series) {
      const latestSample = [...points].reverse().find((sample) => sample[item.key] !== null);
      const latest = latestSample?.[item.key] ?? null;
      context.fillStyle = item.color;
      context.fillRect(legendX, 15, 10, 3);
      context.fillStyle = options.textColor ?? "#17312d";
      const legend = `${item.label} ${formatNumber(latest)}${latest === null ? "" : item.unit}`;
      context.fillText(legend, legendX + 16, 17);
      legendX += Math.min(180, context.measureText(legend).width + 38);
    }

    for (const item of series) {
      context.beginPath();
      context.strokeStyle = item.color;
      context.lineWidth = 2;
      context.lineJoin = "round";
      context.lineCap = "round";
      let segmentOpen = false;
      for (let index = 0; index < points.length; index += 1) {
        const sample = points[index];
        const value = sample[item.key];
        if (value === null || !Number.isFinite(value)) {
          segmentOpen = false;
          continue;
        }
        const x = padding.left + ((sample.timestamp - startedAt) / duration) * plotWidth;
        const y = padding.top + ((maximum - value) / range) * plotHeight;
        if (!segmentOpen) {
          context.moveTo(x, y);
          segmentOpen = true;
        } else {
          context.lineTo(x, y);
        }
      }
      context.stroke();
    }

    const accessibleSummary = series.map((item) => {
      const latestSample = [...points].reverse().find((sample) => sample[item.key] !== null);
      const latest = latestSample?.[item.key] ?? null;
      return `${item.label}${latest === null ? "暂无数据" : `${formatNumber(latest)}${item.unit}`}`;
    }).join("，");
    canvas.setAttribute?.(
      "aria-label",
      `${title}，${accessibleSummary}，时长 ${formatElapsed(endedAt - startedAt)}`,
    );
  }

  function setSamples(nextSamples) {
    if (destroyed) return;
    samples = normalizeChartSamples(nextSamples, series, windowMs);
    requestDraw();
  }

  function appendSample(sample) {
    if (destroyed) return;
    const normalized = normalizePerformanceSample(sample);
    if (!hasSeriesValue(normalized, series)) return;
    samples = appendPerformanceSample(samples, normalized, {
      limit: Math.max(1, samples.length + 1),
    });
    samples = trimToWindow(
      samples.filter((item) => hasSeriesValue(item, series)),
      windowMs,
    );
    requestDraw();
  }

  const resizeObserver = options.autoResize !== false && typeof globalThis.ResizeObserver === "function"
    ? new globalThis.ResizeObserver(resize)
    : null;
  resizeObserver?.observe(canvas);
  resize();

  return {
    setSamples,
    appendSample,
    resize,
    render: requestDraw,
    getSamples: () => samples.map((sample) => ({ ...sample })),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelSchedule(scheduledDraw);
      scheduledDraw = null;
      resizeObserver?.disconnect();
    },
  };
}

export function drawPerformanceChart(canvas, samples, options = {}) {
  const chart = createPerformanceChart(canvas, {
    ...options,
    autoResize: false,
  });
  chart.setSamples(samples);
  chart.resize();
  return chart;
}
