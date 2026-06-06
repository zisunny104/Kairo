/**
 * ExperimentHubManager - 實驗中樞管理器
 *
 * 負責管理實驗 ID 和同步模式（Local / Hub / Viewer），
 * 處理與中樞伺服器的通訊和事件通知，支援多裝置協同實驗。
 */

import {
  RECORD_SOURCES,
  SYNC_DATA_TYPES,
  SYNC_ROLE_CONFIG,
  EXPERIMENT_HUB_CONSTANTS,
} from "../constants/index.js";
import { generateExperimentId } from "../core/random-utils.js";
import { Logger } from "../core/console-manager.js";
import { EventEmitter } from "../core/event-emitter.js";
import { WS_PROTOCOL } from "../../shared/ws-protocol-constants.js";
import { getApiUrl } from "../core/url-utils.js";

class ExperimentHubManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      ...config,
      apiBaseUrl: config.apiBaseUrl || this.getDefaultApiUrl(),
    };

    this.ids = {
      hub: null,
      experiment: null,
      combination: null,
    };

    this.connection = {
      mode: EXPERIMENT_HUB_CONSTANTS.MODE.LOCAL,
      connected: false,
      wsClient: null,
      role: null,
    };

    this.syncClientReady = false;
    this.syncManager = config.syncManager || null;
    this._pendingExperimentIdRegistration = null;
    this._lastRegisteredExperimentId = null;
    this._experimentIdSetAfterSyncReady = false;
    this.syncClient = config.syncClient || null;
    this.experimentSyncCore = config.experimentSyncCore || null;
    this.roleConfig = {
      ...SYNC_ROLE_CONFIG,
      ...config.roleConfig,
    };

    this.initialize();
  }

  updateDependencies(deps = {}) {
    Object.assign(this, deps);
  }

  /** 動態解析 WebSocketClient，避免快取過期參考造成記憶體洩漏 */
  get _wsClient() {
    return (this.syncClient || this.syncManager?.core?.syncClient)?.wsClient ?? null;
  }

  /**
   * 初始化管理器
   */
  initialize() {
    this.restoreIds();

    if (this.syncManager) {
      this.waitForSyncClient();
    }

    Logger.debug("ExperimentHubManager 初始化完成", {
      mode: this.connection.mode,
      ids: this.ids,
    });
  }

  /**
   * 取得預設 API URL
   */
  getDefaultApiUrl() {
    return getApiUrl();
  }

  /**
   * 設定 Hub ID
   */
  setHubId(id, options = {}) {
    const oldId = this.ids.hub;
    this.ids.hub = id;

    if (!options.silent) {
      this.saveIds();
      this.emit(EXPERIMENT_HUB_CONSTANTS.EVENT.ID_CHANGED, {
        type: "hub",
        oldValue: oldId,
        newValue: id,
      });
    }

    Logger.debug("Hub ID 已設定", id);
    return id;
  }

  /**
   * 取得 Hub ID
   */
  getHubId() {
    return this.ids.hub;
  }

  /**
   * 設定實驗 ID
   */
  setExperimentId(id, source = RECORD_SOURCES.LOCAL_INPUT, options = {}) {
    const normalizedId = typeof id === "string" ? id.trim() : id;
    const validation = this.validateId(normalizedId, "experiment");
    if (!validation.valid) {
      Logger.warn("無效的實驗 ID，跳過設定", {
        id,
        normalizedId,
        source,
        reason: validation.error,
      });
      return null;
    }

    const oldId = this.ids.experiment;
    this.ids.experiment = normalizedId;
    // 只有本地主動設定才算「已明確設定」，避免 reconnect 時遠端新 ID 被擋住
    if (this.syncClientReady
        && source !== RECORD_SOURCES.SYNC_BROADCAST
        && source !== RECORD_SOURCES.HUB_SYNC) {
      this._experimentIdSetAfterSyncReady = true;
    }

    if (!options.silent) {
      this.saveIds();
      this.emit(EXPERIMENT_HUB_CONSTANTS.EVENT.ID_CHANGED, {
        type: "experiment",
        oldValue: oldId,
        newValue: normalizedId,
        source: source,
      });

      if (
        this.isHubMode() &&
        this.connection.connected &&
        source !== RECORD_SOURCES.SYNC_BROADCAST &&
        source !== RECORD_SOURCES.HUB_SYNC
      ) {
        this.syncExperimentIdToHub(normalizedId, source);
      }
    }

    Logger.debug("實驗 ID 已設定", { id: normalizedId, source });
    return normalizedId;
  }

  /**
   * 取得實驗 ID
   */
  getExperimentId() {
    return this.ids.experiment;
  }

  /**
   * 設定組合 ID
   */
  setCombinationId(id, options = {}) {
    const oldId = this.ids.combination;
    this.ids.combination = id;

    if (!options.silent) {
      this.saveIds();
      this.emit(EXPERIMENT_HUB_CONSTANTS.EVENT.ID_CHANGED, {
        type: "combination",
        oldValue: oldId,
        newValue: id,
      });
    }

    Logger.debug("組合 ID 已設定", id);
    return id;
  }

  /**
   * 取得組合 ID
   */
  getCombinationId() {
    return this.ids.combination;
  }

  /**
   * 產生新的實驗 ID
   * 使用前端格式：6位大寫英數字
   * 範例: "JHWH4A"
   */
  generateExperimentId() {
    const id = generateExperimentId();
    this.setExperimentId(id, RECORD_SOURCES.LOCAL_GENERATE);
    return id;
  }

  /**
   * 註冊實驗 ID 到伺服器
   * 僅在同步模式下發送到伺服器
   * @param {string} experimentId - 實驗 ID
   * @returns {Promise<boolean>} 註冊是否成功
   */
  async registerExperimentId(experimentId) {
    try {
      if (!this.isSyncMode()) {
        Logger.debug("非同步模式，跳過實驗 ID 註冊", experimentId);
        return false;
      }

      if (!experimentId) {
        Logger.warn("無效的實驗 ID，跳過註冊");
        return false;
      }

      Logger.debug("開始註冊實驗 ID 到伺服器", experimentId);

      if (this._wsClient && this.connection.connected) {
        const message = {
          type: EXPERIMENT_HUB_CONSTANTS.MESSAGE_TYPES.EXPERIMENT_ID_REGISTER,
          data: {
            experimentId: experimentId,
            timestamp: Date.now(),
          },
        };

        this._wsClient.send(message);
        this._lastRegisteredExperimentId = experimentId;
        this._pendingExperimentIdRegistration = null;
        Logger.debug("實驗 ID 註冊訊息已發送", message);
        return true;
      }

      Logger.warn("WebSocket 未連接，將在連線後重新註冊實驗 ID", experimentId);
      this._pendingExperimentIdRegistration = experimentId;
      return false;
    } catch (error) {
      Logger.error("註冊實驗 ID 失敗:", error);
      return false;
    }
  }

  /**
   * 註冊實驗狀態到伺服器（同步模式）
   * @param {Object} state - 實驗狀態資料
   * @returns {Promise<boolean>} 是否成功
   */
  async registerExperimentState(state) {
    try {
      if (!this.isSyncMode()) {
        return false;
      }

      if (!state || typeof state !== "object") {
        Logger.warn("無效的實驗狀態，跳過註冊");
        return false;
      }

      if (!this._wsClient || !this.connection.connected) {
        Logger.warn("WebSocket 未連接，無法註冊實驗狀態");
        return false;
      }

      const message = {
        type: WS_PROTOCOL.C2S.EXPERIMENT_STATE_REGISTER,
        data: {
          state: {
            ...state,
            clientId: state.clientId || this.getClientId(),
            timestamp: state.timestamp || new Date().toISOString(),
          },
        },
      };

      this._wsClient.send(message);
      Logger.debug("實驗狀態註冊訊息已發送", message);
      return true;
    } catch (error) {
      Logger.error("註冊實驗狀態失敗:", error);
      return false;
    }
  }

  /**
   * 檢查是否為同步模式
   * @returns {boolean} 是否為同步模式
   */
  isSyncMode() {
    return this.syncManager?.isSyncMode === true;
  }

  /**
   * 驗證 ID 有效性
   */
  validateId(id, type = "experiment") {
    if (id === undefined || id === null) {
      return { valid: false, error: "ID 不能為 null 或 undefined" };
    }

    if (typeof id !== "string") {
      return { valid: false, error: "ID 必須是字串" };
    }

    const normalized = id.trim();
    if (normalized.length === 0) {
      return { valid: false, error: "ID 不能為空" };
    }

    if (normalized === "undefined" || normalized === "null") {
      return { valid: false, error: "ID 不能是無效文字" };
    }

    switch (type) {
      case "experiment":
        if (!/^[A-Z0-9]{6}$/.test(normalized) && !/^[A-Za-z0-9_-]+$/.test(normalized)) {
          return { valid: false, error: "實驗 ID 格式不正確" };
        }
        break;
    }

    return { valid: true };
  }

  /**
   * 重置所有 ID
   */
  resetIds(options = {}) {
    const oldIds = { ...this.ids };

    this.ids = {
      hub: null,
      experiment: null,
      combination: null,
    };

    if (!options.silent) {
      this.saveIds();
      this.emit(EXPERIMENT_HUB_CONSTANTS.EVENT.ID_CHANGED, {
        type: "all",
        oldValue: oldIds,
        newValue: this.ids,
      });
    }

    Logger.debug("所有 ID 已重置");
  }

  /**
   * 儲存 ID 到 localStorage
   */
  saveIds() {
    try {
      localStorage.setItem(
        EXPERIMENT_HUB_CONSTANTS.STORAGE_KEY,
        JSON.stringify(this.ids),
      );
    } catch (error) {
      Logger.error("儲存 ID 失敗", error);
    }
  }

  /**
   * 從 localStorage 恢復 ID
   */
  restoreIds() {
    try {
      const saved = localStorage.getItem(EXPERIMENT_HUB_CONSTANTS.STORAGE_KEY);
      if (!saved) {
        return;
      }

      const ids = JSON.parse(saved);
      const validIds = { ...this.ids };

      if (ids && typeof ids === "object") {
        if (ids.hub !== undefined && ids.hub !== null) {
          validIds.hub = ids.hub;
        }
        if (ids.experiment !== undefined && ids.experiment !== null) {
          const validation = this.validateId(ids.experiment, "experiment");
          if (validation.valid) {
            validIds.experiment = ids.experiment.trim();
          } else {
            Logger.warn("從 localStorage 還原時忽略無效 experimentId", {
              experimentId: ids.experiment,
              reason: validation.error,
            });
          }
        }
        if (ids.combination !== undefined && ids.combination !== null) {
          validIds.combination = ids.combination;
        }
      }

      this.ids = validIds;
      Logger.debug("已從 localStorage 還原 ID", this.ids);
    } catch (error) {
      Logger.error("還原 ID 失敗", error);
    }
  }

  /**
   * 取得目前模式
   */
  getMode() {
    return this.connection.mode;
  }

  /**
   * 檢查是否為本機模式
   */
  isLocalMode() {
    return this.connection.mode === EXPERIMENT_HUB_CONSTANTS.MODE.LOCAL;
  }

  /**
   * 檢查是否處於同步模式（非本機模式）
   */
  isInSyncMode() {
    return !this.isLocalMode();
  }

  /**
   * 檢查是否為 Hub 模式
   */
  isHubMode() {
    return this.connection.mode === EXPERIMENT_HUB_CONSTANTS.MODE.HUB;
  }

  /**
   * 檢查是否為檢視模式
   */
  isViewerMode() {
    return this.connection.mode === EXPERIMENT_HUB_CONSTANTS.MODE.VIEWER;
  }

  /**
   * 切換到 Hub 模式
   */
  async switchToHubMode() {
    if (this.isHubMode()) {
      Logger.debug("已經是 Hub 模式");
      return true;
    }

    const oldMode = this.connection.mode;
    this.connection.mode = EXPERIMENT_HUB_CONSTANTS.MODE.HUB;

    this.emit(EXPERIMENT_HUB_CONSTANTS.EVENT.MODE_CHANGED, {
      oldMode,
      newMode: this.connection.mode,
    });

    Logger.info("已切換到 Hub 模式");

    if (!this.connection.connected) {
      await this.connect();
    }

    return true;
  }

  /**
   * 切換到本機模式
   */
  switchToLocalMode() {
    if (this.isLocalMode()) {
      Logger.debug("已經是本機模式");
      return true;
    }

    const oldMode = this.connection.mode;
    this.connection.mode = EXPERIMENT_HUB_CONSTANTS.MODE.LOCAL;

    this.emit(EXPERIMENT_HUB_CONSTANTS.EVENT.MODE_CHANGED, {
      oldMode,
      newMode: this.connection.mode,
    });

    Logger.info("已切換到本機模式");

    if (this.connection.connected) {
      this.disconnect();
    }

    return true;
  }

  /**
   * 設定檢視模式
   */
  setViewerMode(isViewer) {
    const oldMode = this.connection.mode;

    if (isViewer) {
      this.connection.mode = EXPERIMENT_HUB_CONSTANTS.MODE.VIEWER;
    } else if (this.connection.connected) {
      this.connection.mode = EXPERIMENT_HUB_CONSTANTS.MODE.HUB;
    } else {
      this.connection.mode = EXPERIMENT_HUB_CONSTANTS.MODE.LOCAL;
    }

    if (oldMode !== this.connection.mode) {
      this.emit(EXPERIMENT_HUB_CONSTANTS.EVENT.MODE_CHANGED, {
        oldMode,
        newMode: this.connection.mode,
      });

      Logger.info("模式已變更", {
        from: oldMode,
        to: this.connection.mode,
      });
    }
  }

  /**
   * 等待 SyncClient 就緒
   */
  waitForSyncClient() {
    if (this.syncClientReady) return;

    const checkInterval = setInterval(() => {
      if (this.syncClient || this.syncManager?.core?.syncClient) {
        clearInterval(checkInterval);
        if (!this.syncClientReady) this.onSyncClientReady();
      }
    }, EXPERIMENT_HUB_CONSTANTS.DEFAULTS.SYNC_CLIENT_READY_POLL_INTERVAL_MS);

    setTimeout(() => {
      clearInterval(checkInterval);
      if (this.syncClientReady) return;
      // timeout 清除 interval 後補做一次最終檢查，防止競爭視窗內錯過就緒訊號
      if (this.syncClient || this.syncManager?.core?.syncClient) {
        this.onSyncClientReady();
      } else {
        Logger.warn("SyncClient 就緒超時");
      }
    }, EXPERIMENT_HUB_CONSTANTS.DEFAULTS.SYNC_CLIENT_READY_TIMEOUT_MS);
  }

  /**
   * SyncClient 就緒回調
   */
  onSyncClientReady() {
    Logger.debug("[HubManager] SyncClient 就緒");
    this.syncClientReady = true;

    const syncClient =
      this.syncClient || this.syncManager?.core?.syncClient;
    this.syncClient = syncClient;

    if (!syncClient) {
      Logger.warn("SyncClient 尚未就緒，跳過 Hub 註冊");
      return;
    }

    this.hydrateExperimentIdFromSessionState();

    if (syncClient?.isConnected?.()) {
      this.connection.connected = true;
      this.connection.role = syncClient.getRole();
      this.updateModeFromRole();
    }

    this._flushPendingExperimentIdRegistration();
  }

  /**
   * 從 SyncClient 快照中擷取可用的 experimentId。
   */
  _getExperimentIdFromSessionSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
      return null;
    }

    const experimentState = snapshot.experimentState;
    const topState = snapshot.state;
    const restoredExperimentId =
      experimentState?.experimentId ||
      experimentState?.registeredExperimentId ||
      topState?.experimentId ||
      topState?.registeredExperimentId ||
      null;

    return typeof restoredExperimentId === "string"
      ? restoredExperimentId.trim()
      : null;
  }

  _shouldRestoreExperimentIdFromSnapshot(normalized, currentExperimentId) {
    if (!normalized) {
      return false;
    }
    if (!currentExperimentId) {
      return true;
    }
    if (currentExperimentId === normalized) {
      return false;
    }
    if (this._experimentIdSetAfterSyncReady) {
      Logger.debug("已有同步就緒後的實驗 ID，跳過從工作階段快照還原舊 ID", {
        currentExperimentId,
        restoredExperimentId: normalized,
      });
      return false;
    }
    return true;
  }

  hydrateExperimentIdFromSessionState() {
    const snapshot = this.syncClient?.getLatestSessionState?.();
    const normalized = this._getExperimentIdFromSessionSnapshot(snapshot);
    if (!normalized) {
      return;
    }

    const currentExperimentId = this.getExperimentId();
    if (!this._shouldRestoreExperimentIdFromSnapshot(normalized, currentExperimentId)) {
      return;
    }

    this.setExperimentId(normalized, RECORD_SOURCES.HUB_SYNC, {
      silent: false,
    });
    Logger.debug("從工作階段快照還原實驗 ID", normalized);
  }

  /**
   * 根據角色更新模式
   */
  updateModeFromRole() {
    const role = this.connection.role;
    if (role === this.roleConfig.VIEWER) {
      this.setViewerMode(true);
    } else if (this.connection.connected) {
      this.connection.mode = EXPERIMENT_HUB_CONSTANTS.MODE.HUB;
    }
  }

  /**
   * 連接到 Hub
   */
  async connect() {
    if (this.connection.connected) {
      Logger.debug("已經連接到 Hub");
      return true;
    }

    if (!this.syncClientReady) {
      Logger.warn("SyncClient 尚未就緒");
      return false;
    }

    Logger.debug("等待 Hub 連接...");
    return true;
  }

  _flushPendingExperimentIdRegistration() {
    const pendingId = this._pendingExperimentIdRegistration;
    if (!pendingId) {
      return;
    }

    if (!this._wsClient || !this.connection.connected) {
      return;
    }

    Logger.debug("連接完成，嘗試重新註冊待處理的實驗 ID", pendingId);
    this.registerExperimentId(pendingId);
  }

  /**
   * 斷開與 Hub 的連接
   */
  disconnect() {
    if (!this.connection.connected) {
      Logger.debug("已經斷開連接");
      return;
    }

    this.connection.connected = false;
    this.emit(EXPERIMENT_HUB_CONSTANTS.EVENT.DISCONNECTED);
    Logger.info("已斷開 Hub 連接");
  }

  /**
   * 發送訊息到 Hub
   */
  sendMessage(type, data) {
    if (!this.connection.connected) {
      Logger.warn("未連接到 Hub，無法發送訊息");
      return false;
    }

    if (!this._wsClient) {
      Logger.error("WebSocket 客戶端不存在");
      return false;
    }

    try {
      this._wsClient.emit(type, data);
      Logger.debug("已發送訊息到 Hub", { type, data });
      return true;
    } catch (error) {
      Logger.error("發送訊息失敗", error);
      this.emit(EXPERIMENT_HUB_CONSTANTS.EVENT.ERROR, {
        type: EXPERIMENT_HUB_CONSTANTS.MESSAGE_TYPES.SEND_FAILED,
        error,
      });
      return false;
    }
  }

  /**
   * 同步實驗 ID 到 Hub
   */
  syncExperimentIdToHub(experimentId, source = RECORD_SOURCES.LOCAL_INPUT) {
    const data = {
      experimentId,
      source,
      clientId: this.getClientId(),
      timestamp: Date.now(),
    };

    const syncClient = this.syncClient;
    if (syncClient?.syncState) {
      const updateData = {
        type: SYNC_DATA_TYPES.EXPERIMENT_ID_UPDATE,
        clientId: syncClient?.clientId,
        timestamp: Date.now(),
        ...data,
      };

      if (!this.experimentSyncCore?.safeBroadcast) {
        Logger.warn("experimentSyncCore 未 inject，改用 Hub 訊息同步");
        this.sendMessage(
          EXPERIMENT_HUB_CONSTANTS.MESSAGE_TYPES.EXPERIMENT_ID_UPDATE,
          data,
        );
        return;
      }

      this.experimentSyncCore.safeBroadcast(updateData).catch((error) => {
        Logger.warn("同步實驗 ID 更新失敗:", error);
      });
      Logger.debug("實驗 ID 已廣播", experimentId);
    } else {
      this.sendMessage(
        EXPERIMENT_HUB_CONSTANTS.MESSAGE_TYPES.EXPERIMENT_ID_UPDATE,
        data,
      );
    }
  }

  /**
   * 查詢連接狀態
   */
  isConnected() {
    return this.connection.connected;
  }

  /**
   * 取得客戶端 ID
   */
  getClientId() {
    return this.syncClient?.clientId || EXPERIMENT_HUB_CONSTANTS.DEFAULTS.CLIENT_ID;
  }

  /**
   * 取得目前角色
   */
  getRole() {
    return this.connection.role || null;
  }

  /**
   * 取得管理器狀態
   */
  getState() {
    return {
      ids: { ...this.ids },
      connection: {
        mode: this.connection.mode,
        connected: this.connection.connected,
        role: this.connection.role,
      },
      config: { ...this.config },
    };
  }

  /**
   * 銷毀管理器
   */
  destroy() {
    this.disconnect();
    this.clearListeners();
    Logger.debug("ExperimentHubManager 已銷毀");
  }
}

export default ExperimentHubManager;
export { ExperimentHubManager };
