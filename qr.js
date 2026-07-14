const MIN_VERSION = 1;
const MAX_VERSION = 10;
const QUIET_ZONE = 4;

// QR Code Model 2, error-correction level M. Each entry is a list of
// [block count, total codewords per block, data codewords per block].
const RS_BLOCKS_M = {
  1: [[1, 26, 16]],
  2: [[1, 44, 28]],
  3: [[1, 70, 44]],
  4: [[2, 50, 32]],
  5: [[2, 67, 43]],
  6: [[4, 43, 27]],
  7: [[4, 49, 31]],
  8: [[2, 60, 38], [2, 61, 39]],
  9: [[3, 58, 36], [2, 59, 37]],
  10: [[4, 69, 43], [1, 70, 44]],
};

const ALIGNMENT_POSITIONS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

class BitBuffer {
  constructor() {
    this.bits = [];
  }

  append(value, length) {
    for (let shift = length - 1; shift >= 0; shift -= 1) {
      this.bits.push(((value >>> shift) & 1) !== 0);
    }
  }

  get length() {
    return this.bits.length;
  }

  toBytes() {
    const bytes = new Array(Math.ceil(this.bits.length / 8)).fill(0);
    this.bits.forEach((bit, index) => {
      if (bit) bytes[index >>> 3] |= 0x80 >>> (index & 7);
    });
    return bytes;
  }
}

const GF_EXP = new Array(512);
const GF_LOG = new Array(256).fill(0);
let gfValue = 1;
for (let index = 0; index < 255; index += 1) {
  GF_EXP[index] = gfValue;
  GF_LOG[gfValue] = index;
  gfValue <<= 1;
  if ((gfValue & 0x100) !== 0) gfValue ^= 0x11d;
}
for (let index = 255; index < GF_EXP.length; index += 1) {
  GF_EXP[index] = GF_EXP[index - 255];
}

function gfMultiply(left, right) {
  if (left === 0 || right === 0) return 0;
  return GF_EXP[GF_LOG[left] + GF_LOG[right]];
}

function reedSolomonGenerator(degree) {
  let result = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = new Array(result.length + 1).fill(0);
    for (let coefficient = 0; coefficient < result.length; coefficient += 1) {
      next[coefficient] ^= result[coefficient];
      next[coefficient + 1] ^=
        gfMultiply(result[coefficient], GF_EXP[index]);
    }
    result = next;
  }
  return result;
}

function reedSolomonRemainder(data, degree) {
  const generator = reedSolomonGenerator(degree);
  const result = [...data, ...new Array(degree).fill(0)];
  for (let index = 0; index < data.length; index += 1) {
    const factor = result[index];
    if (factor === 0) continue;
    for (let offset = 0; offset < generator.length; offset += 1) {
      result[index + offset] ^=
        gfMultiply(generator[offset], factor);
    }
  }
  return result.slice(data.length);
}

function expandBlocks(version) {
  const blocks = [];
  for (const [count, totalCount, dataCount] of RS_BLOCKS_M[version]) {
    for (let index = 0; index < count; index += 1) {
      blocks.push({ dataCount, errorCount: totalCount - dataCount });
    }
  }
  return blocks;
}

function dataCapacity(version) {
  return expandBlocks(version).reduce(
    (total, block) => total + block.dataCount,
    0,
  );
}

function encodeUtf8(text) {
  return Array.from(new TextEncoder().encode(text));
}

function needsUtf8Eci(text) {
  return /[^\x00-\x7f]/u.test(text);
}

function requiredDataBits(byteLength, version, includeEci) {
  const countBits = version <= 9 ? 8 : 16;
  return (includeEci ? 12 : 0) + 4 + countBits + byteLength * 8;
}

function chooseVersion(byteLength, includeEci) {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version += 1) {
    if (requiredDataBits(byteLength, version, includeEci) <=
        dataCapacity(version) * 8) {
      return version;
    }
  }
  throw new Error("内容过长，无法生成二维码（最多支持版本 10）");
}

function makeDataCodewords(bytes, version, includeEci) {
  const capacity = dataCapacity(version);
  const buffer = new BitBuffer();

  if (includeEci) {
    buffer.append(0b0111, 4); // ECI mode
    buffer.append(26, 8); // ECI assignment 26: UTF-8
  }

  buffer.append(0b0100, 4); // Byte mode
  buffer.append(bytes.length, version <= 9 ? 8 : 16);
  bytes.forEach((byte) => buffer.append(byte, 8));

  const capacityBits = capacity * 8;
  buffer.append(0, Math.min(4, capacityBits - buffer.length));
  while ((buffer.length & 7) !== 0) buffer.append(0, 1);

  const result = buffer.toBytes();
  let useFirstPad = true;
  while (result.length < capacity) {
    result.push(useFirstPad ? 0xec : 0x11);
    useFirstPad = !useFirstPad;
  }
  return result;
}

