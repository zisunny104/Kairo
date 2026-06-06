/**
 * BoardPageManager - 實驗頁面管理器
 *
 * 專門用於 board.html 頁面，負責載入所有必要的腳本、
 * 初始化各個管理器模組，並協調頁面各元件間的互動。
 */

import { Logger } from "../core/console-manager.js";
import {
  loadScenariosData,
  loadUnitsFromScenarios,
} from "../core/data-loader.js";
import {
  ACTION_IDS,
  ACTION_BUTTONS,
  SYNC_DATA_TYPES,
  SYNC_EVENTS,
} from "../constants/index.js";
import { experimentSyncManager } from "./board-experiment-sync.js";
import { BoardSyncIO } from "./board-sync-io.js";
import { ExperimentFlowManager } from "../experiment/experiment-flow-manager.js";
import { buildBoardGestureScript } from "../experiment/experiment-script-builder.js";
import { BoardUIManager } from "./board-ui-manager.js";
import { generateExperimentId } from "../core/random-utils.js";
import { initializeBoardManagers } from "./board-init.js";

class BoardPageManager {
  constructor() {
    this.initStages = {
      DEPENDENCY_READY: "dependency_ready",
      MODULES_INIT: "modules_init",
      COMPONENTS_INIT: "components_init",
      COMPLETE: "complete",
    };

    this.currentStage = null;
    this.stageStartTime = null;
    this._listenersSetup = false; // 防止事件監聽器重複設定
    this._contentAreaListeners = null;
    this._exportGestureBound = false;
    this.pendingExperimentStartData = null;

    this.timerManager = null;
    this.gestureUtils = null;
    this.syncManager = null;
    this.recordManager = null;
    this.experimentStateManager = null;
    this.syncIO = null;
    this._lastCombinationLoadSignature = null;
    this._lastCombinationRenderSignature = null;
  }

  _getExperimentId() {
    return this.experimentSystemManager?.getExperimentId?.() || "";
  }

  _getParticipantName() {
    return this.experimentSystemManager?.getParticipantName?.() || "";
  }

  _buildHubExperimentState(type, isRunning) {
    return {
      type,
      experimentId: this._getExperimentId(),
      participantName: this._getParticipantName(),
      combinationId: this.currentCombination?.combinationId || "",
      combinationName: this.currentCombination?.combinationName || "",
      gestureCount: this.currentCombination?.gestures?.length || 0,
      isRunning,
    };
  }

  /**
   * 開始新的初始化階段
   * @param {string} stage - 階段名稱
   */
  startStage(stage) {
    this.currentStage = stage;
    this.stageStartTime = performance.now();
    document.body?.setAttribute("data-board-stage", stage);
    Logger.debug(`開始階段: ${stage}`);
  }

  /**
   * 結束目前初始化階段
   */
  endStage() {
    if (this.currentStage && this.stageStartTime) {
      const duration = performance.now() - this.stageStartTime;
      Logger.debug(
        `階段 ${this.currentStage} 完成 (<orange>${duration.toFixed(0)} ms</orange>)`,
      );
    }
    this.currentStage = null;
    this.stageStartTime = null;
  }

  async _runInitStage(stage, task) {
    this.startStage(stage);
    try {
      await task();
    } finally {
      this.endStage();
    }
  }

  /**
   * 初始化 Board 頁面（載入腳本並初始化模組）
   */
  async initialize() {
    const startTime = performance.now();
    try {
      Logger.debug("BoardPageManager 開始初始化");

      await this._runInitStage(this.initStages.DEPENDENCY_READY, async () => {
        await this.prepareDependencies();
      });

      await this._runInitStage(this.initStages.MODULES_INIT, async () => {
        await this.initializeModules();
      });

      await this._runInitStage(this.initStages.COMPONENTS_INIT, () =>
        this.initializeRemainingComponents(),
      );

      // 完成
      this.currentStage = this.initStages.COMPLETE;
      document.body?.setAttribute("data-board-stage", this.initStages.COMPLETE);
      document.body?.classList.remove("board-booting");
      document.body?.classList.add("board-ready");
      Logger.debug(
        `BoardPageManager 初始化完成 (<orange>${(performance.now() - startTime).toFixed(0)} ms</orange>)`,
      );
    } catch (error) {
      Logger.error(
        `BoardPageManager 初始化失敗 (階段: ${this.currentStage}, 耗時: ${(performance.now() - startTime).toFixed(0)} ms)`,
        error,
      );
      // 即使失敗也嘗試繼續基本功能
      try {
        await this.initializeRemainingComponents();
      } catch (e) {
        Logger.error("初始化其他元件失敗:", e);
      }

      // 確保 UI 渲染完成後才結束骨架載入狀態
      document.body?.setAttribute("data-board-stage", this.initStages.COMPLETE);
      document.body?.classList.remove("board-booting");
      document.body?.classList.add("board-ready");
    }
  }

  /**
   * 初始化模組
   */
  async initializeModules() {
    // 先載入 scenarioData，以便在 SystemManager 初始化時可用
    await this.loadScenarioData();
    await initializeBoardManagers(this);
  }

  /**
   * 載入實驗頁面所需的依賴腳本
   */
  async prepareDependencies() {
    // board.html 已透過 module bootstrap + 靜態 import 鏈載入依賴，
    // 這裡保留初始化階段但不再動態注入 script，避免雙軌載入互相干擾。
    Logger.debug("Board 依賴由靜態 import 鏈提供，略過動態 script 載入");
  }

