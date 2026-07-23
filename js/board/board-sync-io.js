/**
 * BoardSyncIO - board 端（實驗者）同步收發控制
 *
 * 集中處理同步訊息接收（receive*）與送出（send*），
 * 讓 page manager 專注在頁面協調。
 *
 * 角色說明：
 * - Board（board.html）：實驗者（experimenter）控制實驗流程、手動標記 action 完成
 * - Panel（panel.html）：受試者（participant）配戴 MR 裝置進行實際操作
 *
 * 同步方向重點：
 * - 實驗生命週期（開始/暫停/繼續/停止）：雙向同步
 * - ACTION_COMPLETED：panel → board（受試者完成動作，通知實驗者標記）
 * - board 端的 gesture step 推進由實驗者本人點擊手勢按鈕觸發，不由遠端驅動
 */

import { SYNC_EVENTS, SYNC_DATA_TYPES } from "../constants/index.js";
import { Logger } from "../core/console-manager.js";
import { dispatchSessionRestoreEvents } from "../core/session-restore-events.js";

class BoardSyncIO {
  constructor(pageManager) {
    this.pageManager = pageManager;
    this._started = false;
  }

  _getExperimentId() {
    return this.pageManager?.experimentSystemManager?.getExperimentId?.() || "";
  }

  _getParticipantName() {
    return this.pageManager?.experimentSystemManager?.getParticipantName?.() || "";
  }

  startReceive() {
    if (this._started) return;
    this._started = true;

    document.addEventListener(
      SYNC_EVENTS.EXPERIMENT_STATE_CHANGE_LOCAL,
      (event) => {
        const data = event.detail;
        if (!data || !data.type) return;

        switch (data.type) {
          case SYNC_DATA_TYPES.EXPERIMENT_INITIALIZE:
            this.receiveExperimentInit(data);
            break;
          case SYNC_DATA_TYPES.EXPERIMENT_ID_UPDATE:
            this.receiveExperimentIdUpdate(data);
            break;
            default:
            Logger.warn("未知的遠端事件類型:", data.type);
        }
      },
    );

    window.addEventListener(SYNC_EVENTS.SESSION_STATE, (event) => {
      dispatchSessionRestoreEvents(event.detail, { includePowerState: false });
    });

    window.addEventListener(SYNC_EVENTS.STATE_UPDATE, (event) => {
      const page = this.pageManager;
      const state = event.detail;
      if (!state) return;

      const myId = page.syncManager?.core?.syncClient?.clientId;
      if (myId && state.clientId === myId && !state._sessionRestore) return;

      if (state.type === SYNC_DATA_TYPES.EXPERIMENT_INITIALIZE) {
        this.receiveExperimentInit(state);
      } else if (state.type === SYNC_DATA_TYPES.BUTTON_ACTION) {
        this.receiveButtonAction(state);
      } else if (state.type === SYNC_DATA_TYPES.ACTION_COMPLETED) {
        this.receiveActionCompleted(state);
      } else if (state.type === SYNC_DATA_TYPES.ACTION_CANCELLED) {
        this.receiveActionCancelled(state);
      } else if (state.type === SYNC_DATA_TYPES.EXPERIMENT_ID_UPDATE) {
        this.receiveExperimentIdUpdate(state);
      } else if (state.type === SYNC_DATA_TYPES.PARTICIPANT_NAME_UPDATE) {
        this.receiveParticipantNameUpdate(state);
      }
    });

    window.addEventListener(SYNC_EVENTS.STATE_BROADCAST, (event) => {
      const detail = event.detail;
      if (!detail?.type) return;

      if (detail.type === SYNC_DATA_TYPES.EXPERIMENT_STARTED) {
        this.receiveExperimentStarted(detail);
      } else if (detail.type === SYNC_DATA_TYPES.EXPERIMENT_PAUSED) {
        this.receiveExperimentPaused(detail);
      } else if (detail.type === SYNC_DATA_TYPES.EXPERIMENT_RESUMED) {
        this.receiveExperimentResumed(detail);
      } else if (detail.type === SYNC_DATA_TYPES.EXPERIMENT_STOPPED) {
        this.receiveExperimentStopped(detail);
      }
    });

  }

