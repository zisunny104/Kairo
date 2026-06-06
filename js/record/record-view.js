/**
 * RecordView - 實驗紀錄 UI 管理系統
 *
 * 負責即時日誌顯示、歷史日誌列表、下載與刪除操作。
 * 透過 BroadcastChannel 接收 RecordManager 的日誌更新事件。
 *
 * 依賴（透過 updateDependencies 注入）：
 *   recordManager      → RecordManager 實例
 *   timeSyncManager → 時間同步管理器
 *   config          → 全域設定物件
 *   getGesturesData → () => Object  手勢資料字典
 *   getCombination  → () => Object  目前組合
 *   syncLogsNow     → () => void    立即儲存日誌的回呼（可選）
 *   onRecordsSyncedRefresh → ({ reason, data }) => void 廣播刷新前的額外 UI 收尾（可選）
 */

import { RECORD_TYPE_LABELS, RECORD_TYPES, GESTURE_ATTEMPT_TYPE_LABELS, API_ENDPOINTS } from "../constants/index.js";
import { Logger } from "../core/console-manager.js";
import { recordViewFilter } from "./record-view-filter.js";
import { recordViewModal } from "./record-view-modal.js";
import { recordViewList } from "./record-view-list.js";
import { recordViewStats } from "./record-view-stats.js";
import { getApiUrl } from "../core/url-utils.js";

class RecordView {
  constructor() {
    this.currentRecords = [];
    this.selectedRecords = new Set();
    this.recordManager = null;
    this.timeSyncManager = null;
    this.config = null;
    this.getGesturesData = null;
    this.getCombination = null;
    this.syncLogsNow = null;
    this.onRecordsSyncedRefresh = null;
    this.getExperimentIsPaused = null;
    this._syncNowInProgress = false;

    this._isLoadingList = false;
    this._lastLoadAt = 0;
    this._loadDebounceMs = 800;
    this._loadTimer = null;
    this._refreshQueued = false;
    this._refreshQueuedImmediate = false;
    this._hasRequestedInitialLoad = false;
    this._initialLoadObserver = null;
    this._initialLoadFallbackTimer = null;
    this._allRecords = [];
    this._filterUiReady = false;
    this.recordFilterPopover = null;
    this._recordListActionsBound = false;
    this._currentRecordActionsBound = false;
    this._initialized = false;
    this._logModal = null;

    this.recordCountFilter = { min: 0, max: null, maxAvailable: 0 };
    this.durationFilter = { min: 0, max: null, maxAvailable: 0 };
    this.timeFilter = { min: null, max: null, minAvailable: null, maxAvailable: null };

    this._initBroadcastChannel();
  }

  /**
   * 注入或更新執行期依賴
   * @param {Object}   [deps]
   * @param {Object}   [deps.recordManager]      - RecordManager 實例
   * @param {Object}   [deps.timeSyncManager] - 時間同步管理器
   * @param {Object}   [deps.config]          - 全域設定物件
   * @param {Function} [deps.getGesturesData] - `() => Object` 取得手勢資料字典
   * @param {Function} [deps.getCombination]  - `() => Object` 取得目前組合
   * @param {Function} [deps.syncLogsNow]     - `() => void` 立即儲存日誌的回呼
   * @param {Function} [deps.onRecordsSyncedRefresh] - `({ reason, data }) => void` 刷新前 UI 收尾回呼
   */
  updateDependencies(deps = {}) {
    Object.assign(this, deps);
  }

  // ─── 初始化 ────────────────────────────────────────────────────────────────

  /**
   * 初始化 UI 容器與日誌列表（需 recordManager 已注入才會生效）
   */
  initialize() {
    if (this._initialized) return;

    if (!this.recordManager) {
      Logger.debug("[RecordView.initialize] recordManager 尚未就緒，稍後初始化");
      return;
    }

    this.initializeRecordContainer();
    this.initializeRecordList();

    if (document.getElementById("recordEntriesContainer")) {
      this.scheduleInitialRecordLoad();
    }

    this._initialized = true;
    Logger.debug("[RecordView.initialize] 完成");
  }

  initializeRecordContainer() {
    const container = document.getElementById("recordContainer");
    if (!container) return;

    container.className = "experiment-ui-card";
    container.innerHTML = `
      <div class="records-header">
        <h3>實驗日誌</h3>
        <div class="records-status">
          <button id="copyCurrentRecordsBtn" data-action="copy-current-records" title="複製即時日誌" aria-label="複製即時日誌">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
          <button id="syncRecordsNowBtn" class="is-hidden" data-action="sync-now" title="立即同步日誌" aria-label="立即同步日誌">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7,11 12,6 17,11"></polyline>
              <line x1="12" y1="6" x2="12" y2="18"></line>
            </svg>
          </button>
          <span class="record-status-indicator idle">等待開始</span>
        </div>
      </div>
      <div class="records-live-content">
        <div class="no-current-records">
          <div class="no-records-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 11H5a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2h-4"></path>
              <path d="M9 11V9a3 3 0 0 1 6 0v2"></path>
              <circle cx="12" cy="16" r="1"></circle>
            </svg>
          </div>
          <div class="no-records-text">尚未開始實驗</div>
          <div class="no-records-hint">實驗開始後，此處將顯示即時日誌</div>
        </div>
      </div>`;

    this._bindCurrentRecordActions();
  }