function addErrorCorrection(data, version) {
  const blockDefinitions = expandBlocks(version);
  const blocks = [];
  let offset = 0;

  for (const definition of blockDefinitions) {
    const blockData = data.slice(offset, offset + definition.dataCount);
    offset += definition.dataCount;
    blocks.push({
      data: blockData,
      error: reedSolomonRemainder(blockData, definition.errorCount),
    });
  }

  const result = [];
  const maximumDataLength = Math.max(...blocks.map((block) => block.data.length));
  for (let index = 0; index < maximumDataLength; index += 1) {
    blocks.forEach((block) => {
      if (index < block.data.length) result.push(block.data[index]);
    });
  }

  const maximumErrorLength = Math.max(...blocks.map((block) => block.error.length));
  for (let index = 0; index < maximumErrorLength; index += 1) {
    blocks.forEach((block) => {
      if (index < block.error.length) result.push(block.error[index]);
    });
  }
  return result;
}

function makeEmptyMatrix(version) {
  const size = version * 4 + 17;
  return {
    size,
    modules: Array.from({ length: size }, () => new Array(size).fill(false)),
    functions: Array.from({ length: size }, () => new Array(size).fill(false)),
  };
}

function setFunctionModule(state, x, y, dark) {
  if (x < 0 || y < 0 || x >= state.size || y >= state.size) return;
  state.modules[y][x] = Boolean(dark);
  state.functions[y][x] = true;
}

function drawFinderPattern(state, centerX, centerY) {
  for (let offsetY = -4; offsetY <= 4; offsetY += 1) {
    for (let offsetX = -4; offsetX <= 4; offsetX += 1) {
      const distance = Math.max(Math.abs(offsetX), Math.abs(offsetY));
      setFunctionModule(
        state,
        centerX + offsetX,
        centerY + offsetY,
        distance !== 2 && distance !== 4,
      );
    }
  }
}

function drawAlignmentPattern(state, centerX, centerY) {
  for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
    for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
      const distance = Math.max(Math.abs(offsetX), Math.abs(offsetY));
      setFunctionModule(
        state,
        centerX + offsetX,
        centerY + offsetY,
        distance !== 1,
      );
    }
  }
}

function bchRemainder(value, polynomial) {
  const polynomialDegree = 31 - Math.clz32(polynomial);
  while (value !== 0 && 31 - Math.clz32(value) >= polynomialDegree) {
    value ^= polynomial << (31 - Math.clz32(value) - polynomialDegree);
  }
  return value;
}

function formatBits(mask) {
  // Error-correction level M has format indicator 00.
  const data = mask;
  return ((data << 10) | bchRemainder(data << 10, 0x537)) ^ 0x5412;
}

function versionBits(version) {
  return (version << 12) | bchRemainder(version << 12, 0x1f25);
}

function drawFormatBits(state, mask) {
  const bits = formatBits(mask);
  for (let index = 0; index < 15; index += 1) {
    const dark = ((bits >>> index) & 1) !== 0;
    const verticalY = index < 6
      ? index
      : index < 8
        ? index + 1
        : state.size - 15 + index;
    setFunctionModule(state, 8, verticalY, dark);

    const horizontalX = index < 8
      ? state.size - index - 1
      : index === 8
        ? 7
        : 15 - index - 1;
    setFunctionModule(state, horizontalX, 8, dark);
  }
  setFunctionModule(state, 8, state.size - 8, true);
}

function drawVersionBits(state, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let index = 0; index < 18; index += 1) {
    const dark = ((bits >>> index) & 1) !== 0;
    const firstX = state.size - 11 + (index % 3);
    const firstY = Math.floor(index / 3);
    setFunctionModule(state, firstX, firstY, dark);
    setFunctionModule(state, firstY, firstX, dark);
  }
}

function drawFunctionPatterns(state, version) {
  drawFinderPattern(state, 3, 3);
  drawFinderPattern(state, state.size - 4, 3);
  drawFinderPattern(state, 3, state.size - 4);

  const positions = ALIGNMENT_POSITIONS[version];
  for (const centerY of positions) {
    for (const centerX of positions) {
      if (!state.functions[centerY][centerX]) {
        drawAlignmentPattern(state, centerX, centerY);
      }
    }
  }

  for (let index = 0; index < state.size; index += 1) {
    if (!state.functions[6][index]) {
      setFunctionModule(state, index, 6, (index & 1) === 0);
    }
    if (!state.functions[index][6]) {
      setFunctionModule(state, 6, index, (index & 1) === 0);
    }
  }

  drawFormatBits(state, 0);
  drawVersionBits(state, version);
}

function shouldMask(mask, x, y) {
  switch (mask) {
    case 0: return ((x + y) & 1) === 0;
    case 1: return (y & 1) === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new Error("二维码掩码编号无效");
  }
}