  /**
   * 接收來自受試者（panel）端的 ACTION_COMPLETED 通知。
   *
   * 職責：
   * 1. 在 board 的手勢按鈕上標記綠色（讓實驗者看到受試者已完成此 action）
   * 2. 記錄同步事件日誌
   *
   * 不做的事：
   * - 不推進 gesture step（activateGestureStep）。
   *   gesture step 只由實驗者本人點擊 board 手勢按鈕觸發，
   *   不應由受試者的遠端訊號自動驅動。
   */
  receiveActionCompleted(syncData) {
    const page = this.pageManager;
    const {
      actionId,
      enteredActionId,
      source,
      clientId,
      timestamp,
      experimentId,
    } = syncData;

    const currentExperimentId = this._getExperimentId();

    if (!page.experimentRunning) {
      Logger.debug("忽略遠端 ACTION_COMPLETED：實驗尚未開始", {
        actionId,
        experimentId,
        timestamp,
      });
      return;
    }

    if (experimentId && currentExperimentId && experimentId !== currentExperimentId) {
      Logger.debug("忽略遠端 ACTION_COMPLETED：experimentId 不一致", {
        actionId,
        remoteExperimentId: experimentId,
        currentExperimentId,
      });
      return;
    }

    const ts =
      typeof timestamp === "number"
        ? timestamp
        : typeof timestamp === "string"
          ? Date.parse(timestamp)
          : NaN;
    if (
      Number.isFinite(ts) &&
      page.experimentStartedAt > 0 &&
      ts < page.experimentStartedAt - 2000
    ) {
      Logger.debug("忽略過舊的遠端 ACTION_COMPLETED", {
        actionId,
        timestamp,
        experimentStartedAt: page.experimentStartedAt,
      });
      return;
    }

    page.logAction("sync_action_completed", {
      actionId: actionId,
      source: source,
      clientId: clientId,
      timestamp: timestamp,
    });

    // 在對應的手勢按鈕上標記綠色，讓實驗者知道受試者已完成此 action。
    // gesture step 的推進由實驗者點擊手勢按鈕時觸發，不在此處驅動。
    const markSyncedAction = (targetActionId) => {
      if (!targetActionId) return;
      const targetButton = document.querySelector(
        `.gesture-action-button[data-action-id="${targetActionId}"]`,
      );
      if (!targetButton) return;
      if (targetButton.getAttribute("data-completed") === "true") return;

      const rawIdx = parseInt(targetButton.dataset.gestureIndex, 10);
      const gestureIndex = Number.isNaN(rawIdx) ? null : rawIdx;
      page._markActionCompleted(targetButton, targetActionId, gestureIndex, true);
      targetButton.classList.add("sync-action-completed");
      setTimeout(() => {
        targetButton.classList.remove("sync-action-completed");
      }, 2000);
    };

    if (actionId) {
      markSyncedAction(actionId);
    }
    if (enteredActionId && enteredActionId !== actionId) {
      markSyncedAction(enteredActionId);
    }
  }

  receiveActionCancelled(syncData) {
    const page = this.pageManager;
    const { actionId, clientId, timestamp, gestureIndex } = syncData;

    page.logAction("sync_action_cancelled", {
      actionId: actionId,
      clientId: clientId,
      timestamp: timestamp,
    });

    const actionButton = document.querySelector(
      `.gesture-action-button[data-action-id="${actionId}"]`,
    );
    if (actionButton && actionButton.getAttribute("data-completed") === "true") {
      page._cancelActionCompletion(actionButton, actionId, gestureIndex);
    }
  }

  receiveButtonAction(data) {
    const page = this.pageManager;
    const {
      button,
      actionId,
      function: buttonFunction,
      clientId,
    } = data;

    if (actionId) {
      const now = Date.now();
      const lastProcessTime = page.processedRemoteActions.get(actionId);

      if (
        lastProcessTime &&
        now - lastProcessTime < page.remoteActionDedupeWindow
      ) {
        return;
      }

      page.processedRemoteActions.set(actionId, now);
    }

    if (page.recordManager) {
      page.recordManager.logButtonAction(
        button,
        buttonFunction,
        clientId,
        actionId,
      );
    }

  }

  async receiveExperimentInit(data) {
    const page = this.pageManager;
    const { experimentId, currentCombination, participantName, loadedUnits } = data;

    if (experimentId) {
      await page.experimentSystemManager?.handleSyncExperimentIdUpdate?.({
        experimentId,
      });
      Logger.info(`從機台面板同步的實驗ID: ${experimentId}`);
    }

    if (participantName) {
      page.experimentSystemManager?.setParticipantName?.(participantName);
    }

    if (currentCombination) {
      if (page.experimentRunning) {
        Logger.debug("實驗進行中，將組合更新請求加入佇列");
        page.pendingCombinationUpdate = { currentCombination, loadedUnits };
        return;
      }

      await page.experimentSystemManager?.applyCombinationFromSync?.({
        combination: currentCombination,
        experimentId,
      });
      page.currentCombination = currentCombination;
      if (loadedUnits) {
        page.loadedUnits = loadedUnits;
      }
    }

    if (!page.experimentRunning) {
      page.startExperiment();
    }
  }

  receiveParticipantNameUpdate(data) {
    const page = this.pageManager;
    if (page.experimentRunning) {
      page.pendingParticipantNameUpdate = data;
      return;
    }

    const { participantName } = data;
    page.experimentSystemManager?.setParticipantName?.(participantName);
  }