  initializeRecordList() {
    const container = document.getElementById("recordsList");
    if (!container) return;

    const filterBlocks = [
      this._renderFilterBlock({
        title: "記錄數", minValueId: "recordFilterMinValue", maxValueId: "recordFilterMaxValue",
        minRangeId: "recordFilterMinRange", maxRangeId: "recordFilterMaxRange",
        slidersId: "recordFilterCountSliders", minValue: 0, maxValue: 0,
      }),
      this._renderFilterBlock({
        title: "實驗耗時", minValueId: "recordFilterDurationMinValue", maxValueId: "recordFilterDurationMaxValue",
        minRangeId: "recordFilterDurationMinRange", maxRangeId: "recordFilterDurationMaxRange",
        slidersId: "recordFilterDurationSliders", minValue: "0秒", maxValue: "0秒",
      }),
      this._renderFilterBlock({
        title: "實驗時間", minValueId: "recordFilterTimeMinValue", maxValueId: "recordFilterTimeMaxValue",
        minRangeId: "recordFilterTimeMinRange", maxRangeId: "recordFilterTimeMaxRange",
        slidersId: "recordFilterTimeSliders", minValue: "--", maxValue: "--",
      }),
    ].join("");

    container.innerHTML = `
      <div class="records-section-header">
        <h2>實驗日誌列表</h2>
        <div class="records-list-header">
          <button id="refreshRecordsBtn" class="btn-secondary" data-action="refresh-records" title="重新整理" aria-label="重新整理">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" class="icon-sm">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
              <path d="M21 3v5h-5"></path>
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>
              <path d="M3 21v-5h5"></path>
            </svg>
          </button>
          <button id="recordFilterToggleBtn" class="btn-secondary" data-action="toggle-filter" title="篩選" aria-label="篩選">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" class="icon-sm">
              <path d="M3 4h18"></path><path d="M6 10h12"></path><path d="M10 16h4"></path>
            </svg>
          </button>
          <button id="downloadSelectedRecordsBtn" class="btn-secondary is-hidden" data-action="download-selected" title="下載選取" aria-label="下載選取">
            <svg class="svg-icon svg-md" viewBox="0 0 24 24">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7,10 12,15 17,10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
          </button>
          <button id="deleteSelectedRecordsBtn" class="btn-danger is-hidden" data-action="delete-selected" title="刪除選取" aria-label="刪除選取">
            <svg class="svg-icon svg-md" viewBox="0 0 24 24">
              <polyline points="3,6 5,6 21,6"></polyline>
              <path d="M19,6v14a2,2 0 0,1-2,2H7a2,2 0 0,1-2-2V6m3,0V4a2,2 0 0,1,2-2h4a2,2 0 0,1,2,2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
          </button>
        </div>
      </div>

      <div id="recordFilterPopover" class="record-filter-popover is-hidden" aria-hidden="true">
        ${filterBlocks}
        <div class="record-filter-actions">
          <button class="btn-secondary" data-action="reset-filter">重置</button>
          <button class="btn-primary" data-action="apply-filter">套用</button>
        </div>
      </div>

      <div class="form-group">
        <div id="recordEntriesContainer">
          ${this._renderRecordListSkeleton()}
        </div>
      </div>`;

    this._bindRecordListActions();
  }

  _renderRecordListSkeleton() {
    return `
      <div class="records-list records-list-loading-skeleton" role="list">
        <div class="records-skeleton-item">
          <div class="skeleton-line w-70"></div>
          <div class="skeleton-line w-40"></div>
        </div>
        <div class="records-skeleton-item">
          <div class="skeleton-line w-80"></div>
          <div class="skeleton-line w-45"></div>
        </div>
        <div class="records-skeleton-item">
          <div class="skeleton-line w-65"></div>
          <div class="skeleton-line w-35"></div>
        </div>
      </div>
      <div class="records-loading-caption">正在準備實驗日誌...</div>`;
  }

  // ─── 即時日誌顯示 ──────────────────────────────────────────────────────────

