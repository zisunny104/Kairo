/**
 * SyncManager UI - 同步面板 UI 介面管理
 * 負責膠囊指示器、控制面板、按鈕與輸入框
 */

import { SYNC_EVENTS, SYNC_MANAGER_CONSTANTS } from "../constants/index.js";
import { UIModal } from "../ui/modal.js";
import { Logger } from "../core/console-manager.js";
import { getSharedConfig } from "../core/config.js";

export class SyncManagerUI {
  constructor(core, config = {}) {
    this.core = core;
    this.syncManager = config.syncManager || null;
    this.roleConfig =
      config.roleConfig ||
      this.syncManager?.ROLE ||
      SYNC_MANAGER_CONSTANTS.DEFAULT_ROLE_CONFIG;
    this.pageConfig =
      config.pageConfig ||
      this.syncManager?.PAGE ||
      SYNC_MANAGER_CONSTANTS.DEFAULT_PAGE_CONFIG;
    this.statusConfig =
      config.statusConfig ||
      this.syncManager?.STATUS ||
      SYNC_MANAGER_CONSTANTS.DEFAULT_STATUS_CONFIG;
    this.indicatorManager = config.indicatorManager || null;
    this.capsuleIndicator = null;
    this.controlPanel = null;
    this.controlPanelModal = null;
    this.currentShareCode = null;
    this.initialized = false;
    this.eventListeners = [];
    this.domListeners = [];
    this._windowListenersBound = false;
    this.syncBusinessConfig = getSharedConfig()?.multiScreenSync || {};
  }

  isSyncEnabled() {
    return this.syncBusinessConfig.enableSync !== false;
  }

  getValidCreateCode() {
    const configuredCode = this.syncBusinessConfig.validCreateCode;
    if (typeof configuredCode !== "string") return null;
    const normalized = configuredCode.trim();
    return normalized.length > 0 ? normalized : null;
  }

  getCreateCodeLength() {
    const configuredCode = this.getValidCreateCode();
    return configuredCode ? configuredCode.length : 9;
  }

  applyCreateCodeInputConfig(createCodeInput) {
    if (!createCodeInput) return;
    const expectedLength = this.getCreateCodeLength();
    const hint = "輸入建立代碼";

    createCodeInput.maxLength = expectedLength;
    createCodeInput.placeholder = hint;
    createCodeInput.title = hint;
  }

  applySyncAvailabilityState() {
    if (this.isSyncEnabled()) return;

    const createCodeInput = document.getElementById("createCodeInput");
    const createBtn = document.getElementById("createSessionBtn");
    const joinInput = document.getElementById("sessionCodeInput");
    const joinBtn = document.getElementById("joinSessionBtn");
    const channelButtons = this.controlPanel?.querySelectorAll(
      ".sync-channel-btn",
    );

    this._setElementsDisabled(
      [createCodeInput, createBtn, joinInput, joinBtn],
      true,
    );
    this._setElementsDisabled(channelButtons, true);

    this.showStatus("error", "同步功能已停用（config）");
  }

  getRoleText(role) {
    return this.syncManager?.getRoleText?.(role) || role;
  }

  getStatusText(status) {
    return this.syncManager?.getStatusText?.(status) || status;
  }

  getPageName(pageKey) {
    return this.syncManager?.getPageName?.(pageKey) || pageKey;
  }

  getPagePath(pageKey) {
    return this.syncManager?.getPagePath?.(pageKey) || pageKey;
  }

  initialize() {
    if (this.initialized) {
      Logger.debug("[SyncManagerUI.initialize] 已初始化，跳過");
      return;
    }

    const initStart = performance.now();

    Logger.debug("[SyncManagerUI.initialize] 開始初始化");
    try {
      this.createCapsuleIndicator();
      this.setupEventListeners();
      this.updateIndicator();
      this.updateUIState();

      this.initialized = true;

      const duration = performance.now() - initStart;
      Logger.debug(
        `[SyncManagerUI.initialize] 完成 (<orange>${duration.toFixed(0)} ms</orange>)`,
      );
    } catch (error) {
      Logger.error("UI 初始化失敗", error);
    }
  }

  createCapsuleIndicator() {
    Logger.debug("[SyncManagerUI.createCapsuleIndicator] 開始建立膠囊指示器");
    if (this.indicatorManager) {
      this.capsuleIndicator = this.indicatorManager.createCapsuleIndicator(
        () => {
          Logger.debug(
            `[SyncManagerUI] 膠囊指示器被點擊，initialized=${this.initialized}`,
          );
          if (!this.initialized) {
            this.showStatus("error", "同步面板尚未初始化");
            Logger.error(
              "[SyncManagerUI] <red>同步面板尚未初始化</red>",
            );
            return;
          }
          Logger.debug("[SyncManagerUI] 呼叫 showPanel()");
          this.showPanel();
        },
      );
      Logger.debug("[SyncManagerUI.createCapsuleIndicator] 完成");
    } else {
      Logger.debug("[SyncManagerUI.createCapsuleIndicator] indicatorManager 不存在");
    }
  }

