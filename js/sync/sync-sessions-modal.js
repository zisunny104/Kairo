/**
 * SyncSessionsModal - 工作階段管理 Modal
 * 負責以 Modal 形式顯示、檢視和管理所有工作階段（含公開頻道）
 */

import { UIModal } from "../ui/modal.js";
import {
  SYNC_EVENTS,
  API_ENDPOINTS,
  SYNC_ROLE_CONFIG,
  SYNC_DATA_TYPES,
  EXPERIMENT_FLOW_STATE,
  getSyncRoleText,
} from "../constants/index.js";
import { Logger } from "../core/console-manager.js";
import { getApiUrl } from "../core/url-utils.js";
import { normalizeExperimentStatePayload } from "../experiment/experiment-state-manager.js";

const SESSION_ACTIVE_THRESHOLD_S = 600;

export class SyncSessionsModal {
  constructor(core, config = {}) {
    this.core = core;
    this.syncManager = config.syncManager || null;
    this.timeSyncManager = config.timeSyncManager || core?.timeSyncManager || null;
    this.roleConfig = config.roleConfig || SYNC_ROLE_CONFIG;
    this.indicatorManager = config.indicatorManager || null;
    this.el = null;
    this.modal = null;
    this.sessionsData = [];
    this.expandedCards = new Set();
    this._adminToken = null;
  }

  async _fetchAdminToken() {
    if (this._adminToken) return this._adminToken;
    try {
      const res = await fetch(`${this.getApiUrl()}${API_ENDPOINTS.SYNC.ADMIN_TOKEN}`);
      const data = await res.json();
      this._adminToken = data.token || null;
    } catch {
      this._adminToken = null;
    }
    return this._adminToken;
  }

  async _adminHeaders() {
    const token = await this._fetchAdminToken();
    const headers = { "Content-Type": "application/json" };
    if (token) headers["X-Admin-Token"] = token;
    return headers;
  }

  formatDateTime(timestampMs) {
    if (this.timeSyncManager?.formatDateTime) {
      return this.timeSyncManager.formatDateTime(timestampMs);
    }
    return new Date(timestampMs).toLocaleString();
  }

  getApiUrl() {
    return getApiUrl();
  }

  _renderButton({ id, className, label, disabled = false }) {
    return `<button id="${id}" class="${className}"${disabled ? " disabled" : ""}>${label}</button>`;
  }

  _escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  _normalizeSession(session) {
    const normalized = { ...session };
    normalized.id = normalized.id || "";
    normalized.created = normalized.created ?? 0;
    normalized.lastActivity = normalized.lastActivity ?? 0;
    normalized.channelName = normalized.channelName || null;
    normalized.maxClients = normalized.maxClients ?? null;
    normalized.shareCodes = Array.isArray(normalized.shareCodes) ? normalized.shareCodes : [];
    normalized.clients = Array.isArray(normalized.clients) ? normalized.clients : [];
    normalized.state = this._parseSessionState(normalized);
    normalized.experimentMeta = this._extractExperimentMeta(normalized.state);
    return normalized;
  }

  _parseSessionState(session) {
    let rawState = session.state ?? {};
    if (typeof rawState === "string") {
      try {
        rawState = JSON.parse(rawState);
      } catch {
        return {};
      }
    }

    if (rawState && typeof rawState === "object") {
      const mergedState = rawState.experimentState || rawState.lastState
        ? {
            ...(rawState.experimentState || {}),
            ...(rawState.lastState || {}),
          }
        : rawState;

      return this._normalizeExperimentState(mergedState);
    }

    return {};
  }

  _normalizeExperimentState(state) {
    return normalizeExperimentStatePayload(state);
  }

  _extractExperimentMeta(state) {
    if (!state || typeof state !== "object") return {};

    const experimentId = state.experimentId || "";
    const participantName = state.participantName || "";
    const combinationName =
      state.combinationName ||
      state.currentCombination?.combinationName ||
      "";
    const unitIds = Array.isArray(state.loadedUnits)
      ? state.loadedUnits
      : Array.isArray(state.unitIds)
      ? state.unitIds
      : Array.isArray(state.currentCombination?.unitIds)
      ? state.currentCombination.unitIds
      : [];
    const unitOrder = unitIds.length ? unitIds.join("→") : "";

    let progress = "";
    if (typeof state.currentUnitIndex === "number" && typeof state.totalUnits === "number") {
      progress = `${state.currentUnitIndex + 1}/${state.totalUnits}`;
    } else if (typeof state.currentStepIndex === "number" && typeof state.totalSteps === "number") {
      progress = `${state.currentStepIndex + 1}/${state.totalSteps}`;
    }

    return { experimentId, participantName, combinationName, unitOrder, progress };
  }

