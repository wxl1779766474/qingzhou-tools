import {
  clonePerformanceReport,
  parsePerformanceReport,
} from "./android-performance-core.js";

export const ANDROID_PERFORMANCE_DATABASE_NAME = "lightboat-tools";
export const ANDROID_PERFORMANCE_DATABASE_VERSION = 1;
export const ANDROID_PERFORMANCE_REPORT_STORE = "android-performance-reports";
export const ANDROID_PERFORMANCE_REPORT_LIMIT = 20;

const REPORT_CREATED_AT_INDEX = "createdAt";
const REPORT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;

export class PerformanceStorageError extends Error {
  constructor(message, code = "PERFORMANCE_STORAGE_ERROR", cause = undefined) {
    super(message);
    this.name = "PerformanceStorageError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function fail(message, code, cause) {
  throw new PerformanceStorageError(message, code, cause);
}

function normalizeLimit(value, fallback = ANDROID_PERFORMANCE_REPORT_LIMIT) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    fail("性能报告数量上限无效", "INVALID_REPORT_LIMIT");
  }
  return limit;
}

function normalizeReportId(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !REPORT_ID_PATTERN.test(value)
  ) {
    fail("性能报告 ID 无效", "INVALID_REPORT_ID");
  }
  return value;
}

function sortReports(reports) {
  return reports.sort(
    (left, right) =>
      right.createdAt - left.createdAt || right.id.localeCompare(left.id),
  );
}

function normalizeStoredReport(report) {
  return parsePerformanceReport(report);
}

function isQuotaExceeded(error) {
  let current = error;
  const visited = new Set();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (
      current.name === "QuotaExceededError" ||
      current.code === 22 ||
      current.code === 1014 ||
      current.code === "QUOTA_EXCEEDED"
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("IndexedDB request failed"),
    );
  });
}

function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error ?? new Error("IndexedDB transaction aborted"),
    );
    transaction.onerror = () => reject(
      transaction.error ?? new Error("IndexedDB transaction failed"),
    );
  });
}

export class MemoryPerformanceReportRepository {
  constructor({ maxReports = ANDROID_PERFORMANCE_REPORT_LIMIT, reports = [] } = {}) {
    this.kind = "memory";
    this.persistent = false;
    this.maxReports = normalizeLimit(maxReports);
    this._reports = new Map();
    for (const report of reports) {
      const normalized = normalizeStoredReport(report);
      this._reports.set(normalized.id, normalized);
    }
    this._prune();
  }

  _prune() {
    const sorted = sortReports([...this._reports.values()]);
    for (const report of sorted.slice(this.maxReports)) {
      this._reports.delete(report.id);
    }
  }

  async saveReport(report) {
    const normalized = normalizeStoredReport(report);
    this._reports.set(normalized.id, normalized);
    this._prune();
    return clonePerformanceReport(normalized);
  }

  async listReports({ limit = this.maxReports } = {}) {
    const normalizedLimit = normalizeLimit(limit, this.maxReports);
    return sortReports([...this._reports.values()])
      .slice(0, normalizedLimit)
      .map(clonePerformanceReport);
  }

  async getReport(id) {
    const report = this._reports.get(normalizeReportId(id));
    return report ? clonePerformanceReport(report) : null;
  }

  async deleteReport(id) {
    return this._reports.delete(normalizeReportId(id));
  }

  async clearReports() {
    this._reports.clear();
  }

  async save(report) {
    return this.saveReport(report);
  }

  async list(options) {
    return this.listReports(options);
  }

  async get(id) {
    return this.getReport(id);
  }

  async delete(id) {
    return this.deleteReport(id);
  }

  async clear() {
    return this.clearReports();
  }

  close() {}
}

export class IndexedDbPerformanceReportRepository {
  constructor({
    indexedDB,
    databaseName = ANDROID_PERFORMANCE_DATABASE_NAME,
    databaseVersion = ANDROID_PERFORMANCE_DATABASE_VERSION,
    storeName = ANDROID_PERFORMANCE_REPORT_STORE,
    maxReports = ANDROID_PERFORMANCE_REPORT_LIMIT,
  } = {}) {
    if (!indexedDB || typeof indexedDB.open !== "function") {
      fail("当前浏览器不支持 IndexedDB", "INDEXEDDB_UNAVAILABLE");
    }
    if (typeof databaseName !== "string" || !databaseName) {
      fail("IndexedDB 数据库名称无效", "INVALID_DATABASE_NAME");
    }
    if (!Number.isSafeInteger(databaseVersion) || databaseVersion < 1) {
      fail("IndexedDB 数据库版本无效", "INVALID_DATABASE_VERSION");
    }
    if (typeof storeName !== "string" || !storeName) {
      fail("IndexedDB 仓库名称无效", "INVALID_STORE_NAME");
    }

    this.kind = "indexeddb";
    this.persistent = true;
    this.maxReports = normalizeLimit(maxReports);
    this._indexedDB = indexedDB;
    this._databaseName = databaseName;
    this._databaseVersion = databaseVersion;
    this._storeName = storeName;
    this._databasePromise = null;
  }