  /**
   * 初始化其餘元件（在管理器初始化之後）
   */
  async initializeRemainingComponents() {
    // 保留 modules_init 階段已載入的資料，避免重複載入造成啟動成本上升。
    Object.assign(this, {
      scenariosData: this.scenariosData || null,
      scriptData: this.scriptData || null,
      gesturesData: this.gesturesData || null,
      currentUnit: this.currentUnit || null,
      currentStep: this.currentStep || 0,
      currentCombination: this.currentCombination || null,
      currentUnitOrder: this.currentUnitOrder || [],
      sessionId: this.generateSessionId(),
      experimentRunning: false,
      participantName: "",
      lastSavedParticipantName: "",
      pendingExperimentIdUpdate: null,
      pendingParticipantNameUpdate: null,
      actionsMap: this.actionsMap || new Map(),
      actionToStepMap: this.actionToStepMap || new Map(),
      processedRemoteActions: new Map(),
    });
    this._lastCombinationRenderSignature = null;
    // 避免遠端 action 短時間內重複處理
    this.remoteActionDedupeWindow = 500;
    this.experimentStartedAt = 0;
    this.boardUIManager = new BoardUIManager(this);
    this.boardUIManager.init();
    Logger.debug("BoardUIManager 已初始化");
    await this.init();
  }

  /**
   * 設定事件監聽器（僅應被呼叫一次）
   * @private
   */
  _setupEventListeners() {
    // 防止重複監聽器設定
    if (this._listenersSetup) {
      Logger.debug("BoardPageManager 事件監聽器已設定，略過重複綁定");
      return;
    }

    this._listenersSetup = true;

    // 監聽 ExperimentSystemManager 的組合選擇事件
    window.addEventListener("experimentSystem:combinationSelected", (event) => {
      const { combination, experimentId } = event.detail;
      this._handleSystemCombinationSelected(combination, experimentId);
    });

    window.addEventListener(SYNC_EVENTS.CLIENT_JOINED, () => {
      this._onClientJoined();
    });

    window.addEventListener("experimentSystem:stopRequested", (event) => {
      if (event.defaultPrevented) return;
      if (!this.experimentSystemManager?.isExperimentRunning?.()) return;

      Logger.debug("Board: 收到 stopRequested 事件，使用 BoardPageManager.stopExperiment 處理");
      event.preventDefault();
      this.stopExperiment({
        reason: event.detail?.reason || "manual",
        broadcast: event.detail?.broadcast !== false,
        source: event.detail?.source || "ui",
      });
    });

    this.experimentFlowManager.on(
      ExperimentFlowManager.EVENT.STARTED,
      (data) => {
        this._handleFlowStarted(data);
      },
    );
    this.experimentFlowManager.on(
      ExperimentFlowManager.EVENT.PAUSED,
      (data) => {
        this._handleFlowPaused(data);
      },
    );
    this.experimentFlowManager.on(
      ExperimentFlowManager.EVENT.RESUMED,
      (data) => {
        this._handleFlowResumed(data);
      },
    );
    this.experimentFlowManager.on(
      ExperimentFlowManager.EVENT.STOPPED,
      (data) => {
        this._handleFlowStopped(data);
      },
    );
    this.experimentFlowManager.on(
      ExperimentFlowManager.EVENT.COMPLETED,
      (data) => {
        this._handleFlowCompleted(data);
      },
    );
  }

  /**
   * 新客戶端加入 session 時，主動推送當前完整狀態。
   * 確保後加入的客戶端能取得 board 目前選定的組合與實驗 ID。
   * @private
   */
  _onClientJoined() {
    if (!this.syncManager?.isSyncMode) return;

    Logger.debug("Board: 新客戶端加入，推送當前實驗狀態");

    const type = this.experimentRunning
      ? SYNC_DATA_TYPES.EXPERIMENT_STARTED
      : SYNC_DATA_TYPES.EXPERIMENT_STOPPED;
    experimentSyncManager.registerExperimentStateToHub(
      this._buildHubExperimentState(type, this.experimentRunning),
    );

    this.experimentCombinationManager?.broadcastCurrentCombination?.();
  }

  /**
   * 處理 ExperimentSystemManager 的組合選擇事件
   * @private
   */
  async _handleSystemCombinationSelected(combination, experimentId) {
    Logger.debug("_handleSystemCombinationSelected: 收到組合選擇事件", {
      combinationName: combination?.combinationName,
      combinationId: combination?.combinationId,
      experimentId,
    });

    // 更新 board 端的目前組合參照
    this.currentCombination = combination;

    // 載入對應的腳本（board 專屬邏輯 — 建構手勢序列等）
    try {
      await this.loadScriptForCombination(combination, experimentId);
      Logger.debug("_handleSystemCombinationSelected: 手勢序列載入完成");
    } catch (error) {
      Logger.error("_handleSystemCombinationSelected: 載入手勢序列失敗", error);
    }
  }

