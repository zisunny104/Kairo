/**
 * ExperimentSystemManager - 統一協調實驗系統
 *
 * 整合並協調 UI、組合、流程、Hub 等管理器，處理管理器間的
 * 事件串接與狀態同步，確保各模組正確互動與資料一致性。
 */

import {
  RECORD_SOURCES,
  SYNC_EVENTS,
  SYNC_ROLE_CONFIG,
  EXPERIMENT_HUB_CONSTANTS,
  EXPERIMENT_COMBINATION_EVENTS,
} from "../constants/index.js";
import { Logger } from "../core/console-manager.js";
import { experimentSyncManager } from "../board/board-experiment-sync.js";
import { generateExperimentId } from "../core/random-utils.js";
import ExperimentActionHandler from "./experiment-action-handler.js";
import ExperimentFlowManager from "./experiment-flow-manager.js";

class ExperimentSystemManager {
  /**
   * 建構函式
   * @param {Object} config - 設定選項
   */
  constructor(config = {}) {
    this.combinationManager = config.combinationManager;
    this.uiManager = config.uiManager;
    this.hubManager = config.hubManager;
    this.flowManager = config.flowManager;
    this.timerManager = config.timerManager;
    this.pageManager = config.pageManager || null;
    this.actionHandler = config.actionHandler || null;
    this.recordManager = config.recordManager || null;

    this.state = {
      initialized: false,
      containers: {
        combinationSelector: null,
        unitPanel: null,
        experimentControls: null,
      },
      uiInitialized: {
        combinationSelector: false,
        unitPanel: false,
        experimentControls: false,
      },
    };

    this._unsubscribers = [];
    this._experimentIdUiSyncBound = false;

    Logger.debug("ExperimentSystemManager 已建立");
  }

  /**
   * 初始化系統管理器
   */
  async initialize() {
    if (this.state.initialized) {
      return;
    }

    const initStart = performance.now();

    try {
      if (!this.combinationManager) {
        throw new Error("ExperimentCombinationManager is a required dependency");
      }
      if (!this.uiManager) {
        throw new Error("ExperimentUIManager is a required dependency");
      }

      this._initializeActionHandler();
      this._setupEventListeners();

      await this.combinationManager.ready();
      const currentCombo = this.combinationManager.getCurrentCombination();
      if (currentCombo) {
        Logger.debug("初始化同步預設組合狀態:", currentCombo.combinationName);
      }

      this.state.initialized = true;
      const duration = performance.now() - initStart;
      Logger.debug(
        `系統管理器初始化完成 (<orange>${duration.toFixed(0)} ms</orange>)`,
      );
    } catch (error) {
      Logger.error(
        "系統管理器初始化失敗:",
        error instanceof Error ? error.message : String(error),
      );
      if (error instanceof Error) {
        Logger.error("堆棧:", error.stack);
      }
      throw error;
    }
  }

  /**
   * 清理所有事件監聽器，供重新初始化或銷毀時使用
   */
  cleanup() {
    this._unsubscribers.forEach((unsub) => {
      try { unsub(); } catch (e) {
        Logger.warn("ExperimentSystemManager cleanup 失敗:", e);
      }
    });
    this._unsubscribers = [];

    if (this._experimentIdUiSyncBound) {
      window.removeEventListener("focus", this._syncFromSystemHandler);
      document.removeEventListener("visibilitychange", this._visibilityHandler);
      this._syncFromSystemHandler = null;
      this._visibilityHandler = null;
      this._experimentIdUiSyncBound = false;
    }

    this.state.initialized = false;
  }

  /**
   * 初始化動作處理器
   * @private
   */
  _initializeActionHandler() {
    let actionHandler = this.actionHandler;
    if (!actionHandler) {
      actionHandler = new ExperimentActionHandler({
        enableRemoteSync: true,
        enableGestureValidation: true,
      });
    }

    this.flowManager.injectDependencies({ actionHandler });
    actionHandler.injectFlowManager(this.flowManager);
    actionHandler.updateDependencies({
      experimentSystemManager: this,
      syncClient: this.pageManager?.syncManager?.core?.syncClient || null,
    });
    this.actionHandler = actionHandler;
  }

  /**
   * 初始化 UI 元件
   * @param {Object} containers - 容器元素選擇器
   * @param {Object} scriptData - 腳本數據
   */
  async initializeUI(containers = {}, scriptData = null) {
    if (!this.state.initialized) {
      throw new Error("系統管理器尚未初始化，請先呼叫 initialize()");
    }
    this.state.containers = { ...containers };
    this.state.scriptData = scriptData;

    if (containers.combinationSelector) {
      await this._initializeCombinationSelector(containers.combinationSelector);
    }

    if (containers.unitPanel && scriptData?.units) {
      await this._initializeUnitPanel(containers.unitPanel, scriptData.units);
    }

    if (containers.experimentControls) {
      await this._initializeExperimentControls(containers.experimentControls);
    }

    const currentCombo = this.combinationManager.getCurrentCombination();
    const currentUnitIds = this.combinationManager.getCurrentUnitIds();
    if (currentCombo && currentUnitIds.length > 0) {
      Logger.debug(
        `【<cyan>排序追蹤</cyan>】<blue>initializeUI</blue> 自動初始化 [組合: ${currentCombo.combinationName}] [順序: ${currentUnitIds.join("→")}]`,
        { 來源: "initializeUI", combinationId: currentCombo.combinationId, combinationName: currentCombo.combinationName, unitIds: currentUnitIds },
      );
      this._updateUIForCombination(currentCombo, currentUnitIds);
      Logger.debug("已套用目前組合到UI:", currentCombo.combinationName);
    }

    await this._initializeExperimentId();

    Logger.debug("UI 元件初始化完成");
  }