  createControlPanel() {
    Logger.debug("[SyncManagerUI.createControlPanel] 開始建立控制面板，this.controlPanelModal存在=" + (this.controlPanelModal ? "是" : "否"));
    const modalHtml = this._renderControlPanelModal();

    if (this.controlPanelModal) {
      Logger.debug("[SyncManagerUI.createControlPanel] 關閉既存的 controlPanelModal");
      this.controlPanelModal.close();
    }

    this.controlPanelModal = new UIModal({
      id: "syncControlPanel",
      html: modalHtml,
    });
    this.controlPanelModal.open();
    this.controlPanel = this.controlPanelModal.modalEl;

    this.setupEventListeners();

    if (this.indicatorManager && this.controlPanel) {
      const panelContent = this.controlPanel.querySelector(
        ".sync-panel-content",
      );
      if (panelContent) {
        this.indicatorManager.attachToPanel(panelContent);
      }
    }
  }

  _renderControlPanelModal() {
    const version = getSharedConfig()?.version || "";
    const versionLabel = version ? `v${version}` : "";
    return `
      <div class="modal-overlay active" id="syncControlPanel">
        <div class="modal-container sync-control-panel">
          ${this._renderControlPanelHeader()}
          <div class="modal-body">
            <div class="sync-panel-content">
              ${this._renderConnectionSection()}
              ${this._renderConnectedSection()}
              <div id="syncStatusMessage"></div>
              ${versionLabel ? `<div class="sync-panel-version">${versionLabel}</div>` : ""}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  _getPageList() {
    // this.syncManager 是 SyncManager 類本身（非實例），PAGE_LIST 是靜態屬性
    const list = this.syncManager?.PAGE_LIST || {};
    return Object.entries(list).map(([key, info]) => ({ key, name: info.name, path: info.path }));
  }

  _renderControlPanelHeader() {
    const pages = this._getPageList();
    const btnHtml = pages.map(p =>
      `<button class="sync-page-toggle-btn" data-page="${p.key}"><span class="btn-text-split">${p.name}</span></button>`,
    ).join("");
    const optHtml = pages.map(p =>
      `<option value="${p.key}">${p.name}</option>`,
    ).join("");
    return `
      <div class="modal-header">
        <h2 class="modal-title">同步面板</h2>
        <div class="sync-page-toggle-group">${btnHtml}</div>
        <div class="sync-page-select-wrapper">
          <select class="sync-page-select" title="切換頁面">${optHtml}</select>
        </div>
        <button class="modal-close-btn" title="關閉">×</button>
      </div>
    `;
  }

  _renderConnectionSection() {
    return `
      <div id="syncConnectionSection" class="sync-connection-section">
        <div class="sync-create-join-container">
          <div class="sync-create-section">
            <h3 class="sync-section-title">建立工作階段</h3>
            <div class="sync-code-input-group">
              <div class="sync-create-input-container">
                <input type="text"
                       id="createCodeInput"
                       placeholder="輸入建立代碼"
                       maxlength="9"
                       pattern="[0-9]*"
                       inputmode="numeric"
                       class="sync-create-input">
                <div id="codeValidationStatus" class="sync-code-validation-indicator"></div>
              </div>
              <button id="createSessionBtn" class="sync-create-btn" disabled>建立</button>
            </div>
          </div>

          <div class="sync-ui-divider">
            <span>或</span>
          </div>

          <div class="sync-join-section">
            <div class="sync-join-header">
              <span class="sync-section-title sync-join-title">加入工作階段</span>
              <div class="sync-ch-role-group">
                <button class="sync-ch-role-btn active" data-role="operator">操作者</button>
                <button class="sync-ch-role-btn" data-role="viewer">檢視者</button>
              </div>
            </div>

            <div class="sync-quick-channel-buttons sync-quick-channel-buttons--inline">
              <button class="sync-channel-btn" data-channel="A">公開 A</button>
              <button class="sync-channel-btn" data-channel="B">公開 B</button>
              <button class="sync-channel-btn" data-channel="C">公開 C</button>
            </div>

            <div class="sync-join-method-divider"></div>

            <div class="sync-join-input-group">
              <input type="text"
                     id="sessionCodeInput"
                     placeholder="輸入分享代碼"
                     maxlength="8">
              <button id="joinSessionBtn">加入</button>
            </div>

            <div class="sync-join-method-divider"></div>

          </div>
        </div>
      </div>
    `;
  }

  _renderConnectedSection() {
    return `
      <div id="syncConnectedSection" class="sync-connected-section">
        <div class="sync-session-info-container">
          <div class="sync-session-info-cards">
            <div class="sync-info-card">
              <div class="sync-card-label">工作階段ID</div>
              <div class="sync-card-value" id="connectedDisplaySessionId">-</div>
            </div>
            <div class="sync-info-card sync-role-card" id="roleCard">
              <div class="sync-card-label">我的角色</div>
              <div class="sync-card-value" id="connectedDisplayRole">-</div>
            </div>
            <div class="sync-info-card">
              <div class="sync-card-label">連線狀態</div>
              <div class="sync-card-value" id="connectedDisplayStatus">-</div>
            </div>
          </div>
          <div class="sync-client-id-display">
            <span class="sync-client-id-label">客戶端ID</span>
            <span class="sync-client-id-value" id="connectedDisplayClientId">-</span>
          </div>
          <div class="sync-session-buttons-container">
            <div class="sync-session-share-row">
              <button id="shareSessionToggleBtn" class="sync-share-toggle-btn">
                分享此工作階段
              </button>
              <div id="shareSessionContent" class="sync-share-content hidden">
                <h3>分享此工作階段</h3>

                <div class="sync-share-code-display">
                  <span class="sync-share-code-label">分享代碼:</span>
                  <div class="sync-share-code-container">
                    <button id="regenerateShareCodeBtn" class="sync-regenerate-code-btn sync-regenerate-inline-btn sync-btn-base" title="重新產生分享代碼">
                      <svg class="sync-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
                        <path d="M21 3v5h-5"></path>
                        <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>
                        <path d="M8 16H3v5"></path>
                      </svg>
                    </button>
                    <span id="shareDisplayCode" class="sync-share-code">-</span>
                    <div class="sync-share-code-buttons">
                      <button id="copyShareCodeBtn" class="sync-copy-code-btn sync-btn-base" title="複製分享代碼">
                        <svg class="sync-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
                          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
                        </svg>
                      </button>
                      <button id="copyShareLinkBtn" class="sync-copy-link-btn sync-btn-base" title="複製分享連結">
                        <svg class="sync-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>

                <button id="shareSessionCollapseBtn" class="sync-share-collapse-btn">
                  <svg class="sync-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18 15l-6-6-6 6"></path>
                  </svg>
                  收起
                </button>
              </div>
            </div>
            <div class="sync-session-action-row">
              <button id="closePublicChannelBtn" class="sync-close-channel-btn" style="display: none;">
                關閉目前工作階段
              </button>
              <button id="disconnectBtn" class="sync-disconnect-btn">
                退出工作階段
              </button>
              <button id="manageSessionsBtn" class="sync-manage-sessions-btn">
                管理工作階段
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  addWindowListener(eventType, handler) {
    window.addEventListener(eventType, handler);
    this.eventListeners.push({ target: window, event: eventType, handler });
  }

  addDOMListener(element, eventType, handler) {
    if (element) {
      element.addEventListener(eventType, handler);
      this.domListeners.push({ element, event: eventType, handler });
    }
  }

  setupEventListeners() {
    try {
      this._resetDomListeners();

      if (!this._windowListenersBound) {
        this.addWindowListener(SYNC_EVENTS.SESSION_JOINED, (event) => {
          const detail = event.detail ?? {};
          const { shareCode } = detail;
          if (shareCode) {
            this.currentShareCode = shareCode;
          }
        });

        this.addWindowListener(SYNC_EVENTS.CONNECTED, () => {
          this.updateUIState();
          this.updateIndicator();
          this.updateConnectedSessionInfo();
        });

        this.addWindowListener(SYNC_EVENTS.DISCONNECTED, () => {
          this.updateUIState();
          this.updateIndicator();
        });

        this.addWindowListener(SYNC_EVENTS.SERVER_STATUS_CHANGED, (event) => {
          const { online, previousOnline } = event.detail;

          this.updateIndicator();

          if (previousOnline && !online) {
            this.showStatus("error", "伺服器已離線");
          } else if (!previousOnline && online) {
            this.showStatus("success", "伺服器已連線");
          }
        });

        this.addWindowListener(SYNC_EVENTS.SESSION_INVALID, (event) => {
          const { reason, originalError } = event.detail;

          Logger.warn("工作階段失效", { reason, originalError });

          if (reason === "session_not_found") {
            this.showStatus(
              "error",
              "工作階段已失效，請重新加入或建立新工作階段",
            );
          } else {
            this.showStatus("error", "工作階段連線異常");
          }

          this.updateIndicator();
          this.updateConnectedSessionInfo();
        });

        this.addWindowListener(SYNC_EVENTS.SESSION_STATE_REFRESHED, () => {
          this.showStatus("info", "已接收伺服器推送的同步狀態");
        });

        this._windowListenersBound = true;
      }

      if (!this.controlPanel) {
        Logger.debug("[SyncManagerUI] 控制面板尚未建立，略過 DOM 事件綁定");
        return;
      }

      const closeBtn = this.controlPanel.querySelector(".modal-close-btn");
      if (closeBtn) {
        this.addDOMListener(closeBtn, "click", () => this.hidePanel());
      }

      const pageToggleButtons = this.controlPanel.querySelectorAll(".sync-page-toggle-btn");
      const pageSelect = this.controlPanel.querySelector(".sync-page-select");

      const navigateToPage = (targetPage) => {
        const basePath = window.location.pathname.substring(
          0, window.location.pathname.lastIndexOf("/") + 1,
        );
        if (targetPage === this.pageConfig.PANEL) {
          window.location.href = basePath.endsWith("/") ? basePath : basePath + "/";
        } else {
          window.location.href = basePath + this.getPagePath(targetPage);
        }
      };

      if (pageToggleButtons.length > 0) {
        pageToggleButtons.forEach((btn) => {
          btn.title = `切換至${btn.querySelector(".btn-text-split")?.textContent || btn.dataset.page}`;
          this.addDOMListener(btn, "click", () => navigateToPage(btn.dataset.page));
        });
      }

      if (pageSelect) {
        this.addDOMListener(pageSelect, "change", () => navigateToPage(pageSelect.value));
      }

      this.updatePageToggleButtonState();

      this.addDOMListener(this.controlPanel, "click", (e) => {
        if (e.target === this.controlPanel) {
          this.hidePanel();
        }
      });

      const createCodeInput = document.getElementById("createCodeInput");
      const createBtn = document.getElementById("createSessionBtn");
      this.applyCreateCodeInputConfig(createCodeInput);

      this.addDOMListener(createCodeInput, "input", (e) => {
        e.target.value = e.target.value.replace(/[^0-9]/g, "");
        this.validateCreateCode(e.target.value);
      });

      this.addDOMListener(createCodeInput, "keypress", (e) => {
        const expectedLength = this.getCreateCodeLength();
        if (e.key === "Enter" && createCodeInput.value.length === expectedLength) {
          this.handleCreateSession();
        }
      });

      this.addDOMListener(createBtn, "click", () => {
        const expectedLength = this.getCreateCodeLength();
        if (createCodeInput.value.length === expectedLength) {
          this.handleCreateSession();
        }
      });

      this.applySyncAvailabilityState();

      const roleCard = document.getElementById("roleCard");
      if (roleCard) {
        this.addDOMListener(roleCard, "click", () => {
          try {
            const currentRole =
              this.core.syncClient?.role || this.roleConfig.VIEWER;
            const newRole =
              currentRole === this.roleConfig.OPERATOR
                ? this.roleConfig.VIEWER
                : this.roleConfig.OPERATOR;

            if (this.core.syncClient) {
              this.core.syncClient.role = newRole;
              this.core.syncClient.saveRole(newRole);
            }

            this.updateConnectedSessionInfo();

            this.showStatus(
              "info",
              `角色已切換為: ${this.getRoleText(newRole)}`,
            );
          } catch (error) {
            Logger.error("角色切換失敗:", error);
            this.showStatus("error", "角色切換失敗");
          }
        });
      }

      const joinBtn = document.getElementById("joinSessionBtn");
      this.addDOMListener(joinBtn, "click", () => this.handleJoinSession());

      const channelBtns =
        this.controlPanel.querySelectorAll(".sync-channel-btn");
      channelBtns.forEach((btn) => {
        this.addDOMListener(btn, "click", () => {
          const channel = btn.dataset.channel;
          this.handleJoinChannel(channel);
        });
      });

      const chRoleBtns =
        this.controlPanel.querySelectorAll(".sync-ch-role-btn");
      chRoleBtns.forEach((btn) => {
        this.addDOMListener(btn, "click", () => {
          chRoleBtns.forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
        });
      });

      const sessionCodeInput = document.getElementById("sessionCodeInput");
      this.addDOMListener(sessionCodeInput, "keypress", (e) => {
        if (e.key === "Enter") {
          this.handleJoinSession();
        }
      });

      const shareSessionToggleBtn = document.getElementById(
        "shareSessionToggleBtn",
      );
      const shareSessionContent = document.getElementById(
        "shareSessionContent",
      );
      const shareSessionCollapseBtn = document.getElementById(
        "shareSessionCollapseBtn",
      );

      if (shareSessionToggleBtn && shareSessionContent) {
        this.addDOMListener(shareSessionToggleBtn, "click", () => {
          shareSessionContent.classList.remove("hidden");
          shareSessionToggleBtn.classList.add("hidden");

          this.initializeShareCode();
        });
      }

      if (shareSessionCollapseBtn && shareSessionContent) {
        this.addDOMListener(shareSessionCollapseBtn, "click", () => {
          shareSessionContent.classList.add("hidden");
          if (shareSessionToggleBtn) {
            shareSessionToggleBtn.classList.remove("hidden");
          }
        });
      }

      const copyShareCodeBtn = document.getElementById("copyShareCodeBtn");
      if (copyShareCodeBtn) {
        this.addDOMListener(copyShareCodeBtn, "click", () => {
          const shareCode =
            document.getElementById("shareDisplayCode").textContent;
          if (shareCode && shareCode !== "-") {
            navigator.clipboard
              .writeText(shareCode)
              .then(() => {
                this._flashCopiedButton(copyShareCodeBtn);
              })
              .catch(() => {
                this.showStatus("error", "複製失敗，請手動複製");
              });
          }
        });
      }

      const disconnectBtn = document.getElementById("disconnectBtn");
      if (disconnectBtn) {
        this.addDOMListener(disconnectBtn, "click", () => {
          this.handleDisconnect();
        });
      }

      const closePublicChannelBtn = document.getElementById(
        "closePublicChannelBtn",
      );
      if (closePublicChannelBtn) {
        this.addDOMListener(closePublicChannelBtn, "click", () => {
          this.handleCloseCurrentSession();
        });
      }

      const manageSessionsBtn = document.getElementById("manageSessionsBtn");
      if (manageSessionsBtn) {
        this.addDOMListener(manageSessionsBtn, "click", () => {
          window.dispatchEvent(new CustomEvent(SYNC_EVENTS.SHOW_SESSIONS));
        });
      }

      const regenerateShareCodeBtn = document.getElementById(
        "regenerateShareCodeBtn",
      );
      if (regenerateShareCodeBtn) {
        this.addDOMListener(regenerateShareCodeBtn, "click", async () => {
          regenerateShareCodeBtn.disabled = true;
          regenerateShareCodeBtn.style.opacity = "0.5";
          try {
            const result = await this.core.syncClient.regenerateShareCode();
            if (result) {
              const newShareCode = result.shareCode;
              this.currentShareCode = newShareCode;

              const shareDisplayCode =
                document.getElementById("shareDisplayCode");
              if (shareDisplayCode) {
                shareDisplayCode.textContent = newShareCode;
              }

              this.showStatus("success", "已重新產生分享代碼");
            }
          } catch (error) {
            Logger.error("[SyncUI] 重新產生分享代碼失敗:", error);
            this.showStatus(
              "error",
              "重新產生分享代碼失敗",
            );
          } finally {
            regenerateShareCodeBtn.disabled = false;
            regenerateShareCodeBtn.style.opacity = "1";
          }
        });
      }

      const copyShareLinkBtn = document.getElementById("copyShareLinkBtn");
      if (copyShareLinkBtn) {
        this.addDOMListener(copyShareLinkBtn, "click", async () => {
          const shareCode =
            document.getElementById("shareDisplayCode")?.textContent;
          if (!shareCode || shareCode === "-") {
            this.showStatus("error", "沒有分享代碼");
            return;
          }

          try {
            const shareUrl = this.core.generateShareUrl(
              shareCode,
              this.core.syncClient?.role || this.roleConfig.VIEWER,
            );

            await navigator.clipboard.writeText(shareUrl);

            this.showStatus("success", "已複製分享連結");
            this._flashCopiedButton(copyShareLinkBtn);
          } catch (error) {
            this.showStatus(
              "error",
              "分享連結複製失敗",
            );
          }
        });
      }
    } catch (error) {
      Logger.error("事件監聽器設定失敗:", error);
    }
  }

  validateCreateCode(code) {
    const statusDiv = document.getElementById("codeValidationStatus");
    const createBtn = document.getElementById("createSessionBtn");

    if (!statusDiv || !createBtn) return;

    const expectedLength = this.getCreateCodeLength();
    const configuredCode = this.getValidCreateCode();

    if (code.length === 0) {
      this._setCreateCodeValidationState(statusDiv, createBtn, "idle");
      return;
    }

    if (code.length < expectedLength) {
      this._setCreateCodeValidationState(statusDiv, createBtn, "invalid");
      return;
    }

    if (code.length !== expectedLength) return;

    const isExpectedCode = !configuredCode || code === configuredCode;
    this._setCreateCodeValidationState(
      statusDiv,
      createBtn,
      isExpectedCode ? "valid" : "invalid",
    );
  }

  async handleCreateSession() {
    if (!this.isSyncEnabled()) {
      this.showStatus("error", "同步功能已停用（config）");
      return;
    }

    const input = document.getElementById("createCodeInput");
    const code = input.value.trim();
    const expectedLength = this.getCreateCodeLength();
    const configuredCode = this.getValidCreateCode();

    if (code.length !== expectedLength) {
      this.showStatus("error", "請輸入有效代碼");
      return;
    }

    if (configuredCode && code !== configuredCode) {
      this.showStatus("error", "建立代碼錯誤");
      return;
    }

    this.showStatus("info", "建立中...");

    try {
      const result = await this.core.createSession(code);
      const sessionId = result.sessionId;

      this.showStatus("success", "建立成功");
      this.refreshFromCoreState();

      window.dispatchEvent(
        new CustomEvent(SYNC_EVENTS.SESSION_CREATED, {
          detail: { sessionId },
        }),
      );

      input.value = "";

      Logger.info("[SyncUI] 工作階段建立成功", { sessionId });
    } catch (error) {
      this.showStatus("error", "建立工作階段失敗");
      Logger.error("[SyncUI] 建立工作階段失敗:", error);
    }
  }

  async handleJoinSession() {
    if (!this.isSyncEnabled()) {
      this.showStatus("error", "同步功能已停用（config）");
      return;
    }

    const input = document.getElementById("sessionCodeInput");
    const code = input.value.trim().toUpperCase();

    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      this.showStatus("error", "請輸入有效之分享代碼");
      return;
    }

    const role = this._getSelectedChannelRole();

    this.showStatus("info", "加入中...");

    try {
      await this.core.joinSessionByShareCode(code, role);

      const roleText = this.getRoleText(role);
      this.showStatus("success", `加入成功（${roleText}）`);
      this.refreshFromCoreState();

      input.value = "";
    } catch (error) {
      this.showStatus("error", error.message || "加入工作階段失敗");
    }
  }

