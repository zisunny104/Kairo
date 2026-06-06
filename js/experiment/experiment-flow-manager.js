/**
 * ExperimentFlowManager - 實驗流程管理器
 *
 * 負責實驗生命週期控制（開始、暫停、繼續、停止、完成）、
 * 步驟與單元進度管理，並發布流程事件供其他模組訂閱。
 * 與 ExperimentTimerManager 和 UI 層互動以驅動實驗進行。
 *
 * 狀態所有權：FlowManager 完整擁有所有流程狀態，不依賴外部 store。
 * 外部模組透過事件（STARTED / PAUSED / RESUMED / STOPPED / COMPLETED）
 * 取得狀態變化通知，不應直接讀寫 FlowManager 內部屬性。
 */

import { buildActionSequenceFromUnits } from "../core/data-loader.js";
import {
  SYNC_EVENTS,
  EXPERIMENT_FLOW_STATE,
  EXPERIMENT_FLOW_EVENTS,
  EXPERIMENT_FLOW_DOM_EVENTS,
} from "../constants/index.js";
import { Logger } from "../core/console-manager.js";
import { EventEmitter } from "../core/event-emitter.js";

class ExperimentFlowManager extends EventEmitter {
  static STATE = EXPERIMENT_FLOW_STATE;
  static EVENT = EXPERIMENT_FLOW_EVENTS;

  constructor({
    hubManager = null,
    combinationManager = null,
    actionHandler = null,
    uiManager = null,
    actionsMap = null,
    unitsData = null,
    dispatchDomLifecycleEvents = false,
  } = {}) {
    super();
    this.hubManager = hubManager;
    this.combinationManager = combinationManager;
    this.actionHandler = actionHandler;
    this.uiManager = uiManager;
    this.actionsMap = actionsMap;
    this.unitsData = unitsData;
    // 只有 board 端需要發出 document lifecycle 事件（供 experimentSyncManager 捕捉後廣播）
    // panel 端使用 EventEmitter 路徑，document dispatch 對 panel 是死碼
    this._dispatchDomLifecycleEvents = dispatchDomLifecycleEvents;

    // 流程狀態 — FlowManager 是唯一 owner，不透過外部 store
    this._state = ExperimentFlowManager.STATE.IDLE;
    this._isRunning = false;
    this._isPaused = false;
    this._locked = false;
    this._currentUnitIndex = 0;
    this._currentStepIndex = 0;
    this._loadedUnits = [];
    this._completedUnits = new Set();
    this._deferCompletion = false;

    this.autoProgressTimer = null;
    this.pausedByVisibility = false;

    this._setupVisibilityHandler();
    Logger.debug("ExperimentFlowManager 初始化完成");
  }

  _setupVisibilityHandler() {
    this._visibilityHandler = () => {
      if (document.hidden) {
        if (this.isRunning && !this.isPaused) {
          this.pausedByVisibility = true;
          this.pauseExperiment();
        }
      } else {
        if (this.pausedByVisibility && this.isRunning && this.isPaused) {
          this.pausedByVisibility = false;
          this.resumeExperiment();
        }
      }
    };
    document.addEventListener(EXPERIMENT_FLOW_DOM_EVENTS.VISIBILITY_CHANGE, this._visibilityHandler);
  }

  /**
   * 建構後 inject dependencies（用於延後綁定情境）
   * 注意：不再接受 stateManager，FlowManager 自管狀態。
   */
  injectDependencies({
    hubManager,
    combinationManager,
    actionHandler,
    uiManager,
    actionsMap,
    unitsData,
  } = {}) {
    if (hubManager) this.hubManager = hubManager;
    if (combinationManager) this.combinationManager = combinationManager;
    if (actionHandler) this.actionHandler = actionHandler;
    if (uiManager) this.uiManager = uiManager;
    if (actionsMap) this.actionsMap = actionsMap;
    if (unitsData) this.unitsData = unitsData;
    return this;
  }

  // ─── 狀態屬性（直接讀寫內部欄位）───────────────────────────────────────────

  get state() { return this._state; }
  set state(value) { this._state = value; }

  get isRunning() { return this._isRunning; }
  set isRunning(value) { this._isRunning = Boolean(value); }

  get isPaused() { return this._isPaused; }
  set isPaused(value) { this._isPaused = Boolean(value); }

  get locked() { return this._locked; }
  set locked(value) { this._locked = Boolean(value); }

  get currentUnitIndex() { return this._currentUnitIndex; }
  set currentUnitIndex(value) { this._currentUnitIndex = Number(value) || 0; }

  get currentStepIndex() { return this._currentStepIndex; }
  set currentStepIndex(value) { this._currentStepIndex = Number(value) || 0; }

  get loadedUnits() { return this._loadedUnits; }
  set loadedUnits(value) { this._loadedUnits = Array.isArray(value) ? value : []; }