  /**
   * 初始化組合選擇器
   * @private
   */
  async _initializeCombinationSelector(container) {
    const combinations = this.combinationManager.getAvailableCombinations();

    if (combinations.length === 0) {
      Logger.warn("沒有可用的組合");
      return;
    }

    const combosForUI = combinations.map((c) => ({
      id: c.combinationId,
      name: c.combinationName,
      description: c.description || "",
    }));

    const currentCombo = this.combinationManager.getCurrentCombination();
    const activeId = currentCombo?.combinationId ?? null;

    Logger.debug("初始化組合選擇器", {
      currentCombo: currentCombo?.combinationName,
      activeId,
      combinations: combinations.length,
    });

    const rendered = this.uiManager.renderCombinationSelector(container, combosForUI, {
      activeId,
      showTitle: true,
      title: "單元組合",
      onSelect: async (combinationId) => {
        if (!combinationId) {
          Logger.warn("未收到有效的組合ID，忽略選擇事件");
          return;
        }
        await this.selectCombination(combinationId);
      },
    });

    Logger.debug("組合選擇器已初始化");
    if (rendered) {
      this.state.uiInitialized.combinationSelector = true;
    }
  }

  /**
   * 初始化單元面板
   * @private
   * @param {string} container - 容器選擇器
   * @param {Array} units - 單元數據
   */
  async _initializeUnitPanel(container, units) {
    const currentUnitIds = this.combinationManager.getCurrentUnitIds();
    const preparedUnits = units.map((unit) => {
      const prepared = {
        id: unit.unit_id,
        title: unit.unit_name || unit.unit_id,
        stepCount: unit.steps ? unit.steps.length : 0,
        checked: currentUnitIds.includes(unit.unit_id),
      };

      Logger.debug(`準備單元數據: ${prepared.id}`, prepared);
      return prepared;
    });

    const rendered = this.uiManager.renderUnitsPanel(
      container,
      preparedUnits,
      currentUnitIds,
      {
        showHeader: true,
        headerTitle: "教學單元",
        showSelectAll: true,
        showPowerOptions: true,
        includeStartup: true,
        includeShutdown: true,
        enableSorting: true,
        onUnitToggle: (event) => {
          this._handleUnitToggle(event);
        },
        onReorder: (fromIndex, toIndex) => {
          this._handleUnitReorder(fromIndex, toIndex);
        },
      },
    );

    this._applyPowerOptionsToUi(
      this.combinationManager.normalizePowerOptions(
        this.combinationManager.getCurrentCombination()?.powerOptions,
      ),
    );
    this._bindPowerOptionListeners();

    requestAnimationFrame(() => this._tryCallPageManager("updateSelectAllState"));

    Logger.debug("單元面板已初始化");
    if (rendered) {
      this.state.uiInitialized.unitPanel = true;
    }
  }

  /**
   * 初始化實驗控制面板
   * @private
   */
  async _initializeExperimentControls(container) {
    const experimentId = this.hubManager.getExperimentId();

    const rendered = this.uiManager.renderExperimentControls(container, {
      showExperimentId: true,
      showParticipantName: true,
      showTimer: true,
      experimentId: experimentId,
      onStart: () => this._handleExperimentStart(),
      onPause: () => this._handleExperimentPause(),
      onResume: () => this._handleExperimentResume(),
      onStop: () => this._handleExperimentStop(),
      onRegenerateId: () => this.regenerateExperimentId(),
    });

    Logger.debug("實驗控制面板已初始化");
    if (rendered) {
      this.state.uiInitialized.experimentControls = true;
    }
  }

  /**
   * 選擇組合
   * @param {string} combinationId - 組合ID
   */
  async selectCombination(combinationId) {
    try {
      const combination =
        this.combinationManager.getCombinationById(combinationId);
      if (!combination) {
        throw new Error(`找不到組合: ${combinationId}`);
      }

      const experimentId = this.getExperimentId();
      const combinationWithOptions = {
        ...combination,
        powerOptions: this._getPowerOptionsFromUi(),
      };
      const success = await this.combinationManager.setCombination(
        combinationWithOptions,
        experimentId,
      );

      if (success) {
        Logger.debug(`組合已切換: ${combination.combinationName}`);
      } else {
        Logger.error(`組合切換失敗: ${combinationId}`);
      }

      return success;
    } catch (error) {
      Logger.error("選擇組合失敗:", error);
      return false;
    }
  }