  async handleJoinChannel(channelName) {
    const role = this._getSelectedChannelRole();

    const roleText = this.getRoleText(role) || role;
    this.showStatus("info", `加入頻道 ${channelName}…`);

    const allBtns = this.controlPanel.querySelectorAll(".sync-channel-btn");
    this._setElementsDisabled(allBtns, true);

    try {
      await this.core.joinPublicChannel(channelName, role);

      this.showStatus("success", `頻道 ${channelName} 加入成功（${roleText}）`);
      this.refreshFromCoreState();
    } catch (error) {
      this.showStatus("error", error.message || `加入頻道 ${channelName} 失敗`);
      Logger.error("[SyncUI] 加入公開頻道失敗:", error);
    } finally {
      this._setElementsDisabled(allBtns, false);
    }
  }

  async handleDisconnect() {
    const sessionId = this.core.currentSessionId || this.core.getSessionId?.();

    if (!sessionId) {
      this.showStatus("error", "未連線到任何工作階段");
      return;
    }

    if (!confirm("確定要退出工作階段嗎？")) {
      return;
    }

    try {
      this.showStatus("info", "正在退出工作階段...");
      this.core.disconnect();

      const shareSessionContent = document.getElementById(
        "shareSessionContent",
      );
      const shareSessionToggleBtn = document.getElementById(
        "shareSessionToggleBtn",
      );
      if (shareSessionContent) {
        shareSessionContent.classList.add("hidden");
      }
      if (shareSessionToggleBtn) {
        shareSessionToggleBtn.classList.remove("hidden");
      }

      this.refreshFromCoreState();

      this.showStatus("success", "已退出工作階段");

      setTimeout(() => {
        this.hidePanel();
      }, 1500);
    } catch (error) {
      this.showStatus("error", "退出工作階段失敗");
      Logger.error("Disconnect error:", error);
    }
  }