  receiveExperimentIdUpdate(data) {
    const page = this.pageManager;
    if (page.experimentRunning) {
      page.pendingExperimentIdUpdate = data;
      Logger.debug(
        `實驗進行中，等待實驗結束後套用ID更新: ${data.experimentId}`,
      );
      return;
    }

    const { experimentId } = data;
    Logger.debug(`套用遠端實驗ID更新: ${experimentId}`);

    page.experimentSystemManager?.handleSyncExperimentIdUpdate?.(data);
    Logger.info(`實驗ID已同步並儲存: ${experimentId}`);
  }

  sendParticipantNameUpdate(participantName) {
    const page = this.pageManager;

    if (!page.syncManager?.core?.isConnected()) {
      return;
    }

    if (!participantName || !participantName.trim()) {
      Logger.debug("受試者名稱為空，跳過同步");
      return;
    }

    const updateData = {
      type: SYNC_DATA_TYPES.PARTICIPANT_NAME_UPDATE,
      clientId: page.syncManager?.core?.syncClient?.clientId || "experiment_panel",
      timestamp: Date.now(),
      experimentId: this._getExperimentId(),
      participantName: participantName.trim(),
    };

    page.experimentSyncCore?.safeBroadcast?.(updateData).catch((error) => {
      Logger.warn("同步受試者名稱更新失敗:", error);
    });

    document.dispatchEvent(
      new CustomEvent(SYNC_EVENTS.EXPERIMENT_STATE_CHANGE_LOCAL, {
        detail: updateData,
      }),
    );
  }

  async receiveExperimentStarted(detail) {
    const page = this.pageManager;
    const myId = page.syncManager?.core?.syncClient?.clientId;
    if (myId && detail.clientId === myId) {
      Logger.debug("Board: 收到本機實驗開始廣播，忽略");
      return;
    }

    if (page.experimentFlowManager?.isRunning) {
      Logger.debug("Board: Flow 已在進行中，忽略遠端啟動");
      return;
    }

    if (page.experimentRunning) {
      const currentId = this._getExperimentId();
      if (currentId === detail.experimentId) {
        Logger.debug("Board: 收到遠端實驗開始，但本機已在進行相同實驗，忽略");
        return;
      }
    }

    page.logAction("sync_experiment_started_received", {
      clientId: detail.clientId,
      experimentId: detail.experimentId,
    });

    const currentExperimentId = this._getExperimentId();
    if (currentExperimentId !== detail.experimentId) {
      await page.experimentSystemManager?.handleSyncExperimentIdUpdate?.({
        experimentId: detail.experimentId,
      });
    }

    if (detail.participantName) {
      const currentParticipantName = this._getParticipantName();
      if (!currentParticipantName) {
        page.experimentSystemManager?.setParticipantName?.(detail.participantName);
      }
    }

    if (detail.combinationId) {
      await page.experimentSystemManager?.selectCombination?.(detail.combinationId);
    }

    page.logAction("sync_experiment_started", {
      clientId: detail.clientId,
      experimentId: detail.experimentId,
      combinationId: detail.combinationId,
      combinationName: detail.combinationName,
    });

    try {
      page.startExperiment();
      Logger.debug("Board: 遠端實驗開始已處理，已啟動本機實驗");
    } catch (error) {
      Logger.error("Board: 啟動遠端同步實驗失敗:", error);
    }
  }

  receiveExperimentPaused(detail) {
    const page = this.pageManager;
    if (!page.experimentRunning) {
      return;
    }

    // 透過 ExperimentSystemManager 路由，確保 FlowManager 狀態、
    // 計時器、UI 鎖定、recordManager.logExperimentPause() 一致更新
    const handled = page.experimentSystemManager?.handleSyncExperimentPaused?.(detail);
    if (handled === false) {
      // FlowManager 已暫停（冪等保護），直接略過
      return;
    }

    Logger.info("遠端暫停實驗");
    page.logAction("sync_experiment_paused", {
      clientId: detail.clientId,
    });
  }

  receiveExperimentResumed(detail) {
    const page = this.pageManager;
    if (!page.experimentRunning) {
      return;
    }

    // 透過 ExperimentSystemManager 路由，確保 FlowManager 狀態、
    // 計時器、UI 鎖定、recordManager.logExperimentResume() 一致更新
    const handled = page.experimentSystemManager?.handleSyncExperimentResumed?.(detail);
    if (handled === false) {
      // FlowManager 未暫停（冪等保護），直接略過
      return;
    }

    Logger.info("遠端繼續實驗");
    page.logAction("sync_experiment_resumed", {
      clientId: detail.clientId,
    });
  }

  receiveExperimentStopped(detail) {
    const page = this.pageManager;
    if (!page.experimentRunning) {
      return;
    }

    page.logAction("sync_experiment_stopped_received", {
      clientId: detail.clientId,
    });

    Logger.debug("Board: 收到遠端停止訊號，Board 端由實驗者手動結束，不自動 stop", {
      clientId: detail.clientId,
    });
  }
}

export { BoardSyncIO };