  get completedUnits() { return this._completedUnits; }
  set completedUnits(value) { this._completedUnits = value instanceof Set ? value : new Set(); }

  get deferCompletion() { return this._deferCompletion; }
  set deferCompletion(value) { this._deferCompletion = Boolean(value); }

  setDeferCompletion(shouldDefer) {
    this._deferCompletion = Boolean(shouldDefer);
  }

  /**
   * 開始實驗
   */
  async startExperiment(options = {}) {
    const broadcast = options.broadcast !== false;
    if (this.isRunning) {
      Logger.warn("實驗已在進行中");
      return false;
    }

    try {
      Logger.info("開始實驗");

      if (options.units) {
        this.loadedUnits = options.units;
      } else if (this.combinationManager?.getLoadedUnits) {
        this.loadedUnits = this.combinationManager.getLoadedUnits();
      }

      if (this.loadedUnits.length === 0) {
        throw new Error("沒有可用的單元");
      }

      this.currentUnitIndex = 0;
      this.currentStepIndex = 0;
      this._completedUnits.clear();

      if (this.actionHandler) {
        const unitIds = this.loadedUnits.length > 0
          ? this.loadedUnits
          : this.combinationManager?.getLoadedUnits?.() || [];
        const actionsMap = this.actionsMap || new Map();
        const unitsData = this.unitsData || [];
        const combo = this.combinationManager?.getCurrentCombination?.() || null;
        const powerOptions = combo?.powerOptions || {};
        const includeStartup = typeof powerOptions.includeStartup === "boolean"
          ? powerOptions.includeStartup : true;
        const includeShutdown = typeof powerOptions.includeShutdown === "boolean"
          ? powerOptions.includeShutdown : true;
        const actionSequence = buildActionSequenceFromUnits(
          unitIds, actionsMap, unitsData, { includeStartup, includeShutdown },
        );

        if (actionSequence && actionSequence.length > 0) {
          this.actionHandler.initializeSequence(actionSequence);
          Logger.debug("已初始化 action 序列", { actionCount: actionSequence.length });
        }
      }

      this._isRunning = true;
      this._isPaused = false;
      this._state = ExperimentFlowManager.STATE.RUNNING;
      this._locked = true;
      this.emit(ExperimentFlowManager.EVENT.LOCKED, { locked: true });

      const startData = {
        units: [...this.loadedUnits],
        timestamp: new Date().toISOString(),
        source: options.source || "local",
        broadcast,
      };
      this.emit(ExperimentFlowManager.EVENT.STARTED, startData);
      this.emit(ExperimentFlowManager.EVENT.STATE_CHANGED, {
        oldState: ExperimentFlowManager.STATE.IDLE,
        newState: this._state,
      });

      if (broadcast && this._dispatchDomLifecycleEvents) {
        document.dispatchEvent(new CustomEvent(SYNC_EVENTS.EXPERIMENT_STARTED, { detail: startData }));
      }

      Logger.debug("實驗已開始", { unitCount: this.loadedUnits.length });
      return true;
    } catch (error) {
      Logger.error("開始實驗失敗", error);
      this.emit(ExperimentFlowManager.EVENT.ERROR, { type: "start_failed", error });
      return false;
    }
  }

  /**
   * 暫停實驗
   */
  pauseExperiment(options = {}) {
    const broadcast = options.broadcast !== false;
    if (!this.isRunning) {
      Logger.warn("實驗未進行，無法暫停");
      return false;
    }
    if (this.isPaused) {
      Logger.warn("實驗已暫停");
      return false;
    }

    Logger.info("暫停實驗");

    this._isPaused = true;
    this._state = ExperimentFlowManager.STATE.PAUSED;

    const pauseData = {
      currentUnit: this.currentUnitIndex,
      currentStep: this.currentStepIndex,
      timestamp: new Date().toISOString(),
      source: options.source || "local",
      broadcast,
    };
    this.emit(ExperimentFlowManager.EVENT.PAUSED, pauseData);
    this.emit(ExperimentFlowManager.EVENT.STATE_CHANGED, {
      oldState: ExperimentFlowManager.STATE.RUNNING,
      newState: this._state,
    });

    if (broadcast && this._dispatchDomLifecycleEvents) {
      document.dispatchEvent(new CustomEvent(SYNC_EVENTS.EXPERIMENT_PAUSED, { detail: pauseData }));
    }

    return true;
  }

