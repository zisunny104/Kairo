/**
 * TimeSyncManager - 時間同步管理器
 *
 * 處理客戶端時間格式化與同步
 * 確保多裝置間的時間戳一致性
 */

import { getSharedConfig } from "./config.js";
import { Logger } from "./console-manager.js";

class TimeSyncManager {
  constructor() {
    // 時間偏差（毫秒）= 本機時間 - 伺服器時間
    this.timeOffset = 0;

    // 時間同步狀態
    this.isSynced = false;
    this.lastSyncTime = null;

    // 時區設定
    this.timezone = getSharedConfig()?.timezone || "Asia/Taipei";

    // 多次同步結果用於計算平均偏差
    this.syncSamples = [];
    this.maxSamples = 3;

    // 時間格式預設值（可由 CONFIG.timeFormatPresets 覆蓋）
    this.dateTimePresets = {
      dateTime: { includeSeconds: true },
      dateTimeShort: { includeSeconds: false },
      recordDetail: { includeSeconds: true },
      recordFilter: { includeSeconds: false },
    };

    // 時間長度格式（可由 CONFIG.durationTextStyle 覆蓋）
    this.durationTextStyle = getSharedConfig()?.durationTextStyle || "zh";
  }

  /**
   * 取得校正後的伺服器時間（毫秒級）
   * 應該在所有需要參考時間的地方使用此方法
   */
  getServerTime() {
    return Date.now() - this.timeOffset;
  }

  /**
   * 檢查時間同步狀態
   */
  isSynchronized() {
    return this.isSynced;
  }

  normalizeServerTime(serverTime) {
    if (typeof serverTime !== "number" || Number.isNaN(serverTime)) {
      return null;
    }

    // WebSocket 可能傳回秒級時間戳，此時轉成毫秒
    if (serverTime >= 1_000_000_000 && serverTime < 1_000_000_000_000) {
      Logger.warn(
        `[TimeSyncManager] serverTime 似乎為秒級，轉換為毫秒: ${serverTime} -> ${serverTime * 1000}`,
      );
      return serverTime * 1000;
    }

    return serverTime;
  }

  /**
   * 透過 WebSocket 進行一次性校時
   * @param {number} serverTime - 伺服器時間戳（毫秒）
   */
  syncWithWebSocket(serverTime) {
    const normalizedServerTime = this.normalizeServerTime(serverTime);
    if (!normalizedServerTime || normalizedServerTime < 1_000_000_000_000) {
      Logger.warn(
        `[TimeSyncManager] 收到無效的 serverTime，略過校時: ${serverTime}`,
      );
      return;
    }

    const clientTime = Date.now();
    const offset = clientTime - normalizedServerTime;

    // 記錄樣本
    this.syncSamples.push({
      offset: offset,
      delay: 0, // WebSocket 延遲忽略不計
      timestamp: clientTime,
    });

    if (this.syncSamples.length > this.maxSamples) {
      this.syncSamples.shift();
    }

    // 計算平均偏差
    this.timeOffset = Math.round(
      this.syncSamples.reduce((sum, s) => sum + s.offset, 0) /
        this.syncSamples.length,
    );

    this.isSynced = true;
    this.lastSyncTime = Date.now();

    Logger.debug(
      `[TimeSyncManager] WebSocket 校時完成: 偏差=${this.timeOffset}ms`,
    );
  }
  /**
   * 格式化時間長度（持續時間）
   * @param {number} milliseconds - 毫秒數
   * @returns {string} 格式化的時間長度 (HH:MM:SS)
   */
  formatDuration(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return [
      String(hours).padStart(2, "0"),
      String(minutes).padStart(2, "0"),
      String(seconds).padStart(2, "0"),
    ].join(":");
  }

  /**
   * 格式化計時器（分:秒.毫秒）
   * @param {number} milliseconds - 毫秒數
   * @returns {string} 格式化的計時字串 (MM:SS.mmm)
   */
  formatStopwatch(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const ms = milliseconds % 1000;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  }

