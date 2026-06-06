/**
 * ExperimentUIManager - 管理實驗面板的 UI 控件與狀態同步
 *
 * 負責初始化、inject dependencies、計時器委派、ID 廣播，
 * 以及回應 ExperimentFlowManager 的狀態變更以更新畫面與互動。
 *
 * 繼承鏈：
 *   ExperimentControlsDom → ExperimentUIRenderer → ExperimentUIManager
 *
 * DOM 操作    → ExperimentControlsDom
 * 通用 UI 工具與渲染 → ExperimentUIRenderer
 * 初始化與流程協調   → ExperimentUIManager（本檔）
 */

import { RECORD_SOURCES, SYNC_EVENTS } from "../constants/index.js";
import { Logger } from "../core/console-manager.js";
import ExperimentUIRenderer from "./experiment-ui-renderer.js";

class ExperimentUIManager extends ExperimentUIRenderer {
  /**
   * 建構函式
   * @param {Object} config - 配置選項
   */
  constructor(config = {}) {
    super();
    this.config = {
      enableVisualHints: config.enableVisualHints ?? true,
      highlightDuration: config.highlightDuration ?? 300,
      selectors: config.selectors || {},
    };

    // dependencies container
    this.dependencies = {
      flowManager: null,
      combinationManager: null,
      hubManager: null,
      experimentSystemManager: null,
      syncManager: null,
      syncClient: null,
      experimentSyncCore: null,
    };

    // UI 狀態（供 ExperimentUIRenderer 方法讀寫）
    this.state = {
      visualHintsEnabled: this.config.enableVisualHints,
      highlightedButtons: new Set(),
      lockedElements: new Set(),
      hiddenElements: new Set(),
    };

    // DOM 元素快取（供 ExperimentUIRenderer 方法讀寫）
    this.elements = new Map();

    // 事件監聽器集合（供 ExperimentUIRenderer 的 on/off 使用）
    this.listeners = new Map();

    this.initialized = false;

    Logger.debug("ExperimentUIManager 已建立");
  }

  // ==========================================
  // 初始化
  // ==========================================

  initialize() {
    if (this.initialized) {
      Logger.warn("UI 管理器已經初始化");
      return;
    }
    this._cacheCommonElements();
    this._setupStateInputSync();
    this.initialized = true;
    Logger.debug("UI 管理器初始化完成");
    this._emit("ui-manager-initialized");
  }

  /** @private */
  _cacheCommonElements() {
    const selectors = {
      powerSwitchArea: "#powerSwitchArea",
      pauseIndicator: "#pauseIndicator",
      experimentTimer: "#experimentTimer",
      experimentPanel: ".experiment-panel",
      visualHintsToggle: "#toggleTouchVisuals",
    };
    Object.entries(selectors).forEach(([key, sel]) => {
      const el = document.querySelector(sel);
      if (el) this.elements.set(key, el);
    });
  }

  /**
   * 監聽 ExperimentStateManager 的狀態事件，將值同步到 DOM 輸入框。
   * @private
   */
  _setupStateInputSync() {
    this._onStateIdChanged = (e) => {
      const { experimentId } = e.detail || {};
      if (experimentId == null) return;
      const safeExperimentId = typeof experimentId === "string" ? experimentId : "";
      const input = document.getElementById("experimentIdInput");
      if (input && input.value.trim() !== safeExperimentId) {
        input.value = safeExperimentId;
      }
    };
    this._onParticipantChanged = (e) => {
      const { participantName } = e.detail || {};
      if (participantName == null) return;
      const safeName = typeof participantName === "string" ? participantName : "";
      const input = document.getElementById("participantNameInput");
      if (input && input.value.trim() !== safeName) {
        input.value = safeName;
      }
    };
    document.addEventListener(SYNC_EVENTS.EXPERIMENT_STATE_ID_CHANGED, this._onStateIdChanged);
    document.addEventListener(SYNC_EVENTS.EXPERIMENT_STATE_PARTICIPANT_CHANGED, this._onParticipantChanged);
  }

  // ==========================================
  // inject dependencies
  // ==========================================

  injectFlowManager(flowManager) {
    if (!flowManager) { Logger.warn("Injected FlowManager 無效"); return; }
    this.dependencies.flowManager = flowManager;
  }

  updateDependencies(deps = {}) {
    Object.assign(this.dependencies, deps);
  }