  _renderSessionExperimentMeta(session) {
    const meta = [];
    const { experimentId, participantName, combinationName, unitOrder, progress } = session.experimentMeta || {};

    if (experimentId) {
      meta.push(`<span class="ssm-meta-chip"><span class="ssm-meta-chip-label">實驗ID</span>${this._escapeHtml(experimentId)}</span>`);
    }
    if (participantName) {
      meta.push(`<span class="ssm-meta-chip"><span class="ssm-meta-chip-label">受試者</span>${this._escapeHtml(participantName)}</span>`);
    }
    if (combinationName) {
      meta.push(`<span class="ssm-meta-chip"><span class="ssm-meta-chip-label">組合</span>${this._escapeHtml(combinationName)}</span>`);
    }
    if (unitOrder) {
      meta.push(`<span class="ssm-meta-chip"><span class="ssm-meta-chip-label">排序</span>${this._escapeHtml(unitOrder)}</span>`);
    }
    if (progress) {
      meta.push(`<span class="ssm-meta-chip"><span class="ssm-meta-chip-label">進度</span>${this._escapeHtml(progress)}</span>`);
    }

    return meta.length ? `<div class="ssm-session-meta-row">${meta.join("")}</div>` : "";
  }

  _renderClientStateDetails(state) {
    if (!state || typeof state !== "object") {
      return "<div class=\"ssm-client-state-empty\">無可用狀態</div>";
    }

    const normalizedState = this._normalizeExperimentState(
      state.experimentState || state.state || state.lastState || state,
    );
    const meta = this._extractExperimentMeta(normalizedState);
    const statusItems = [];
    const type = String(normalizedState.type || state.type || "");
    const isPaused = Boolean(
      type === SYNC_DATA_TYPES.EXPERIMENT_PAUSED ||
      normalizedState.experimentPaused ||
      normalizedState.isPaused,
    );
    const isStopped = Boolean(
      type === SYNC_DATA_TYPES.EXPERIMENT_STOPPED ||
      normalizedState.flowState === EXPERIMENT_FLOW_STATE.STOPPED ||
      normalizedState.isStopped,
    );
    const isRunning = Boolean(
      type === SYNC_DATA_TYPES.EXPERIMENT_STARTED ||
      type === SYNC_DATA_TYPES.EXPERIMENT_RESUMED ||
      normalizedState.isExperimentRunning ||
      normalizedState.isRunning,
    );

    let experimentStatus = "未啟動";
    if (isStopped) {
      experimentStatus = "已結束";
    } else if (isPaused) {
      experimentStatus = "已暫停";
    } else if (isRunning) {
      experimentStatus = "執行中";
    }

    if (meta.experimentId) {
      statusItems.push(`<div class="ssm-client-state-row"><span>實驗ID</span><strong>${this._escapeHtml(meta.experimentId)}</strong></div>`);
    }
    if (meta.participantName) {
      statusItems.push(`<div class="ssm-client-state-row"><span>受試者</span><strong>${this._escapeHtml(meta.participantName)}</strong></div>`);
    }
    if (meta.combinationName) {
      statusItems.push(`<div class="ssm-client-state-row"><span>組合</span><strong>${this._escapeHtml(meta.combinationName)}</strong></div>`);
    }
    if (meta.progress) {
      statusItems.push(`<div class="ssm-client-state-row"><span>進度</span><strong>${this._escapeHtml(meta.progress)}</strong></div>`);
    }

    statusItems.push(`<div class="ssm-client-state-row"><span>實驗狀態</span><strong>${experimentStatus}</strong></div>`);

    if (!meta.experimentId && !meta.participantName && !meta.combinationName && !meta.progress) {
      statusItems.push("<div class=\"ssm-client-state-empty\">此裝置回傳的狀態尚無實驗摘要</div>");
    }

    return `<div class="ssm-client-state-details">${statusItems.join("")}</div>`;
  }

  _ensureOriginalText(element) {
    if (element && typeof element.dataset !== "undefined" && !element.dataset.originalText) {
      element.dataset.originalText = element.textContent;
    }
  }

  _restoreOriginalText(element) {
    if (element && typeof element.dataset !== "undefined" && element.dataset.originalText) {
      element.textContent = element.dataset.originalText;
    }
  }

  _renderToolbar() {
    return `
      <div class="ssm-toolbar">
        ${this._renderButton({ id: "refreshSessionsBtn", className: "ssm-btn", label: "↻ 重新整理" })}
        <div class="ssm-toolbar-spacer"></div>
        ${this._renderButton({ id: "stopAllActiveSessionsBtn", className: "ssm-btn ssm-btn-warning", label: "結束活動中" })}
        ${this._renderButton({ id: "clearAllSessionsBtn", className: "ssm-btn ssm-btn-danger", label: "清除工作階段" })}
      </div>`;
  }

