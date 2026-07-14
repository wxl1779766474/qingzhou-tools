function assertString(value, label = "内容") {
  if (typeof value !== "string") {
    throw new Error(`${label}必须是文本`);
  }
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value !== null && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = sortJsonValue(value[key]);
        return result;
      }, {});
  }

  return value;
}

function parseJson(input, sortKeys) {
  assertString(input, "JSON 内容");

  if (input.trim() === "") {
    throw new Error("JSON 内容不能为空");
  }

  try {
    const value = JSON.parse(input);
    return sortKeys ? sortJsonValue(value) : value;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`JSON 格式错误：${error.message}`);
    }
    throw error;
  }
}

function normalizeIndent(indent) {
  if (indent === "\t") {
    return indent;
  }
  if (!Number.isInteger(indent) || indent < 0 || indent > 10) {
    throw new Error("JSON 缩进必须是 Tab 或 0 到 10 之间的整数");
  }
  return indent;
}

export function formatJson(input, { indent = 2, sortKeys = false } = {}) {
  const value = parseJson(input, Boolean(sortKeys));
  return JSON.stringify(value, null, normalizeIndent(indent));
}

export function minifyJson(input, { sortKeys = false } = {}) {
  return JSON.stringify(parseJson(input, Boolean(sortKeys)));
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/gu, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function highlightedToken(className, token) {
  return `<span class="${className}">${escapeHtml(token)}</span>`;
}

export function highlightJson(jsonText) {
  // Validate first so the scanner only has to handle tokens allowed by JSON.
  parseJson(jsonText, false);

  let html = "";
  let index = 0;

  while (index < jsonText.length) {
    const character = jsonText[index];

    if (/\s/u.test(character) || "{}[],:".includes(character)) {
      html += escapeHtml(character);
      index += 1;
      continue;
    }

    if (character === '"') {
      let end = index + 1;
      while (end < jsonText.length) {
        if (jsonText[end] === "\\") {
          end += 2;
          continue;
        }
        if (jsonText[end] === '"') {
          end += 1;
          break;
        }
        end += 1;
      }

      const token = jsonText.slice(index, end);
      let nextIndex = end;
      while (nextIndex < jsonText.length && /\s/u.test(jsonText[nextIndex])) {
        nextIndex += 1;
      }
      const className =
        jsonText[nextIndex] === ":" ? "json-key" : "json-string";
      html += highlightedToken(className, token);
      index = end;
      continue;
    }

    const remainder = jsonText.slice(index);
    const number = remainder.match(
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u,
    );
    if (number) {
      html += highlightedToken("json-number", number[0]);
      index += number[0].length;
      continue;
    }

    const literal = remainder.match(/^(?:true|false|null)/u)?.[0];
    if (literal) {
      const className = literal === "null" ? "json-null" : "json-boolean";
      html += highlightedToken(className, literal);
      index += literal.length;
      continue;
    }

    // This is unreachable after JSON validation, but avoids an infinite loop if
    // the platform parser ever accepts a token the scanner does not know yet.
    throw new Error("JSON 高亮失败：遇到无法识别的内容");
  }

  return html;
}

function getBufferConstructor() {
  return typeof globalThis.Buffer === "function" ? globalThis.Buffer : null;
}

function utf8ToBytes(input) {
  if (typeof globalThis.TextEncoder === "function") {
    return new globalThis.TextEncoder().encode(input);
  }

  const BufferConstructor = getBufferConstructor();
  if (BufferConstructor) {
    return Uint8Array.from(BufferConstructor.from(input, "utf8"));
  }

  try {
    const encoded = encodeURIComponent(input);
    const bytes = [];
    for (let index = 0; index < encoded.length; index += 1) {
      if (encoded[index] === "%") {
        bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
        index += 2;
      } else {
        bytes.push(encoded.charCodeAt(index));
      }
    }
    return Uint8Array.from(bytes);
  } catch {
    throw new Error("文本包含无法编码的字符");
  }
}

function bytesToBase64(bytes) {
  if (typeof globalThis.btoa === "function") {
    const chunkSize = 0x8000;
    let binary = "";
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return globalThis.btoa(binary);
  }

  const BufferConstructor = getBufferConstructor();
  if (BufferConstructor) {
    return BufferConstructor.from(bytes).toString("base64");
  }

  throw new Error("当前环境不支持 Base64 编码");
}

function base64ToBytes(input) {
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(input);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  const BufferConstructor = getBufferConstructor();
  if (BufferConstructor) {
    return Uint8Array.from(BufferConstructor.from(input, "base64"));
  }

  throw new Error("当前环境不支持 Base64 解码");
}

function bytesToUtf8(bytes) {
  if (typeof globalThis.TextDecoder === "function") {
    try {
      return new globalThis.TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Base64 解码结果不是有效的 UTF-8 文本");
    }
  }

  const BufferConstructor = getBufferConstructor();
  if (BufferConstructor) {
    const decoded = BufferConstructor.from(bytes).toString("utf8");
    if (!utf8BytesEqual(utf8ToBytes(decoded), bytes)) {
      throw new Error("Base64 解码结果不是有效的 UTF-8 文本");
    }
    return decoded;
  }

  try {
    let encoded = "";
    for (const byte of bytes) {
      encoded += `%${byte.toString(16).padStart(2, "0")}`;
    }
    return decodeURIComponent(encoded);
  } catch {
    throw new Error("Base64 解码结果不是有效的 UTF-8 文本");
  }
}

function utf8BytesEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function encodeBase64Utf8(input) {
  assertString(input);
  return bytesToBase64(utf8ToBytes(input));
}

export function decodeBase64Utf8(input) {
  assertString(input, "Base64 内容");

  const validBase64 =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (input.length % 4 !== 0 || !validBase64.test(input)) {
    throw new Error("Base64 格式错误：请检查字符和填充");
  }

  let bytes;
  try {
    bytes = base64ToBytes(input);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("当前环境")) {
      throw error;
    }
    throw new Error("Base64 格式错误：无法解码");
  }

  if (bytesToBase64(bytes) !== input) {
    throw new Error("Base64 格式错误：编码不是规范格式");
  }

  return bytesToUtf8(bytes);
}