  /**
   * 設定事件監聽器，所有訂閱均收入 _unsubscribers 供 cleanup() 使用
   * @private
   */
  _setupEventListeners() {
    const sub = (fn) => this._unsubscribers.push(fn);

    sub(this.combinationManager.on(EXPERIMENT_COMBINATION_EVENTS.COMBINATION_SELECTED, (data) => {
      this._handleCombinationSelected(data);
    }));

    sub(this.flowManager.on(ExperimentFlowManager.EVENT.STARTED, () => this._handleFlowStarted()));
    sub(this.flowManager.on(ExperimentFlowManager.EVENT.PAUSED, () => this._handleFlowPaused()));
    sub(this.flowManager.on(ExperimentFlowManager.EVENT.RESUMED, () => this._handleFlowResumed()));

    sub(this.flowManager.on(ExperimentFlowManager.EVENT.STOPPED, (data) => {
      this._handleFlowStopped(data);
    }));

    sub(this.flowManager.on(ExperimentFlowManager.EVENT.COMPLETED, (data) => {
      this._handleFlowStopped({
        reason: data?.reason || "completed",
        completedUnits: data?.completedUnits,
        timestamp: data?.timestamp,
      });
    }));

    const onPanelOpened = () => this.refreshPanelUi();
    window.addEventListener("panel:experiment:opened", onPanelOpened);
    sub(() => window.removeEventListener("panel:experiment:opened", onPanelOpened));

    if (this.hubManager?.on) {
      sub(this.hubManager.on(EXPERIMENT_HUB_CONSTANTS.EVENT.ID_CHANGED, (data) => {
        this._handleHubIdChanged(data);
      }));
    }

    sub(this.uiManager.on("experiment-controls-rendered", () => {
      this._bindExperimentIdInputListener();
    }));

    const onCombinationSelected = (event) => this._handleRemoteCombinationSelected(event?.detail);
    window.addEventListener(SYNC_EVENTS.COMBINATION_SELECTED, onCombinationSelected);
    sub(() => window.removeEventListener(SYNC_EVENTS.COMBINATION_SELECTED, onCombinationSelected));
  }

  /**
   * 處理 Hub Manager 實驗 ID 變化事件
   * 當其他客戶端改變實驗 ID 時觸發
   * @private
   */
  async _handleHubIdChanged(data) {
    const { type, newValue, source } = data;

    if (type !== "experiment") {
      Logger.debug("Hub ID 變化但不是實驗 ID，忽略:", type);
      return;
    }

    const isExperimentRunning = this.flowManager.isRunning;

    if (isExperimentRunning) {
      Logger.debug(
        "實驗進行中，實驗 ID 變化被忽略 (來自:",
        source,
        ", 新 ID:",
        newValue,
        ")",
      );
      return;
    }

    Logger.debug("【ID 變化】實驗 ID 已從遠端改變，更新 UI 並等待面板打開", {
      source,
      newValue,
    });

    await this.handleSyncExperimentIdUpdate({ experimentId: newValue });
  }

  /**
   * 將系統持有的實驗 ID 同步到 UI 輸入框
   * @private
   */
  _syncExperimentIdToUI() {
    const idInput = document.getElementById("experimentIdInput");
    if (!idInput) return;
    const currentId = this.getExperimentId() ?? "";
    if (idInput.value.trim() !== currentId) {
      idInput.value = currentId;
    }
  }

  /**
   * 綁定實驗ID輸入框監聽器（可重入，避免重複綁定）
   * @private
   */
  _bindExperimentIdInputListener() {
    const idInput = document.getElementById("experimentIdInput");
    if (!idInput) return;

    if (!idInput._experimentSystemBound) {
      this._setupExperimentIdInputListener(idInput);
      Logger.debug("實驗ID輸入框事件監聽已綁定");
    }

    this._syncExperimentIdToUI();
  }

  /**
   * 處理組合選擇事件
   * @private
   */
  _handleCombinationSelected(data) {
    const { combination, unitIds, experimentId } = data;
    // CombinationManager 已持有 currentCombination / loadedUnits，此處只需協調 UI 與廣播
    const normalizedPowerOptions = this.combinationManager.normalizePowerOptions(
      combination?.powerOptions,
    );

    this._applyPowerOptionsToUi(normalizedPowerOptions);

    Logger.debug(
      `【<cyan>排序追蹤</cyan>】<blue>組合選擇</blue> [組合: ${combination?.combinationName}] [順序: ${(unitIds || []).join("→")}]`,
      { 來源: "combination:selected 事件", combinationId: combination?.combinationId, combinationName: combination?.combinationName, unitIds: [...(unitIds || [])] },
    );

    this._updateUIForCombination(combination, unitIds);

    window.dispatchEvent(
      new CustomEvent("experimentSystem:combinationSelected", {
        detail: { combination, experimentId: experimentId || this.getExperimentId() },
      }),
    );

    Logger.debug("組合選擇事件已處理:", combination.combinationName);
  }

  _handleRemoteCombinationSelected(detail) {
    if (!detail || detail.source !== RECORD_SOURCES.SYNC_BROADCAST) return;
    const combination = detail.combination;
    if (!combination) { Logger.warn("遠端組合資料缺失，忽略同步"); return; }
    if (this.flowManager?.isRunning) { Logger.debug("實驗進行中，忽略遠端組合同步"); return; }

    const cm = this.combinationManager;
    const normalizedPowerOptions = cm.normalizePowerOptions(combination.powerOptions);
    this._applyPowerOptionsToUi(normalizedPowerOptions);
    cm.setCombination(
      { ...combination, powerOptions: normalizedPowerOptions },
      detail.experimentId || this.getExperimentId(),
      { skipBroadcast: true, skipCache: combination.combinationId === "custom" },
    );
  }