  _renderChannelBadge(isChannel) {
    return isChannel ? "<span class=\"ssm-channel-badge\">公開頻道</span>" : "";
  }

  _renderSessionLabel(isChannel, channelName) {
    return isChannel ? `公開頻道 ${this._escapeHtml(channelName)}` : "工作階段";
  }

  _renderClientChips(clientCount, operatorCount, viewerCount) {
    if (clientCount === 0) {
      return "<span class=\"ssm-chip ssm-chip-empty\">目前無裝置連線</span>";
    }
    const operatorChip = operatorCount > 0
      ? `<span class="ssm-chip ssm-chip-op" title="${getSyncRoleText(this.roleConfig.OPERATOR)}">${operatorCount} ${getSyncRoleText(this.roleConfig.OPERATOR)}</span>`
      : "";
    const viewerChip = viewerCount > 0
      ? `<span class="ssm-chip ssm-chip-view" title="${getSyncRoleText(this.roleConfig.VIEWER)}">${viewerCount} ${getSyncRoleText(this.roleConfig.VIEWER)}</span>`
      : "";
    return `${operatorChip}${viewerChip}`;
  }

  _renderClientRow(client) {
    const clientId = client.id || client.clientId;
    const shortId = clientId.length > 20
      ? clientId.substring(0, 8) + "…" + clientId.slice(-6)
      : clientId;
    const joinedTime = this.formatDateTime(client.joinedAt * 1000);
    const isOperator = client.role === this.roleConfig.OPERATOR;
    const safeClientId = this._escapeHtml(clientId);
    const safeShortId = this._escapeHtml(shortId);

    return `
      <div class="ssm-client sync-session-client ${client.role}" data-client-id="${safeClientId}">
        <div class="ssm-client-top">
          <code class="ssm-client-id sync-client-id-text" title="${safeClientId}">${safeShortId}</code>
          ${client.clientType ? `<span class="ssm-type-tag">${this._escapeHtml(client.clientType)}</span>` : ""}
          <div class="sync-ch-role-group ssm-client-role-group">
            <button class="sync-ch-role-btn sync-client-role-btn ${isOperator ? "active" : ""}"
                    data-client-id="${safeClientId}" data-role="${this.roleConfig.OPERATOR}">${getSyncRoleText(this.roleConfig.OPERATOR)}</button>
            <button class="sync-ch-role-btn sync-client-role-btn ${!isOperator ? "active" : ""}"
                    data-client-id="${safeClientId}" data-role="${this.roleConfig.VIEWER}">${getSyncRoleText(this.roleConfig.VIEWER)}</button>
          </div>
        </div>
        <div class="ssm-client-meta">加入 ${joinedTime}</div>
        <div class="ssm-client-btns sync-client-actions">
          <button class="ssm-client-btn ssm-btn-push sync-client-refresh-btn"
                  data-client-id="${safeClientId}">↑ 推送狀態</button>
          <button class="ssm-client-btn ssm-btn-info sync-client-request-state-btn"
                  data-client-id="${safeClientId}">? 請求狀態</button>
          <button class="ssm-client-btn ssm-btn-kick sync-client-kick-btn"
                  data-client-id="${safeClientId}">✕ 強制退出</button>
        </div>
        <div class="ssm-client-state" data-client-state="${safeClientId}">
          <div class="ssm-client-state-empty">尚未請求</div>
        </div>
      </div>`;
  }

  _renderSyncStateHtml(session) {
    if (!session || !session.state) {
      return "<div class=\"ssm-no-data ssm-no-state\">尚無同步資料</div>";
    }

    let parsedState = session.state;
    if (typeof session.state === "string") {
      try {
        parsedState = JSON.parse(session.state);
      } catch {
        parsedState = null;
      }
    }

    const fieldCount = parsedState && typeof parsedState === "object"
      ? Object.keys(parsedState).length : 0;

    return `
      <div class="sync-session-state-toggle" data-session-id="${this._escapeHtml(session.id)}">
        <div class="sync-session-state-header ssm-state-hdr">
          <span>同步狀態</span>
          <span class="ssm-state-count">${fieldCount} 個欄位</span>
          <span class="sync-state-expand-icon ssm-state-arrow"></span>
        </div>
        <div class="sync-session-state-details is-hidden ssm-state-body">
          ${this.formatSyncState(session.state)}
        </div>
      </div>`;
  }

  _renderShareCodesHtml(shareCodes) {
    if (!shareCodes || shareCodes.length === 0) {
      return "<div class=\"ssm-no-data\">無分享代碼</div>";
    }
    return shareCodes.map((c) => {
      const expires = c.expiresAt ? this.formatDateTime(c.expiresAt * 1000) : "—";
      const statusClass = c.used ? "ssm-code-used" : "ssm-code-active";
      const statusText = c.used ? "已使用" : "有效";
      return `<div class="ssm-share-code ${statusClass}">
        <code class="ssm-code-value">${this._escapeHtml(c.code)}</code>
        <span class="ssm-code-status">${statusText}</span>
        <span class="ssm-code-expires">到期 ${expires}</span>
      </div>`;
    }).join("");
  }

