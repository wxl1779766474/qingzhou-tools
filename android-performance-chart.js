import {
  appendPerformanceSample,
  downsamplePerformanceSamples,
  normalizePerformanceSample,
} from "./android-performance-core.js";

const DEFAULT_WINDOW_MS = 10 * 60 * 1_000;
const CHART_PADDING = Object.freeze({
  top: 42,
  right: 18,
  bottom: 30,
  left: 48,
});
const TOOLTIP_MARGIN = 8;
const TOOLTIP_GAP = 12;
const TOOLTIP_LINE_HEIGHT = 18;

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
    const scale = item.scale === undefined ? 1 : item.scale;
    if (
      typeof scale !== "number" ||
      !Number.isFinite(scale) ||
      scale <= 0
    ) {
      throw new TypeError("图表指标 scale 必须是有限正数");
    }
    return {
      key: item.key,
      label: String(item.label ?? item.key),
      unit: String(item.unit ?? ""),
      color: String(item.color ?? ["#0d7965", "#438cf0", "#d97832"][index % 3]),
      scale,
    };
  });
}

function getSeriesValue(sample, item) {
  const rawValue = sample?.[item.key];
  if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) return null;
  const value = rawValue * item.scale;
  return Number.isFinite(value) ? value : null;
}

function finiteValues(samples, series) {
  const values = [];
  for (const sample of samples) {
    for (const item of series) {
      const value = getSeriesValue(sample, item);
      if (value !== null) values.push(value);
    }
  }
  return values;
}

function hasSeriesValue(sample, series) {
  return series.some((item) => getSeriesValue(sample, item) !== null);
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
    const value = getSeriesValue(sample, item);
    if (value === null) continue;
    const firstValue = getSeriesValue(first, item);
    const lastValue = getSeriesValue(last, item);
    const expected = firstValue !== null && lastValue !== null
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
      const value = getSeriesValue(sample, item);
      if (value === null) continue;
      if (
        minimum === null ||
        value < getSeriesValue(minimum, item)
      ) {
        minimum = sample;
      }
      if (
        maximum === null ||
        value > getSeriesValue(maximum, item)
      ) {
        maximum = sample;
      }
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
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 100) return String(Math.round(value));
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function formatHoverNumber(value) {
  if (!Number.isFinite(value)) return "—";
  return String(Number(value.toFixed(2)));
}