  /**
   * 更新 UI 以符合組合（委派給 UIManager）
   * @private
   */
  _updateUIForCombination(combination, unitIds) {
    if (this.state.containers.combinationSelector) {
      const containerEl = document.querySelector(this.state.containers.combinationSelector);
      if (containerEl) {
        this.uiManager.updateCombinationSelection(containerEl, combination.combinationId);
      }
    }
    if (this.state.containers.unitPanel) {
      this.uiManager.applyUnitCombinationToPanel(
        this.state.containers.unitPanel,
        unitIds,
        { combinationName: combination?.combinationName, combinationId: combination?.combinationId },
      );
      requestAnimationFrame(() => {
        this._tryCallPageManager("updateSelectAllState");
        this._tryCallPageManager("updateUnitButtonStates");
      });
    }
  }

  /**
   * 處理單元面板切換事件
   * @private
   */
  _handleUnitToggle(event) {
    const selectedUnitIds = this._getUnitIdsFromUi({ onlyChecked: true });
    this._applyCustomUnitSelection(selectedUnitIds);
    requestAnimationFrame(() => this._tryCallPageManager("updateSelectAllState"));
  }

  /**
   * 處理單元面板重新排序事件
   * @private
   * UI reorder 已由 Renderer 處理 DOM 結構，此處只需同步實驗狀態與控件顯示。
   */
  _handleUnitReorder(fromIndex, toIndex) {
    Logger.debug("單元重新排序:", { fromIndex, toIndex });
    const selectedUnitIds = this._getUnitIdsFromUi({ onlyChecked: true });
    this._applyCustomUnitSelection(selectedUnitIds);
    this._tryCallPageManager("updateUnitButtonStates");
    this._tryCallPageManager("updateSelectAllState");
  }

  syncUnitSelectionFromUi() {
    const selectedUnitIds = this._getUnitIdsFromUi({ onlyChecked: true });
    if (!selectedUnitIds.length) return false;
    this._applyCustomUnitSelection(selectedUnitIds, { forceBroadcast: true });
    this._tryCallPageManager("updateUnitButtonStates");
    this._tryCallPageManager("updateSelectAllState");
    return true;
  }

  /**
   * 可供外部呼叫，委派給 CombinationManager.applyCustomSelection
   * @public
   */
  applyCustomUnitSelection(unitIds = [], options = {}) {
    return this._applyCustomUnitSelection(unitIds, options);
  }

  /**
   * 將自訂單元選擇套用到 CombinationManager
   * @private
   */
  _applyCustomUnitSelection(unitIds = [], options = {}) {
    return this.combinationManager.applyCustomSelection(unitIds, {
      ...options,
      experimentId: this.getExperimentId(),
      powerOptions: options.powerOptions || this._getPowerOptionsFromUi(),
    });
  }

  _getPowerOptionsFromUi() {
    return this.uiManager.getPowerOptionsFromUi();
  }

  _applyPowerOptionsToUi(options = {}) {
    this.uiManager.applyPowerOptionsToUi(options);
  }

  _bindPowerOptionListeners() {
    this.uiManager.bindPowerOptionListeners(() => this._handlePowerOptionsChanged());
  }

  _handlePowerOptionsChanged() {
    const selectedUnitIds = this._getUnitIdsFromUi({ onlyChecked: true });
    this._applyCustomUnitSelection(selectedUnitIds, {
      forceBroadcast: true,
      powerOptions: this._getPowerOptionsFromUi(),
    });
  }

  _getUnitIdsFromUi({ onlyChecked = false } = {}) {
    return this.uiManager.getUnitIdsFromUi({
      onlyChecked,
      containerSelector: this.state.containers?.unitPanel ?? null,
    });
  }

  _getFlow() {
    return this.flowManager ?? null;
  }

  getFlowProgressSnapshot() {
    const flow = this._getFlow();
    if (!flow) {
      return {
        currentUnitIndex: -1,
        totalUnits: 0,
        unitIds: [],
        isLastUnit: false,
      };
    }

    const progress = flow.getProgress?.() || null;
    const unitIds =
      flow.getUnitList?.() ||
      (Array.isArray(flow.loadedUnits) ? [...flow.loadedUnits] : []);
    const currentUnitIndex = progress?.currentUnitIndex ?? flow.currentUnitIndex ?? -1;
    const totalUnits = progress?.totalUnits ?? unitIds.length;
    const isLastUnit = totalUnits > 0 && currentUnitIndex >= totalUnits - 1;

    return {
      currentUnitIndex,
      totalUnits,
      unitIds,
      isLastUnit,
    };
  }

  getScriptUnits() {
    const units = this.state.scriptData?.units;
    return Array.isArray(units) ? units : [];
  }

  getCurrentCombination() {
    return this.combinationManager?.getCurrentCombination?.() || null;
  }

  getCurrentUnitIds() {
    return this.combinationManager?.getCurrentUnitIds?.() || [];
  }

  getCurrentPowerOptions() {
    const combo = this.getCurrentCombination();
    return this.combinationManager.normalizePowerOptions(combo?.powerOptions);
  }

  advanceToNextUnit() {
    return this._getFlow()?.nextUnit?.() || false;
  }

  advanceToNextStep() {
    return this._getFlow()?.nextStep?.() || false;
  }

  getCurrentAction() {
    return this.actionHandler?.getCurrentAction?.() || null;
  }

  completeCurrentAction(actionData = {}) {
    return this.actionHandler?.completeCurrentAction?.(actionData) || false;
  }