  /**
   * 格式化時間為東八區 YYYY-MM-DD HH:MM:SS 格式
   * @param {number|Date} timestamp - 毫秒級時間戳或 Date 物件
   * @param {Object} options - 選項
   * @param {boolean} options.includeMilliseconds - 是否包含毫秒（預設 false）
   * @returns {string} 格式化的時間字串
   */
  formatDateTime(timestamp, options = {}) {
    try {
      const date =
        typeof timestamp === "number"
          ? new Date(timestamp)
          : timestamp instanceof Date
            ? timestamp
            : new Date(timestamp);

      if (isNaN(date.getTime())) {
        return "無效時間";
      }

      const includeDate = options.includeDate !== false;
      const includeTime = options.includeTime !== false;
      const includeSeconds = options.includeSeconds !== false;

      // 快取 Intl.DateTimeFormat，避免高頻呼叫（計時器每 50ms）時反覆建構
      if (!this._dtfCache) this._dtfCache = new Map();
      const cacheKey = `${this.timezone}:${includeDate}:${includeTime}:${includeSeconds}`;
      let formatter = this._dtfCache.get(cacheKey);
      if (!formatter) {
        formatter = new Intl.DateTimeFormat("zh-TW", {
          ...(includeDate ? { year: "numeric", month: "2-digit", day: "2-digit" } : {}),
          ...(includeTime
            ? { hour: "2-digit", minute: "2-digit", ...(includeSeconds ? { second: "2-digit" } : {}) }
            : {}),
          timeZone: this.timezone,
          hour12: false,
        });
        this._dtfCache.set(cacheKey, formatter);
      }

      let result = formatter.format(date).replace(/\//g, "-");

      // 如果需要毫秒
      if (options.includeMilliseconds) {
        const ms = String(date.getMilliseconds()).padStart(3, "0");
        result += `.${ms}`;
      }

      return result;
    } catch (error) {
      Logger.error("[TimeSyncManager] 時間格式化失敗:", error);
      return "格式化錯誤";
    }
  }

  /**
   * 以預設格式名稱格式化時間
   * @param {number|Date} timestamp - 毫秒級時間戳或 Date 物件
  * @param {string} preset - 預設名稱（例如 dateTime, dateTimeShort, recordDetail, recordFilter）
   * @param {Object} overrideOptions - 覆蓋預設值的選項
   * @returns {string} 格式化的時間字串
   */
  formatDateTimeWithPreset(timestamp, preset, overrideOptions = {}) {
    const presetOptions = this._getDateTimePreset(preset);
    return this.formatDateTime(timestamp, {
      ...presetOptions,
      ...overrideOptions,
    });
  }

  _getDateTimePreset(preset) {
    const configPresets = getSharedConfig()?.timeFormatPresets || {};
    return {
      ...(this.dateTimePresets[preset] || {}),
      ...(configPresets[preset] || {}),
    };
  }

  /**
   * 格式化時間為東八區 HH:MM:SS 格式（不含日期）
   * @param {number|Date} timestamp - 毫秒級時間戳或 Date 物件
   * @param {Object} options - 選項
   * @param {boolean} options.includeMilliseconds - 是否包含毫秒（預設 false）
   * @returns {string} 格式化的時間字串
   */
  formatTime(timestamp, options = {}) {
    try {
      const dateTime = this.formatDateTime(timestamp, options);
      // 取出時間部分（空格後的內容）
      const timeMatch = dateTime.match(/\s(.*)$/);
      return timeMatch ? timeMatch[1] : "無效時間";
    } catch (error) {
      Logger.error("[TimeSyncManager] 時間格式化失敗:", error);
      return "格式化錯誤";
    }
  }

  /**
   * 格式化日期為東八區 YYYY-MM-DD 格式（不含時間）
   * @param {number|Date} timestamp - 毫秒級時間戳或 Date 物件
   * @returns {string} 格式化的日期字串
   */
  formatDate(timestamp) {
    try {
      const dateTime = this.formatDateTime(timestamp, { includeTime: false });
      // 取出日期部分（空格前的內容）
      const dateMatch = dateTime.match(/^([^\s]+)/);
      return dateMatch ? dateMatch[1] : "無效日期";
    } catch (error) {
      Logger.error("[TimeSyncManager] 日期格式化失敗:", error);
      return "格式化錯誤";
    }
  }

  /**
   * 格式化時間長度（文字顯示）
   * @param {number} seconds - 秒數
   * @param {Object} options - 顯示選項
   * @returns {string} 格式化的時間長度
   */
  formatDurationText(seconds, options = {}) {
    const style = options.style || this.durationTextStyle;
    if (style !== "zh") {
      return this.formatDuration(seconds * 1000);
    }

    if (seconds < 60) {
      return `${seconds}秒`;
    }
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (minutes < 60) {
      return `${minutes}分${secs}秒`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}小時${mins}分${secs}秒`;
  }
}

// ES6 模組匯出
export default TimeSyncManager;
export { TimeSyncManager };