  /**
   * 更新即時日誌顯示（由 RecordManager 驅動）
   * @param {Array} logs - 完整日誌陣列
   */
  updateLiveDisplay(logs) {
    this._currentLogs = logs;

    // 節流：每 100ms 最多重繪一次，避免高頻 _addLog 在主執行緒上累積大量 DOM 操作
    const now = Date.now();
    if (this._liveDisplayLastRender && now - this._liveDisplayLastRender < 100) {
      if (!this._liveDisplayThrottleTimer) {
        this._liveDisplayThrottleTimer = setTimeout(() => {
          this._liveDisplayThrottleTimer = null;
          this._renderLiveDisplay();
        }, 100);
      }
      return;
    }
    this._liveDisplayLastRender = now;
    this._renderLiveDisplay();
  }

  _renderLiveDisplay() {
    const logsContent = document.querySelector("#recordContainer .records-live-content");
    if (!logsContent) return;

    const logs = this._currentLogs;

    const recentLogs = logs.slice(-20);
    if (recentLogs.length === 0) return;

    const gesturesData = this.getGesturesData?.() ?? {};
    const entriesHtml = recentLogs.map((log) => {
      const date = new Date(log.ts);
      const time = date.toTimeString().slice(0, 8) + "." + String(date.getMilliseconds()).padStart(3, "0");

      const typeLabel = RECORD_TYPE_LABELS[log.type] ?? log.type;
      const detailParts = [];

      let gestureMeta = "";
      if (log.g_id) {
        const gestureName = gesturesData[log.g_id]?.zh;
        gestureMeta = gestureName ? `${gestureName} (${log.g_id})` : log.g_id;
      }
      if (log.g_idx !== undefined) {
        const gestureIndexLabel = `手勢#${log.g_idx + 1}`;
        detailParts.push(gestureMeta ? `${gestureIndexLabel} (${gestureMeta})` : gestureIndexLabel);
      }
      if (log.g_type) detailParts.push(GESTURE_ATTEMPT_TYPE_LABELS[log.g_type] ?? log.g_type);
      if (log.s_id) detailParts.push(`(${log.s_id})`);
      if (log.a_id) detailParts.push(`[${log.a_id}]`);

      const details = detailParts.join(" ");
      return `<div class="current-record-entry">
        <span class="record-time">[${time}]</span>
        <span class="record-type">${typeLabel}</span>
        ${details ? `<span class="record-details">${details}</span>` : ""}
      </div>`;
    }).join("");

    logsContent.innerHTML = `
      <div class="current-record-entries">${entriesHtml}</div>
      <div class="records-summary">共 ${logs.length} 筆記錄</div>`;
    logsContent.scrollTop = logsContent.scrollHeight;

    const statusIndicator = logsContent.closest("#recordContainer")?.querySelector(".record-status-indicator");
    if (statusIndicator) {
      const isPaused = this.getExperimentIsPaused?.() ?? false;
      statusIndicator.className = `record-status-indicator ${isPaused ? "paused" : "running"}`;
      statusIndicator.textContent = `${isPaused ? "已暫停" : "進行中"} · ${logs.length} 筆`;
    }

    this.updateSyncButtonState("show", logs.length);
  }

  /**
   * 實驗結束後更新日誌顯示
   * @param {number} totalLogs
   */
  showCompletionDisplay(totalLogs) {
    const logsContent = document.querySelector("#recordContainer .records-live-content");
    if (!logsContent) return;

    logsContent.innerHTML = `
      <div class="current-record-entries">
        <div class="current-record-entry record-completion">
          <span class="record-type">完成</span>
          <span class="record-details">實驗已結束，日誌已儲存 (共 ${totalLogs} 筆記錄)</span>
        </div>
      </div>`;

    const statusIndicator = logsContent.closest("#recordContainer")?.querySelector(".record-status-indicator");
    if (statusIndicator) {
      statusIndicator.className = "record-status-indicator completed";
      statusIndicator.textContent = `已完成 · ${totalLogs} 筆`;
    }

    this.updateSyncButtonState("hide");

    const resetDelay = this.config?.userSettings?.postExperimentResetDelayMs ?? 3000;
    setTimeout(() => this.resetLiveDisplayToIdle(), resetDelay);
  }

  /**
   * 重置即時日誌到等待狀態
   */
  resetLiveDisplayToIdle() {
    const logsContent = document.querySelector("#recordContainer .records-live-content");
    if (!logsContent) return;

    logsContent.innerHTML = `
      <div class="no-current-records">
        <div class="no-records-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 11H5a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2h-4"></path>
            <path d="M9 11V9a3 3 0 0 1 6 0v2"></path>
            <circle cx="12" cy="16" r="1"></circle>
          </svg>
        </div>
        <div class="no-records-text">尚未開始實驗</div>
        <div class="no-records-hint">實驗開始後，此處將顯示即時日誌</div>
      </div>`;

    const statusIndicator = logsContent.closest("#recordContainer")?.querySelector(".record-status-indicator");
    if (statusIndicator) {
      statusIndicator.className = "record-status-indicator idle";
      statusIndicator.textContent = "等待開始";
    }

    this.updateSyncButtonState("hide");
  }