function formatElapsed(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "0s";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function findNearestSample(points, targetTimestamp) {
  if (!points.length || !Number.isFinite(targetTimestamp)) return null;
  let nearest = points[0];
  let nearestDistance = Math.abs(nearest.timestamp - targetTimestamp);

  for (const point of points.slice(1)) {
    const distance = Math.abs(point.timestamp - targetTimestamp);
    if (
      distance < nearestDistance ||
      (
        distance === nearestDistance &&
        compareSamples(point, nearest) < 0
      )
    ) {
      nearest = point;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function positionTooltip({
  anchorX,
  anchorY,
  canvasHeight,
  canvasWidth,
  height,
  width,
}) {
  const safeWidth = Math.min(width, Math.max(1, canvasWidth - TOOLTIP_MARGIN * 2));
  const safeHeight = Math.min(height, Math.max(1, canvasHeight - TOOLTIP_MARGIN * 2));
  let x = anchorX + TOOLTIP_GAP;
  let y = anchorY - safeHeight - TOOLTIP_GAP;

  if (x + safeWidth > canvasWidth - TOOLTIP_MARGIN) {
    x = anchorX - safeWidth - TOOLTIP_GAP;
  }
  if (y < TOOLTIP_MARGIN) {
    y = anchorY + TOOLTIP_GAP;
  }

  return {
    height: safeHeight,
    width: safeWidth,
    x: clamp(x, TOOLTIP_MARGIN, canvasWidth - safeWidth - TOOLTIP_MARGIN),
    y: clamp(y, TOOLTIP_MARGIN, canvasHeight - safeHeight - TOOLTIP_MARGIN),
  };
}

function roundedRectangle(context, x, y, width, height, radius) {
  context.beginPath();
  if (typeof context.roundRect === "function") {
    context.roundRect(x, y, width, height, radius);
    return;
  }

  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - safeRadius,
    y + height,
  );
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
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
  let pointerClientPosition = null;

  canvas.setAttribute?.("role", "img");
  canvas.setAttribute?.("aria-label", `${title}，暂无数据`);

  function getPointerCanvasPosition() {
    if (!pointerClientPosition) return null;
    const rectangle = typeof canvas.getBoundingClientRect === "function"
      ? canvas.getBoundingClientRect()
      : null;
    const rectangleWidth = Number.isFinite(rectangle?.width) && rectangle.width > 0
      ? rectangle.width
      : cssWidth;
    const rectangleHeight = Number.isFinite(rectangle?.height) && rectangle.height > 0
      ? rectangle.height
      : cssHeight;
    const rectangleLeft = Number.isFinite(rectangle?.left) ? rectangle.left : 0;
    const rectangleTop = Number.isFinite(rectangle?.top) ? rectangle.top : 0;
    return {
      x: ((pointerClientPosition.x - rectangleLeft) / rectangleWidth) * cssWidth,
      y: ((pointerClientPosition.y - rectangleTop) / rectangleHeight) * cssHeight,
    };
  }

  function isInsidePlot(position) {
    return Boolean(
      position &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.y) &&
      position.x >= CHART_PADDING.left &&
      position.x <= cssWidth - CHART_PADDING.right &&
      position.y >= CHART_PADDING.top &&
      position.y <= cssHeight - CHART_PADDING.bottom,
    );
  }

  function clearPointer() {
    if (!pointerClientPosition) return;
    pointerClientPosition = null;
    requestDraw();
  }

  function handlePointerMove(event) {
    if (
      destroyed ||
      !Number.isFinite(event?.clientX) ||
      !Number.isFinite(event?.clientY)
    ) {
      clearPointer();
      return;
    }

    const nextPosition = {
      x: event.clientX,
      y: event.clientY,
    };
    const previousPosition = pointerClientPosition;
    pointerClientPosition = nextPosition;
    if (!isInsidePlot(getPointerCanvasPosition())) {
      pointerClientPosition = null;
      if (previousPosition) requestDraw();
      return;
    }
    requestDraw();
  }

  function handlePointerExit() {
    if (destroyed) return;
    clearPointer();
  }

  function setHoverActive(active) {
    canvas.classList?.toggle("is-performance-chart-hovering", Boolean(active));
  }

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
    setHoverActive(false);
    canvas.setAttribute?.("aria-label", `${title}，暂无数据`);
    context.fillStyle = options.mutedColor ?? "#607571";
    context.font = '13px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(emptyText, cssWidth / 2, cssHeight / 2);
  }

  function drawHoverLayer({
    duration,
    maximum,
    plotHeight,
    plotWidth,
    points,
    range,
    startedAt,
  }) {
    const pointer = getPointerCanvasPosition();
    if (!isInsidePlot(pointer)) return false;

    const targetTimestamp = startedAt +
      ((pointer.x - CHART_PADDING.left) / plotWidth) * duration;
    const selectedSample = findNearestSample(points, targetTimestamp);
    if (!selectedSample) return false;

    const selectedX = CHART_PADDING.left +
      ((selectedSample.timestamp - startedAt) / duration) * plotWidth;
    const selectedValues = series.map((item) => ({
      item,
      value: getSeriesValue(selectedSample, item),
    }));
    const selectedSeries = selectedValues.flatMap(({ item, value }) => {
      if (value === null) return [];
      const rawY = CHART_PADDING.top +
        ((maximum - value) / range) * plotHeight;
      return [{
        item,
        value,
        y: clamp(
          rawY,
          CHART_PADDING.top,
          CHART_PADDING.top + plotHeight,
        ),
      }];
    });
    if (!selectedSeries.length) return false;

    context.beginPath();
    context.strokeStyle = options.hoverGuideColor ?? "rgba(13, 121, 101, 0.34)";
    context.lineWidth = 1;
    context.moveTo(selectedX, CHART_PADDING.top);
    context.lineTo(selectedX, CHART_PADDING.top + plotHeight);
    context.stroke();

    for (const entry of selectedSeries) {
      context.beginPath();
      context.fillStyle = options.hoverPointRingColor ?? "#ffffff";
      context.arc(selectedX, entry.y, 6, 0, Math.PI * 2);
      context.fill();

      context.beginPath();
      context.fillStyle = entry.item.color;
      context.arc(selectedX, entry.y, 4, 0, Math.PI * 2);
      context.fill();
    }

    const timeText = `测试时间 ${formatElapsed(selectedSample.timestamp - startedAt)}`;
    const metricLines = selectedValues.map(({ item, value }) => ({
      color: item.color,
      text: value === null
        ? `${item.label} —`
        : `${item.label} ${formatHoverNumber(value)}${item.unit}`,
    }));
    context.font = '600 12px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const maximumTooltipHeight = Math.max(
      1,
      cssHeight - TOOLTIP_MARGIN * 2,
    );
    const rowsPerColumn = Math.max(
      1,
      Math.floor(
        (maximumTooltipHeight - 14) / TOOLTIP_LINE_HEIGHT,
      ) - 1,
    );
    const columnCount = Math.ceil(metricLines.length / rowsPerColumn);
    const naturalColumnWidths = Array.from(
      { length: columnCount },
      (_, columnIndex) => {
        const columnLines = metricLines.slice(
          columnIndex * rowsPerColumn,
          (columnIndex + 1) * rowsPerColumn,
        );
        return Math.max(
          24,
          ...columnLines.map((line) => context.measureText(line.text).width + 14),
        );
      },
    );
    const preferredColumnGap = columnCount > 1 ? 12 : 0;
    const naturalColumnsWidth = naturalColumnWidths.reduce(
      (total, width) => total + width,
      0,
    ) + preferredColumnGap * Math.max(0, columnCount - 1);
    const tooltipWidth = Math.max(
      88,
      context.measureText(timeText).width + 20,
      naturalColumnsWidth + 20,
    );
    const tooltipHeight = 14 +
      (
        1 +
        Math.min(metricLines.length, rowsPerColumn)
      ) * TOOLTIP_LINE_HEIGHT;
    const tooltip = positionTooltip({
      anchorX: selectedX,
      anchorY: Math.min(...selectedSeries.map((entry) => entry.y)),
      canvasHeight: cssHeight,
      canvasWidth: cssWidth,
      height: tooltipHeight,
      width: tooltipWidth,
    });
    const innerWidth = Math.max(1, tooltip.width - 20);
    const columnGap = columnCount > 1
      ? Math.min(
          preferredColumnGap,
          innerWidth / (columnCount * 2),
        )
      : 0;
    const columnWidthBudget = Math.max(
      1,
      innerWidth - columnGap * Math.max(0, columnCount - 1),
    );
    const naturalColumnWidthTotal = naturalColumnWidths.reduce(
      (total, width) => total + width,
      0,
    );
    const columnScale = Math.min(
      1,
      columnWidthBudget / Math.max(1, naturalColumnWidthTotal),
    );
    const columnWidths = naturalColumnWidths.map(
      (width) => width * columnScale,
    );
    const columnOffsets = columnWidths.map((_, columnIndex) => (
      columnWidths
        .slice(0, columnIndex)
        .reduce((total, width) => total + width, 0) +
      columnGap * columnIndex
    ));

    roundedRectangle(
      context,
      tooltip.x,
      tooltip.y,
      tooltip.width,
      tooltip.height,
      8,
    );
    context.fillStyle = options.tooltipBackgroundColor ?? "rgba(23, 49, 45, 0.96)";
    context.fill();
    context.strokeStyle = options.tooltipBorderColor ?? "rgba(255, 255, 255, 0.14)";
    context.lineWidth = 1;
    context.stroke();

    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillStyle = options.tooltipMutedColor ?? "#c8ddd8";
    context.fillText(
      timeText,
      tooltip.x + 10,
      tooltip.y + 13,
      Math.max(1, tooltip.width - 20),
    );
    for (let index = 0; index < metricLines.length; index += 1) {
      const line = metricLines[index];
      const columnIndex = Math.floor(index / rowsPerColumn);
      const rowIndex = index % rowsPerColumn;
      const x = tooltip.x + 10 + columnOffsets[columnIndex];
      const y = tooltip.y + 13 + (rowIndex + 1) * TOOLTIP_LINE_HEIGHT;
      context.fillStyle = line.color;
      context.fillRect(x, y - 2, 8, 4);
      context.fillStyle = options.tooltipTextColor ?? "#ffffff";
      context.fillText(
        line.text,
        x + 14,
        y,
        Math.max(1, columnWidths[columnIndex] - 14),
      );
    }
    return true;
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

    const padding = CHART_PADDING;
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
    const latestSample = points.at(-1);
    for (const item of series) {
      const latest = getSeriesValue(latestSample, item);
      context.fillStyle = item.color;
      context.fillRect(legendX, 15, 10, 3);
      context.fillStyle = options.textColor ?? "#17312d";
      const legend = `${item.label} ${formatNumber(latest)}${latest === null ? "" : item.unit}`;
      context.fillText(legend, legendX + 16, 17);
      legendX += Math.min(180, context.measureText(legend).width + 38);
    }

    for (const item of series) {
      const seriesPoints = points.flatMap((sample) => {
        const value = getSeriesValue(sample, item);
        if (value === null) return [];
        return {
          x: padding.left + ((sample.timestamp - startedAt) / duration) * plotWidth,
          y: padding.top + ((maximum - value) / range) * plotHeight,
        };
      });
      if (!seriesPoints.length) continue;

      context.beginPath();
      context.strokeStyle = item.color;
      context.lineWidth = 2;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.moveTo(seriesPoints[0].x, seriesPoints[0].y);
      for (const point of seriesPoints.slice(1)) {
        context.lineTo(point.x, point.y);
      }
      context.stroke();

      context.beginPath();
      context.fillStyle = item.color;
      for (const point of seriesPoints) {
        context.moveTo(point.x + 2.5, point.y);
        context.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
      }
      context.fill();
    }

    setHoverActive(drawHoverLayer({
      duration,
      maximum,
      plotHeight,
      plotWidth,
      points,
      range,
      startedAt,
    }));

    const accessibleSummary = series.map((item) => {
      const latest = getSeriesValue(latestSample, item);
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

  canvas.addEventListener?.("pointermove", handlePointerMove);
  canvas.addEventListener?.("pointerleave", handlePointerExit);
  canvas.addEventListener?.("pointercancel", handlePointerExit);

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
      pointerClientPosition = null;
      setHoverActive(false);
      canvas.removeEventListener?.("pointermove", handlePointerMove);
      canvas.removeEventListener?.("pointerleave", handlePointerExit);
      canvas.removeEventListener?.("pointercancel", handlePointerExit);
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