  handleCorrectAction(actionId, actionData = {}) {
    return this.actionHandler?.handleCorrectAction?.(actionId, actionData) || false;
  }

  isExperimentRunning() {
    return this.flowManager?.isRunning ?? false;
  }

  async startExperiment(options = {}) {
    const flow = this._getFlow();
    if (!flow) {
      throw new Error("ExperimentFlowManager 不可用，無法開始實驗");
    }

    let experimentId = this.getExperimentId();
    if (!experimentId) {
      Logger.warn("缺少實驗ID，嘗試自動產生");
      experimentId = await this.regenerateExperimentId();
    }

    if (!experimentId) {
      Logger.error("無法開始實驗：實驗ID仍為空值");
      return false;
    }

    Logger.debug("【<green>實驗啟動</green>】開始執行實驗", {
      experimentId,
      options,
    });

    return flow.startExperiment(options);
  }

  pauseExperiment(options = {}) {
    return this._getFlow()?.pauseExperiment?.(options) || false;
  }

  resumeExperiment(options = {}) {
    return this._getFlow()?.resumeExperiment?.(options) || false;
  }

  togglePauseExperiment() {
    const flow = this._getFlow();
    if (!flow?.isRunning) return false;
    return flow.isPaused ? this.resumeExperiment() : this.pauseExperiment();
  }

  stopExperiment(...args) {
    return this._getFlow()?.stopExperiment?.(...args) || false;
  }

  async startExperimentFromSync(syncData = {}) {
    const remoteComboId = syncData?.combinationId;
    const currentCombo = this.combinationManager.getCurrentCombination();

    if (
      remoteComboId &&
      (!currentCombo || currentCombo.combinationId !== remoteComboId)
    ) {
      Logger.info(`[ExperimentSystem] 組合不一致，同步遠端組合: ${remoteComboId}`);
      await this.selectCombination(remoteComboId).catch((err) =>
        Logger.warn("[ExperimentSystem] 設定遠端組合失敗:", err),
      );
    }

    if (this.isExperimentRunning()) {
      Logger.debug("[ExperimentSystem] 實驗已在進行中，略過同步啟動");
      return false;
    }

    return this.startExperiment({ broadcast: false, source: "sync" });
  }

  async handleSyncExperimentStart(syncData = {}) {
    await this.handleSyncExperimentIdUpdate(syncData);
    this.handleSyncParticipantNameUpdate(syncData);

    if (!this.isExperimentRunning()) {
      return this.startExperimentFromSync(syncData);
    }
    Logger.debug("[ExperimentSystem] 實驗已在進行中，忽略遠端開始請求");
    return false;
  }

  handleSyncExperimentPaused(syncData = {}) {
    if (!this.isExperimentRunning() || this._getFlow()?.isPaused) return false;
    return this.pauseExperiment({ ...syncData, broadcast: false, source: "sync" });
  }

  handleSyncExperimentResumed(syncData = {}) {
    if (!this.isExperimentRunning() || !this._getFlow()?.isPaused) return false;
    return this.resumeExperiment({ ...syncData, broadcast: false, source: "sync" });
  }

  handleSyncExperimentStopped(syncData = {}) {
    if (!this.isExperimentRunning()) return false;
    return this.stopExperiment({ reason: syncData.reason || "sync", broadcast: false, source: "sync" });
  }

  async handleSyncExperimentIdUpdate(syncData = {}) {
    const { experimentId, _sessionRestore } = syncData;
    if (!experimentId) return false;

    const currentId = this.getExperimentId();

    // session restore 時以同步端優先，無條件套用（即使 ID 相同也要確保 stateManager 正確）。
    // 非 restore 情況才做去重判斷，避免重複廣播。
    if (!_sessionRestore && currentId === experimentId) return false;

    Logger.debug("【<blue>SYNC</blue>】同步實驗 ID 更新", {
      currentId,
      experimentId,
      _sessionRestore: !!_sessionRestore,
    });

    await this.setExperimentId(experimentId, RECORD_SOURCES.SYNC_BROADCAST, {
      registerToHub: false,
      broadcast: false,
      reapplyCombination: true,
      skipCombinationBroadcast: true,
    });

    // session restore 後將 ID 持久化至 localStorage，
    // 避免舊值殘留造成下次頁面載入時的落差。
    if (_sessionRestore) {
      this.hubManager?.saveIds?.();
    }

    return true;
  }

  async applyCombinationFromSync(syncData = {}) {
    const combination = syncData?.combination || syncData?.currentCombination;
    if (!combination) return false;
    if (this.isExperimentRunning()) {
      Logger.debug("實驗進行中，略過遠端組合同步套用");
      return false;
    }

    const normalizedPowerOptions = this.combinationManager.normalizePowerOptions(
      combination.powerOptions,
    );
    this._applyPowerOptionsToUi(normalizedPowerOptions);
    const normalizedCombination = { ...combination, powerOptions: normalizedPowerOptions };

    const experimentId =
      syncData?.experimentId ||
      this.getExperimentId() ||
      null;

    return this.combinationManager.setCombination(
      normalizedCombination,
      experimentId,
      {
        skipBroadcast: true,
        skipCache: normalizedCombination.combinationId === "custom",
      },
    );
  }

  handleSyncParticipantNameUpdate(syncData = {}) {
    const { participantName } = syncData;
    if (!participantName) return false;
    return this.setParticipantName(participantName);
  }

