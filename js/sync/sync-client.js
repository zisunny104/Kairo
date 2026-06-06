/**
 * SyncClient - 多裝置同步客戶端
 *
 * 負責 WebSocket + REST API 混合架構的同步、工作階段管理、狀態同步、
 * 心跳檢測與分享代碼管理，支援多客戶端協同同步。
 */

import {
  SYNC_EVENTS,
  SYNC_DATA_TYPES,
  SYNC_MANAGER_CONSTANTS,
  SYNC_CLIENT_CONSTANTS,
  SYNC_PAGE_CONFIG,
  SYNC_ROLE_CONFIG,
  SYNC_STATUS_CONFIG,
  getSyncPagePath,
  getSyncPageName,
  API_ENDPOINTS,
} from "../constants/index.js";
import { Logger } from "../core/console-manager.js";
import { WS_PROTOCOL } from "../../shared/ws-protocol-constants.js";
import { WebSocketClient } from "../core/websocket-client.js";
import { getApiUrl } from "../core/url-utils.js";

class SyncClient {
  /**
   * 建構函數
   * @param {Object} config - 設定選項
   */
  constructor(config = {}) {
    this.roleConfig = {
      ...SYNC_ROLE_CONFIG,
      ...config.roleConfig,
    };
    // API 端點設定
    this.apiBaseUrl = config.apiBaseUrl || getApiUrl();
    this.clientType = this.detectClientType();

    // WebSocket 客戶端（延遲初始化）
    this.wsClient = null;
    this.wsConfig = {
      url: config.wsUrl,
      storagePrefix: SYNC_CLIENT_CONSTANTS.STORAGE_PREFIX,
      autoReconnect: true,
    };
    this.timeSyncManager = config.timeSyncManager || null;

    // 連線和狀態管理
    this.sessionId = null;
    this.clientId = null;
    this.role = this.roleConfig.LOCAL;
    this.connected = false;
    this.serverOnline = true;
    this.previousServerOnline = true;
    this.initialized = false;
    this.sessionInvalid = false;
    this.connectionAttempted = false;
    this.sessionStore = config.sessionStore || null;

    // 從外部注入的工作階段儲存器載入狀態（若有）
    this.loadState();

    // 心跳檢測定時器
    this.healthCheckTimer = null;
    this.healthCheckInterval =
      SYNC_CLIENT_CONSTANTS.DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.lastHealthCheckTime = 0;
    this.healthCheckCacheTtl =
      SYNC_CLIENT_CONSTANTS.DEFAULT_HEALTH_CHECK_CACHE_TTL_MS;
    this.healthCheckLoopActive = false;
    this.healthCheckInProgress = false;

    // 狀態更新節流：同一幀只派發最後一筆，避免 message handler 連續重負載
    this.pendingStateUpdate = null;
    this.stateUpdateFlushScheduled = false;
    this.stateUpdateFlushTimer = null;
    this.latestSessionState = null;

    // 如果有儲存的 sessionId，代表之前加入過工作階段
    if (this.sessionId) {
      Logger.info("偵測到儲存的工作階段，準備恢復連線");
    } else {
      // 無 session 時只做一次初始檢查，讓 UI 知道 server 是否可達。
      // 後續狀態由 WS 事件（_updateServerOnline）維護，不需要持續 polling。
      void this.checkServerHealth();
    }

    // 監聽全域工作階段失效事件
    this.setupGlobalEventHandlers();
  }

  /**
   * 設定全域事件處理器
   */
  setupGlobalEventHandlers() {
    // 先移除舊的 handler（防止每次重新初始化時重複累積）
    if (this._sessionInvalidHandler) {
      window.removeEventListener(SYNC_EVENTS.WEBSOCKET_SESSION_INVALID, this._sessionInvalidHandler);
    }
    this._sessionInvalidHandler = (event) => {
      const { reason, originalError } = event.detail;
      Logger.warn("收到全域工作階段失效事件", { reason, originalError });

      this.sessionInvalid = true;
      this.clearInvalidSessionData();

      window.dispatchEvent(
        new CustomEvent(SYNC_EVENTS.SESSION_INVALID, {
          detail: { reason, originalError },
        }),
      );
    };
    window.addEventListener(SYNC_EVENTS.WEBSOCKET_SESSION_INVALID, this._sessionInvalidHandler);
  }

