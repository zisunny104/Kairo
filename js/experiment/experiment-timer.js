/**
 * ExperimentTimerManager - 實驗計時器管理器
 *
 * 提供實驗總計時與步驟計時功能。
 * 計時狀態完整由此管理器擁有，不依賴外部 store。
 */

import { TimeSyncManager } from "../core/time-sync-manager.js";

export class ExperimentTimerManager {
  constructor(options = {}) {
    // 計時狀態 — 此管理器的唯一 owner
    this.experimentStartTime = null;
    this.experimentElapsedMs = 0;
    this.experimentPaused = false;

    this.experimentInterval = null;

    this.timeSyncManager = options.timeSyncManager || new TimeSyncManager();
    this.recordManager = options.recordManager || null;
    this.getCurrentCombination = options.getCurrentCombination || null;

    this.timerStates = {};
    this.timerIntervals = {};
    this.longPressTimers = {};
    this.currentActiveIndex = null;

    this.onExperimentTick = null;
    this.onIndexedTick = null;
  }

  _getTimerElement() {
    return (
      document.getElementById("experimentTimer") ||
      document.getElementById("experiment-timer")
    );
  }

  // ===== 實驗計時 =====

  _startTimerInterval() {
    if (this.experimentInterval) return;
    // 快取元素引用，避免每次 tick 重新查詢 DOM
    const el = this._getTimerElement();
    this.experimentInterval = setInterval(() => {
      if (!this.experimentPaused) {
        this.experimentElapsedMs = Date.now() - this.experimentStartTime;
        if (typeof this.onExperimentTick === "function") {
          this.onExperimentTick(this.experimentElapsedMs);
        }
        if (el) {
          el.textContent = this.timeSyncManager.formatStopwatch(this.experimentElapsedMs);
        }
      }
    }, 50);
  }

  startExperimentTimer() {
    if (this.experimentInterval) return;
    this.experimentStartTime = Date.now();
    this.experimentElapsedMs = 0;
    this.experimentPaused = false;
    this._startTimerInterval();
  }

  pauseExperimentTimer() {
    this.experimentPaused = true;
    if (this.experimentInterval) {
      clearInterval(this.experimentInterval);
      this.experimentInterval = null;
    }

    Object.keys(this.timerStates).forEach((idx) => {
      const state = this.timerStates[idx];
      if (state && state.running) {
        clearInterval(this.timerIntervals[idx]);
        state.running = false;
        state.elapsedTime += Date.now() - state.startTime;
      }
    });
  }

  resumeExperimentTimer() {
    if (!this.experimentStartTime) {
      this.startExperimentTimer();
      return;
    }
    this.experimentStartTime = Date.now() - this.experimentElapsedMs;
    this.experimentPaused = false;
    this._startTimerInterval();
  }

  stopExperimentTimer() {
    this.experimentPaused = false;
    if (this.experimentInterval) {
      clearInterval(this.experimentInterval);
      this.experimentInterval = null;
    }
    this.experimentStartTime = null;
    this.experimentElapsedMs = 0;
    const el = this._getTimerElement();
    if (el) el.textContent = this.timeSyncManager.formatStopwatch(0);

    Object.keys(this.timerStates).forEach((idx) => {
      if (this.timerIntervals[idx]) {
        clearInterval(this.timerIntervals[idx]);
        this.timerIntervals[idx] = null;
      }
      const state = this.timerStates[idx];
      if (state) {
        state.running = false;
        state.elapsedTime = 0;
      }
    });
    this.currentActiveIndex = null;
  }

  getExperimentElapsedMs() {
    return this.experimentElapsedMs;
  }

  // ===== 步驟計時 =====

  _ensureState(idx) {
    if (!this.timerStates[idx]) {
      this.timerStates[idx] = {
        running: false,
        startTime: 0,
        elapsedTime: 0,
        justReset: false,
      };
    }
  }