  /**
   * 更新同步按鈕狀態
   * @param {"show"|"hide"|"disabled"|"enabled"} state
   * @param {number} logCount
   */
  updateSyncButtonState(state, logCount = 0) {
    const btn = document.getElementById("syncRecordsNowBtn");
    if (!btn) return;
    switch (state) {
      case "show":
        btn.classList.remove("is-hidden");
        btn.disabled = logCount <= 0;
        btn.title = logCount > 0 ? `立即同步日誌 (目前 ${logCount} 筆)` : "暫無日誌可發送";
        break;
      case "hide":
        btn.classList.add("is-hidden");
        break;
      case "disabled":
        btn.disabled = true;
        btn.title = "暫無日誌可發送";
        break;
      case "enabled":
        btn.disabled = false;
        btn.title = `立即同步日誌 (目前 ${logCount} 筆)`;
        break;
    }
  }

  // ─── 事件綁定 ──────────────────────────────────────────────────────────────

  _bindCurrentRecordActions() {
    if (this._currentRecordActionsBound) return;
    const container = document.getElementById("recordContainer");
    if (!container) return;

    container.addEventListener("click", async (event) => {
      const target = event.target.closest("[data-action]");
      if (!target) return;
      const action = target.dataset.action;

      if (action === "sync-now") {
        await this._handleSyncNow();
        return;
      }
      if (action === "copy-current-records") {
        this.copyCurrentRecordsToClipboard(target);
      }
    });

    this._currentRecordActionsBound = true;
  }

  async _handleSyncNow() {
    if (this._syncNowInProgress) return;

    const btn = document.getElementById("syncRecordsNowBtn");
    const indicator = document.querySelector("#recordContainer .record-status-indicator");
    this._syncNowInProgress = true;

    if (btn) {
      btn.disabled = true;
      btn.dataset.syncing = "true";
      btn.title = "同步中...";
    }
    indicator?.classList.add("syncing");

    const syncStart = Date.now();
    const minSyncDisplayMs = 600;
    try {
      if (this.syncLogsNow) {
        await this.syncLogsNow();
      } else {
        await this.recordManager?.flushAll?.();
      }
    } finally {
      const elapsed = Date.now() - syncStart;
      if (elapsed < minSyncDisplayMs) {
        await new Promise((resolve) => setTimeout(resolve, minSyncDisplayMs - elapsed));
      }
      this._syncNowInProgress = false;
      indicator?.classList.remove("syncing");
      if (btn) {
        btn.dataset.syncing = "false";
        this.updateSyncButtonState("enabled", this.recordManager?.records?.length || 0);
      }
    }
  }

  _bindRecordListActions() {
    if (this._recordListActionsBound) return;
    const container = document.getElementById("recordsList");
    if (!container) return;

    container.addEventListener("click", (event) => {
      const target = event.target.closest("[data-action]");
      if (!target) return;
      const action = target.dataset.action;
      const recordId = target.dataset.recordId;

      switch (action) {
        case "refresh-records":
          this._initialLoadObserver?.disconnect();
          this._initialLoadObserver = null;
          clearTimeout(this._initialLoadFallbackTimer);
          this._initialLoadFallbackTimer = null;
          this._hasRequestedInitialLoad = true;
          this.requestRecordListRefresh({ immediate: true, reason: "manual_refresh" });
          break;
        case "toggle-filter": this.toggleRecordFilter(); break;
        case "download-selected": this.downloadSelectedRecords(); break;
        case "delete-selected": this.deleteSelectedRecords(); break;
        case "apply-filter": this.applyRecordFilter(); break;
        case "reset-filter": this.resetRecordFilter(); break;
        case "select-filtered": this.selectFilteredRecords(); break;
        case "view-record": if (recordId) this.viewRecordDetails(recordId); break;
        case "download-record": if (recordId) this.downloadRecordById(recordId); break;
        case "delete-record": if (recordId) this.deleteRecordById(recordId); break;
      }
    });

    container.addEventListener("change", (event) => {
      const checkbox = event.target.closest("input[data-record-id]");
      if (checkbox) this.toggleRecordSelection(checkbox.dataset.recordId);
    });

    this._recordListActionsBound = true;
  }

  // ─── 日誌列表載入 ──────────────────────────────────────────────────────────