  _renderSessionActionButton(isChannel, session) {
    if (isChannel) {
      return `<button class="ssm-footer-btn ssm-btn-gray sync-close-channel-btn"
               data-channel-name="${this._escapeHtml(session.channelName || "")}"
               ${session.clients?.length ? "" : "disabled"}>清除所有連線</button>`;
    }
    return `<button class="ssm-footer-btn ssm-btn-danger-ol sync-delete-session-btn"
               data-session-id="${this._escapeHtml(session.id)}">刪除此工作階段</button>`;
  }

  initialize() {
    window.addEventListener(SYNC_EVENTS.SHOW_SESSIONS, () => {
      this.showModal();
    });

    window.addEventListener(SYNC_EVENTS.SESSION_CREATED, () => {
      if (this.el && document.body.contains(this.el)) {
        this.refreshSessionsList();
      }
    });

    window.addEventListener(SYNC_EVENTS.SESSION_INVALID, (event) => {
      const { reason, originalError } = event.detail;
      Logger.info("工作階段失效，重新載入列表", { reason, originalError });
      if (this.el && document.body.contains(this.el)) {
        this.refreshSessionsList();
      }
    });
  }

  async showModal() {
    if (this.modal) {
      this.modal.close();
    }

    await this.loadSessionsData();

    const modalHtml = `
      <div class="modal-overlay sync-sessions-overlay active" id="syncSessionsPanel">
        <div class="modal-container sync-sessions-ui">
          <div class="modal-header ssm-header">
            <div class="ssm-header-left">
              <h2 class="modal-title">工作階段管理</h2>
              <span class="ssm-summary" id="ssmSummary">${this._renderSummary()}</span>
            </div>
            <button class="modal-close-btn" title="關閉">×</button>
          </div>

          <div class="modal-body ssm-body">
            ${this._renderToolbar()}
            <div id="sessionsList" class="ssm-list scrollbar-gray">
              ${this.renderSessionsList()}
            </div>
          </div>
        </div>
      </div>
    `;

    this.modal = new UIModal({
      id: "syncSessionsPanel",
      html: modalHtml,
    });
    this.modal.open();
    this.el = this.modal.modalEl;

    this.bindEvents();
  }

  async loadSessionsData() {
    try {
      const apiUrl = this.getApiUrl();
      const response = await fetch(`${apiUrl}${API_ENDPOINTS.SYNC.SESSIONS}`, {
        headers: await this._adminHeaders(),
      });
      const data = await response.json();

      if (data.success) {
        this.sessionsData = (data.data || []).map((session) => this._normalizeSession(session));
      } else {
        Logger.warn("載入工作階段資料失敗:", data.message);
        this.sessionsData = [];
      }
    } catch (error) {
      Logger.warn("載入工作階段資料錯誤:", error);
      this.sessionsData = [];
    }
  }

  async refreshSessionsList() {
    try {
      await this.loadSessionsData();
      const sessionsList = this.el?.querySelector("#sessionsList");
      if (sessionsList) {
        sessionsList.innerHTML = this.renderSessionsList();
      }
      const summary = this.el?.querySelector("#ssmSummary");
      if (summary) summary.textContent = this._renderSummary();
    } catch (error) {
      Logger.error("重新整理工作階段列表錯誤:", error);
    }
  }

  _renderSummary() {
    const sessions = this.sessionsData.filter((s) => !s.isChannel);
    const channels = this.sessionsData.filter((s) => s.isChannel);
    const activeSessions = sessions.filter((s) => Date.now() / 1000 - s.lastActivity < SESSION_ACTIVE_THRESHOLD_S).length;
    const activeChannels = channels.filter((s) => (s.clients?.length || 0) > 0).length;
    const totalClients = this.sessionsData.reduce((sum, s) => sum + (s.clients?.length || 0), 0);
    const parts = [];
    if (sessions.length > 0) parts.push(`${sessions.length} 工作階段・${activeSessions} 活動中`);
    if (channels.length > 0) parts.push(`${activeChannels}/${channels.length} 頻道線上`);
    if (totalClients > 0) parts.push(`${totalClients} 裝置`);
    return parts.join("　") || "目前無工作階段";
  }

  renderSessionsList() {
    if (this.sessionsData.length === 0) {
      return "<div class=\"ssm-empty\">目前無工作階段與頻道資料</div>";
    }
    return this.sessionsData.map((session) => this.renderSessionCard(session)).join("");
  }