  /**
   * 繼續實驗
   */
  resumeExperiment(options = {}) {
    const broadcast = options.broadcast !== false;
    if (!this.isRunning) {
      Logger.warn("實驗未進行，無法繼續");
      return false;
    }
    if (!this.isPaused) {
      Logger.warn("實驗未暫停");
      return false;
    }

    Logger.info("繼續實驗");

    this._isPaused = false;
    this._state = ExperimentFlowManager.STATE.RUNNING;

    const resumeData = {
      currentUnit: this.currentUnitIndex,
      currentStep: this.currentStepIndex,
      timestamp: new Date().toISOString(),
      source: options.source || "local",
      broadcast,
    };
    this.emit(ExperimentFlowManager.EVENT.RESUMED, resumeData);
    this.emit(ExperimentFlowManager.EVENT.STATE_CHANGED, {
      oldState: ExperimentFlowManager.STATE.PAUSED,
      newState: this._state,
    });

    if (broadcast && this._dispatchDomLifecycleEvents) {
      document.dispatchEvent(new CustomEvent(SYNC_EVENTS.EXPERIMENT_RESUMED, { detail: resumeData }));
    }

    return true;
  }

  /**
   * 停止實驗
   */
  stopExperiment(reason = "manual", options = {}) {
    const broadcast = options.broadcast !== false;
    if (!this.isRunning) {
      Logger.warn("實驗未進行，無法停止");
      return false;
    }

    Logger.info("停止實驗", { reason });

    const oldState = this._state;
    this._isRunning = false;
    this._isPaused = false;
    this._state = ExperimentFlowManager.STATE.STOPPED;
    this._locked = false;
    this.emit(ExperimentFlowManager.EVENT.UNLOCKED, { locked: false });

    const stopData = {
      reason,
      broadcast,
      currentUnit: this.currentUnitIndex,
      currentStep: this.currentStepIndex,
      completedUnits: this._completedUnits.size,
      timestamp: new Date().toISOString(),
      source: options.source || "local",
    };
    this.emit(ExperimentFlowManager.EVENT.STOPPED, stopData);
    this.emit(ExperimentFlowManager.EVENT.STATE_CHANGED, { oldState, newState: this._state });

    if (broadcast && this._dispatchDomLifecycleEvents) {
      document.dispatchEvent(new CustomEvent(SYNC_EVENTS.EXPERIMENT_STOPPED, { detail: stopData }));
    }

    return true;
  }

  /**
   * 完成實驗
   */
  completeExperiment(options = {}) {
    const broadcast = options.broadcast !== false;
    if (!this.isRunning) {
      Logger.warn("實驗未進行，無法標記為完成");
      return false;
    }

    Logger.info("實驗完成");

    const oldState = this._state;
    this._isRunning = false;
    this._isPaused = false;
    this._state = ExperimentFlowManager.STATE.COMPLETED;
    this._locked = false;
    this.emit(ExperimentFlowManager.EVENT.UNLOCKED, { locked: false });

    const completedData = {
      totalUnits: this.loadedUnits.length,
      completedUnits: this._completedUnits.size,
      reason: "completed",
      broadcast,
      timestamp: new Date().toISOString(),
      source: options.source || "local",
    };

    this.emit(ExperimentFlowManager.EVENT.COMPLETED, completedData);
    this.emit(ExperimentFlowManager.EVENT.STATE_CHANGED, { oldState, newState: this._state });

    if (broadcast && this._dispatchDomLifecycleEvents) {
      document.dispatchEvent(new CustomEvent(SYNC_EVENTS.EXPERIMENT_STOPPED, { detail: completedData }));
    }

    return true;
  }

  /**
   * 重置實驗
   */
  resetExperiment() {
    Logger.info("重置實驗");

    const oldState = this._state;

    this._isRunning = false;
    this._isPaused = false;
    this._state = ExperimentFlowManager.STATE.IDLE;
    this._currentUnitIndex = 0;
    this._currentStepIndex = 0;
    this._completedUnits.clear();
    this._locked = false;
    this.emit(ExperimentFlowManager.EVENT.UNLOCKED, { locked: false });

    if (oldState !== this._state) {
      this.emit(ExperimentFlowManager.EVENT.STATE_CHANGED, {
        oldState,
        newState: this._state,
      });
    }

    Logger.debug("實驗已重置");
  }

  /**
   * 前進到下一步
   */
  nextStep() {
    if (!this.isRunning || this.isPaused) {
      Logger.warn("實驗未進行或已暫停，無法前進");
      return false;
    }

    const currentUnit = this.getCurrentUnit();
    if (!currentUnit) {
      Logger.warn("沒有目前單元");
      return false;
    }

    const oldStepIndex = this._currentStepIndex;

    if (this._currentStepIndex < currentUnit.steps.length - 1) {
      this._currentStepIndex++;

      this.emit(ExperimentFlowManager.EVENT.STEP_CHANGED, {
        unitIndex: this._currentUnitIndex,
        oldStepIndex,
        newStepIndex: this._currentStepIndex,
        step: this.getCurrentStep(),
      });

      Logger.debug("前進到下一步", { unit: this._currentUnitIndex, step: this._currentStepIndex });
      return true;
    } else {
      return this.nextUnit();
    }
  }