  /**
   * 處理 ExperimentFlowManager 的 STARTED 事件
   * @private
   * 觸發時機：ExperimentFlowManager.startExperiment() 完成
   * 目的：初始化 Board 端的記錄、同步等特定功能
   */
  _handleFlowStarted(data) {
    Logger.info("Board: 實驗已開始，初始化記錄和同步", { units: data.units });

    // 同步 experimentRunning 旗標，避免 _autoStartExperimentIfNeeded 重複觸發
    this.experimentRunning = true;
    this.experimentStartedAt = Date.now();

    // 初始化日誌管理器（重置記錄狀態，設定 experimentId/participantName）
    // EXP_START 狀態日誌由 ExperimentSystemManager._handleFlowStarted 統一記錄（訂閱在後執行）
    if (this.recordManager) {
      const experimentId = this._getExperimentId() || data.experimentId || "";
      const participantName = this._getParticipantName();

      this.recordManager.initialize(experimentId, participantName);
      if (this.pendingExperimentStartData) {
        this.recordManager.logAction(
          "experiment_started",
          this.pendingExperimentStartData,
        );
        this.pendingExperimentStartData = null;
      }
      Logger.debug(`日誌管理器已初始化: ID=${experimentId}`);
    }

    this.updateExperimentStats();

    // 實驗開始時先聚焦第一步，避免自動啟動計時器
    this.gestureUtils?.focusGestureStep(0);

    const container = document.querySelector(".container");
    const isStackedLayout =
      container &&
      window.getComputedStyle(container).flexDirection === "column";
    const experimentControls = document.getElementById("experimentControlsContainer");

    if (isStackedLayout) {
      return;
    }

    if (experimentControls) {
      experimentControls.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    // 廣播由 FlowManager 派發 document: experiment_started
    // → bindBoardBroadcastEvents 捕獲後廣播，此處不重複 dispatch
  }

  /**
   * 處理 FlowManager PAUSED 事件（board 端）
   * FlowManager 自動派送的 EXPERIMENT_PAUSED DOM 事件由 bindBoardBroadcastEvents 負責廣播；
   * 此方法僅額外將暫停狀態更新至 Hub。
   */
  _handleFlowPaused(data) {
    // EXP_PAUSE 狀態日誌由 ExperimentSystemManager._handleFlowPaused 統一記錄
    if (data?.broadcast === false) {
      Logger.debug("Board: 遠端套用的暫停事件，略過同步廣播");
      return;
    }
    experimentSyncManager.registerExperimentStateToHub(
      this._buildHubExperimentState(SYNC_DATA_TYPES.EXPERIMENT_PAUSED, true),
    );
    Logger.debug("Board: 實驗已暫停");
  }

  /**
   * 處理 FlowManager RESUMED 事件（board 端）
   * FlowManager 自動派送的 EXPERIMENT_RESUMED DOM 事件由 bindBoardBroadcastEvents 負責廣播；
   * 此方法僅額外將繼續狀態更新至 Hub。
   */
  _handleFlowResumed(data) {
    // EXP_RESUME 狀態日誌由 ExperimentSystemManager._handleFlowResumed 統一記錄
    if (data?.broadcast === false) {
      Logger.debug("Board: 遠端套用的繼續事件，略過同步廣播");
      return;
    }
    experimentSyncManager.registerExperimentStateToHub(
      this._buildHubExperimentState(SYNC_DATA_TYPES.EXPERIMENT_RESUMED, true),
    );
    Logger.debug("Board: 實驗已繼續");
  }

  /**
   * 處理 ExperimentFlowManager 的 STOPPED 事件
   * @private
   * 觸發時機：ExperimentFlowManager.stopExperiment() 完成
   * 目的：更新 experimentRunning 旗標、將停止狀態推送至 Hub，
   *        並在 postExperimentResetDelayMs 後重置手勢序列。
   * 日誌寫入（EXP_END + flushAll）由 stopExperiment() 在此事件之後統一負責。
   */
  _handleFlowStopped(data) {
    Logger.info("Board: 實驗已停止，重置狀態", {
      reason: data.reason,
      completedUnits: data.completedUnits,
    });

    if (data?.broadcast === false) {
      Logger.debug("Board: 遠端套用的停止事件，略過同步廣播");
    } else {
      experimentSyncManager.registerExperimentStateToHub(
        this._buildHubExperimentState(SYNC_DATA_TYPES.EXPERIMENT_STOPPED, false),
      );
    }

    // 同步 experimentRunning 旗標
    this.experimentRunning = false;
    this.experimentStartedAt = 0;

    const resetDelay = this.configManager?.userSettings?.postExperimentResetDelayMs ?? 5000;
    setTimeout(() => {
      this.gestureUtils?.resetGestureSequence();
      this.recordManager?.view?.resetLiveDisplayToIdle?.();
    }, resetDelay);

    // EXP_END 狀態日誌由 ExperimentSystemManager._handleFlowStopped 統一記錄（同步執行）
    // flushAll() 由 stopExperiment() 在 stopFlowExperiment() 之後負責呼叫（確保 EXP_END 先寫入）
  }

  /**
   * 處理 ExperimentFlowManager 的 COMPLETED 事件（所有單元自然完成，無使用者中斷）
   * stopExperiment() 不會被呼叫，因此需在此處補齊日誌結尾與檔案儲存。
   * @private
   */
  async _handleFlowCompleted(data) {
    Logger.info("Board: 實驗自然完成，儲存日誌並清理資源", {
      totalUnits: data.totalUnits,
      completedUnits: data.completedUnits,
    });

    if (data?.broadcast === false) {
      Logger.debug("Board: 遠端套用的完成事件，略過同步廣播");
    } else {
      experimentSyncManager.registerExperimentStateToHub(
        this._buildHubExperimentState(SYNC_DATA_TYPES.EXPERIMENT_STOPPED, false),
      );
    }

    this.experimentRunning = false;
    this.experimentStartedAt = 0;

    const resetDelay = this.configManager?.userSettings?.postExperimentResetDelayMs ?? 5000;
    setTimeout(() => {
      this.gestureUtils?.resetGestureSequence();
      this.recordManager?.view?.resetLiveDisplayToIdle?.();
    }, resetDelay);

    // EXP_END 由 ExperimentSystemManager._handleFlowStopped 同步寫入（COMPLETED 映射到該方法），
    // 計時器也由同一路徑停止；此處只負責 flushAll()，確保自然完成路徑也能持久化到 JSONL
    if (this.recordManager) {
      try {
        await this.recordManager.flushAll();
      } catch (error) {
        Logger.error("Board: 完成實驗日誌儲存失敗:", error);
      }
    }
  }

  /**
  * 設定 board 控制項的鎖定狀態
   * @private
   * @param {boolean} locked - 是否鎖定
   */
  _setBoardControlsLocked(locked) {
    Logger.debug(`設定 board 控制項鎖定狀態: ${locked}`);

    // 鎖定/解鎖主要控制按鈕
    const startBtn = document.getElementById("startExperimentBtn");
    const stopBtn = document.getElementById("stopExperimentBtn");
    const regenerateBtn = document.getElementById("regenerateExperimentIdBtn");

    if (startBtn) startBtn.disabled = locked;
    // 停止按鈕邏輯與 locked 相反：實驗進行中（locked=true）才可用，未執行時停用
    if (stopBtn) stopBtn.disabled = !locked;
    if (regenerateBtn) regenerateBtn.disabled = locked;

    // 更新按鈕樣式以反映鎖定狀態（停止按鈕不參與 locked 樣式）
    const lockableButtons = [startBtn, regenerateBtn].filter((btn) => btn);
    lockableButtons.forEach((btn) => {
      if (locked) {
        btn.classList.add("locked");
      } else {
        btn.classList.remove("locked");
      }
    });
  }

  setExperimentControlsLocked(locked) {
    this._setBoardControlsLocked(locked);
  }

  generateSessionId() {
    return generateExperimentId();
  }

  _syncCombinationDetailRender() {
    if (!this.boardUIManager?.initialized || !this.currentCombination) return false;

    const signature = this._lastCombinationLoadSignature || JSON.stringify({
      combinationId: this.currentCombination?.combinationId || "",
      combinationName: this.currentCombination?.combinationName || "",
      gestureCount: this.currentCombination?.gestures?.length || 0,
    });

    if (this._lastCombinationRenderSignature === signature) return true;

    this.boardUIManager.renderUnitDetail();
    this._lastCombinationRenderSignature = signature;
    Logger.debug("Board: 右面板手勢序列已同步渲染");
    return true;
  }

  /**
   * 初始化實驗頁面管理器
   */
  async init() {
    await this.boardUIManager.renderUnifiedUI();

    this._syncCombinationDetailRender();

    this.boardUIManager.renderGestureTypesReference();
    this.setupParticipantNameListener();
    if (!this.syncIO) {
      this.syncIO = new BoardSyncIO(this);
    }
    this.syncIO.startReceive();
    this._bindExportGestureButton();
  }

  async loadScenarioData() {
    Logger.debug("loadScenarioData: 開始載入劇本資料");
    const loadStart = performance.now();
    try {
      // 使用資料轉換器載入完整的 units 和 actions 資料
      const convertedData = await loadUnitsFromScenarios();
      this.scenariosData = await loadScenariosData();

      // 載入手勢多語言資料
      this.gesturesData = await fetch("data/gestures.json").then((r) =>
        r.json(),
      );

      // 儲存 actions 相關資料
      this.actionsMap = convertedData.actions;
      this.actionToStepMap = convertedData.actionToStep;
      this.unitsData = convertedData.units;
      this.experimentFlowManager?.injectDependencies?.({
        actionsMap: this.actionsMap,
        unitsData: this.unitsData,
      });

      // 初始化 scriptData
      this.scriptData = {
        combinations: convertedData.unit_combinations,
        gestures: this.scenariosData.gesture_list,
        sections: this.scenariosData.sections,
        units: convertedData.units,
      };

      Logger.debug(`loadScenarioData: 劇本資料載入完成 (<orange>${(performance.now() - loadStart).toFixed(0)} ms</orange>)`, {
        gestureList_count: this.scenariosData?.gesture_list?.length || 0,
        sections_count: this.scenariosData?.sections?.length || 0,
        combinations_count: convertedData?.unit_combinations?.length || 0,
      });
    } catch (error) {
      Logger.error(`載入 scenarios.json 失敗 (<orange>${(performance.now() - loadStart).toFixed(0)} ms</orange>):`, error);
    }
  }

  /**
   * 載入組合腳本並建立手勢序列
   * @param {Object} combination - 組合資料
   * @param {string} experimentId - 實驗ID
   */
  async loadScriptForCombination(combination, experimentId) {
    Logger.debug("loadScriptForCombination: 開始載入組合腳本", {
      combinationName: combination?.combinationName,
      experimentId,
    });
    try {
      // 確保實驗ID不為空
      if (!experimentId || !experimentId.trim()) {
        experimentId = this.experimentSystemManager
          ? this.experimentSystemManager.getExperimentId() ||
            generateExperimentId()
          : generateExperimentId();
      }

      const unitIds = this.experimentCombinationManager.getCombinationUnitIds(
        combination,
        experimentId,
      );
      const normalizedPowerOptions = combination?.powerOptions || {};
      const loadSignature = JSON.stringify({
        experimentId,
        combinationId: combination?.combinationId || "",
        unitIds,
        powerOptions: normalizedPowerOptions,
      });
      if (this._lastCombinationLoadSignature === loadSignature) {
        Logger.debug("loadScriptForCombination: 組合內容未變更，略過重建", {
          experimentId,
          combinationId: combination?.combinationId,
        });
        return true;
      }

      Logger.debug("loadScriptForCombination: 實驗ID確認完成", {
        experimentId,
      });

      Logger.debug("loadScriptForCombination: 單元序列模式", { unitIds });
      const { script, hasScenarioSections } = buildBoardGestureScript({
        combination,
        experimentId,
        scenariosData: this.scenariosData,
        unitIds,
        actionIds: ACTION_IDS,
        actionButtons: ACTION_BUTTONS,
      });

      if (!hasScenarioSections) {
        Logger.warn(
          "loadScriptForCombination: scenariosData 或 sections 不存在",
        );
      }

      Logger.debug("loadScriptForCombination: 手勢序列建構完成", {
        gestureCount: script.gestures.length,
        unitCount: script.unitsSequence.length,
        combinationName: script.combinationName,
      });

      if (script.gestures.length === 0) {
        Logger.warn("loadScriptForCombination: 警告：沒有產生任何手勢！");
      }

      this.currentCombination = script;
      this._lastCombinationLoadSignature = loadSignature;
      this._syncCombinationDetailRender();
    } catch (error) {
      Logger.error("loadScriptForCombination: 載入組合劇本失敗", error);
    }
  }

  updateExperimentStats() {
    this.boardUIManager.updateStats(this.currentCombination);
  }

  /**
   * BoardUIManager 完成手勢序列渲染後呼叫此鉤子。
   * 由 PageManager 自行決定後續要做的事（綁定事件、更新統計），
   * 避免 UIManager 直接存取 PageManager 的私有方法。
   * @param {HTMLElement} contentArea - 已完成渲染的內容區域元素
   */
  onUnitRendered(contentArea) {
    this._bindGestureContentEvents(contentArea);
    this.updateExperimentStats();
  }

  _bindGestureContentEvents(contentArea) {
    if (!contentArea) return;

    if (this._contentAreaListeners?.element === contentArea) {
      return;
    }

    if (this._contentAreaListeners?.element) {
      const previous = this._contentAreaListeners;
      previous.element.removeEventListener("click", previous.onClick);
      previous.element.removeEventListener(
        "pointerdown",
        previous.onPointerDown,
      );
      previous.element.removeEventListener(
        "pointerup",
        previous.onPointerUp,
      );
      previous.element.removeEventListener(
        "pointercancel",
        previous.onPointerUp,
      );
      previous.element.removeEventListener(
        "pointerout",
        previous.onPointerOut,
      );
    }

    const parseIndex = (value) => {
      const idx = parseInt(value, 10);
      return Number.isNaN(idx) ? null : idx;
    };

    const withTimerCard = (event, handler, options = {}) => {
      const target = event.target.closest("[data-action]");
      if (!target || !contentArea.contains(target)) return;

      if (options.skipChildTransition && target.contains(event.relatedTarget)) {
        return;
      }

      if (target.dataset.action !== "timer-card") return;

      const idx = parseIndex(target.dataset.gestureIndex);
      if (idx === null) return;

      handler(idx);
    };

    const onClick = (event) => {
      const target = event.target.closest("[data-action]");
      if (!target || !contentArea.contains(target)) return;

      const action = target.dataset.action;
      const idx = parseIndex(target.dataset.gestureIndex);
      const gestureName = target.dataset.gestureName || "";

      switch (action) {
        case "timer-card":
          if (idx !== null) {
            this.timerManager?.toggleIndexedTimer(idx);
          }
          break;
        case "mark-gesture":
          if (idx !== null) {
            this.gestureUtils?.markGesture(
              idx,
              target.dataset.markStatus,
              gestureName,
            );
          }
          break;
        case "next-step":
          if (idx !== null) {
            this.gestureUtils?.goToNextStep(idx, gestureName);
          }
          break;
        case "action-button": {
          const actionId = target.dataset.actionId;
          this._handleActionButtonClick(target, actionId, idx);
          break;
        }
        default:
          break;
      }
    };

    const onPointerDown = (event) => {
      withTimerCard(event, (idx) => {
        this.timerManager?.longPressStart(idx);
      });
    };

    const onPointerUp = (event) => {
      withTimerCard(event, (idx) => {
        this.timerManager?.longPressEnd(idx);
      });
    };

    const onPointerOut = (event) => {
      withTimerCard(
        event,
        (idx) => {
          this.timerManager?.longPressEnd(idx);
        },
        { skipChildTransition: true },
      );
    };

    contentArea.addEventListener("click", onClick);
    contentArea.addEventListener("pointerdown", onPointerDown);
    contentArea.addEventListener("pointerup", onPointerUp);
    contentArea.addEventListener("pointercancel", onPointerUp);
    contentArea.addEventListener("pointerout", onPointerOut);

    this._contentAreaListeners = {
      element: contentArea,
      onClick,
      onPointerDown,
      onPointerUp,
      onPointerOut,
    };
  }

  /**
   * 實驗者（board）點擊手勢動作按鈕時的處理。
   *
   * 1. 推進 gesture step（僅在此處觸發，不由遠端 panel 訊號驅動）
   * 2. 將按鈕標記為已完成（綠色）
   */
  _handleActionButtonClick(buttonElement, actionId, gestureIndex) {
    if (typeof this.gestureUtils?.activateGestureStep === "function") {
      const idx = Number.isFinite(gestureIndex)
        ? gestureIndex
        : parseInt(gestureIndex, 10);
      if (!Number.isNaN(idx)) {
        this.gestureUtils.activateGestureStep(idx);
      }
    }

    const isCompleted = buttonElement.getAttribute("data-completed") === "true";
    if (!isCompleted) {
      this._markActionCompleted(buttonElement, actionId, gestureIndex, false);
    }
  }

  _scrollActionCardIntoView(buttonElement) {
    const card = buttonElement?.closest("[id^='gesture-card-']");
    if (!card) return;

    const scrollContainer = document.querySelector(".right-panel");
    const containerRect = scrollContainer?.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const isOutOfView = containerRect
      ? cardRect.top < containerRect.top || cardRect.bottom > containerRect.bottom
      : cardRect.top < 0 || cardRect.bottom > window.innerHeight;

    if (isOutOfView) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    this._scrollActionButtonHorizontally(buttonElement);
  }

  _scrollActionButtonHorizontally(buttonElement) {
    const actionContainer = buttonElement?.closest(".gesture-actions-container");
    if (!actionContainer) return;

    const containerRect = actionContainer.getBoundingClientRect();
    const buttonRect = buttonElement.getBoundingClientRect();
    const isOutOfView =
      buttonRect.left < containerRect.left ||
      buttonRect.right > containerRect.right;
    if (!isOutOfView) return;

    const targetLeft =
      buttonElement.offsetLeft -
      (actionContainer.clientWidth - buttonElement.offsetWidth) / 2;
    actionContainer.scrollTo({
      left: Math.max(0, targetLeft),
      behavior: "smooth",
    });
  }

  /**
   * 標記一個 action 為已完成（將手勢按鈕變成綠色）。
   *
   * @param {HTMLElement} buttonElement - 對應的手勢動作按鈕
   * @param {string}      actionId      - action ID
   * @param {number|null} gestureIndex  - 所屬的 gesture 索引
   * @param {boolean}     isRemote      - true 表示由 panel（受試者）端同步觸發，
   *                                      false 表示由實驗者本人點擊觸發
   *
   * 說明：
   * - 變綠即視為實驗者確認，無論來源均寫入 JSONL。
   * - isRemote 僅影響 src 欄位（"local" / "remote"）及是否廣播電源 action。
   * - data-completed 守衛確保同一按鈕不會重複寫入。
   */
  _markActionCompleted(
    buttonElement,
    actionId,
    gestureIndex,
    isRemote = false,
  ) {
    if (!buttonElement) return;

    const stepId =
      this.experimentActionHandler?.actionToStepMap?.get(actionId)?.step_id ||
      null;

    buttonElement.setAttribute("data-completed", "true");
    buttonElement.style.background = "#c8e6c9";
    buttonElement.style.borderColor = "#4caf50";
    buttonElement.style.boxShadow = "0 0 8px rgba(76, 175, 80, 0.3)";

    this._scrollActionCardIntoView(buttonElement);

    if (this.recordManager) {
      this.recordManager.logAction(actionId, gestureIndex, stepId, {
        src: isRemote ? "remote" : "local",
      });
    }

    if (!isRemote && actionId) {
      const isPowerAction =
        actionId === ACTION_IDS.POWER_ON || actionId === ACTION_IDS.POWER_OFF;
      if (isPowerAction) {
        const experimentId = this._getExperimentId();
        const combinationId =
          this.currentCombination?.combinationId ||
          this.experimentCombinationManager?.getCurrentCombination?.()
            ?.combinationId ||
          "";
        const participantName = this._getParticipantName();
        experimentSyncManager.broadcastActionCompleted({
          actionId,
          experimentId,
          combinationId,
          participantName,
        });
      }
    }
  }

  _cancelActionCompletion(
    buttonElement,
    actionId,
    gestureIndex,
  ) {
    if (!buttonElement) return;

    buttonElement.setAttribute("data-completed", "false");
    buttonElement.style.background = "#e8eeff";
    buttonElement.style.borderColor = "#667eea";
    buttonElement.style.boxShadow = "";

    if (this.recordManager) {
      this.recordManager.logAction(
        `${actionId}_CANCELLED`,
        gestureIndex,
        null,
      );
    }
  }

  /**
   * 更新全選複選框的狀態
   */
  updateSelectAllState() {
    this.uiManager.updateSelectAllState();
  }

  updateUnitButtonStates() {
    const unitList = document.querySelector(
      "#unitsPanelContainer .experiment-units-list",
    );
    if (!unitList) return;

    const allItems = Array.from(
      unitList.querySelectorAll("li:not(.power-option-card)"),
    );

    allItems.forEach((li, index) => {
      const upBtn = li.querySelector(".unit-up-btn");
      const downBtn = li.querySelector(".unit-down-btn");

      if (upBtn) {
        upBtn.disabled = index === 0;
        upBtn.classList.toggle("disabled", index === 0);
      }
      if (downBtn) {
        downBtn.disabled = index === allItems.length - 1;
        downBtn.classList.toggle("disabled", index === allItems.length - 1);
      }
    });
  }

  onUnitSelectionChanged() {
    if (!this.experimentSystemManager?.syncUnitSelectionFromUi) {
      Logger.warn("Unit selection 已收斂至 ExperimentSystemManager，缺少入口");
      return;
    }

    this.experimentSystemManager.syncUnitSelectionFromUi();
    document.querySelectorAll(".combination-item").forEach((el) => {
      el.classList.remove("active");
    });
  }

  async startExperiment() {
    const validUnits = this.boardUIManager.getCheckedValidUnits();

    if (validUnits.length === 0) {
      Logger.warn("無法開始實驗：請至少選擇一個教學單元");
      return false;
    }

    let experimentId = this._getExperimentId();

    if (!experimentId) {
      Logger.warn("請輸入實驗ID");
      this.boardUIManager.focusExperimentIdInput();
      return false;
    }

    if (
      !this.currentCombination ||
      !this.currentCombination.gestures ||
      this.currentCombination.gestures.length === 0
    ) {
      Logger.warn("請先選擇實驗組合並載入手勢序列");
      return false;
    }

    let participantName = this._getParticipantName();

    if (!participantName) {
      participantName = this.participantName || "";
      Logger.debug("受試者名稱未填寫，使用空值繼續");
    }

    const unitOrder =
      this.experimentSystemManager?.getCurrentUnitIds?.().join("->") ||
      this.loadedUnits?.join("->") ||
      "";

    const experimentData = {
      experimentId: experimentId,
      participantName: participantName,
      combinationId: this.currentCombination.combinationId,
      combinationName: this.currentCombination.combinationName,
      unitCount: validUnits.length,
      unitOrder: unitOrder,
      gestureCount: this.currentCombination.gestures.length,
      startTime: new Date().toISOString(),
    };

    // 日誌初始化與面板切換統一由 Flow STARTED 事件處理
    this.pendingExperimentStartData = experimentData;

    experimentSyncManager.registerExperimentStateToHub({
      experiment_id: experimentData.experimentId,
      participantName: experimentData.participantName,
      combination_name: experimentData.combinationName,
      combination_id: experimentData.combinationId,
      gesture_count: experimentData.gestureCount,
      is_running: true,
    });

    const systemManager = this.experimentSystemManager;
    if (!systemManager?.startExperiment) {
      Logger.warn("ExperimentSystemManager 未就緒，無法啟動實驗");
      return false;
    }

    // Board 端強制手動結束：禁止流程自然完成時自動停止
    this.experimentFlowManager?.setDeferCompletion?.(true);

    const flowStarted = await systemManager.startExperiment();
    if (!flowStarted) {
      Logger.warn("實驗流程啟動失敗");
      this.pendingExperimentStartData = null;
      return false;
    }

    this.participantName = this._getParticipantName();
    this.lastSavedParticipantName = this.participantName;

    return true;
  }

  async stopExperiment(options = {}) {
    const systemManager = this.experimentSystemManager;
    if (!systemManager?.isExperimentRunning) {
      Logger.warn("ExperimentSystemManager 未就緒，無法停止實驗");
      return;
    }

    if (!systemManager.isExperimentRunning()) {
      return;
    }

    if (this.pendingExperimentIdUpdate) {
      this.syncIO?.receiveExperimentIdUpdate(this.pendingExperimentIdUpdate);
      this.pendingExperimentIdUpdate = null;
    }

    if (this.pendingParticipantNameUpdate) {
      this.syncIO?.receiveParticipantNameUpdate(this.pendingParticipantNameUpdate);
      this.pendingParticipantNameUpdate = null;
    }

    if (this.pendingCombinationUpdate) {
      const { currentCombination, loadedUnits } = this.pendingCombinationUpdate;
      await this.experimentSystemManager?.applyCombinationFromSync?.({
        combination: currentCombination,
        experimentId:
          this.experimentSystemManager?.getExperimentId?.() ||
          this.experimentId ||
          "",
      });
      this.currentCombination =
        this.experimentCombinationManager?.getCurrentCombination?.() ||
        currentCombination;
      if (loadedUnits) {
        this.loadedUnits = loadedUnits;
      }
      Logger.info(
        `套用等待中的組合更新: ${currentCombination?.combinationName || "未知組合"}`,
      );
      this.pendingCombinationUpdate = null;
    }

    const experimentData = {
      experiment_id: this._getExperimentId(),
      participant_name: this._getParticipantName(),
      combination: this.currentCombination?.combinationName || "",
      end_time: new Date().toISOString(),
    };

    this.logAction("experiment_stopped", experimentData);

    // stopExperiment() 同步觸發 STOPPED 事件 →
    // _handleFlowStopped 延遲重置手勢序列；ExperimentSystemManager._handleFlowStopped 停止計時器與寫入 EXP_END，
    // 之後 flushAll() 才能確保 EXP_END 已存在於 records
    systemManager.stopExperiment(options.reason || "manual", options);

    if (this.recordManager) {
      try {
        await this.recordManager.flushAll();
      } catch (error) {
        Logger.error("Board: 儲存實驗日誌失敗:", error);
      }
    }
  }

  resetCurrentCombinationRender() {
    this.timerManager?.destroy?.();
    this._lastCombinationRenderSignature = null;
    this._syncCombinationDetailRender();
    setTimeout(() => {
      document.querySelector(".right-panel")?.scrollTo({ top: 0, behavior: "smooth" });
    }, 50);
  }

  resetGestureSequenceForRecordSync() {
    // 實驗進行中/暫停中仍會持續 flush 記錄，不能在此重置 UI。
    if (this.experimentFlowManager?.isRunning) {
      Logger.debug("RecordView 刷新略過重置：實驗仍在進行中");
      return;
    }

    this.resetCurrentCombinationRender();

    // 同步右面板實驗控制按鈕至已停止狀態（顯示開始列，隱藏控制按鈕）
    this.experimentSystemManager?.resetControlsToStopped?.();

    Logger.debug("RecordView 刷新時已重置手勢序列顯示與右面板控制狀態");
  }

  /**
   * 暫停/繼續實驗 —帶過 FlowManager（統一驅動計時器、UI、同步廣播）
   */
  togglePauseExperiment() {
    if (!this.experimentRunning) return;
    const systemManager = this.experimentSystemManager;
    if (!systemManager?.togglePauseExperiment) {
      Logger.warn("ExperimentSystemManager 未就緒，無法切換暫停");
      return;
    }
    systemManager.togglePauseExperiment();
  }

  /** 設定受試者名稱監聽器 */
  setupParticipantNameListener() {
    this.boardUIManager.bindParticipantNameInput({
      onInitial: (name) => {
        this.participantName = name;
        this.lastSavedParticipantName = name;
      },
      onInput: (newValue) => {
        if (newValue !== this.lastSavedParticipantName) {
          this.participantName = newValue;
          this.lastSavedParticipantName = newValue;
          this.syncIO?.sendParticipantNameUpdate(newValue);
          this.logAction("participant_name_updated", {
            participant_name: newValue,
            timestamp: new Date().toISOString(),
          });
        }
      },
    });
  }

  /** 監聽遠端實驗狀態變化 */
  // 同步訊息接收與送出由 BoardSyncIO 負責。

  logAction(action, data) {
    const _logEntry = {
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      action: action,
      data: data,
    };

    Logger.debug("BoardPageManager logAction", _logEntry);
  }

  _bindExportGestureButton() {
    if (this._exportGestureBound) return;
    const btn = document.getElementById("exportGestureSequenceBtn");
    if (!btn) return;

    btn.addEventListener("click", () => this.exportGestureSequence());
    this._exportGestureBound = true;
  }

  exportGestureSequence() {
    try {
      if (!this.currentCombination) {
        this._showToast("請先選擇一個組合");
        return;
      }

      const gestures = this.currentCombination.gestures || [];
      if (gestures.length === 0) {
        this._showToast("沒有手勢序列資料");
        return;
      }

      const experimentIdInput = document.getElementById("experimentIdInput");
      const experimentId = experimentIdInput?.value || "N/A";
      const normalizedExperimentId = this._getExperimentId() || experimentId;

      const gestureTypes = gestures
        .map((g) => g.gesture || "?")
        .join(" ");
      const textContent = `${normalizedExperimentId} ${gestureTypes}`;

      navigator.clipboard
        .writeText(textContent)
        .then(() => {
          const btn = document.getElementById("exportGestureSequenceBtn");
          if (btn) {
            const originalHTML = btn.innerHTML;
            const originalBg = btn.style.background;
            btn.innerHTML = "✓ 已複製";
            btn.style.background = "#4caf50";

            setTimeout(() => {
              btn.innerHTML = originalHTML;
              btn.style.background = originalBg;
            }, 2000);
          }

          Logger.info("已複製手勢序列", textContent);
        })
        .catch((err) => {
          Logger.error("複製到剪貼簿失敗:", err);
          this._showToast("複製失敗，請查看控制台");
        });
    } catch (error) {
      Logger.error("匯出手勢序列失敗:", error);
      this._showToast("匯出失敗，請查看控制台");
    }
  }

  _showToast(message, type = "error") {
    const toast = document.createElement("div");
    toast.textContent = message;
    const colors = { error: "#f44336", success: "#4caf50", info: "#667eea" };
    Object.assign(toast.style, {
      position: "fixed", top: "20px", right: "20px", zIndex: "9999",
      padding: "12px 20px", borderRadius: "8px", fontFamily: "sans-serif",
      fontSize: "14px", color: "white", maxWidth: "320px",
      background: colors[type] || colors.error,
      boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
      transition: "opacity 0.3s",
    });
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = "0"; setTimeout(() => toast.remove(), 300); }, 3000);
  }
}

const boardPageManager = new BoardPageManager();
window.boardPageManager = boardPageManager;

const initializeBoard = async () => {
  try {
    await boardPageManager.initialize();
    Logger.debug("Board 頁面已自動初始化");
  } catch (error) {
    Logger.error("Board 頁面自動初始化失敗:", error);
  }
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeBoard);
} else {
  initializeBoard();
}

export { BoardPageManager, boardPageManager };