  renderSessionCard(session) {
    const isExpanded = this.expandedCards.has(session.id);
    const isChannel = !!session.isChannel;
    const clientCount = session.clients?.length || 0;
    const maxClients = session.maxClients != null ? session.maxClients : "—";
    const isActive = isChannel ? clientCount > 0 : Date.now() / 1000 - session.lastActivity < SESSION_ACTIVE_THRESHOLD_S;

    const createdTime = this.formatDateTime(session.created * 1000);
    const lastActivity = this.formatDateTime(session.lastActivity * 1000);

    const cardClass = [
      "sync-session-card",
      isExpanded ? "expanded" : "",
      isChannel ? "ssm-card-channel" : (isActive ? "ssm-card-active" : "ssm-card-inactive"),
    ].filter(Boolean).join(" ");

    const channelBadge = this._renderChannelBadge(isChannel);
    const label = this._renderSessionLabel(isChannel, session.channelName);
    const safeSessionId = this._escapeHtml(session.id);
    const experimentMetaHtml = this._renderSessionExperimentMeta(session);

    const operatorCount = (session.clients || []).filter((c) => c.role === this.roleConfig.OPERATOR).length;
    const viewerCount = (session.clients || []).filter((c) => c.role === this.roleConfig.VIEWER).length;
    const clientChips = this._renderClientChips(clientCount, operatorCount, viewerCount);

    return `
      <div class="${cardClass}" data-session-id="${safeSessionId}" data-channel="${this._escapeHtml(session.channelName || "")}">
        <div class="sync-session-header ssm-card-header">
          <div class="ssm-card-check ssm-card-check-ph"></div>
          <div class="ssm-card-body">
            <div class="ssm-card-title-row">
              <span class="ssm-card-name">${label}</span>
              ${channelBadge}
            </div>
            <code class="ssm-card-id">${safeSessionId}</code>
            ${experimentMetaHtml}
            <div class="ssm-card-meta">
              <span class="ssm-meta-item"><span class="ssm-meta-lbl">建立</span> ${createdTime}</span>
              <span class="ssm-meta-sep">·</span>
              <span class="ssm-meta-item"><span class="ssm-meta-lbl">活動</span> ${lastActivity}</span>
              <span class="ssm-meta-sep">·</span>
              <span class="ssm-meta-item"><span class="ssm-meta-lbl">裝置</span> <strong>${clientCount}</strong>/${maxClients}</span>
            </div>
          </div>
          <div class="ssm-card-aside">
            <div class="ssm-chips">${clientChips}</div>
            <div class="ssm-card-foot">
              <span class="ssm-status-dot ${isActive ? "active" : ""}"></span>
              <span class="ssm-status-lbl">${isActive ? "活動中" : "閒置"}</span>
              <span class="sync-session-expand-icon ssm-expand-arrow"></span>
            </div>
          </div>
        </div>
        <div class="sync-session-details ssm-card-details"></div>
      </div>
    `;
  }

  formatSyncState(state) {
    if (typeof state === "string") {
      try {
        state = JSON.parse(state);
      } catch (error) {
        Logger.debug("解析同步狀態失敗:", error);
        return "<span class=\"sync-state-empty\">資料格式錯誤</span>";
      }
    }

    if (!state || typeof state !== "object") {
      return "<span class=\"sync-state-empty\">無資料</span>";
    }

    const formatValue = (value, indent = 0) => {
      const indentStr = "  ".repeat(indent);

      if (value === null) return "<span class=\"sync-state-null\">null</span>";
      if (typeof value === "boolean") return `<span class="sync-state-boolean">${value}</span>`;
      if (typeof value === "number") return `<span class="sync-state-number">${value}</span>`;
      if (typeof value === "string") {
        if (value.length > 50) {
          return `<span class="sync-state-string">"${this._escapeHtml(value.substring(0, 47))}..."</span>`;
        }
        return `<span class="sync-state-string">"${this._escapeHtml(value)}"</span>`;
      }

      if (Array.isArray(value)) {
        if (value.length === 0) return "<span class=\"sync-state-array\">[]</span>";
        const items = value.slice(0, 5).map((item) => formatValue(item, indent + 1));
        const remaining = value.length > 5 ? ` ... 還有 ${value.length - 5} 個項目` : "";
        return `<span class="sync-state-array">[\n${indentStr}  ${items.join(`,\n${indentStr}  `)}${remaining}\n${indentStr}]</span>`;
      }

      if (typeof value === "object") {
        const entries = Object.entries(value);
        if (entries.length === 0) return "<span class=\"sync-state-object\">{}</span>";
        const formattedEntries = entries.slice(0, 10).map(
          ([key, val]) => `${indentStr}  <span class="sync-state-key">"${this._escapeHtml(key)}"</span>: ${formatValue(val, indent + 1)}`,
        );
        const remaining = entries.length > 10 ? `\n${indentStr}  ... 還有 ${entries.length - 10} 個欄位` : "";
        return `<span class="sync-state-object">{\n${formattedEntries.join(",\n")}${remaining}\n${indentStr}}</span>`;
      }

      return `<span class="sync-state-unknown">${String(value)}</span>`;
    };

    return `<div class="sync-state-formatted">${formatValue(state)}</div>`;
  }