  /**
   * 初始化同步功能
   */
  initializeSync() {
    if (this.initialized) {
      Logger.debug("同步功能已初始化，跳過");
      return;
    }

    const initStart = performance.now();

    Logger.info("初始化同步功能...");

    this.stopHealthCheck();

    this.wsClient = new WebSocketClient({
      ...this.wsConfig,
      roleConfig: this.roleConfig,
      timeSyncManager: this.timeSyncManager,
    });
    this.setupWebSocketHandlers();

    this.initialized = true;
    const duration = performance.now() - initStart;
    Logger.info(
      `同步功能初始化完成，切換到 WebSocket 狀態監聽 (<orange>${duration.toFixed(0)} ms</orange>)`,
    );
  }

  detectClientType() {
    const path = (window.location.pathname || "").toLowerCase();
    const boardPath = getSyncPagePath(SYNC_PAGE_CONFIG.BOARD).toLowerCase();
    return path.includes(boardPath)
      ? SYNC_PAGE_CONFIG.BOARD
      : SYNC_PAGE_CONFIG.PANEL;
  }

  /**
   * 設定 WebSocket 事件處理器
   */
  setupWebSocketHandlers() {
    this.wsClient.on(SYNC_CLIENT_CONSTANTS.EVENT_NAMES.AUTHENTICATED, (data) => {
      Logger.debug("WebSocket 認證成功", data);
      this.connected = true;
      this.connectionAttempted = false;
      this.sessionId = data.sessionId;
      this.clientId = data.clientId;
      this.role = data.role;
      this.saveState();

      this._updateServerOnline(true);

      window.dispatchEvent(
        new CustomEvent(SYNC_EVENTS.CONNECTED, { detail: data }),
      );
    });

    this.wsClient.on(SYNC_CLIENT_CONSTANTS.EVENT_NAMES.RECONNECTED, (data) => {
      Logger.debug("WebSocket 重新連接成功", data);
      this.connected = true;
      this.connectionAttempted = false;

      this._updateServerOnline(true);

      window.dispatchEvent(
        new CustomEvent(SYNC_EVENTS.RECONNECTED, { detail: data }),
      );
    });

    this.wsClient.on(SYNC_CLIENT_CONSTANTS.EVENT_NAMES.DISCONNECTED, (data) => {
      Logger.info("WebSocket 已斷線", data);
      this.connected = false;
      this.connectionAttempted = true;

      this._updateServerOnline(false);

      window.dispatchEvent(
        new CustomEvent(SYNC_EVENTS.DISCONNECTED, { detail: data }),
      );
    });

    this.wsClient.on(WS_PROTOCOL.S2C.SESSION_STATE_UPDATE, (data) => {
      Logger.debug("收到狀態更新", data);
      this.triggerStateUpdate(data.state);
    });

    // 純轉發的 WS 客戶端事件（收到後直接派發至 DOM，不做額外處理）
    for (const [wsEvent, domEvent, label] of [
      [WS_PROTOCOL.S2C.CLIENT_JOINED, SYNC_EVENTS.CLIENT_JOINED, "新客戶端加入"],
      [WS_PROTOCOL.S2C.CLIENT_LEFT, SYNC_EVENTS.CLIENT_LEFT, "客戶端退出"],
      [WS_PROTOCOL.S2C.CLIENT_RECONNECTED, SYNC_EVENTS.CLIENT_RECONNECTED, "客戶端重新連接"],
    ]) {
      this.wsClient.on(wsEvent, (data) => {
        Logger.debug(label, data);
        window.dispatchEvent(new CustomEvent(domEvent, { detail: data }));
      });
    }

    this.wsClient.on(SYNC_CLIENT_CONSTANTS.EVENT_NAMES.SERVER_ERROR, (data) => {
      Logger.error("伺服器錯誤", data);

      if (data && data.message && data.message.includes("工作階段不存在")) {
        Logger.warn("偵測到工作階段不存在錯誤，自動清理工作階段資訊");

        this.sessionInvalid = true;
        this.clearInvalidSessionData();

        window.dispatchEvent(
          new CustomEvent(SYNC_EVENTS.SESSION_INVALID, {
            detail: {
              reason: SYNC_CLIENT_CONSTANTS.SESSION_NOT_FOUND_REASON,
              originalError: data,
            },
          }),
        );
      }

      window.dispatchEvent(
        new CustomEvent(SYNC_EVENTS.SERVER_ERROR, { detail: data }),
      );
    });

    // 純轉發的實驗狀態事件
    for (const [event, label] of [
      [SYNC_EVENTS.EXPERIMENT_STARTED, "收到實驗開始事件"],
      [SYNC_EVENTS.EXPERIMENT_PAUSED, "收到實驗暫停事件"],
      [SYNC_EVENTS.EXPERIMENT_RESUMED, "收到實驗繼續事件"],
      [SYNC_EVENTS.EXPERIMENT_STOPPED, "收到實驗停止事件"],
      [SYNC_EVENTS.EXPERIMENT_ID_CHANGED, "收到實驗ID變化事件"],
    ]) {
      this.wsClient.on(event, (data) => {
        Logger.debug(label, data);
        window.dispatchEvent(new CustomEvent(event, { detail: data }));
      });
    }

    this.wsClient.on(WS_PROTOCOL.S2C.SESSION_STATE, (data) => {
      Logger.debug("收到工作階段狀態", data);
      this.latestSessionState = data || null;
      window.dispatchEvent(
        new CustomEvent(SYNC_EVENTS.SESSION_STATE, { detail: data }),
      );
    });

    this.wsClient.on(WS_PROTOCOL.S2C.REQUEST_CLIENT_STATE, (data) => {
      const requestId = data?.requestId;
      if (!requestId) {
        Logger.warn("收到缺少 requestId 的請求客戶端狀態訊息");
        return;
      }

      const latestState = this.getLatestSessionState();
      let state = latestState || {
        sessionId: this.sessionId,
        clientId: this.clientId,
        role: this.role,
      };

      if (latestState && typeof latestState === "object") {
        state = this._flattenSessionState(latestState);
      }

      const localClientState = this._getLocalExperimentState();
      if (localClientState && typeof localClientState === "object") {
        state = { ...state, ...localClientState };
      }

      this.wsClient.send({
        type: WS_PROTOCOL.C2S.CLIENT_STATE_RESPONSE,
        data: {
          requestId,
          state,
          sessionId: this.sessionId,
          clientId: this.clientId,
        },
      });

      Logger.debug("已回傳客戶端狀態回應", { requestId, clientId: this.clientId });
    });

    this.wsClient.on(WS_PROTOCOL.S2C.SYNC_STATE, (data) => {
      Logger.debug("收到伺服器同步狀態推送 (sync_state)", data);
      window.dispatchEvent(
        new CustomEvent(SYNC_EVENTS.SESSION_STATE_REFRESHED, { detail: data }),
      );
    });
  }