function placeData(state, codewords, mask) {
  let byteIndex = 0;
  let bitIndex = 7;
  let row = state.size - 1;
  let direction = -1;

  for (let right = state.size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;
    while (true) {
      for (let columnOffset = 0; columnOffset < 2; columnOffset += 1) {
        const x = right - columnOffset;
        if (state.functions[row][x]) continue;

        let dark = false;
        if (byteIndex < codewords.length) {
          dark = ((codewords[byteIndex] >>> bitIndex) & 1) !== 0;
        }
        if (shouldMask(mask, x, row)) dark = !dark;
        state.modules[row][x] = dark;

        bitIndex -= 1;
        if (bitIndex < 0) {
          byteIndex += 1;
          bitIndex = 7;
        }
      }

      row += direction;
      if (row < 0 || row >= state.size) {
        row -= direction;
        direction = -direction;
        break;
      }
    }
  }
}

function cloneState(state) {
  return {
    size: state.size,
    modules: state.modules.map((row) => [...row]),
    functions: state.functions.map((row) => [...row]),
  };
}

function runPenalty(line) {
  let score = 0;
  let runColor = line[0];
  let runLength = 1;
  for (let index = 1; index <= line.length; index += 1) {
    if (index < line.length && line[index] === runColor) {
      runLength += 1;
    } else {
      if (runLength >= 5) score += 3 + runLength - 5;
      if (index < line.length) {
        runColor = line[index];
        runLength = 1;
      }
    }
  }
  return score;
}

function finderLikePenalty(line) {
  let score = 0;
  for (let index = 0; index <= line.length - 11; index += 1) {
    const window = line.slice(index, index + 11)
      .map((value) => value ? "1" : "0")
      .join("");
    if (window === "00001011101" || window === "10111010000") score += 40;
  }
  return score;
}

function penaltyScore(modules) {
  const size = modules.length;
  let score = 0;
  let darkCount = 0;

  for (let y = 0; y < size; y += 1) {
    const row = modules[y];
    const column = modules.map((candidateRow) => candidateRow[y]);
    score += runPenalty(row) + runPenalty(column);
    score += finderLikePenalty(row) + finderLikePenalty(column);
    darkCount += row.reduce((count, dark) => count + (dark ? 1 : 0), 0);
  }

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = modules[y][x];
      if (modules[y][x + 1] === color &&
          modules[y + 1][x] === color &&
          modules[y + 1][x + 1] === color) {
        score += 3;
      }
    }
  }

  const total = size * size;
  score += Math.floor(Math.abs(darkCount * 20 - total * 10) / total) * 10;
  return score;
}

/**
 * Creates a QR Code Model 2 matrix using byte-mode UTF-8 and error level M.
 * The returned rows contain booleans: true is a dark module.
 */
export function createQrMatrix(text) {
  if (typeof text !== "string") {
    throw new Error("二维码内容必须是字符串");
  }
  if (text.length === 0) {
    throw new Error("二维码内容不能为空");
  }

  const bytes = encodeUtf8(text);
  const includeEci = needsUtf8Eci(text);
  const version = chooseVersion(bytes.length, includeEci);
  const data = makeDataCodewords(bytes, version, includeEci);
  const codewords = addErrorCorrection(data, version);
  const base = makeEmptyMatrix(version);
  drawFunctionPatterns(base, version);

  let bestMatrix = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = cloneState(base);
    placeData(candidate, codewords, mask);
    drawFormatBits(candidate, mask);
    const penalty = penaltyScore(candidate.modules);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMatrix = candidate.modules;
    }
  }
  return bestMatrix;
}

/** Draws a QR matrix on a Canvas 2D surface with the required quiet zone. */
export function renderQr(canvas, text, options = {}) {
  if (!canvas || typeof canvas.getContext !== "function") {
    throw new Error("无法使用二维码画布");
  }
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法获取二维码画布上下文");

  const requestedSize = options.size ?? canvas.width ?? 320;
  const size = Math.floor(Number(requestedSize));
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("二维码尺寸必须是正数");
  }

  const matrix = createQrMatrix(text);
  const moduleCount = matrix.length + QUIET_ZONE * 2;
  const moduleSize = Math.floor(size / moduleCount);
  if (moduleSize < 1) throw new Error("二维码画布尺寸过小");

  const background = options.background ?? "#ffffff";
  const color = options.color ?? "#173c38";
  canvas.width = size;
  canvas.height = size;
  context.imageSmoothingEnabled = false;
  context.fillStyle = background;
  context.fillRect(0, 0, size, size);

  const drawnSize = moduleSize * moduleCount;
  const offset = Math.floor((size - drawnSize) / 2) + QUIET_ZONE * moduleSize;
  context.fillStyle = color;
  for (let y = 0; y < matrix.length; y += 1) {
    for (let x = 0; x < matrix.length; x += 1) {
      if (matrix[y][x]) {
        context.fillRect(
          offset + x * moduleSize,
          offset + y * moduleSize,
          moduleSize,
          moduleSize,
        );
      }
    }
  }
  return matrix;
}