  renderSessionDetails(session) {
    const isChannel = !!session.isChannel;

    // 已連線裝置
    const clientsHtml = session.clients && session.clients.length > 0
      ? session.clients.map((client) => this._renderClientRow(client)).join("")
      : "<div class=\"ssm-empty-clients\">目前無裝置連線</div>";

    // 分享代碼（頻道沒有）
    let shareCodesHtml = "";
    if (!isChannel) {
      shareCodesHtml = this._renderShareCodesHtml(session.shareCodes);
    }

    // 同步狀態（頻道沒有）
    const stateHtml = !isChannel ? this._renderSyncStateHtml(session) : "";

    // 操作按鈕
    const actionBtn = this._renderSessionActionButton(isChannel, session);

    return `
      <div class="ssm-details-inner">
        <div class="ssm-section">
          <div class="ssm-section-title">已連線裝置</div>
          <div class="ssm-clients-list">${clientsHtml}</div>
        </div>
        ${!isChannel ? `
        <div class="ssm-section">
          <div class="ssm-section-title">分享代碼 <span class="ssm-count-badge">${session.shareCodes?.length || 0}</span></div>
          ${shareCodesHtml}
        </div>
        <div class="ssm-section">
          <div class="ssm-section-title">同步狀態</div>
          ${stateHtml}
        </div>` : ""}
        <div class="ssm-detail-footer">
          ${actionBtn}
        </div>
      </div>
    `;
  }