  // ==================== 工作階段管理 ====================

  /**
   * 建立新的工作階段
   * @param {string} createCode - 建立代碼
   * @returns {Promise<{sessionId: string}>}
   */
  async createSession(createCode) {
    this.initializeSync();
    this.connectionAttempted = true;

    await this.checkServerHealth();
    if (!this.serverOnline) {
      throw new Error("伺服器離線，無法建立工作階段");
    }

    const response = await fetch(`${this.apiBaseUrl}${API_ENDPOINTS.SYNC.SESSION}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ createCode }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error((error.message || error.error || `HTTP ${response.status}`).replace(SYNC_PAGE_CONFIG.PANEL, getSyncPageName(SYNC_PAGE_CONFIG.PANEL)).replace(SYNC_PAGE_CONFIG.BOARD, getSyncPageName(SYNC_PAGE_CONFIG.BOARD)));
    }

    const data = await response.json();

    this.sessionId = data.data.sessionId;
    this.clientId = data.data.clientId;
    this.role = data.data.role;
    this.saveState();

    await this.wsClient.connect({
      sessionId: this.sessionId,
      clientId: this.clientId,
      role: this.role,
      clientType: this.clientType,
    });

    return { sessionId: data.data.sessionId };
  }

  /**
   * 產生分享代碼
   * @returns {Promise<{shareCode: string, expiresAt: string}>}
   */
  async generateShareCode() {
    if (!this.sessionId || !this.clientId) {
      throw new Error("尚未加入工作階段");
    }

    await this.checkServerHealth();
    if (!this.serverOnline) {
      throw new Error("伺服器離線，無法產生分享代碼");
    }

    const response = await fetch(
      `${this.apiBaseUrl}${API_ENDPOINTS.SYNC.GENERATE_SHARE_CODE}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: this.sessionId,
          clientId: this.clientId,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error((error.message || error.error || `HTTP ${response.status}`).replace(SYNC_PAGE_CONFIG.PANEL, getSyncPageName(SYNC_PAGE_CONFIG.PANEL)).replace(SYNC_PAGE_CONFIG.BOARD, getSyncPageName(SYNC_PAGE_CONFIG.BOARD)));
    }

    const data = await response.json();

    Logger.debug("分享代碼已產生:", data.data.shareCode);

    return {
      shareCode: data.data.shareCode,
      expiresAt: data.data.expiresAt,
    };
  }