  async handleCloseCurrentSession() {
    const sessionId = this.core.currentSessionId || this.core.getSessionId();
    if (!sessionId) {
      this.showStatus("error", "未連線到任何工作階段");
      return;
    }

    const isPublicChannel = sessionId.startsWith(
      SYNC_MANAGER_CONSTANTS.PUBLIC_CHANNEL_PREFIX,
    );
    const confirmMessage = isPublicChannel
      ? "確定要關閉目前公開頻道嗎？所有連線將被中斷。"
      : "確定要關閉目前工作階段嗎？所有連線將被中斷。";

    if (!confirm(confirmMessage)) {
      return;
    }

    try {
      this.showStatus(
        "info",
        isPublicChannel
          ? "正在關閉公開頻道..."
          : "正在關閉目前工作階段...",
      );

      const result = await this.core.closeCurrentSession(sessionId);
      this.core.disconnect();

      this.showStatus(
        "success",
        `${isPublicChannel ? "公開頻道" : "工作階段"}已關閉（已斷線 ${result.closedCount || 0} 筆）`,
      );

      this.refreshFromCoreState();
    } catch (error) {
      Logger.error("Close current session error:", error);
      this.showStatus(
        "error",
        "關閉工作階段失敗",
      );
    }
  }

  async initializeShareCode() {
    Logger.debug("開始初始化分享代碼");

    let shareCode = this.currentShareCode;

    if (shareCode) {
      const shareDisplayCode = document.getElementById("shareDisplayCode");
      if (shareDisplayCode) {
        shareDisplayCode.textContent = shareCode;
      }
    } else {
      await this.regenerateAndDisplayShareCode();
    }
  }