  bindEvents() {
    const closeBtn = this.el.querySelector(".modal-close-btn");
    closeBtn.addEventListener("click", () => {
      this.modal?.close();
      this.modal = null;
      this.el = null;
    });

    const refreshBtn = this.el.querySelector("#refreshSessionsBtn");
    refreshBtn.addEventListener("click", async () => {
      this._ensureOriginalText(refreshBtn);
      refreshBtn.disabled = true;
      refreshBtn.textContent = "載入中...";
      await this.loadSessionsData();
      const sessionsList = this.el.querySelector("#sessionsList");
      sessionsList.innerHTML = this.renderSessionsList();
      refreshBtn.disabled = false;
      this._restoreOriginalText(refreshBtn);
    });

    const clearAllBtn = this.el.querySelector("#clearAllSessionsBtn");
    clearAllBtn.addEventListener("click", async () => {
      if (!confirm("確定要刪除所有工作階段嗎？此操作無法還原。\n（公開頻道不受影響）")) return;

      this._ensureOriginalText(clearAllBtn);
      clearAllBtn.disabled = true;
      clearAllBtn.textContent = "刪除中...";

      try {
        const response = await fetch(`${this.getApiUrl()}${API_ENDPOINTS.SYNC.SESSIONS_CLEAR}`, {
          method: "POST",
          headers: await this._adminHeaders(),
        });
        const data = await response.json();

        if (data.success) {
          this.expandedCards.clear();
          await this.refreshSessionsList();
        } else {
          this.indicatorManager?.showStatus("error", "刪除失敗: " + data.message);
        }
      } catch (error) {
        Logger.error("刪除所有工作階段錯誤:", error);
        this.indicatorManager?.showStatus("error", "刪除失敗: " + (error.message || ""));
      }

      clearAllBtn.disabled = false;
      this._restoreOriginalText(clearAllBtn);
    });

    const stopAllActiveBtn = this.el.querySelector("#stopAllActiveSessionsBtn");
    stopAllActiveBtn.addEventListener("click", async () => {
      const activeSessions = this.sessionsData.filter((session) => {
        if (session.isChannel) return false;
        return Date.now() / 1000 - session.lastActivity < SESSION_ACTIVE_THRESHOLD_S;
      });

      if (activeSessions.length === 0) {
        this.indicatorManager?.showStatus("info", "目前沒有活動中的工作階段");
        return;
      }

      if (!confirm(`確定要結束所有 ${activeSessions.length} 個活動中工作階段嗎？`)) return;

      stopAllActiveBtn.disabled = true;
      stopAllActiveBtn.textContent = "處理中...";

      let successCount = 0;
      let failCount = 0;
      try {
        const headers = await this._adminHeaders();
        for (const session of activeSessions) {
          try {
            const res = await fetch(`${this.getApiUrl()}${API_ENDPOINTS.SYNC.SESSION_TARGET(session.id)}`, {
              method: "DELETE",
              headers,
            });
            const data = await res.json();
            if (data.success) {
              successCount++;
            } else {
              failCount++;
              Logger.warn(`結束工作階段 ${session.id} 失敗:`, data.message);
            }
          } catch (e) {
            failCount++;
            Logger.error(`結束工作階段 ${session.id} 異常:`, e);
          }
        }

        const msg = failCount === 0
          ? `已結束 ${successCount} 個活動中工作階段`
          : `結束 ${successCount} 個，失敗 ${failCount} 個`;
        this.indicatorManager?.showStatus(failCount === 0 ? "success" : "error", msg);
        await this.refreshSessionsList();
      } catch (error) {
        Logger.error("結束活動中工作階段錯誤:", error);
        this.indicatorManager?.showStatus("error", "操作失敗: " + error.message);
      }

      stopAllActiveBtn.disabled = false;
      stopAllActiveBtn.textContent = "結束所有活動中";
    });

    this.el.addEventListener("click", (event) => {
      // 刪除工作階段
      if (event.target.classList.contains("sync-delete-session-btn")) {
        const sessionId = event.target.dataset.sessionId;
        (async () => {
          if (!confirm(`確定要刪除工作階段 ${sessionId} 嗎？`)) return;

          event.target.disabled = true;
          event.target.textContent = "刪除中...";

          try {
            const response = await fetch(`${this.getApiUrl()}${API_ENDPOINTS.SYNC.SESSION_TARGET(sessionId)}`, { method: "DELETE", headers: await this._adminHeaders() });
            const data = await response.json();

            if (data.success) {
              this.expandedCards.delete(sessionId);
              const card = event.target.closest(".sync-session-card");
              if (card) card.remove();
              await this.refreshSessionsList();
              this.indicatorManager?.showStatus("success", `工作階段 ${sessionId} 已刪除`);
            } else {
              this.indicatorManager?.showStatus("error", "刪除失敗: " + data.message);
              event.target.disabled = false;
              event.target.textContent = "刪除";
            }
          } catch (error) {
            Logger.error("刪除工作階段錯誤:", error);
            this.indicatorManager?.showStatus("error", "刪除失敗: " + error.message);
            event.target.disabled = false;
            event.target.textContent = "刪除";
          }
        })();
        return;
      }

      // 清除頻道連線
      if (event.target.classList.contains("sync-close-channel-btn")) {
        const channelName = event.target.dataset.channelName;
        if (!channelName) return;
        (async () => {
          if (!confirm(`確定要清除公開頻道 ${channelName} 的所有連線嗎？`)) return;

          event.target.disabled = true;
          event.target.textContent = "處理中...";

          try {
            const response = await fetch(`${this.getApiUrl()}${API_ENDPOINTS.SYNC.CHANNEL_CLOSE}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ channelName }),
            });
            const data = await response.json();

            if (data.success) {
              if (this.indicatorManager) {
                this.indicatorManager.showStatus("success", `頻道 ${channelName} 已清除 ${data.data?.closedCount || 0} 個連線`);
              }
              await this.refreshSessionsList();
            } else {
              this.indicatorManager?.showStatus("error", "清除失敗: " + data.message);
              event.target.disabled = false;
              event.target.textContent = "清除連線";
            }
          } catch (error) {
            Logger.error("清除頻道連線錯誤:", error);
            this.indicatorManager?.showStatus("error", "清除失敗: " + error.message);
            event.target.disabled = false;
            event.target.textContent = "清除連線";
          }
        })();
        return;
      }

      // 強制退出裝置
      if (event.target.classList.contains("sync-client-kick-btn")) {
        const clientId = event.target.dataset.clientId;
        if (!clientId) return;
        if (!confirm(`確定要強制退出裝置 ${clientId} 嗎？`)) return;
        (async () => {
          event.target.disabled = true;
          event.target.textContent = "處理中...";
          try {
            const res = await fetch(`${this.getApiUrl()}${API_ENDPOINTS.SYNC.CLIENT_KICK(clientId)}`, { method: "POST", headers: await this._adminHeaders() });
            const data = await res.json();
            if (data.success) {
              await this.refreshSessionsList();
            } else {
              this.indicatorManager?.showStatus("error", "強制退出失敗: " + data.message);
              event.target.disabled = false;
              event.target.textContent = "強制退出";
            }
          } catch (e) {
            this.indicatorManager?.showStatus("error", "強制退出失敗: " + e.message);
            event.target.disabled = false;
            event.target.textContent = "強制退出";
          }
        })();
        return;
      }

      // 調整角色
      if (event.target.classList.contains("sync-client-role-btn")) {
        if (event.target.classList.contains("active")) return;
        const clientId = event.target.dataset.clientId;
        const role = event.target.dataset.role;
        if (!clientId || !role) return;
        (async () => {
          event.target.disabled = true;
          const origText = event.target.textContent;
          event.target.textContent = "處理中...";
          try {
            const res = await fetch(`${this.getApiUrl()}${API_ENDPOINTS.SYNC.CLIENT_ROLE(clientId)}`, {
              method: "POST",
              headers: await this._adminHeaders(),
              body: JSON.stringify({ role }),
            });
            const data = await res.json();
            if (data.success) {
              await this.refreshSessionsList();
            } else {
              this.indicatorManager?.showStatus("error", "調整角色失敗: " + data.message);
              event.target.disabled = false;
              event.target.textContent = origText;
            }
          } catch (e) {
            this.indicatorManager?.showStatus("error", "調整角色失敗: " + e.message);
            event.target.disabled = false;
            event.target.textContent = origText;
          }
        })();
        return;
      }

      // 推送狀態給指定裝置
      if (event.target.classList.contains("sync-client-refresh-btn")) {
        const clientId = event.target.dataset.clientId;
        if (!clientId) return;
        (async () => {
          this._ensureOriginalText(event.target);
          event.target.disabled = true;
          event.target.textContent = "推送中...";
          try {
            const res = await fetch(`${this.getApiUrl()}${API_ENDPOINTS.SYNC.CLIENT_REFRESH(clientId)}`, { method: "POST" });
            const data = await res.json();
            if (!data.success) {
              this.indicatorManager?.showStatus("error", "推送失敗: " + data.message);
            }
          } catch (e) {
            this.indicatorManager?.showStatus("error", "推送失敗: " + e.message);
          } finally {
            event.target.disabled = false;
            this._restoreOriginalText(event.target);
          }
        })();
        return;
      }

      // 請求指定裝置當前狀態
      if (event.target.classList.contains("sync-client-request-state-btn")) {
        const clientId = event.target.dataset.clientId;
        if (!clientId) return;

        const clientElement = event.target.closest(".ssm-client");
        const stateContainer = clientElement?.querySelector(".ssm-client-state");
        if (stateContainer) {
          stateContainer.innerHTML = "<div class=\"ssm-client-state-loading\">請求中...</div>";
        }

        (async () => {
          this._ensureOriginalText(event.target);
          event.target.disabled = true;
          event.target.textContent = "請求中...";
          try {
            const res = await fetch(`${this.getApiUrl()}${API_ENDPOINTS.SYNC.CLIENT_REQUEST_STATE(clientId)}`, {
              method: "POST",
              headers: await this._adminHeaders(),
            });
            const data = await res.json();
            if (!data.success) {
              if (stateContainer) {
                stateContainer.innerHTML = `<div class="ssm-client-state-error">請求失敗：${this._escapeHtml(data.message || "未知錯誤")}</div>`;
              }
            } else {
              const state = data.data?.state || {};
              if (stateContainer) {
                stateContainer.innerHTML = this._renderClientStateDetails(state);
              }
            }
          } catch (e) {
            if (stateContainer) {
              stateContainer.innerHTML = `<div class="ssm-client-state-error">請求失敗：${this._escapeHtml(e.message || "未知錯誤")}</div>`;
            }
          } finally {
            event.target.disabled = false;
            this._restoreOriginalText(event.target);
          }
        })();
        return;
      }

      // 展開/收起工作階段卡片
      if (event.target.closest(".sync-session-header")) {
        const card = event.target.closest(".sync-session-card");
        if (!card) return;
        const sessionId = card.dataset.sessionId;
        if (!sessionId) return;

        const session = this.sessionsData.find((s) => s.id === sessionId);
        if (!session) return;

        const isExpanded = this.expandedCards.has(sessionId);
        const detailsElement = card.querySelector(".sync-session-details");

        if (isExpanded) {
          this.expandedCards.delete(sessionId);
          card.classList.remove("expanded");
          if (detailsElement) detailsElement.innerHTML = "";
        } else {
          this.expandedCards.add(sessionId);
          card.classList.add("expanded");
          if (detailsElement) detailsElement.innerHTML = this.renderSessionDetails(session);
        }
        return;
      }

      // 展開/收起同步狀態
      if (event.target.closest(".sync-session-state-header")) {
        const stateToggle = event.target.closest(".sync-session-state-toggle");
        const stateDetails = stateToggle.querySelector(".sync-session-state-details");
        const expandIcon = stateToggle.querySelector(".sync-state-expand-icon");
        if (stateDetails && expandIcon) {
          const isExpanded = !stateDetails.classList.contains("is-hidden");
          if (isExpanded) {
            stateDetails.classList.add("is-hidden");
            expandIcon.textContent = "▶";
          } else {
            stateDetails.classList.remove("is-hidden");
            expandIcon.textContent = "▼";
          }
        }
        return;
      }
    });
  }

}