  /**
   * 取得目前步驟
   */
  getCurrentStep() {
    const unit = this.getCurrentUnit();
    if (!unit) return null;
    return unit.steps[this._currentStepIndex] || null;
  }

  /**
   * 前進到下一個單元
   */
  nextUnit() {
    if (!this.isRunning) {
      Logger.warn("實驗未進行，無法前進到下一單元");
      return false;
    }

    this.markUnitAsCompleted(this._currentUnitIndex);

    const oldUnitIndex = this._currentUnitIndex;

    if (this._currentUnitIndex < this._loadedUnits.length - 1) {
      this._currentUnitIndex++;
      this._currentStepIndex = 0;

      this.emit(ExperimentFlowManager.EVENT.UNIT_CHANGED, {
        oldUnitIndex,
        newUnitIndex: this._currentUnitIndex,
        unit: this.getCurrentUnit(),
      });

      Logger.debug("前進到下一單元", { unit: this._currentUnitIndex });
      return true;
    } else {
      Logger.info("所有單元已完成");
      if (this._deferCompletion) {
        Logger.debug("完成已延後，等待手動結束");
        return false;
      }
      this.completeExperiment();
      return false;
    }
  }

  /**
   * 設定目前單元
   */
  setCurrentUnit(unitIndex) {
    if (unitIndex < 0 || unitIndex >= this._loadedUnits.length) {
      Logger.warn("單元索引超出範圍", unitIndex);
      return false;
    }

    const oldUnitIndex = this._currentUnitIndex;
    this._currentUnitIndex = unitIndex;
    this._currentStepIndex = 0;

    if (oldUnitIndex !== unitIndex) {
      this.emit(ExperimentFlowManager.EVENT.UNIT_CHANGED, {
        oldUnitIndex,
        newUnitIndex: unitIndex,
        unit: this.getCurrentUnit(),
      });
    }

    Logger.debug("目前單元已設定", unitIndex);
    return true;
  }

  /**
   * 取得目前單元
   */
  getCurrentUnit() {
    return this.getUnitAt(this._currentUnitIndex);
  }

  /**
   * 取得指定索引的單元
   */
  getUnitAt(index) {
    if (index < 0 || index >= this._loadedUnits.length) return null;

    const unitId = this._loadedUnits[index];
    const unitsData = this.unitsData;

    if (Array.isArray(unitsData) && unitsData.length > 0) {
      return unitsData.find((u) => u.unit_id === unitId) || null;
    }

    return null;
  }

  /**
   * 取得單元列表
   */
  getUnitList() {
    return [...this._loadedUnits];
  }

  /**
   * 標記單元為完成
   */
  markUnitAsCompleted(unitIndex) {
    this._completedUnits.add(unitIndex);

    this.emit(ExperimentFlowManager.EVENT.UNIT_COMPLETED, {
      unitIndex,
      unit: this.getUnitAt(unitIndex),
      completedCount: this._completedUnits.size,
      totalCount: this._loadedUnits.length,
    });

    Logger.debug("單元已標記為完成", {
      unitIndex,
      progress: `${this._completedUnits.size}/${this._loadedUnits.length}`,
    });
  }

  /**
   * 檢查單元是否已完成
   */
  isUnitCompleted(unitIndex) {
    return this._completedUnits.has(unitIndex);
  }

  /**
   * 檢查實驗是否完成
   */
  isExperimentCompleted() {
    return this._state === ExperimentFlowManager.STATE.COMPLETED;
  }

  /**
   * 檢查實驗是否已停止
   */
  isExperimentStopped() {
    return this._state === ExperimentFlowManager.STATE.STOPPED;
  }

  /**
   * 取得目前狀態
   */
  getState() {
    return this._state;
  }

  /**
   * 取得進度資訊
   */
  getProgress() {
    return {
      currentUnitIndex: this._currentUnitIndex,
      currentStepIndex: this._currentStepIndex,
      totalUnits: this._loadedUnits.length,
      completedUnits: this._completedUnits.size,
      currentUnit: this.getCurrentUnit(),
      currentStep: this.getCurrentStep(),
      percentage: this._loadedUnits.length > 0
        ? Math.round((this._completedUnits.size / this._loadedUnits.length) * 100)
        : 0,
    };
  }

  /**
   * 銷毀管理器
   */
  destroy() {
    this.stopExperiment("destroy");
    this.clearListeners();
    if (this._visibilityHandler) {
      document.removeEventListener(EXPERIMENT_FLOW_DOM_EVENTS.VISIBILITY_CHANGE, this._visibilityHandler);
      this._visibilityHandler = null;
    }
    this._loadedUnits = [];
    this._completedUnits.clear();
    Logger.debug("ExperimentFlowManager 已銷毀");
  }
}

export default ExperimentFlowManager;
export { ExperimentFlowManager };