  /**
   * 排程初始日誌載入：容器進入視窗後觸發，或最晚 2.5 秒後 fallback 觸發
   */
  scheduleInitialRecordLoad() {
    if (this._hasRequestedInitialLoad) return;
    const container = document.getElementById("recordEntriesContainer");
    if (!container) return;

    const triggerLoad = () => {
      if (this._hasRequestedInitialLoad) return;
      this._hasRequestedInitialLoad = true;
      this._initialLoadObserver?.disconnect();
      this._initialLoadObserver = null;
      clearTimeout(this._initialLoadFallbackTimer);
      this._initialLoadFallbackTimer = null;
      this._runWhenIdle(() => this.requestRecordListRefresh({ immediate: true, reason: "initial_load_visible" }));
    };

    if (typeof window.IntersectionObserver === "function") {
      this._initialLoadObserver = new IntersectionObserver(
        (entries) => { if (entries.some((e) => e.isIntersecting)) triggerLoad(); },
        { root: null, threshold: 0.05 },
      );
      this._initialLoadObserver.observe(container);
      this._initialLoadFallbackTimer = setTimeout(triggerLoad, 2500);
      return;
    }

    this._initialLoadFallbackTimer = setTimeout(triggerLoad, 800);
  }

  _runWhenIdle(task, timeoutMs = 1200) {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => task(), { timeout: timeoutMs });
    } else {
      setTimeout(task, 300);
    }
  }

  /**
   * 請求更新日誌列表，支援立即執行或防抖延後執行
   * @param {Object}  [options]
   * @param {boolean} [options.immediate=false] - 是否立即執行（跳過防抖）
   * @param {string}  [options.reason]          - 觸發原因（用於 debug log）
   */
  requestRecordListRefresh({ immediate = false, reason = "unknown" } = {}) {
    if (immediate) {
      clearTimeout(this._loadTimer);
      this._loadTimer = null;
      this._refreshQueued = false;
      this._refreshQueuedImmediate = false;

      if (this._isLoadingList) {
        this._refreshQueued = true;
        this._refreshQueuedImmediate = true;
        return;
      }

      if (reason === "broadcast_records_synced") {
        this.onRecordsSyncedRefresh?.({ reason, data: null });
      }

      this._hasRequestedInitialLoad = true;
      this.loadRecordList();
      return;
    }

    this._refreshQueued = true;
    if (this._loadTimer) return;

    this._loadTimer = setTimeout(() => {
      this._loadTimer = null;
      if (this._isLoadingList) {
        this._refreshQueued = true;
        this._refreshQueuedImmediate = false;
        return;
      }
      this._hasRequestedInitialLoad = true;
      this._refreshQueued = false;
      this._refreshQueuedImmediate = false;
      if (reason === "broadcast_records_synced") {
        this.onRecordsSyncedRefresh?.({ reason, data: null });
      }
      Logger.debug(`[RecordView] 觸發延後更新 (${reason})`);
      this.loadRecordList();
    }, this._loadDebounceMs);
  }

  /**
   * 載入並顯示實驗日誌列表，包含防重入與防抖保護
   * @returns {Promise<void>}
   */
  async loadRecordList() {
    const now = Date.now();
    if (this._isLoadingList) { this._scheduleLogListReload(); return; }
    if (now - this._lastLoadAt < this._loadDebounceMs) { this._scheduleLogListReload(); return; }

    this._isLoadingList = true;
    const container = document.getElementById("recordEntriesContainer");
    if (!container) { this._isLoadingList = false; return; }

    container.innerHTML = this._renderRecordListSkeleton();

    try {
      const logsDir = await this.getRecordsDirectory();
      const experiments = await this.loadRecordListFromDirectory(logsDir);

      // 重新載入時重置篩選條件
      this.recordCountFilter.min = 0;
      this.recordCountFilter.max = null;
      this.durationFilter.min = 0;
      this.durationFilter.max = null;
      this.timeFilter.min = null;
      this.timeFilter.max = null;

      this.displayRecordList(experiments);
    } catch (error) {
      Logger.error("載入日誌列表失敗:", error);
      this.displayRecordList([]);
    } finally {
      this._isLoadingList = false;
      this._lastLoadAt = Date.now();

      if (this._refreshQueued) {
        const shouldImmediate = this._refreshQueuedImmediate;
        this._refreshQueued = false;
        this._refreshQueuedImmediate = false;
        this.requestRecordListRefresh({ immediate: shouldImmediate, reason: "queued_after_load" });
      }
    }
  }

  _scheduleLogListReload() {
    this.requestRecordListRefresh({ immediate: false, reason: "deferred_reload" });
  }

  async getRecordsDirectory() {
    return this.config?.experiment?.logsDirectory ?? "runtime/experiment-data";
  }

  /**
   * 讀取指定目錄下的所有 .jsonl 實驗日誌檔案
   * @param {string} dirPath - 日誌目錄路徑
   * @returns {Promise<Array>} 解析後的實驗物件陣列，依開始時間降序排列
   */
  async loadRecordListFromDirectory(dirPath) {
    const experiments = [];
    try {
      const files = await this.listFilesInDirectory(dirPath);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
      const apiUrl = getApiUrl();
      const concurrency = 4;

      for (let i = 0; i < jsonlFiles.length; i += concurrency) {
        const batch = jsonlFiles.slice(i, i + concurrency);
        const results = await Promise.all(
          batch.map(async (filename) => {
            try {
              const response = await fetch(`${apiUrl}${API_ENDPOINTS.RECORD.READ(filename)}`);
              if (!response.ok) return null;
              const result = await response.json();
              if (!result.success || !result.content) return null;

              const logs = this.parseJSONL(result.content);
              if (logs.length === 0) return null;

              const match = filename.match(/^(.+?)(?:_\d+)?\.jsonl$/);
              const experimentId = match ? match[1] : filename.replace(".jsonl", "");
              const expStartLog = logs.find((log) => log.type === RECORD_TYPES.EXP_START);

              return {
                experimentId,
                participantName: expStartLog?.participant || "n/a",
                combinationName: expStartLog?.combo_name || "n/a",
                filename,
                filePath: filename,
                logCount: logs.length,
                startTime: logs[0]?.ts || Date.now(),
                endTime: logs[logs.length - 1]?.ts || Date.now(),
                durationSeconds: Math.max(0, Math.round(
                  ((logs[logs.length - 1]?.ts || 0) - (logs[0]?.ts || 0)) / 1000,
                )),
                logs,
                actualExperimentId: experimentId,
              };
            } catch (error) {
              const match = filename.match(/^(.+?)(?:_\d+)?\.jsonl$/);
              const experimentId = match ? match[1] : filename.replace(".jsonl", "");
              return {
                experimentId, participantName: "n/a", combinationName: "n/a",
                filename, filePath: filename, logCount: 0,
                startTime: Date.now(), endTime: Date.now(), durationSeconds: 0,
                logs: [], actualExperimentId: experimentId, error: error.message,
              };
            }
          }),
        );
        experiments.push(...results.filter(Boolean));
      }

      experiments.sort((a, b) => b.startTime - a.startTime);
    } catch (error) {
      Logger.error("讀取目錄失敗:", error);
    }
    return experiments;
  }

  /**
   * 透過 API 取得日誌目錄的檔案列表
   * @param {string} _dirPath - 目錄路徑（目前由 API 統一管理，參數保留供未來擴充）
   * @returns {Promise<string[]>} 檔案名稱陣列
   */
  async listFilesInDirectory(_dirPath) {
    try {
      const response = await fetch(`${getApiUrl()}${API_ENDPOINTS.RECORD.LIST}`);
      if (response.ok) {
        const result = await response.json();
        if (result.success && result.files) {
          return result.files.map((f) => f.filename);
        }
      }
    } catch (error) {
      Logger.debug("API 不可用，無法動態讀取檔案列表", error.message);
    }
    Logger.warn("無法讀取實驗日誌檔案。請啟動伺服器：cd server && npm start");
    return [];
  }

  /**
   * 解析 JSONL 字串為物件陣列，自動過濾解析失敗的行
   * @param {string} content - JSONL 格式字串
   * @returns {Array<Object>}
   */
  parseJSONL(content) {
    return content.trim().split("\n")
      .filter((line) => line.trim())
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  }

  // ─── 日誌操作 ──────────────────────────────────────────────────────────────

  /**
   * 開啟指定實驗日誌的詳細視窗（含統計與 JSONL 預覽）
  * @param {string} recordId - 實驗 ID 或 filename
   */
  async viewRecordDetails(recordId) {
    const experiment = this._findRecord(recordId);
    if (!experiment?.logs?.length) {
      Logger.warn(`找不到實驗 ${recordId} 的日誌資料`);
      return;
    }

    const stats = this.calculateRecordStatistics(experiment.logs);
    const jsonlContent = experiment.logs.map((e) => JSON.stringify(e)).join("\n");
    this.showRecordViewModal(recordId, stats, jsonlContent);
  }

  _buildCurrentRecordCopyHeader() {
    const records = Array.isArray(this.recordManager?.records)
      ? this.recordManager.records
      : [];
    const expStart = records.find((record) => record.type === RECORD_TYPES.EXP_START);
    const experimentId = expStart?.exp_id || "未知";
    const participantName = expStart?.participant || this.recordManager?.participantName || "";
    const combinationName = expStart?.combo_name || expStart?.combo_id || this.getCombination?.()?.combinationName || "";
    const startedAt = expStart?.ts ? new Date(expStart.ts).toISOString() : "";

    const headerLines = ["--- 實驗基本資訊 ---"];
    headerLines.push(`實驗 ID: ${experimentId}`);
    if (participantName) headerLines.push(`受試者: ${participantName}`);
    if (combinationName) headerLines.push(`組合: ${combinationName}`);
    if (startedAt) headerLines.push(`開始時間: ${startedAt}`);
    headerLines.push("-------------------");
    return headerLines;
  }

  /**
   * 透過 API 下載指定實驗的 .jsonl 檔案
  * @param {string} recordId - 實驗 ID 或 filename
   */
  async downloadRecordById(recordId) {
    const experiment = this._findRecord(recordId);
    if (!experiment?.filename) { Logger.warn(`找不到實驗 ${recordId}`); return; }

    try {
      const response = await fetch(`${getApiUrl()}${API_ENDPOINTS.RECORD.READ(experiment.filename)}`);
      if (!response.ok) throw new Error(`API 回傳錯誤: ${response.status}`);
      const result = await response.json();
      if (!result.success || !result.content) throw new Error(result.error || "無法讀取");

      this._downloadBlob(result.content, experiment.filename, "application/x-ndjson");
    } catch (error) {
      Logger.error("下載日誌失敗:", error);
    }
  }

  /**
   * 透過 API 刪除指定實驗的 .jsonl 檔案
  * @param {string} recordId - 實驗 ID 或 filename
   */
  async deleteRecordById(recordId) {
    const experiment = this._findRecord(recordId);
    if (!experiment?.filename) { Logger.warn(`找不到實驗 ${recordId}`); return; }

    try {
      const response = await fetch(
        `${getApiUrl()}${API_ENDPOINTS.RECORD.DELETE(experiment.filename)}`,
        { method: "DELETE" },
      );
      const result = await response.json();
      if (!result.success) throw new Error(result.error || "刪除失敗");
      this.requestRecordListRefresh({ immediate: true, reason: "delete-record" });
    } catch (error) {
      Logger.error("刪除日誌失敗:", error);
    }
  }

  /**
   * 批次下載所有已選取的實驗日誌（合併為一個 .txt 檔案）
   * @returns {Promise<void>}
   */
  async downloadSelectedRecords() {
    if (this.selectedRecords.size === 0) return;
    const apiUrl = getApiUrl();
    let allContent = "";
    let successCount = 0;

    for (const recordId of this.selectedRecords) {
      const experiment = this._findRecord(recordId);
      if (!experiment?.filename) continue;
      try {
        const response = await fetch(`${apiUrl}${API_ENDPOINTS.RECORD.READ(experiment.filename)}`);
        if (response.ok) {
          const result = await response.json();
          if (result.success && result.content) {
            allContent += `\n=== Experiment: ${recordId} (${experiment.filename}) ===\n${result.content}\n`;
            successCount++;
          }
        }
      } catch (error) {
        Logger.warn(`下載日誌 ${recordId} 失敗:`, error.message);
      }
    }

    if (!allContent) { Logger.warn("沒有可下載的日誌資料"); return; }
    const filename = `experiment_logs_batch_${new Date().toISOString().split("T")[0]}.txt`;
    this._downloadBlob(allContent, filename, "text/plain");
    Logger.debug(`已批次下載 ${successCount}/${this.selectedRecords.size} 個日誌`);
  }

  /**
   * 批次刪除所有已選取的實驗日誌
   * @returns {Promise<void>}
   */
  async deleteSelectedRecords() {
    if (this.selectedRecords.size === 0) return;
    const apiUrl = getApiUrl();
    let deletedCount = 0;

    for (const recordId of this.selectedRecords) {
      const experiment = this._findRecord(recordId);
      if (!experiment?.filename) continue;
      try {
        const response = await fetch(
          `${apiUrl}${API_ENDPOINTS.RECORD.DELETE(experiment.filename)}`,
          { method: "DELETE" },
        );
        if (response.ok) {
          const result = await response.json();
          if (result.success) deletedCount++;
        }
      } catch (error) {
        Logger.warn(`刪除日誌 ${recordId} 失敗:`, error.message);
      }
    }

    Logger.debug(`已批次刪除 ${deletedCount}/${this.selectedRecords.size} 個日誌`);
    this.selectedRecords.clear();
    this.requestRecordListRefresh({ immediate: true, reason: "delete-selected" });
  }

  /**
   * 透過 API 更新指定日誌的受試者名稱，並同步更新 modal 顯示與記憶體快取
   * @param {string} filename - 日誌檔案名稱
   * @param {string} newName  - 新的受試者名稱
   * @returns {Promise<void>}
   */
  async updateParticipantName(filename, newName) {
    newName = (newName || "").trim();
    if (!newName) return;

    const safeFilename = filename.endsWith(".jsonl") ? filename : `${filename}.jsonl`;
    try {
      const resp = await fetch(
        `${getApiUrl()}${API_ENDPOINTS.RECORD.UPDATE_PARTICIPANT(encodeURIComponent(safeFilename))}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ participant: newName }) },
      );
      const result = await resp.json();
      if (!result.success) throw new Error(result.error || "更新失敗");

      // 更新 modal 顯示
      const display = document.getElementById("modal-participant-display");
      const input = document.getElementById("modal-participant-input");
      if (display) display.textContent = newName;
      if (input) input.style.display = "none";
      if (display) display.style.display = "";
      const show = (id, v) => { const el = document.getElementById(id); if (el) el.style.display = v; };
      show("modal-participant-edit-btn", "");
      show("modal-participant-save-btn", "none");
      show("modal-participant-cancel-btn", "none");

      // 更新快取
      const cached = this.currentRecords.find(
        (e) => e.filename === filename || e.filename === safeFilename,
      );
      if (cached) {
        cached.participantName = newName;
        cached.logs?.forEach((entry) => {
          if (entry.type === RECORD_TYPES.EXP_START || entry.type === RECORD_TYPES.EXP_END) entry.participant = newName;
        });
      }
    } catch (error) {
      Logger.error("更新受試者名稱失敗:", error);
    }
  }

  async copyCurrentRecordsToClipboard(triggerEl = null) {
    const logs = this._currentLogs;
    if (!Array.isArray(logs) || logs.length === 0) return false;

    const gesturesData = this.getGesturesData?.() ?? {};
    const lines = logs.map((log) => {
      const date = new Date(log.ts);
      const time = date.toTimeString().slice(0, 8) + "." + String(date.getMilliseconds()).padStart(3, "0");
      const typeLabel = RECORD_TYPE_LABELS[log.type] ?? log.type;
      const detailParts = [];
      let gestureMeta = "";
      if (log.g_id) {
        const gestureName = gesturesData[log.g_id]?.zh;
        gestureMeta = gestureName ? `${gestureName} (${log.g_id})` : log.g_id;
      }
      if (log.g_idx !== undefined) {
        const gestureIndexLabel = `手勢#${log.g_idx + 1}`;
        detailParts.push(gestureMeta ? `${gestureIndexLabel} (${gestureMeta})` : gestureIndexLabel);
      }
      if (log.g_type) detailParts.push(GESTURE_ATTEMPT_TYPE_LABELS[log.g_type] ?? log.g_type);
      if (log.s_id) detailParts.push(`(${log.s_id})`);
      if (log.a_id) detailParts.push(`[${log.a_id}]`);
      const details = detailParts.join(" ");
      return `[${time}] ${typeLabel}${details ? " " + details : ""}`;
    });
    lines.push(`共 ${logs.length} 筆記錄`);

    const headerLines = this._buildCurrentRecordCopyHeader();
    const outputLines = [...headerLines, ...lines];

    try {
      await navigator.clipboard.writeText(outputLines.join("\n"));
      if (triggerEl instanceof HTMLElement) {
        triggerEl.classList.add("copied");
        const originalTitle = triggerEl.title;
        triggerEl.title = "已複製";
        setTimeout(() => { triggerEl.classList.remove("copied"); triggerEl.title = originalTitle || "複製即時日誌"; }, 1200);
      }
      return true;
    } catch (error) {
      Logger.error("複製即時日誌失敗:", error);
      return false;
    }
  }

  // ─── BroadcastChannel ──────────────────────────────────────────────────────

  _initBroadcastChannel() {
    try {
      this.broadcastChannel = new BroadcastChannel("ExperimentRecordsChannel");
      this.broadcastChannel.onmessage = (event) => {
        const { type, data } = event.data;
        switch (type) {
          case "recordsSynced":
            if (data?.source && data.source !== "experiment_completion" && data.source !== "runtime_saved") return;
            this.requestRecordListRefresh({ immediate: false, reason: "broadcast_records_synced" });
            break;
          case "experimentDeleted":
            this.requestRecordListRefresh({ immediate: true, reason: "broadcast_deleted" });
            break;
          case "recordsCleared":
            this.requestRecordListRefresh({ immediate: true, reason: "broadcast_cleared" });
            break;
        }
      };
    } catch (error) {
      Logger.warn("[RecordView] BroadcastChannel 不支援，日誌列表需要手動更新:", error);
    }
  }

  destroy() {
    if (this.broadcastChannel) {
      this.broadcastChannel.close();
      this.broadcastChannel = null;
    }
  }

  // ─── 輔助方法 ──────────────────────────────────────────────────────────────

  _findRecord(recordId) {
    return this.currentRecords.find(
      (exp) => exp.filename === recordId || exp.actualExperimentId === recordId || exp.experimentId === recordId,
    );
  }

  /**
   * 建立 Blob URL 並觸發瀏覽器下載
   * @param {string} content  - 檔案內容
   * @param {string} filename - 下載時的檔案名稱
   * @param {string} mimeType - MIME 類型
   */
  _downloadBlob(content, filename, mimeType) {
    const url = window.URL.createObjectURL(new Blob([content], { type: mimeType }));
    const link = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  }

}

// 混入 UI 子模組
Object.assign(RecordView.prototype, recordViewFilter, recordViewModal, recordViewList, recordViewStats);

// 建立全域單例
export const recordView = new RecordView();