  async regenerateAndDisplayShareCode() {
    try {
      if (!this.core.syncClient) {
        throw new Error("SyncClient 未初始化");
      }

      const result = await this.core.generateShareCode();

      const shareCode = result.shareCode;
      this.currentShareCode = shareCode;

      const shareDisplayCode = document.getElementById("shareDisplayCode");
      if (shareDisplayCode) {
        shareDisplayCode.textContent = shareCode;
      }
    } catch (error) {
      Logger.error("產生新分享代碼失敗:", error);
      throw error;
    }
  }

  updateIndicator() {
    if (!this.capsuleIndicator) {
      Logger.warn("capsuleIndicator 不存在，UI 初始化可能失敗或未執行", {
        hasCore: !!this.core,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const status = this.core.getStatusText();
    const isConnected = this.core.isConnected();

    const oldStatusText =
      this.capsuleIndicator.querySelector(".sync-status-text")?.textContent;

    this.capsuleIndicator.classList.remove(
      "offline",
      "online",
      "idle",
      "viewer",
      "operator",
    );

    if (isConnected && status !== this.statusConfig.OFFLINE) {
      this.capsuleIndicator.classList.add("online", status);
    } else {
      this.capsuleIndicator.classList.add("offline", status);
    }

    const textMap = this._getStatusTextMap();

    const statusText = this.capsuleIndicator.querySelector(".sync-status-text");
    if (statusText) {
      statusText.textContent = textMap[status] || "已離線";
    }

    this.logIndicatorStatusChange(status, textMap[status], oldStatusText);

    this.updateUIState();
  }

  logIndicatorStatusChange(status, displayText, oldDisplayText) {
    const colorMap = {
      offline: "red",
      idle: "orange",
      viewer: "blue",
      operator: "green",
    };

    const color = colorMap[status] || "gray";
    const coloredText = `<${color}>${displayText}</${color}>`;

    if (displayText !== oldDisplayText) {
      Logger.debug(`指示器狀態: ${oldDisplayText || "初始"} → ${coloredText}`, {
        status,
        isConnected: this.core.isConnected(),
        serverOnline: this.core.syncClient?.serverOnline,
        connectionAttempted: this.core.syncClient?.connectionAttempted,
        timestamp: new Date().toISOString(),
      });
    } else {
      Logger.debug(`指示器狀態: ${coloredText}`, {
        status,
        isConnected: this.core.isConnected(),
        serverOnline: this.core.syncClient?.serverOnline,
        connectionAttempted: this.core.syncClient?.connectionAttempted,
      });
    }
  }

  updateUIState() {
    try {
      const connectionSection = document.getElementById(
        "syncConnectionSection",
      );
      const connectedSection = document.getElementById("syncConnectedSection");
      const isConnected = this.core.isConnected();

      if (isConnected) {
        this._toggleElementClass(connectionSection, "hidden", true);
        this._toggleElementClass(connectedSection, "show", true);

        this.updateConnectedSessionInfo();
      } else {
        this._toggleElementClass(connectionSection, "hidden", false);
        this._toggleElementClass(connectedSection, "show", false);
      }
    } catch (error) {
      Logger.warn("updateUIState 錯誤:", error);
    }
  }

  updateConnectedSessionInfo() {
    try {
      const sessionId = this.core.getSessionId();
      const role = this.core.syncClient?.role || "-";
      const status = this.core.getStatusText();

      const statusTextMap = this._getStatusTextMap();

      const sessionIdSpan = document.getElementById(
        "connectedDisplaySessionId",
      );
      const roleSpan = document.getElementById("connectedDisplayRole");
      const statusSpan = document.getElementById("connectedDisplayStatus");

      if (sessionIdSpan) {
        sessionIdSpan.textContent = sessionId || "-";
      }
      if (roleSpan) {
        roleSpan.textContent = this.getRoleText(role);
      }
      if (statusSpan) {
        statusSpan.textContent = statusTextMap[status] || status;
      }

      const clientIdEl = document.getElementById("connectedDisplayClientId");
      if (clientIdEl) {
        clientIdEl.textContent = this.core.syncClient?.clientId || "-";
      }

      const isPublicChannel =
        sessionId &&
        sessionId.startsWith(SYNC_MANAGER_CONSTANTS.PUBLIC_CHANNEL_PREFIX);
      const shareRow = this.controlPanel?.querySelector(
        ".sync-session-share-row",
      );
      if (shareRow) {
        shareRow.style.display = isPublicChannel ? "none" : "";
      }

      const closePublicChannelBtn = document.getElementById(
        "closePublicChannelBtn",
      );
      if (closePublicChannelBtn) {
        closePublicChannelBtn.style.display = sessionId ? "" : "none";
      }
    } catch (error) {
      Logger.warn("updateConnectedSessionInfo 錯誤:", error);
    }
  }

  updatePageToggleButtonState() {
    const currentPath = window.location.pathname;
    let currentPage = this.pageConfig.PANEL;
    const pages = this._getPageList();
    for (const { key, path } of pages) {
      if (key !== this.pageConfig.PANEL && path && currentPath.includes(path)) {
        currentPage = key;
        break;
      }
    }

    const pageToggleButtons = this.controlPanel.querySelectorAll(".sync-page-toggle-btn");
    pageToggleButtons.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.page === currentPage);
    });

    const pageSelect = this.controlPanel.querySelector(".sync-page-select");
    if (pageSelect) pageSelect.value = currentPage;
  }