  // ==========================================
  // 輸入框與狀態管理器綁定
  // ==========================================

  /**
   * 綁定實驗 ID 與受試者名稱輸入欄位到 stateManager。
   * 在 StateManager 與 UIManager 均完成建構後呼叫一次。
   */
  bindStateManagerInputs(stateManager) {
    if (!stateManager) return;

    const idInput = document.getElementById("experimentIdInput");
    if (idInput && !idInput._stateSyncBound) {
      idInput._stateSyncBound = true;
      let _debounceTimer = null;
      const DEBOUNCE_MS = 300;
      const applyId = (newId) => {
        if (newId === stateManager.experimentId) return;
        const sys = this.dependencies.experimentSystemManager;
        if (sys?.setExperimentId) {
          sys.setExperimentId(newId, RECORD_SOURCES.LOCAL_INPUT, {
            broadcast: true, reapplyCombination: true,
          });
        } else {
          stateManager.setExperimentId(newId, RECORD_SOURCES.LOCAL_INPUT);
        }
      };
      idInput.addEventListener("input", (e) => {
        if (idInput._experimentSystemBound) return;
        const newId = e.target.value.trim();
        if (_debounceTimer) clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(() => { applyId(newId); _debounceTimer = null; }, DEBOUNCE_MS);
      });
      idInput.addEventListener("change", (e) => {
        if (idInput._experimentSystemBound) return;
        if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
        applyId(e.target.value.trim());
      });
      if (idInput.value.trim() && !stateManager.experimentId) {
        stateManager.setExperimentId(idInput.value.trim(), "input-init");
      }
    }

    const nameInput = document.getElementById("participantNameInput");
    if (nameInput && !nameInput._stateSyncBound) {
      nameInput._stateSyncBound = true;
      const applyName = (newName) => {
        if (newName !== stateManager.participantName) {
          stateManager.setParticipantName(newName, "input");
        }
      };
      nameInput.addEventListener("input", (e) => applyName(e.target.value.trim()));
      nameInput.addEventListener("change", (e) => applyName(e.target.value.trim()));
      if (nameInput.value.trim() && !stateManager.participantName) {
        stateManager.setParticipantName(nameInput.value.trim(), "input-init");
      }
    }
  }

  updateSelectAllState() {
    const selectAllCheckbox = document.querySelector("#selectAllUnits");
    const unitList = document.querySelector("#unitsPanelContainer .experiment-units-list");
    if (!selectAllCheckbox || !unitList) return;
    const checkboxes = Array.from(unitList.querySelectorAll("input[name=\"unitCheckbox\"]"));
    const checkedCount = checkboxes.filter((cb) => cb.checked).length;
    selectAllCheckbox.checked = checkedCount === checkboxes.length && checkboxes.length > 0;
    selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
  }

  // ==========================================
  // 流程事件處理
  // ==========================================

  /** @private */
  _handleExperimentStart() {
    Logger.debug("開始實驗");
    const toggle = this.elements.get("visualHintsToggle");
    if (toggle && this.isVisualHintsEnabled()) {
      this.updateHighlightVisibility();
      Logger.debug("實驗開始：視覺提示已啟用並更新高亮");
    }
  }

  // ==========================================
  // 清理
  // ==========================================

  reset() {
    this.clearAllHighlights();
    this.state.highlightedButtons.clear();
    this.state.lockedElements.clear();
    this.state.hiddenElements.clear();
    this._emit("ui-manager-reset");
    Logger.debug("UI 管理器已重置");
  }

  destroy() {
    this.listeners.forEach((handlers, eventName) => {
      handlers.forEach((handler) => this.off(eventName, handler));
    });
    this.listeners.clear();
    if (this._onStateIdChanged) {
      document.removeEventListener(SYNC_EVENTS.EXPERIMENT_STATE_ID_CHANGED, this._onStateIdChanged);
      this._onStateIdChanged = null;
    }
    if (this._onParticipantChanged) {
      document.removeEventListener(SYNC_EVENTS.EXPERIMENT_STATE_PARTICIPANT_CHANGED, this._onParticipantChanged);
      this._onParticipantChanged = null;
    }
    this.elements.clear();
    this.reset();
    this.dependencies.flowManager = null;
    this.initialized = false;
    this._emit("ui-manager-destroyed");
    Logger.debug("UI 管理器已銷毀");
  }
}

export default ExperimentUIManager;
export { ExperimentUIManager };