  /**
   * 處理實驗開始事件
   * @private
   */
  async _handleExperimentStart() {
    try {
      await this.startExperiment();
    } catch (error) {
      Logger.error("實驗開始失敗:", error);
      return;
    }
    Logger.debug("實驗開始 - 透過 ExperimentSystemManager");
    this.uiManager._handleExperimentStart();
  }

  /**
   * 處理實驗暫停事件
   * @private
   */
  _handleExperimentPause() {
    this.pauseExperiment();
    Logger.debug("實驗暫停 - 透過 ExperimentSystemManager");
  }

  /**
   * 處理實驗繼續事件
   * @private
   */
  _handleExperimentResume() {
    this.resumeExperiment();
    Logger.debug("實驗繼續 - 透過 ExperimentSystemManager");
  }

  /**
   * 處理實驗停止事件
   * @private
   */
  _handleExperimentStop() {
    const stopEvent = new CustomEvent("experimentSystem:stopRequested", {
      detail: { reason: "manual", broadcast: true, source: "ui" },
      cancelable: true,
    });
    window.dispatchEvent(stopEvent);
    if (!stopEvent.defaultPrevented) {
      this.stopExperiment({ reason: "manual", broadcast: true, source: "ui" });
    }
    Logger.debug("實驗停止請求已發出，若無 pageManager 處理則直接停止流程");
  }

  /**
   * 以目前實驗ID重新計算組合的單元排序並更新UI
   * @private
   */
  async _reapplyCombinationWithCurrentId({ skipBroadcast = false } = {}) {
    const combo = this.combinationManager.getCurrentCombination();
    if (!combo) { Logger.warn("沒有目前組合，跳過重新套用"); return; }

    const experimentId = this.getExperimentId();
    const newUnitIds = this.combinationManager.getCombinationUnitIds(combo, experimentId) || [];
    const currentUnitIds = this.combinationManager.getCurrentUnitIds();

    if (this.combinationManager.isSameUnitOrder(newUnitIds, currentUnitIds)) return;

    Logger.debug("以新實驗ID重新計算單元排序:", { experimentId, unitIds: newUnitIds });

    this.combinationManager.handleExperimentIdChanged(experimentId, { skipBroadcast });
  }

  // ==========================================
  // 實驗ID 生命週期管理
  // ==========================================

  /**
   * 同步實驗 ID 到所有管理器
   * @param {string} newId
   * @param {string} source
   */
  _applyExperimentIdToManagers(newId, source) {
    const stateManager = this.pageManager?.experimentStateManager;
    if (stateManager?.setExperimentId) {
      stateManager.setExperimentId(newId, source);
    }

    if (this.hubManager?.setExperimentId) {
      this.hubManager.setExperimentId(newId, source, { silent: true });
    }
  }

  getExperimentId() {
    // StateManager 是唯一 truth source；
    // 同步模式下 HubManager 可能更先取得 ID，作為 fallback。
    return (
      this.pageManager?.experimentStateManager?.getExperimentId() ||
      this.hubManager?.getExperimentId?.() ||
      null
    );
  }

  getParticipantName() {
    return (
      this.pageManager?.experimentStateManager?.getParticipantName() ||
      document.getElementById("participantNameInput")?.value?.trim() ||
      null
    );
  }

  _bindExperimentIdUiSyncGuards() {
    if (this._experimentIdUiSyncBound) {
      return;
    }

    this._syncFromSystemHandler = () => this._syncExperimentIdToUI();
    this._visibilityHandler = () => {
      if (document.visibilityState === "visible") {
        this._syncFromSystemHandler();
      }
    };
    window.addEventListener("focus", this._syncFromSystemHandler);
    document.addEventListener("visibilitychange", this._visibilityHandler);

    this._experimentIdUiSyncBound = true;
  }

  /**
   * 設定實驗ID並更新 UI、中樞、廣播
   * @param {string} newId - 新的實驗ID
   * @param {string} source - 日誌來源標籤
   * @param {Object} options - 選項
   * @param {boolean} options.registerToHub - 是否註冊到中樞（預設依同步模式決定）
   * @param {boolean} options.broadcast - 是否廣播（預設 true）
   * @param {boolean} options.reapplyCombination - 是否重新套用組合排序（預設 true）
   */
  async setExperimentId(newId, source = RECORD_SOURCES.LOCAL_GENERATE, options = {}) {
    const {
      registerToHub = undefined,
      broadcast = true,
      reapplyCombination = true,
      skipCombinationBroadcast = false,
    } = options;

    if (!newId || typeof newId !== "string" || !newId.trim()) {
      Logger.warn("setExperimentId: 無效的實驗ID");
      return false;
    }

    newId = newId.trim();
    Logger.debug("設定實驗ID:", newId);

    this._applyExperimentIdToManagers(newId, source);

    const isSync = this.hubManager?.isInSyncMode?.() || false;
    const registerFlag = registerToHub === undefined
      ? true
      : Boolean(registerToHub);
    const shouldRegister =
      registerFlag &&
      isSync &&
      source !== RECORD_SOURCES.SYNC_BROADCAST &&
      source !== RECORD_SOURCES.HUB_SYNC;
    if (shouldRegister) {
      try {
        if (this.hubManager?.registerExperimentId) {
          await this.hubManager.registerExperimentId(newId);
          Logger.debug("實驗ID已註冊到中樞");
        } else {
          Logger.warn(
            "ExperimentHubManager 不可用，無法註冊實驗ID到中樞",
          );
        }
      } catch (error) {
        Logger.warn("註冊實驗ID到中樞失敗:", error);
      }
    }

    const shouldBroadcast = broadcast && !(isSync && shouldRegister);
    if (shouldBroadcast) {
      experimentSyncManager.broadcastExperimentIdUpdate(newId);
    }

    this._syncExperimentIdToUI();

    if (reapplyCombination) {
      await this._reapplyCombinationWithCurrentId({ skipBroadcast: skipCombinationBroadcast });
    }

    return true;
  }