  toggleIndexedTimer(idx, options = {}) {
    const { logPause = true } = options;
    this._ensureState(idx);
    const state = this.timerStates[idx];
    const card = document.getElementById(`timer-card-${idx}`);

    if (state.running) {
      clearInterval(this.timerIntervals[idx]);
      state.running = false;
      state.elapsedTime += Date.now() - state.startTime;
      if (card) card.classList.remove("timer-card-pressed");
      if (this.currentActiveIndex === idx) this.currentActiveIndex = null;

      if (logPause && this.recordManager && this.getCurrentCombination) {
        const currentCombination = this.getCurrentCombination();
        const currentGesture = currentCombination?.gestures?.[idx];
        if (currentGesture?.step_id) {
          this.recordManager.logGestureStepPause(idx, currentGesture.step_id);
        }
      }
    } else {
      if (this.currentActiveIndex !== null && this.currentActiveIndex !== idx) {
        this._clearTimerOutline(this.currentActiveIndex);
      }

      state.running = true;
      state.startTime = Date.now();
      this.currentActiveIndex = idx;

      if (card) {
        card.classList.remove("timer-card-pressed");
        void card.offsetWidth;
        card.classList.add("timer-card-pressed");
        setTimeout(() => card.classList.remove("timer-card-pressed"), 400);
      }

      const display = document.getElementById(`timer-display-${idx}`);
      this.timerIntervals[idx] = setInterval(() => {
        const currentElapsed = state.elapsedTime + (Date.now() - state.startTime);
        if (display) {
          display.textContent = this.timeSyncManager.formatStopwatch(currentElapsed);
        }
        if (typeof this.onIndexedTick === "function") {
          this.onIndexedTick(idx, currentElapsed);
        }
      }, 16);

      if (this.recordManager && this.getCurrentCombination) {
        const currentCombination = this.getCurrentCombination();
        const currentGesture = currentCombination?.gestures?.[idx];
        if (currentGesture?.step_id) {
          this.recordManager.logGestureStepStart(idx, currentGesture.step_id);
        }
      }
    }
  }

  longPressStart(idx) {
    this._ensureState(idx);
    this.longPressTimers[idx] = setTimeout(() => {
      this.resetIndexedTimer(idx);
    }, 1000);
  }

  longPressEnd(idx) {
    if (this.longPressTimers[idx]) {
      clearTimeout(this.longPressTimers[idx]);
      this.longPressTimers[idx] = null;
    }
  }

  resetIndexedTimer(idx) {
    if (this.timerIntervals[idx]) {
      clearInterval(this.timerIntervals[idx]);
      this.timerIntervals[idx] = null;
    }
    this._clearTimerOutline(idx);
    this.timerStates[idx] = {
      running: false,
      startTime: 0,
      elapsedTime: 0,
      justReset: true,
    };
    if (this.currentActiveIndex === idx) this.currentActiveIndex = null;
    const display = document.getElementById(`timer-display-${idx}`);
    if (display) display.textContent = "00:00.000";
  }

  _clearTimerOutline(idx) {
    const card = document.getElementById(`timer-card-${idx}`);
    if (card) {
      card.classList.remove(
        "timer-card-pressed",
        "timer-card-marked-correct",
        "timer-card-marked-uncertain",
        "timer-card-marked-incorrect",
      );
    }
  }

  getIndexedElapsedSeconds(idx) {
    this._ensureState(idx);
    const state = this.timerStates[idx];
    if (state.running) {
      return Math.floor((state.elapsedTime + (Date.now() - state.startTime)) / 1000);
    }
    return Math.floor((state.elapsedTime || 0) / 1000);
  }

  destroy() {
    // 長按計時器（setTimeout）
    Object.keys(this.longPressTimers).forEach((idx) => {
      if (this.longPressTimers[idx]) {
        clearTimeout(this.longPressTimers[idx]);
        this.longPressTimers[idx] = null;
      }
    });

    // 步驟計時器（setInterval）
    Object.keys(this.timerIntervals).forEach((idx) => {
      if (this.timerIntervals[idx]) {
        clearInterval(this.timerIntervals[idx]);
        this.timerIntervals[idx] = null;
      }
    });

    // 主實驗計時器（setInterval）
    if (this.experimentInterval) {
      clearInterval(this.experimentInterval);
      this.experimentInterval = null;
    }

    this.timerStates = {};
    this.longPressTimers = {};
    this.timerIntervals = {};
    this.experimentStartTime = null;
    this.experimentElapsedMs = 0;
    this.currentActiveIndex = null;
  }
}