  _getStatusTextMap() {
    return {
      offline: this.getStatusText(this.statusConfig.OFFLINE),
      idle: this.getStatusText(this.statusConfig.IDLE),
      viewer: this.getStatusText(this.roleConfig.VIEWER),
      operator: this.getStatusText(this.roleConfig.OPERATOR),
    };
  }

  _getSelectedChannelRole() {
    const activeRoleBtn = this.controlPanel?.querySelector(
      ".sync-ch-role-btn.active",
    );
    return activeRoleBtn?.dataset?.role || this.roleConfig.OPERATOR;
  }

  _setCreateCodeValidationState(statusDiv, createBtn, state) {
    statusDiv.className =
      state === "idle"
        ? "sync-code-validation-indicator"
        : `sync-code-validation-indicator ${state}`;

    if (state === "idle") {
      statusDiv.textContent = "";
      createBtn.disabled = true;
      return;
    }

    statusDiv.innerHTML =
      state === "valid"
        ? this._getValidationCheckIconHtml()
        : this._getValidationCrossIconHtml();
    createBtn.disabled = state !== "valid";
  }

  _setElementsDisabled(elements, disabled) {
    if (!elements) return;
    if (typeof elements.forEach === "function") {
      elements.forEach((element) => {
        if (element) element.disabled = disabled;
      });
      return;
    }
    elements.disabled = disabled;
  }