  _open() {
    if (this._databasePromise) return this._databasePromise;
    this._databasePromise = new Promise((resolve, reject) => {
      let request;
      let settled = false;
      try {
        request = this._indexedDB.open(
          this._databaseName,
          this._databaseVersion,
        );
      } catch (error) {
        reject(error);
        return;
      }

      request.onupgradeneeded = () => {
        const database = request.result;
        let store;
        if (!database.objectStoreNames.contains(this._storeName)) {
          store = database.createObjectStore(this._storeName, { keyPath: "id" });
        } else {
          store = request.transaction.objectStore(this._storeName);
        }
        if (!store.indexNames.contains(REPORT_CREATED_AT_INDEX)) {
          store.createIndex(REPORT_CREATED_AT_INDEX, "createdAt", {
            unique: false,
          });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        settled = true;
        database.onversionchange = () => {
          database.close();
          this._databasePromise = null;
        };
        resolve(database);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(request.error ?? new Error("Unable to open IndexedDB"));
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(new Error("IndexedDB upgrade is blocked"));
      };
    }).catch((error) => {
      this._databasePromise = null;
      throw new PerformanceStorageError(
        "无法打开性能报告存储",
        "INDEXEDDB_OPEN_FAILED",
        error,
      );
    });
    return this._databasePromise;
  }

  async _runTransaction(mode, operation) {
    const database = await this._open();
    let transaction;
    let done;
    try {
      transaction = database.transaction(this._storeName, mode);
      done = transactionToPromise(transaction);
      const result = await operation(transaction.objectStore(this._storeName));
      await done;
      return result;
    } catch (error) {
      try {
        transaction?.abort();
      } catch {
        // The transaction may already have completed or aborted.
      }
      try {
        await done;
      } catch {
        // The original request error is more useful than the abort wrapper.
      }
      throw new PerformanceStorageError(
        "性能报告存储操作失败",
        "INDEXEDDB_TRANSACTION_FAILED",
        error,
      );
    }
  }

  async _getAllReports() {
    const reports = await this._runTransaction("readonly", (store) =>
      requestToPromise(store.getAll()),
    );
    return sortReports(
      reports.map((report) => normalizeStoredReport(report)),
    );
  }

  async _prune() {
    const reports = await this._getAllReports();
    const excess = reports.slice(this.maxReports);
    if (!excess.length) return;
    await this._runTransaction("readwrite", async (store) => {
      await Promise.all(
        excess.map((report) => requestToPromise(store.delete(report.id))),
      );
    });
  }

  async _putReport(report) {
    await this._runTransaction("readwrite", (store) =>
      requestToPromise(store.put(report)),
    );
  }

  async _deleteReportWithoutLookup(id) {
    await this._runTransaction("readwrite", (store) =>
      requestToPromise(store.delete(id)),
    );
  }

  async saveReport(report) {
    const normalized = normalizeStoredReport(report);
    try {
      await this._putReport(normalized);
    } catch (error) {
      if (!isQuotaExceeded(error)) throw error;

      let oldest = null;
      try {
        oldest = (await this._getAllReports()).at(-1) ?? null;
        if (oldest) await this._deleteReportWithoutLookup(oldest.id);
      } catch (cleanupError) {
        throw new PerformanceStorageError(
          "浏览器存储空间不足，无法清理旧性能报告",
          "QUOTA_EXCEEDED",
          cleanupError,
        );
      }

      if (!oldest) {
        throw new PerformanceStorageError(
          "浏览器存储空间不足，性能报告未保存",
          "QUOTA_EXCEEDED",
          error,
        );
      }

      try {
        await this._putReport(normalized);
      } catch (retryError) {
        if (isQuotaExceeded(retryError)) {
          throw new PerformanceStorageError(
            "浏览器存储空间不足，性能报告未保存",
            "QUOTA_EXCEEDED",
            retryError,
          );
        }
        throw retryError;
      }
    }
    await this._prune();
    return clonePerformanceReport(normalized);
  }

  async listReports({ limit = this.maxReports } = {}) {
    const normalizedLimit = normalizeLimit(limit, this.maxReports);
    return (await this._getAllReports())
      .slice(0, normalizedLimit)
      .map(clonePerformanceReport);
  }

  async getReport(id) {
    const report = await this._runTransaction("readonly", (store) =>
      requestToPromise(store.get(normalizeReportId(id))),
    );
    return report ? clonePerformanceReport(normalizeStoredReport(report)) : null;
  }

  async deleteReport(id) {
    const normalizedId = normalizeReportId(id);
    const exists = await this.getReport(normalizedId);
    if (!exists) return false;
    await this._deleteReportWithoutLookup(normalizedId);
    return true;
  }

  async clearReports() {
    await this._runTransaction("readwrite", (store) =>
      requestToPromise(store.clear()),
    );
  }

  async save(report) {
    return this.saveReport(report);
  }

  async list(options) {
    return this.listReports(options);
  }

  async get(id) {
    return this.getReport(id);
  }

  async delete(id) {
    return this.deleteReport(id);
  }

  async clear() {
    return this.clearReports();
  }

  async close() {
    if (!this._databasePromise) return;
    try {
      const database = await this._databasePromise;
      database.close();
    } finally {
      this._databasePromise = null;
    }
  }
}

export function createPerformanceReportRepository({
  indexedDB = globalThis.indexedDB,
  fallbackToMemory = true,
  ...options
} = {}) {
  if (!indexedDB || typeof indexedDB.open !== "function") {
    if (fallbackToMemory) {
      return new MemoryPerformanceReportRepository(options);
    }
    fail("当前浏览器不支持 IndexedDB", "INDEXEDDB_UNAVAILABLE");
  }
  return new IndexedDbPerformanceReportRepository({ indexedDB, ...options });
}
