export const ANDROID_MEMORY_SERIES_PREFERENCES_VERSION = 1;

export const ANDROID_MEMORY_SERIES_PREFERENCES_STORAGE_KEY =
  "lightboat-android-memory-series:v1";

export const ANDROID_MEMORY_SERIES_KEYS = Object.freeze([
  "memoryPssMb",
  "memoryJavaHeapKb",
  "memoryNativeHeapKb",
  "memoryCodeKb",
  "memoryGraphicsKb",
]);

const ANDROID_MEMORY_SERIES_KEY_SET = new Set(ANDROID_MEMORY_SERIES_KEYS);

function getDefaultVisibleKeys() {
  return [...ANDROID_MEMORY_SERIES_KEYS];
}

function normalizeVisibleKeys(visibleKeys) {
  if (!Array.isArray(visibleKeys)) {
    return getDefaultVisibleKeys();
  }

  if (visibleKeys.length === 0) {
    return [];
  }

  if (visibleKeys.some((key) => typeof key !== "string")) {
    return getDefaultVisibleKeys();
  }

  const knownKeys = new Set(
    visibleKeys.filter((key) => ANDROID_MEMORY_SERIES_KEY_SET.has(key)),
  );

  if (knownKeys.size === 0) {
    return getDefaultVisibleKeys();
  }

  return ANDROID_MEMORY_SERIES_KEYS.filter((key) => knownKeys.has(key));
}

export function parseAndroidMemorySeriesPreferences(serializedPreferences) {
  if (
    typeof serializedPreferences !== "string" ||
    serializedPreferences.length === 0
  ) {
    return getDefaultVisibleKeys();
  }

  try {
    const preferences = JSON.parse(serializedPreferences);

    if (
      preferences === null ||
      typeof preferences !== "object" ||
      Array.isArray(preferences) ||
      preferences.version !== ANDROID_MEMORY_SERIES_PREFERENCES_VERSION ||
      !Array.isArray(preferences.visibleKeys)
    ) {
      return getDefaultVisibleKeys();
    }

    return normalizeVisibleKeys(preferences.visibleKeys);
  } catch {
    return getDefaultVisibleKeys();
  }
}

export function serializeAndroidMemorySeriesPreferences(visibleKeys) {
  return JSON.stringify({
    version: ANDROID_MEMORY_SERIES_PREFERENCES_VERSION,
    visibleKeys: normalizeVisibleKeys(visibleKeys),
  });
}

export function readAndroidMemorySeriesPreferences(storage) {
  try {
    if (!storage || typeof storage.getItem !== "function") {
      return getDefaultVisibleKeys();
    }

    return parseAndroidMemorySeriesPreferences(
      storage.getItem(ANDROID_MEMORY_SERIES_PREFERENCES_STORAGE_KEY),
    );
  } catch {
    return getDefaultVisibleKeys();
  }
}

export function writeAndroidMemorySeriesPreferences(storage, visibleKeys) {
  try {
    if (!storage || typeof storage.setItem !== "function") {
      return false;
    }

    storage.setItem(
      ANDROID_MEMORY_SERIES_PREFERENCES_STORAGE_KEY,
      serializeAndroidMemorySeriesPreferences(visibleKeys),
    );
    return true;
  } catch {
    return false;
  }
}