function assertUrlMode(mode) {
  if (mode !== "full" && mode !== "component") {
    throw new Error("URL 模式必须是 full 或 component");
  }
}

export function encodeUrl(input, mode = "full") {
  assertString(input, "URL 内容");
  assertUrlMode(mode);

  try {
    return mode === "full" ? encodeURI(input) : encodeURIComponent(input);
  } catch {
    throw new Error("URL 编码失败：内容包含无效字符");
  }
}

export function decodeUrl(input, mode = "full") {
  assertString(input, "URL 内容");
  assertUrlMode(mode);

  try {
    return mode === "full" ? decodeURI(input) : decodeURIComponent(input);
  } catch {
    throw new Error("URL 解码失败：请检查百分号编码");
  }
}

function localDateTime(date) {
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ];
  const time = [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ];
  return `${parts.join("-")} ${time.join(":")}`;
}

function timestampResult(milliseconds) {
  const date = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || Number.isNaN(date.getTime())) {
    throw new Error("时间戳超出有效范围");
  }

  return {
    local: localDateTime(date),
    utc: date.toUTCString(),
    iso: date.toISOString(),
    milliseconds,
    seconds: Math.floor(milliseconds / 1000),
  };
}

export function convertTimestamp(input, now) {
  void now;
  const value = typeof input === "number" ? String(input) : input;
  assertString(value, "时间戳");

  const normalized = value.trim();
  if (!/^\d{10}(?:\d{3})?$/.test(normalized)) {
    throw new Error("时间戳必须是 10 位秒级或 13 位毫秒级数字");
  }

  const numericValue = Number(normalized);
  return timestampResult(
    normalized.length === 10 ? numericValue * 1000 : numericValue,
  );
}

export function getCurrentTimestamps(now = Date.now()) {
  const milliseconds = now instanceof Date ? now.getTime() : Number(now);
  return timestampResult(milliseconds);
}

function countGraphemes(input) {
  if (typeof globalThis.Intl?.Segmenter === "function") {
    return Array.from(
      new globalThis.Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        input,
      ),
    ).length;
  }
  return Array.from(input).length;
}

export function countText(input) {
  assertString(input);

  const nonWhitespace = input.replace(/\s/gu, "");
  const words = input.match(/[A-Za-z0-9]+|[\p{Script=Han}]/gu) ?? [];

  return {
    characters: countGraphemes(input),
    nonWhitespaceCharacters: countGraphemes(nonWhitespace),
    words: words.length,
    lines: input === "" ? 0 : input.split(/\r\n|\r|\n/u).length,
    bytes: utf8ToBytes(input).length,
  };
}
