/**
 * WebSocketClient - WebSocket 客戶端
 *
 * 功能:
 * - 管理 WebSocket 連接生命週期
 * - 支援重新整理後自動恢復連接（使用 sessionStorage）
 * - 心跳保持連接
 * - 自動重連機制
 * - 訊息路由與事件分發
 */

import { SYNC_EVENTS, SYNC_ROLE_CONFIG } from "../constants/index.js";
import { Logger } from "./console-manager.js";
import { WS_PROTOCOL } from "../../shared/ws-protocol-constants.js";

// 高頻訊息類型集合（模組層級常數，避免每則訊息重新分配）
const HIGH_FREQUENCY_TYPES = new Set([
  WS_PROTOCOL.S2C.HEARTBEAT_ACK,
  WS_PROTOCOL.S2C.SESSION_STATE_UPDATE,
  WS_PROTOCOL.S2C.STATE_UPDATE_ACK,
]);

class WebSocketClient {
  /**
   * 建立 WebSocketClient。
   * @param {Object} options - 連線與行為設定。
   * @param {string} [options.url] - WebSocket 連線網址。
   * @param {Object} [options.roleConfig] - 角色識別值。
   * @param {number} [options.heartbeatInterval] - 心跳間隔（毫秒）。
   * @param {number} [options.reconnectInterval] - 重連間隔基準（毫秒）。
   * @param {number} [options.maxReconnectAttempts] - 最大重連次數。
   * @param {string} [options.storagePrefix] - sessionStorage 前綴。
   * @param {boolean} [options.autoReconnect=true] - 是否自動重連。
   * @param {number} [options.maxMessageQueueSize=500] - 佇列最大長度。
   */
  constructor(options = {}) {
    this.config = {
      url: options.url || this.getDefaultWebSocketUrl(),
      heartbeatInterval: options.heartbeatInterval || 30000,
      reconnectInterval: options.reconnectInterval || 3000,
      maxReconnectAttempts: options.maxReconnectAttempts || 5,
      storagePrefix: options.storagePrefix || "panel_",
      autoReconnect: options.autoReconnect !== false,
    };

    this.roleConfig = {
      ...SYNC_ROLE_CONFIG,
      ...options.roleConfig,
    };
    this.timeSyncManager = options.timeSyncManager || null;

    this.ws = null;
    this.wsConnectionId = null;
    this.clientId = null;
    this.sessionId = null;
    this.role = null;
    this.clientType = null;
    this.isAuthenticated = false;
    this.reconnectAttempts = 0;

    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.lastHeartbeatAck = null;

    this.eventHandlers = new Map();

    this.messageQueue = [];
    this.maxMessageQueueSize = options.maxMessageQueueSize || 500;
    this._lastSeq = 0;
    this._pendingStateRecovery = false;
    this._stateRecoveryTimer = null;
    this._stateRecoveryCooldown = options.stateRecoveryCooldown || 8000;

    this.handleOpen = this.handleOpen.bind(this);
    this.handleMessage = this.handleMessage.bind(this);
    this.handleClose = this.handleClose.bind(this);
    this.handleError = this.handleError.bind(this);
    this._handleVisibilityChange = this._handleVisibilityChange.bind(this);

    this._setupVisibilityHandler();
  }

  /**
   * 監聽 Page Visibility API，讓安卓瀏覽器從背景返回時立即確認連線狀態。
   * 安卓 Chrome 在背景時會凍結 setInterval（含 heartbeat），
   * 返回前景時 server 可能已判斷斷線，需主動重連。
   */
  _setupVisibilityHandler() {
    if (typeof document === "undefined") return;
    document.addEventListener("visibilitychange", this._handleVisibilityChange);
  }