  setParticipantName(participantName) {
    if (typeof participantName !== "string") return false;
    const normalized = participantName.trim();

    // StateManager 是 truth source，dispatch 事件後 UIManager._setupStateInputSync 同步到輸入框
    this.pageManager?.experimentStateManager?.setParticipantName?.(normalized, "system");

    window.dispatchEvent(
      new CustomEvent("experimentSystem:participantNameChanged", {
        detail: { participantName: normalized },
      }),
    );
    return true;
  }

  refreshPanelUi() {
    const { combinationSelector, unitPanel, experimentControls } =
      this.state.containers || {};

    if (combinationSelector && !this.state.uiInitialized.combinationSelector) {
      this._initializeCombinationSelector(combinationSelector);
    }

    if (unitPanel && !this.state.uiInitialized.unitPanel) {
      if (this.state.scriptData?.units) {
        this._initializeUnitPanel(unitPanel, this.state.scriptData.units);
      }
    }

    if (experimentControls && !this.state.uiInitialized.experimentControls) {
      this._initializeExperimentControls(experimentControls);
      const idInput = document.getElementById("experimentIdInput");
      if (idInput) {
        this._setupExperimentIdInputListener(idInput);
      }
    }

    this._applyPendingUiUpdates();

    const combo = this.combinationManager.getCurrentCombination();
    const unitIds = this.combinationManager.getCurrentUnitIds();
    if (combo && unitIds.length > 0) {
      requestAnimationFrame(() => this._updateUIForCombination(combo, unitIds));
    }

  }

  _applyPendingUiUpdates() {
    this._syncExperimentIdToUI();

    // 從 StateManager 讀取受試者名稱，同步到輸入框（若面板尚未渲染則略過）
    const participantName = this.pageManager?.experimentStateManager?.getParticipantName?.();
    if (participantName) {
      const input = document.getElementById("participantNameInput");
      if (input && input.value.trim() !== participantName) {
        input.value = participantName;
      }
    }

    const combo = this.combinationManager.getCurrentCombination();
    const unitIds = this.combinationManager.getCurrentUnitIds();
    if (combo && unitIds.length > 0) {
      this._updateUIForCombination(combo, unitIds);
    }
  }

  /**
   * 產生新的實驗ID（自動處理同步/廣播/組合排序）
   * @returns {string} 新產生的實驗ID
   */
  async regenerateExperimentId() {
    Logger.debug("重新產生實驗ID");

    // 同步模式下先檢查 Hub 是否已有 experimentId
    const hubManager = this.hubManager;
    const isSync = hubManager?.isInSyncMode?.() || false;

    if (isSync) {
      try {
        const hubId = hubManager.getExperimentId();
        const currentId = this.getExperimentId();
        if (hubId) {
          if (currentId !== hubId) {
            Logger.debug(`同步到中樞ID: ${hubId}`);
            await this.setExperimentId(hubId, RECORD_SOURCES.HUB_SYNC, {
              broadcast: false,
              reapplyCombination: true,
            });
            return hubId;
          }
          Logger.debug("同步模式下已存在相同 Hub ID，繼續產生新實驗ID");
        }
      } catch (error) {
        Logger.warn("取得中樞ID失敗，產生新ID:", error);
      }
    }

    const newId = generateExperimentId();
    await this.setExperimentId(newId, RECORD_SOURCES.LOCAL_GENERATE);
    Logger.debug("新實驗ID已產生:", newId);
    return newId;
  }

  /**
   * 初始化實驗ID：4步優先順序解析 + 事件綁定
   * 優先順序：中樞同步 > localStorage快取 > 已有輸入值 > 產生新ID
   * @private
   */
  async _initializeExperimentId() {
    let experimentId = null;
    const isSync = this.hubManager?.isInSyncMode?.() || false;

    if (isSync) {
      try {
        experimentId = await this.hubManager.getExperimentId();
        if (experimentId) {
          Logger.debug(`實驗ID來源：中樞 (${experimentId})`);
        }
      } catch (error) {
        Logger.warn("中樞讀取失敗:", error.message);
      }
    }

    if (!experimentId && this.hubManager) {
      const cachedId = this.hubManager.getExperimentId();
      if (cachedId) {
        experimentId = cachedId;
        Logger.debug(`實驗ID來源：localStorage 快取 (${experimentId})`);
      }
    }

    const idInput = document.getElementById("experimentIdInput");
    if (!experimentId && idInput) {
      const inputVal = idInput.value.trim();
      const isInvalidStr = inputVal === "null" || inputVal === "undefined" || inputVal === "載入中...";
      if (inputVal && !isInvalidStr) {
        experimentId = inputVal;
        Logger.debug(`實驗ID來源：輸入框 (${experimentId})`);
      }
    }

    if (!experimentId) {
      experimentId = generateExperimentId();
      Logger.debug(`實驗ID來源：新產生 (${experimentId})`);
    }

    // 只有 operator 才有資格向 Hub 登記或廣播初始 ID，
    // 避免 viewer/board 搶先以本地產生的 ID 覆蓋 Hub 狀態。
    const role = this.hubManager?.getRole?.();
    const isOperator = !role || role === SYNC_ROLE_CONFIG.OPERATOR;
    await this.setExperimentId(
      experimentId,
      RECORD_SOURCES.LOCAL_INITIALIZE,
      {
        registerToHub: isOperator,
        broadcast: isSync && isOperator,
        reapplyCombination: false,
      },
    );

    this._syncExperimentIdToUI();
    this._bindExperimentIdUiSyncGuards();

    if (idInput) {
      this._setupExperimentIdInputListener(idInput);
    } else {
      Logger.debug(
        "experimentIdInput 元素不存在，跳過事件綁定（可能在 Panel 延遲渲染中）",
      );
    }
  }