  _toggleElementClass(element, className, enabled) {
    if (!element) return;
    element.classList.toggle(className, enabled);
  }

  _flashCopiedButton(button, durationMs = 2000) {
    if (!button) return;

    const originalHTML = button.innerHTML;
    button.innerHTML = this._getCheckmarkIconHtml();
    button.classList.add("copied");

    setTimeout(() => {
      button.innerHTML = originalHTML;
      button.classList.remove("copied");
    }, durationMs);
  }

  _getCheckmarkIconHtml() {
    return "<svg class=\"sync-icon sync-icon-checkmark\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z\"/></svg>";
  }

  _getValidationCheckIconHtml() {
    return "<svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"20,6 9,17 4,12\"></polyline></svg>";
  }

  _getValidationCrossIconHtml() {
    return "<svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><line x1=\"18\" y1=\"6\" x2=\"6\" y2=\"18\"></line><line x1=\"6\" y1=\"6\" x2=\"18\" y2=\"18\"></line></svg>";
  }

  showStatus(type, message) {
    this.indicatorManager?.showStatus(type, message || "", 5000);
  }

  refreshFromCoreState() {
    this.updateIndicator();
    this.updateUIState();
    this.updateConnectedSessionInfo();
  }

  showPanel() {
    Logger.debug("[SyncManagerUI.showPanel] 開始打開面板，controlPanel存在=" + (this.controlPanel ? "是" : "否") + "，在DOM中=" + (this.controlPanel && document.body.contains(this.controlPanel) ? "是" : "否"));
    if (!this.controlPanel || !document.body.contains(this.controlPanel)) {
      Logger.debug("[SyncManagerUI.showPanel] controlPanel不存在或不在DOM中，呼叫 createControlPanel()");
      this.createControlPanel();
    }

    this.capsuleIndicator?.classList.add("is-hidden");

    this.controlPanel?.classList.add("active");
    Logger.debug("[SyncManagerUI.showPanel] 已新增 active class");

    this.updatePageToggleButtonState();

    this.refreshFromCoreState();
    Logger.debug("[SyncManagerUI.showPanel] 完成");
  }

  hidePanel() {
    this.controlPanel?.classList.remove("active");
    this.controlPanelModal?.close();
    this.controlPanel = null;
    this._resetDomListeners();

    if (this.capsuleIndicator?.classList.contains("is-hidden")) {
      this.capsuleIndicator.classList.remove("is-hidden");
    }
  }

  _resetDomListeners() {
    this.domListeners.forEach(({ element, event, handler }) => {
      element?.removeEventListener(event, handler);
    });
    this.domListeners = [];
  }

  cleanup() {
    this.eventListeners.forEach(({ target, event, handler }) => {
      target.removeEventListener(event, handler);
    });
    this.eventListeners = [];
    this._windowListenersBound = false;

    this._resetDomListeners();

    this.capsuleIndicator?.remove();
    this.controlPanel?.remove();
    this.controlPanelModal?.close();
    this.controlPanel = null;
    this.currentShareCode = null;
    this.initialized = false;

    Logger.debug("SyncManagerUI 清理完成");
  }
}