  /**
   * 通過分享代碼加入工作階段
   * @param {string} shareCode - 分享代碼
   * @param {string} role - 角色
   * @returns {Promise<boolean>}
   */
  async joinSessionByShareCode(
    shareCode,
    role = null,
  ) {
    const resolvedRole = role || this.roleConfig.VIEWER;
    if (this.sessionInvalid) {
      this.sessionInvalid = false;
      Logger.info("重置工作階段失效標記，允許重新加入");
    }

    this.initializeSync();
    this.connectionAttempted = true;

    await this.checkServerHealth();
    if (!this.serverOnline) {
      throw new Error("伺服器離線，無法加入工作階段");
    }

    const response = await fetch(`${this.apiBaseUrl}${API_ENDPOINTS.SYNC.JOIN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shareCode,
        role: resolvedRole,
        clientId: this.clientId,
        clientType: this.clientType,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error((error.message || error.error || `HTTP ${response.status}`).replace(SYNC_PAGE_CONFIG.PANEL, getSyncPageName(SYNC_PAGE_CONFIG.PANEL)).replace(SYNC_PAGE_CONFIG.BOARD, getSyncPageName(SYNC_PAGE_CONFIG.BOARD)));
    }

    const data = await response.json();

    this.sessionId = data.data.sessionId;
    this.clientId = data.data.clientId;
    this.role = data.data.role;
    this.saveState();

    await this.wsClient.connect({
      sessionId: this.sessionId,
      clientId: this.clientId,
      role: this.role,
      clientType: this.clientType,
    });

    if (data.data.state) {
      this.latestSessionState = {
        state: data.data.state,
        source: SYNC_CLIENT_CONSTANTS.JOIN_RESPONSE_SOURCE,
      };
      window.dispatchEvent(
        new CustomEvent(SYNC_EVENTS.SESSION_STATE, {
          detail: {
            state: data.data.state,
            source: SYNC_CLIENT_CONSTANTS.JOIN_RESPONSE_SOURCE,
          },
        }),
      );
    }

    return true;
  }

  /**
   * 加入公開頻道（無需分享代碼）
   * @param {string} channelName - 頻道名稱 "A" | "B" | "C"
   * @param {string} role - 角色（預設 operator）
   * @returns {Promise<boolean>}
   */
  async joinPublicChannel(
    channelName,
    role = null,
  ) {
    const resolvedRole = role || this.roleConfig.OPERATOR;
    this.initializeSync();
    this.connectionAttempted = true;

    await this.checkServerHealth();
    if (!this.serverOnline) {
      throw new Error("伺服器離線，無法加入頻道");
    }

    const response = await fetch(`${this.apiBaseUrl}${API_ENDPOINTS.SYNC.CHANNEL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelName,
        role: resolvedRole,
        clientId: this.clientId,
        clientType: this.clientType,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error((error.message || error.error || `HTTP ${response.status}`).replace(SYNC_PAGE_CONFIG.PANEL, getSyncPageName(SYNC_PAGE_CONFIG.PANEL)).replace(SYNC_PAGE_CONFIG.BOARD, getSyncPageName(SYNC_PAGE_CONFIG.BOARD)));
    }

    const data = await response.json();

    this.sessionId = data.data.sessionId;
    this.clientId = data.data.clientId;
    this.role = data.data.role;
    this.saveState();

    await this.wsClient.connect({
      sessionId: this.sessionId,
      clientId: this.clientId,
      role: this.role,
      clientType: this.clientType,
    });

    return true;
  }

  /**
   * 關閉公開頻道（中斷所有連線）
   * @param {string} sessionId - 公開頻道 sessionId（可選）
   * @returns {Promise<Object>}
   */
  async closePublicChannel(sessionId = null) {
    const targetSessionId = sessionId || this.sessionId;
    if (
      !targetSessionId ||
      !targetSessionId.startsWith(
        SYNC_MANAGER_CONSTANTS.PUBLIC_CHANNEL_PREFIX,
      )
    ) {
      throw new Error("目前不在公開頻道");
    }

    await this.checkServerHealth();
    if (!this.serverOnline) {
      throw new Error("伺服器離線，無法關閉頻道");
    }

    const response = await fetch(`${this.apiBaseUrl}${API_ENDPOINTS.SYNC.CHANNEL_CLOSE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: targetSessionId }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error((error.message || error.error || `HTTP ${response.status}`).replace(SYNC_PAGE_CONFIG.PANEL, getSyncPageName(SYNC_PAGE_CONFIG.PANEL)).replace(SYNC_PAGE_CONFIG.BOARD, getSyncPageName(SYNC_PAGE_CONFIG.BOARD)));
    }

    const data = await response.json();
    return data.data || {};
  }

  /**
   * 關閉指定工作階段
   * @param {string} sessionId - 工作階段 ID
   * @returns {Promise<Object>}
   */
  async closeSession(sessionId = null) {
    const targetSessionId = sessionId || this.sessionId;
    if (!targetSessionId) {
      throw new Error("目前沒有可關閉的工作階段");
    }

    await this.checkServerHealth();
    if (!this.serverOnline) {
      throw new Error("伺服器離線，無法關閉工作階段");
    }

    const response = await fetch(
      `${this.apiBaseUrl}${API_ENDPOINTS.SYNC.SESSION_TARGET(targetSessionId)}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error((error.message || error.error || `HTTP ${response.status}`).replace(SYNC_PAGE_CONFIG.PANEL, getSyncPageName(SYNC_PAGE_CONFIG.PANEL)).replace(SYNC_PAGE_CONFIG.BOARD, getSyncPageName(SYNC_PAGE_CONFIG.BOARD)));
    }

    const data = await response.json();
    return data.data || {};
  }

  /**
   * 還原工作階段
   * @returns {Promise<boolean>}
   */
  async restoreSession() {
    if (this.sessionInvalid) {
      Logger.debug("工作階段已失效，跳過還原");
      return false;
    }

    if (!this.sessionId || !this.clientId) {
      Logger.debug("沒有可還原的工作階段");
      return false;
    }

    this.connectionAttempted = true;

    await this.checkServerHealth();
    if (!this.serverOnline) {
      throw new Error("伺服器離線，無法還原工作階段");
    }

    // 公開頻道不存在於 DB，跳過 validate 直接重連
    const isPublicChannel = this.sessionId.startsWith(
      SYNC_MANAGER_CONSTANTS.PUBLIC_CHANNEL_PREFIX,
    );
    if (!isPublicChannel) {
      const response = await fetch(
        `${this.apiBaseUrl}${API_ENDPOINTS.SYNC.SESSION_VALIDATE(this.sessionId, this.clientId)}`,
      );

      if (!response.ok) {
        Logger.info("工作階段已失效，清除狀態");
        this.clearState();
        return false;
      }

      const data = await response.json();

      if (!data.data.valid) {
        Logger.warn("工作階段驗證失敗，清除狀態");
        this.clearState();
        return false;
      }
    } else {
      Logger.debug("公開頻道，跳過 DB 驗證直接重連", {
        sessionId: this.sessionId,
      });
    }

    // 如果 WebSocket 已連線且已認證，跳過重複連線
    if (
      this.wsClient &&
      this.wsClient.isAuthenticated &&
      this.wsClient.ws &&
      this.wsClient.ws.readyState === WebSocket.OPEN
    ) {
      Logger.debug("WebSocket 已連線且已認證，跳過重複連線");
    } else {
      // 確保 wsClient 已初始化
      if (!this.wsClient) {
        this.initializeSync();
      }
      await this.wsClient.connect({
        sessionId: this.sessionId,
        clientId: this.clientId,
        role: this.role,
        clientType: this.clientType,
      });
    }

    Logger.info("工作階段還原成功");
    return true;
  }

  /**
   * 取得分享代碼資訊
   * @param {string} shareCode - 分享代碼
   * @returns {Promise<Object>}
   */
  async getShareCodeInfo(shareCode) {
    const response = await fetch(
      `${this.apiBaseUrl}${API_ENDPOINTS.SYNC.SHARE_CODE(shareCode)}`,
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error((error.message || error.error || `HTTP ${response.status}`).replace(SYNC_PAGE_CONFIG.PANEL, getSyncPageName(SYNC_PAGE_CONFIG.PANEL)).replace(SYNC_PAGE_CONFIG.BOARD, getSyncPageName(SYNC_PAGE_CONFIG.BOARD)));
    }

    const data = await response.json();
    return data.data;
  }

  /**
   * 重新產生分享代碼
   * @returns {Promise<{shareCode: string, sessionId: string}>}
   */
  async regenerateShareCode() {
    if (!this.connected || !this.sessionId) {
      throw new Error("未連線到工作階段");
    }

    if (this.role !== this.roleConfig.OPERATOR) {
      throw new Error("僅操作者可以重新產生分享代碼");
    }

    const response = await fetch(
      `${this.apiBaseUrl}${API_ENDPOINTS.SYNC.SESSION_SHARE_CODE(this.sessionId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: this.clientId }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error((error.message || error.error || `HTTP ${response.status}`).replace(SYNC_PAGE_CONFIG.PANEL, getSyncPageName(SYNC_PAGE_CONFIG.PANEL)).replace(SYNC_PAGE_CONFIG.BOARD, getSyncPageName(SYNC_PAGE_CONFIG.BOARD)));
    }

    const data = await response.json();
    return {
      shareCode: data.data.shareCode,
      sessionId: data.data.sessionId,
    };
  }

  /**
   * 取得工作階段中的所有客戶端
   * @returns {Promise<Array>}
   */
  async getSessionClients() {
    if (!this.sessionId) {
      throw new Error("未連線到工作階段");
    }

    const response = await fetch(
      `${this.apiBaseUrl}${API_ENDPOINTS.SYNC.SESSION_CLIENTS(this.sessionId)}`,
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error((error.message || error.error || `HTTP ${response.status}`).replace(SYNC_PAGE_CONFIG.PANEL, getSyncPageName(SYNC_PAGE_CONFIG.PANEL)).replace(SYNC_PAGE_CONFIG.BOARD, getSyncPageName(SYNC_PAGE_CONFIG.BOARD)));
    }

    const data = await response.json();
    return data.data.clients;
  }

  // ==================== 狀態同步 ====================

  /**
   * 同步狀態更新
   * @param {Object} state - 狀態物件
   * @returns {boolean}
   */
  syncState(state) {
    if (!this.initialized || !this.wsClient) {
      Logger.debug("本機模式，跳過狀態同步");
      return false;
    }
    if (!this.connected || !this.sessionId) {
      Logger.warn("未連線，無法同步狀態");
      return false;
    }

    if (this.role !== this.roleConfig.OPERATOR) {
      Logger.warn("僅操作者可以發送狀態更新");
      return false;
    }

    this.wsClient.updateState(state);
    return true;
  }

  /**
   * 觸發狀態更新事件
   * @param {Object|string} state - 狀態資料
   */
  triggerStateUpdate(state) {
    try {
      const parsedState = typeof state === "string" ? JSON.parse(state) : state;

      // 動作相關事件不能被同幀合併，否則連續 action 完成會被覆蓋遺失
      const nonCoalescedTypes = new Set([
        SYNC_DATA_TYPES.ACTION_COMPLETED,
        SYNC_DATA_TYPES.ACTION_CANCELLED,
        SYNC_DATA_TYPES.BUTTON_ACTION,
        SYNC_DATA_TYPES.BUTTON_PRESSED,
      ]);
      if (parsedState?.type && nonCoalescedTypes.has(parsedState.type)) {
        const event = new CustomEvent(SYNC_EVENTS.STATE_UPDATE, {
          detail: parsedState,
        });
        window.dispatchEvent(event);
        return;
      }

      this.pendingStateUpdate = parsedState;
      this.scheduleStateUpdateFlush();
    } catch (error) {
      Logger.error("狀態解析錯誤:", error);
    }
  }

  /**
   * 於下一幀派發狀態更新，連續更新時只保留最後一筆
   */
  scheduleStateUpdateFlush() {
    if (this.stateUpdateFlushScheduled) return;
    this.stateUpdateFlushScheduled = true;

    const flush = () => {
      this.stateUpdateFlushScheduled = false;
      this.stateUpdateFlushTimer = null;

      if (!this.pendingStateUpdate) return;
      const payload = this.pendingStateUpdate;
      this.pendingStateUpdate = null;

      const event = new CustomEvent(SYNC_EVENTS.STATE_UPDATE, {
        detail: payload,
      });
      window.dispatchEvent(event);
    };

    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(flush);
      return;
    }

    this.stateUpdateFlushTimer = setTimeout(flush, 0);
  }

  /**
   * 斷開連線
   */
  disconnect() {
    Logger.info("斷開連線");
    this.stopHealthCheck();
    if (this.stateUpdateFlushTimer) {
      clearTimeout(this.stateUpdateFlushTimer);
      this.stateUpdateFlushTimer = null;
    }
    this.pendingStateUpdate = null;
    this.stateUpdateFlushScheduled = false;
    if (this.wsClient) {
      this.wsClient.disconnect();
    }
    this.connected = false;
    this.clearState();
  }

  // ==================== 狀態管理 ====================

  /**
   * 儲存狀態到外部儲存器
   */
  saveState() {
    if (!this.sessionStore || typeof this.sessionStore.save !== "function") {
      return;
    }

    try {
      this.sessionStore.save({
        sessionId: this.sessionId,
        clientId: this.clientId,
        role: this.role || this.roleConfig.LOCAL,
      });
    } catch (error) {
      Logger.warn("外部儲存器儲存狀態失敗:", error);
    }
  }

  /**
   * 儲存角色到外部儲存器
   * @param {string} role - 角色
   */
  saveRole(role) {
    this.role = role;
    this.saveState();
  }

  /**
   * 從外部儲存器載入狀態
   */
  loadState() {
    if (!this.sessionStore || typeof this.sessionStore.load !== "function") {
      return;
    }

    try {
      const state = this.sessionStore.load() || {};
      this.sessionId = state.sessionId || null;
      this.clientId = state.clientId || null;
      this.role = state.role || this.roleConfig.LOCAL;

      if (this.sessionId && this.clientId) {
        Logger.debug("已從外部儲存器載入同步狀態:", {
          sessionId: this.sessionId,
          clientId: this.clientId,
          role: this.role,
        });
      }
    } catch (error) {
      Logger.error("載入狀態失敗:", error);
    }
  }

  /**
   * 清除外部儲存器狀態
   */
  clearState() {
    if (typeof this.sessionStore?.clear === "function") {
      this.sessionStore.clear();
    }
    this.sessionId = null;
    this.clientId = null;
    this.role = this.roleConfig.LOCAL;
    this.latestSessionState = null;
    this.connectionAttempted = false;
    Logger.debug("同步狀態已重置");
  }

  /**
   * 清理無效的工作階段資料
   */
  clearInvalidSessionData() {
    Logger.info("清理無效的工作階段資料");

    this.stopHealthCheck();
    this.clearState();

    this.connected = false;

    if (this.wsClient) {
      this.wsClient.disconnect();
      this.wsClient = null;
    }
    // 重置初始化旗標，讓下次 createSession/joinSession 建立全新的 wsClient
    // 確保新 wsClient 帶有 autoReconnect: true，避免後續連線無法自動重連
    this.initialized = false;

    Logger.info("工作階段資料清理完成");
  }

  // ==================== 健康檢查 ====================

  /**
   * 由 WS 事件直接更新 serverOnline，並在狀態改變時派發 SERVER_STATUS_CHANGED。
   * 這是事件驅動的核心：不需要 HTTP polling，WS 連線/斷線本身就是最即時的信號。
   */
  _updateServerOnline(online) {
    const prev = this.serverOnline;
    if (prev === online) return;

    this.serverOnline = online;
    this.previousServerOnline = prev;
    this.lastHealthCheckTime = Date.now(); // 讓 cache 保持有效，避免事件後立即觸發多餘的 HTTP

    window.dispatchEvent(
      new CustomEvent(SYNC_EVENTS.SERVER_STATUS_CHANGED, {
        detail: {
          online,
          previousOnline: prev,
          timestamp: new Date().toISOString(),
        },
      }),
    );

    Logger.debug(`伺服器狀態變化（WS 事件）: ${prev} → ${online}`);
  }

  /**
   * 檢查伺服器健康狀態
   * @returns {Promise<boolean>}
   */
  async checkServerHealth() {
    const now = Date.now();
    if (now - this.lastHealthCheckTime < this.healthCheckCacheTtl) {
      return this.serverOnline;
    }

    try {
      const response = await fetch(`${this.apiBaseUrl}${API_ENDPOINTS.SYNC.HEALTH}`, {
        method: "HEAD",
        signal: AbortSignal.timeout(
          SYNC_CLIENT_CONSTANTS.DEFAULT_SERVER_HEALTH_TIMEOUT_MS,
        ),
      });

      this.lastHealthCheckTime = Date.now();
      this._updateServerOnline(response.ok);
      return this.serverOnline;
    } catch {
      this.lastHealthCheckTime = Date.now();
      this._updateServerOnline(false);
      return false;
    }
  }

  /**
   * 停止心跳檢測定時器
   */
  stopHealthCheck() {
    this.healthCheckLoopActive = false;
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  // ==================== Getter 方法 ====================

  /**
   * 取得工作階段 ID
   * @returns {string|null}
   */
  getSessionId() {
    return this.sessionId;
  }

  /**
   * 取得目前儲存的工作階段資訊
   * @returns {{sessionId:string|null, clientId:string|null, role:string}}
   */
  getStoredSessionInfo() {
    return {
      sessionId: this.sessionId,
      clientId: this.clientId,
      role: this.role || this.roleConfig.LOCAL,
    };
  }

  /**
   * 取得客戶端 ID
   * @returns {string|null}
   */
  getClientId() {
    return this.clientId;
  }

  /**
   * 取得角色
   * @returns {string}
   */
  getRole() {
    return this.role;
  }

  /**
   * Flatten wrapped session snapshot to a usable state object.
   * @param {Object} rawState
   * @returns {Object}
   */
  _flattenSessionState(rawState) {
    if (!rawState || typeof rawState !== "object") {
      return rawState;
    }

    if (
      !rawState.experimentState &&
      !rawState.state &&
      !rawState.lastState
    ) {
      return rawState;
    }

    const toObj = (v) => (v && typeof v === "object" ? v : {});
    return {
      ...toObj(rawState.state),
      ...toObj(rawState.experimentState),
      ...toObj(rawState.lastState),
    };
  }

  /**
   * 取得最近一次工作階段快照（由 join 回應或 WebSocket session_state 更新）
   * @returns {Object|null}
   */
  _getLocalExperimentState() {
    const pageManager =
      window.boardPageManager || window.panelPageManager || null;
    if (!pageManager) return null;

    const experimentSystemManager = pageManager.experimentSystemManager;
    const experimentStateManager = pageManager.experimentStateManager;

    const experimentId =
      experimentSystemManager?.getExperimentId?.() ||
      experimentStateManager?.getExperimentId?.() ||
      "";
    const participantName =
      experimentSystemManager?.getParticipantName?.() ||
      experimentStateManager?.getParticipantName?.() ||
      "";

    const currentCombination =
      experimentSystemManager?.getCurrentCombination?.() ||
      experimentStateManager?.getCurrentCombination?.() ||
      pageManager?.currentCombination ||
      null;

    const combinationName =
      currentCombination?.combinationName ||
      currentCombination?.name ||
      "";

    const unitIds =
      experimentSystemManager?.getCurrentUnitIds?.() ||
      currentCombination?.unitIds ||
      currentCombination?.unit_ids ||
      [];

    const localUnitOrder = Array.isArray(unitIds)
      ? unitIds.join("→")
      : typeof unitIds === "string"
      ? unitIds
      : "";

    const isRunning =
      Boolean(experimentSystemManager?.isExperimentRunning?.()) ||
      Boolean(experimentStateManager?.isExperimentRunning);

    return {
      experimentId,
      participantName,
      combinationName,
      unitOrder: localUnitOrder,
      isRunning,
    };
  }

  getLatestSessionState() {
    return this.latestSessionState || null;
  }

  canOperate() {
    return this.connected && this.role === this.roleConfig.OPERATOR;
  }

  /**
   * 檢查是否已連線
   * @returns {boolean}
   */
  isConnected() {
    return this.connected && this.wsClient !== null;
  }

  /**
   * 取得狀態描述文字
   * @returns {'offline'|'idle'|'viewer'|'operator'}
   */
  getStatusText() {
    if (this.connected && this.sessionId) {
      return this.role;
    }

    // 完全退出（sessionId 已清除）→ 一律回到未同步，不受 serverOnline 影響
    if (!this.sessionId) {
      return SYNC_STATUS_CONFIG.IDLE;
    }

    if (!this.connected) {
      return this.connectionAttempted
        ? SYNC_STATUS_CONFIG.OFFLINE
        : SYNC_STATUS_CONFIG.IDLE;
    }

    if (this.serverOnline === false && !this.connected) {
      return SYNC_STATUS_CONFIG.OFFLINE;
    }

    return SYNC_STATUS_CONFIG.IDLE;
  }
}

export { SyncClient };