  _setupExperimentIdInputListener(idInput) {
    if (!idInput || idInput._experimentSystemBound) return;
    idInput._experimentSystemBound = true;

    idInput.addEventListener("change", async () => {
      const newVal = idInput.value.trim();
      if (!newVal) {
        await this.regenerateExperimentId();
        this._syncExperimentIdToUI();
        return;
      }
      await this.setExperimentId(newVal, RECORD_SOURCES.LOCAL_INPUT);
      this._syncExperimentIdToUI();
    });

    idInput.addEventListener("blur", () => {
      this._syncExperimentIdToUI();
    });
  }

  _handleFlowStarted() {
    // board 端持久化；panel 端 recordManager 為 null，自動跳過
    this.recordManager?.logExperimentStart();
    this._applyExperimentLockState({ locked: true, allowParticipantEdit: false });
    this._updateExperimentControlsForStarted();
    this.timerManager.startExperimentTimer();
    Logger.debug("【<green>FLOW STARTED</green>】回應實驗開始事件，UI已更新");
  }

  _handleFlowPaused() {
    // board 端持久化；panel 端 recordManager 為 null，自動跳過
    this.recordManager?.logExperimentPause();
    this._applyExperimentLockState({ locked: true, allowParticipantEdit: true });
    this._updateExperimentControlsForPaused();
    this.timerManager.pauseExperimentTimer();
    Logger.debug("【<yellow>FLOW PAUSED</yellow>】回應實驗暫停事件，UI和計時器已更新");
  }

  _handleFlowResumed() {
    // board 端持久化；panel 端 recordManager 為 null，自動跳過
    this.recordManager?.logExperimentResume();
    this._applyExperimentLockState({ locked: true, allowParticipantEdit: false });
    this._updateExperimentControlsForResumed();
    this.timerManager.resumeExperimentTimer();
    Logger.debug("【<blue>FLOW RESUMED</blue>】回應實驗繼續事件，UI和計時器已更新");
  }

  _handleFlowStopped(data) {
    // board 端持久化；panel 端 recordManager 為 null，自動跳過
    this.recordManager?.logExperimentEnd();
    this._applyExperimentLockState({ locked: false, allowParticipantEdit: true });
    this._updateExperimentControlsForStopped();
    this.timerManager?.stopExperimentTimer?.();
    window.dispatchEvent(
      new CustomEvent("experimentSystem:flowStopped", {
        detail: {
          reason: data.reason,
          completedUnits: data.completedUnits,
          timestamp: data.timestamp,
        },
      }),
    );
    Logger.debug("【<red>FLOW STOPPED</red>】回應實驗停止事件，UI已更新並發出通知");
  }

  /**
   * 將實驗控制 UI 重置為已停止狀態。
   * @public
   */
  resetControlsToStopped() {
    this._applyExperimentLockState({ locked: false, allowParticipantEdit: true });
    this._updateExperimentControlsForStopped();
  }

  _updateExperimentControlsForStarted() {
    this.uiManager.updateExperimentControlsForStarted(
      this.state.containers?.experimentControls ?? null,
    );
  }

  _updateExperimentControlsForPaused() {
    this.uiManager.updateExperimentControlsForPaused(
      this.state.containers?.experimentControls ?? null,
    );
  }

  _updateExperimentControlsForResumed() {
    this.uiManager.updateExperimentControlsForResumed(
      this.state.containers?.experimentControls ?? null,
    );
  }

  _updateExperimentControlsForStopped() {
    this.uiManager.updateExperimentControlsForStopped(
      this.state.containers?.experimentControls ?? null,
    );
  }

  _applyExperimentLockState({ locked, allowParticipantEdit }) {
    this.uiManager.setUILocked(!!locked, {
      combinationSelector: this.state.containers?.combinationSelector ?? null,
    });
    if (typeof this.pageManager?.setExperimentControlsLocked === "function") {
      this.pageManager.setExperimentControlsLocked(!!locked);
    }
    this.uiManager.setParticipantEditAllowed(!!allowParticipantEdit);
  }

  _tryCallPageManager(methodName, ...args) {
    const mgr = this.pageManager;
    if (mgr && typeof mgr[methodName] === "function") {
      return mgr[methodName](...args);
    }
  }
}

// 匯出到全域
export default ExperimentSystemManager;
export { ExperimentSystemManager };