  _handleVisibilityChange() {
    if (document.visibilityState !== "visible") return;

    Logger.debug("[WebSocketClient] 頁面恢復前景，檢查連線狀態");

    if (!this.isAuthenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.sessionId && this.config.autoReconnect) {
        Logger.info("[WebSocketClient] 頁面恢復前景，重新建立連線");
        this.reconnectAttempts = 0;
        this.connect({
          sessionId: this.sessionId,
          clientId: this.clientId,
          role: this.role,
          clientType: this.clientType,
        });
      }
      return;
    }

    // 連線仍開著：送 heartbeat 確認 server 存活，並主動拉取最新狀態
    // 以防背景期間有狀態更新遺漏
    this.send({
      type: WS_PROTOCOL.C2S.HEARTBEAT,
      data: { clientId: this.clientId, timestamp: Date.now() },
    });

    if (this.sessionId) {
      this.send({
        type: WS_PROTOCOL.C2S.GET_SESSION_STATE,
        data: { sessionId: this.sessionId, lastSeq: this._lastSeq },
      });
      Logger.debug("[WebSocketClient] 頁面恢復前景，主動拉取最新工作階段狀態");
    }

    this.emit("visibility_restored", { sessionId: this.sessionId, clientId: this.clientId });
  }

  _clearStateRecoveryLock() {
    this._pendingStateRecovery = false;
    if (this._stateRecoveryTimer) {
      clearTimeout(this._stateRecoveryTimer);
      this._stateRecoveryTimer = null;
    }
  }

  _requestSessionStateRecovery() {
    if (!this.sessionId || !this.isAuthenticated) {
      return;
    }

    if (this._pendingStateRecovery) {
      Logger.debug(
        "[WebSocketClient] 已有進行中的狀態回補請求，略過重複請求",
      );
      return;
    }

    this._pendingStateRecovery = true;
    this._stateRecoveryTimer = setTimeout(() => {
      this._clearStateRecoveryLock();
    }, this._stateRecoveryCooldown);

    Logger.info(
      `[WebSocketClient] 發現序列號遺漏，請求伺服器回補工作階段狀態 (sessionId=${this.sessionId}, lastSeq=${this._lastSeq})`,
    );

    this.send({
      type: WS_PROTOCOL.C2S.GET_SESSION_STATE,
      data: { sessionId: this.sessionId, lastSeq: this._lastSeq },
    });
  }

  /**
   * 取得預設 WebSocket URL。
   * 會依目前網域與頁面路徑自動組合 ws / wss 端點。
   * @returns {string}
   */
  getDefaultWebSocketUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const basePath = this.getWebSocketBasePath();

    return `${protocol}//${host}${basePath}`;
  }

  /**
   * 取得 WebSocket 路徑前綴。
   * @returns {string}
   */
  getWebSocketBasePath() {
    const pathname = window.location.pathname;
    let basePath = pathname.endsWith("/")
      ? pathname
      : pathname.substring(0, pathname.lastIndexOf("/") + 1);
    return basePath + "ws";
  }

  /**
   * 初始化並建立連接。
   * @param {Object} authData - 認證資料。
   * @param {string} authData.sessionId - 工作階段 ID。
   * @param {string} [authData.clientId] - 客戶端 ID。
   * @param {string} [authData.role] - 角色。
   * @param {string} [authData.clientType] - 客戶端類型。
   * @returns {Promise<void>}
   */
  async connect(authData = {}) {
    const savedData = this.loadFromStorage();

    this.sessionId = authData.sessionId || savedData.sessionId;
    this.clientId = authData.clientId || savedData.clientId;
    this.role = authData.role || savedData.role || this.roleConfig.VIEWER;
    this.clientType =
      authData.clientType ||
      savedData.clientType ||
      this.detectClientType();

    if (!this.sessionId) {
      throw new Error("缺少 sessionId，無法連接");
    }

    if (this.ws) {
      const oldWs = this.ws;
      oldWs.onopen = null;
      oldWs.onmessage = null;
      oldWs.onclose = null;
      oldWs.onerror = null;
      if (
        oldWs.readyState === WebSocket.OPEN ||
        oldWs.readyState === WebSocket.CONNECTING
      ) {
        oldWs.close(1000, "Replaced by new connection");
      }
      this.ws = null;
      Logger.debug("[WebSocketClient] 已清除舊連接");
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    Logger.info(
      "[WebSocketClient] 正在連接到 WebSocket 伺服器...",
      this.config.url,
    );

    try {
      this.ws = new WebSocket(this.config.url);

      this.ws.onopen = this.handleOpen;
      this.ws.onmessage = this.handleMessage;
      this.ws.onclose = this.handleClose;
      this.ws.onerror = this.handleError;
    } catch (error) {
      Logger.error("[WebSocketClient] WebSocket 連接失敗:", error);
      throw error;
    }
  }

  /**
   * 處理連線開啟事件。
   * @param {Event} event - WebSocket open event。
   */
  handleOpen(event) {
    Logger.info("[WebSocketClient] WebSocket 連接已建立");
    this.reconnectAttempts = 0;
    this._clearStateRecoveryLock();
  }

  /**
   * 處理收到的訊息。
   * @param {MessageEvent} event - WebSocket message event。
   */
  handleMessage(event) {
    try {
      const message = JSON.parse(event.data);
      const { type, data, seq } = message;

      // 序列號追蹤：偵測遺漏訊息
      if (seq != null && seq > 0) {
        if (this._lastSeq > 0 && seq !== this._lastSeq + 1) {
          const missingCount = seq - this._lastSeq - 1;
          if (missingCount > 0) {
            Logger.warn(
              `[WebSocketClient] 訊息序列號不連續：期望 ${this._lastSeq + 1}，收到 ${seq}，可能遺漏 ${missingCount} 筆`,
            );
            this._requestSessionStateRecovery();
          } else {
            Logger.warn(
              `[WebSocketClient] 收到過舊或重複的序列號：期望 ${this._lastSeq + 1}，收到 ${seq}`,
            );
          }
        }
        this._lastSeq = seq;
      }

      if (HIGH_FREQUENCY_TYPES.has(type)) {
        Logger.debug(`[WebSocketClient] 收到訊息 [${type}]`);
      } else {
        Logger.debug(`[WebSocketClient] 收到訊息 [${type}]:`, data);
      }

      switch (type) {
        case WS_PROTOCOL.S2C.CONNECTED:
          this.handleConnected(data);
          break;

        case WS_PROTOCOL.S2C.AUTH_SUCCESS:
          this.handleAuthSuccess(data);
          break;

        case WS_PROTOCOL.S2C.CLEAR_SYNC_DATA:
          Logger.warn("[WebSocketClient] 處理 clear_sync_data 訊息");
          this.handleClearSyncData(data);
          break;

        case WS_PROTOCOL.S2C.HEARTBEAT_ACK:
          this.handleHeartbeatAck(data);
          break;

        case WS_PROTOCOL.S2C.SESSION_STATE:
          this._clearStateRecoveryLock();
          this.emit(WS_PROTOCOL.S2C.SESSION_STATE, data);
          break;

        case WS_PROTOCOL.S2C.REQUEST_CLIENT_STATE:
          this.emit(WS_PROTOCOL.S2C.REQUEST_CLIENT_STATE, data);
          break;

        case WS_PROTOCOL.S2C.KICKED:
          this.handleKicked(data);
          break;

        case WS_PROTOCOL.S2C.SYNC_STATE:
          this._clearStateRecoveryLock();
          Logger.debug("[WebSocketClient] 收到 sync_state 推送，轉換為 session_state 事件");
          this.emit(WS_PROTOCOL.S2C.SESSION_STATE, data);
          this.emit(WS_PROTOCOL.S2C.SYNC_STATE, data);
          break;

        case WS_PROTOCOL.S2C.SESSION_STATE_UPDATE:
          this.emit(WS_PROTOCOL.S2C.SESSION_STATE_UPDATE, data);
          break;

        case WS_PROTOCOL.S2C.CLIENT_JOINED:
          this.emit("client_joined", data);
          break;

        case WS_PROTOCOL.S2C.CLIENT_LEFT:
          this.emit("client_left", data);
          break;

        case WS_PROTOCOL.S2C.CLIENT_RECONNECTED:
          this.emit("client_reconnected", data);
          break;

        case WS_PROTOCOL.S2C.STATE_UPDATE_ACK:
          Logger.debug("[WebSocketClient] 伺服器確認狀態更新", data);
          break;

        case WS_PROTOCOL.S2C.EXPERIMENT_STARTED:
        case WS_PROTOCOL.S2C.EXPERIMENT_PAUSED:
        case WS_PROTOCOL.S2C.EXPERIMENT_RESUMED:
        case WS_PROTOCOL.S2C.EXPERIMENT_STOPPED:
        case WS_PROTOCOL.S2C.EXPERIMENT_ID_CHANGED:
          this.emit(type, data);
          break;

        case WS_PROTOCOL.S2C.ERROR:
          this.handleServerError(data);
          break;

        default:
          Logger.warn(`[WebSocketClient] 未知的訊息類型: ${type}`);
      }
    } catch (error) {
      Logger.error("[WebSocketClient] 解析訊息失敗:", error, event.data);
    }
  }

  /**
   * 處理連線成功通知。
   * @param {Object} data - 伺服器傳回的 connected 資料。
   */
  handleConnected(data) {
    this.wsConnectionId = data.wsConnectionId;
    Logger.debug(`[WebSocketClient] WebSocket 連接 ID: ${this.wsConnectionId}`);

    // 以 server 提供的 heartbeat 間隔為準，確保雙端一致
    if (data.heartbeatInterval && typeof data.heartbeatInterval === "number") {
      this.config.heartbeatInterval = data.heartbeatInterval;
      Logger.debug(
        `[WebSocketClient] 採用 server 心跳間隔: ${data.heartbeatInterval}ms`,
      );
    }

    this.authenticate();
  }

  /**
   * 送出認證訊息。
   */
  authenticate() {
    if (!this.sessionId) {
      Logger.error("[WebSocketClient] 無法認證：缺少 sessionId");
      return;
    }

    Logger.debug("[WebSocketClient] 正在認證...", {
      sessionId: this.sessionId,
      clientId: this.clientId,
      role: this.role,
      clientType: this.clientType,
    });

    this.send({
      type: WS_PROTOCOL.C2S.AUTH,
      data: {
        sessionId: this.sessionId,
        clientId: this.clientId,
        role: this.role,
        clientType: this.clientType,
      },
    });
  }

  /**
   * 處理認證成功。
   * @param {Object} data - 驗證成功資料。
   */
  handleAuthSuccess(data) {
    const { sessionId, clientId, role, roomInfo, isReconnect, serverTime } =
      data;

    this.sessionId = sessionId;
    this.clientId = clientId;
    this.role = role;
    this.isAuthenticated = true;
    if (!isReconnect) {
      this._lastSeq = 0; // 新連線重置序列號
    }

    this.saveToStorage();

    if (serverTime) {
      this.timeSyncManager?.syncWithWebSocket?.(serverTime);
    }

    this.startHeartbeat();

    this.flushMessageQueue();

    if (isReconnect) {
      Logger.info("[WebSocketClient] 重新連接成功！已恢復狀態");
      this.emit("reconnected", { clientId, sessionId, role });
    } else {
      Logger.info("[WebSocketClient] 認證成功！");
      this.emit("authenticated", { clientId, sessionId, role, roomInfo });
    }
  }

  /**
   * 處理清除同步資料命令。
   * @param {Object} data - 清除命令資料。
   */
  handleClearSyncData(data) {
    const { reason, message } = data;

    Logger.warn(
      `[WebSocketClient] 接收到清除同步數據命令 [${reason}]: ${message}`,
    );

    this.config.autoReconnect = false;
    Logger.debug("[WebSocketClient] 已停用自動重連");

    const clearEvent = new CustomEvent(SYNC_EVENTS.DATA_CLEARED, {
      detail: {
        reason,
        message,
        timestamp: Date.now(),
      },
    });

    Logger.debug("[WebSocketClient] 準備派發 sync_data_cleared 事件", {
      reason,
      message,
    });

    window.dispatchEvent(clearEvent);
    Logger.info("[WebSocketClient] 已派發 window.sync_data_cleared 事件");

    this.emit("sync_data_cleared", {
      reason,
      message,
      timestamp: Date.now(),
    });

    Logger.info(
      `[WebSocketClient] 已派發內部 sync_data_cleared 事件 [${reason}]`,
    );

    Logger.debug("[WebSocketClient] 100ms 後斷開連線...");
    setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        Logger.info("[WebSocketClient] 斷開 WebSocket 連線");
        this.ws.close(1000, "Session not found, clearing sync data");
      }
    }, 100);
  }

  /**
   * 處理連線關閉事件。
   * @param {CloseEvent} event - WebSocket close event。
   */
  handleClose(event) {
    Logger.info(
      `[WebSocketClient] WebSocket 連接已關閉 [${event.code}]: ${event.reason}`,
    );

    this._clearStateRecoveryLock();
    this.isAuthenticated = false;
    this.stopHeartbeat();

    this.emit("disconnected", { code: event.code, reason: event.reason });

    if (
      this.config.autoReconnect &&
      this.reconnectAttempts < this.config.maxReconnectAttempts
    ) {
      this.scheduleReconnect();
    }
  }

  /**
   * 處理 WebSocket 錯誤。
   * @param {Event} event - WebSocket error event。
   */
  handleError(event) {
    Logger.error("[WebSocketClient] WebSocket 錯誤:", event);
    this.emit("error", event);
  }

  /**
   * 處理伺服器錯誤訊息。
   * @param {Object} data - 錯誤資料。
   */
  handleServerError(data) {
    Logger.error("[WebSocketClient] 伺服器錯誤:", data);

    if (data && data.message && data.message.includes("工作階段不存在")) {
      Logger.warn("[WebSocketClient] 偵測到工作階段不存在錯誤，發送清理事件");
      window.dispatchEvent(
        new CustomEvent(SYNC_EVENTS.WEBSOCKET_SESSION_INVALID, {
          detail: {
            reason: "session_not_found",
            originalError: data,
          },
        }),
      );
    }

    this.emit("server_error", data);
  }

  handleKicked(data) {
    const reason = data?.reason || "admin_kick";
    Logger.warn(`[WebSocketClient] 收到強制退出通知: ${reason}`);

    // 停用自動重連，並清除本機儲存，避免在斷線後自動恢復同步
    this.config.autoReconnect = false;
    this.clearStorage();
    this.close();

    window.dispatchEvent(
      new CustomEvent(SYNC_EVENTS.WEBSOCKET_SESSION_INVALID, {
        detail: {
          reason: "kicked",
          originalError: data,
        },
      }),
    );

    this.emit("kicked", data);
  }

  /**
   * 排程重新連接。
   * 使用指數退避＋隨機抖動，避免多裝置同時衝擊 server。
   * 延遲上限 30 秒：base * 2^(attempt-1) ± 10% jitter。
   */
  scheduleReconnect() {
    this.reconnectAttempts++;
    const base = this.config.reconnectInterval;
    const exponential = base * Math.pow(2, this.reconnectAttempts - 1);
    const capped = Math.min(exponential, 30000);
    const jitter = capped * 0.1 * (Math.random() * 2 - 1);
    const delay = Math.round(capped + jitter);

    Logger.info(
      `[WebSocketClient] 將在 ${delay}ms 後嘗試重新連接 (第 ${this.reconnectAttempts} 次)`,
    );

    this.reconnectTimer = setTimeout(() => {
      Logger.debug("[WebSocketClient] 正在重新連接...");
      this.connect({
        sessionId: this.sessionId,
        clientId: this.clientId,
        role: this.role,
      });
    }, delay);
  }

  /**
   * 啟動心跳。
   */
  startHeartbeat() {
    this.stopHeartbeat();
    this.lastHeartbeatAck = Date.now();

    this.heartbeatTimer = setInterval(() => {
      if (!this.isAuthenticated) return;

      // 偵測伺服器單向失聯：若超過 3 個心跳週期未收到 ACK，主動重連
      const silenceTimeout = this.config.heartbeatInterval * 3;
      if (this.lastHeartbeatAck && Date.now() - this.lastHeartbeatAck > silenceTimeout) {
        Logger.warn("[WebSocketClient] 心跳 ACK 超時，伺服器可能已失聯，主動重連");
        this.isAuthenticated = false;
        if (this.ws) {
          this.ws.close(4001, "heartbeat_timeout");
        }
        return;
      }

      this.send({
        type: WS_PROTOCOL.C2S.HEARTBEAT,
        data: {
          clientId: this.clientId,
          timestamp: Date.now(),
        },
      });
    }, this.config.heartbeatInterval);

    Logger.debug(
      `[WebSocketClient] 心跳已啟動 (間隔: ${this.config.heartbeatInterval}ms)`,
    );
  }

  /**
   * 停止心跳。
   */
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 處理心跳確認。
   */
  handleHeartbeatAck(data) {
    this.lastHeartbeatAck = Date.now();
    // 用伺服器回傳的時間做時間同步（若有提供）
    if (data?.serverTime) {
      this.timeSyncManager?.syncWithWebSocket?.(data.serverTime);
    }
  }

  /**
   * 送出訊息；若尚未連線則先加入佇列。
   * @param {Object} message - 要送出的訊息。
   * @returns {boolean}
   */
  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.messageQueue.length >= this.maxMessageQueueSize) {
        Logger.warn(
          `[WebSocketClient] 消息佇列已達最大限制 (${this.maxMessageQueueSize}/${this.maxMessageQueueSize})，舊消息可能被丟棄`,
          { queueSize: this.messageQueue.length },
        );
        this.messageQueue.shift();
      }

      this.messageQueue.push(message);
      Logger.debug(
        `[WebSocketClient] WebSocket 未連接，訊息已加入佇列 (佇列大小: ${this.messageQueue.length}/${this.maxMessageQueueSize})`,
      );
      return false;
    }

    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      Logger.error("[WebSocketClient] 發送訊息失敗:", error);
      this.messageQueue.push(message);
      return false;
    }
  }

  /**
   * 發送已累積的佇列訊息。
   */
  flushMessageQueue() {
    if (this.messageQueue.length === 0) return;

    Logger.debug(
      `[WebSocketClient] 發送佇列中的 ${this.messageQueue.length} 條訊息`,
    );

    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      this.send(message);
    }
  }

  /**
   * 更新工作階段狀態。
   * @param {Object} state - 要同步的狀態。
   */
  updateState(state) {
    this.send({
      type: WS_PROTOCOL.C2S.STATE_UPDATE,
      data: {
        sessionId: this.sessionId,
        clientId: this.clientId,
        state,
      },
    });
  }

  /**
   * 註冊事件處理器。
   * @param {string} event - 事件名稱。
   * @param {Function} handler - 處理函數。
   */
  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
  }

  /**
   * 移除事件處理器。
   * @param {string} event - 事件名稱。
   * @param {Function} handler - 處理函數。
   */
  off(event, handler) {
    if (!this.eventHandlers.has(event)) return;

    const handlers = this.eventHandlers.get(event);
    const index = handlers.indexOf(handler);
    if (index > -1) {
      handlers.splice(index, 1);
    }
  }

  /**
   * 觸發事件。
   * @param {string} event - 事件名稱。
   * @param {*} data - 事件資料。
   */
  emit(event, data) {
    if (!this.eventHandlers.has(event)) return;

    const handlers = this.eventHandlers.get(event);
    handlers.forEach((handler) => {
      try {
        handler(data);
      } catch (error) {
        Logger.error(`[WebSocketClient] 事件處理器錯誤 [${event}]:`, error);
      }
    });
  }

  /**
   * 儲存連接資訊到 sessionStorage。
   */
  saveToStorage() {
    const prefix = this.config.storagePrefix;

    try {
      sessionStorage.setItem(`${prefix}clientId`, this.clientId);
      sessionStorage.setItem(`${prefix}sessionId`, this.sessionId);
      sessionStorage.setItem(`${prefix}role`, this.role);

      Logger.debug("[WebSocketClient] 連接資訊已儲存至 sessionStorage");
    } catch (error) {
      Logger.error("[WebSocketClient] 儲存至 sessionStorage 失敗:", error);
    }
  }

  /**
   * 從 sessionStorage 載入連接資訊。
   * @returns {{clientId?: string, sessionId?: string, role?: string}}
   */
  loadFromStorage() {
    const prefix = this.config.storagePrefix;

    try {
      const clientId = sessionStorage.getItem(`${prefix}clientId`);
      const sessionId = sessionStorage.getItem(`${prefix}sessionId`);
      const role = sessionStorage.getItem(`${prefix}role`);

      if (clientId && sessionId) {
        Logger.debug("[WebSocketClient] 從 sessionStorage 恢復連接資訊:", {
          clientId,
          sessionId,
          role,
        });
        return { clientId, sessionId, role };
      }
    } catch (error) {
      Logger.error("[WebSocketClient] 從 sessionStorage 載入失敗:", error);
    }

    return {};
  }

  /**
   * 清除 sessionStorage 中的連接資訊。
   */
  clearStorage() {
    const prefix = this.config.storagePrefix;

    try {
      sessionStorage.removeItem(`${prefix}clientId`);
      sessionStorage.removeItem(`${prefix}sessionId`);
      sessionStorage.removeItem(`${prefix}role`);

      Logger.debug("[WebSocketClient] 已清除 sessionStorage");
    } catch (error) {
      Logger.error("[WebSocketClient] 清除 sessionStorage 失敗:", error);
    }
  }

  /**
   * 手動重新連接。
   */
  reconnect() {
    Logger.info("[WebSocketClient] 手動重新連接...");
    this.reconnectAttempts = 0;
    this.close();
    this.connect({
      sessionId: this.sessionId,
      clientId: this.clientId,
      role: this.role,
      clientType: this.clientType,
    });
  }

  detectClientType() {
    const path = (window.location.pathname || "").toLowerCase();
    return path.includes("board.html") ? "board" : "panel";
  }

  /**
   * 關閉連接但保留儲存資訊。
   */
  close() {
    Logger.info("[WebSocketClient] 正在關閉 WebSocket 連接...");

    this.config.autoReconnect = false; // 停用自動重連
    this.stopHeartbeat();

    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this._handleVisibilityChange);
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close(1000, "Client closing");
      this.ws = null;
    }

    this.isAuthenticated = false;
  }

  /**
   * 完全斷開連接並清除儲存資料。
   */
  disconnect() {
    this.close();
    this.clearStorage();
    Logger.info("[WebSocketClient] 已完全斷開連接");
  }

  /**
   * 取得目前連接狀態快照。
   * @returns {Object}
   */
  getState() {
    return {
      connected: this.ws && this.ws.readyState === WebSocket.OPEN,
      authenticated: this.isAuthenticated,
      wsConnectionId: this.wsConnectionId,
      clientId: this.clientId,
      sessionId: this.sessionId,
      role: this.role,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}

// ES6 模組匯出
export default WebSocketClient;
export { WebSocketClient };
