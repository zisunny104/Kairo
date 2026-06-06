/**
 * SyncConfirmDialogManager - 同步工作階段加入確認對話框
 *
 * 負責顯示加入同步工作階段的確認對話框，包含分享代碼驗證、
 * 角色選擇與即時驗證回饋。
 */

import { UIModal } from "../ui/modal.js";
import { Logger } from "../core/console-manager.js";

function escAttr(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

class SyncConfirmDialogManager {
  static syncManager = null;
  static syncClientProvider = null;
  static indicatorManager = null;

  static configure({ syncManager, syncClientProvider, indicatorManager } = {}) {
    if (syncManager) {
      this.syncManager = syncManager;
    }
    if (syncClientProvider) {
      this.syncClientProvider = syncClientProvider;
    }
    if (indicatorManager) {
      this.indicatorManager = indicatorManager;
    }
  }
  /**
   * 顯示加入工作階段確認對話框
   * @param {string} code - 分享代碼
   * @param {string} role - 'viewer' 或 'operator'
   * @param {Function} onConfirm - 確認時的Callback
   * @param {Function} onCancel - 取消時的Callback
   */
  static showJoinConfirmation(code, role, onConfirm, onCancel) {
    Logger.debug("顯示加入確認對話框", { code, role });

    let selectedRole = role;
    let editedCode = code;
    const originalCode = code; // 記錄原始代碼用於還原

    // 移除已存在的對話框（避免重複）
    const existing = document.querySelector(".sync-confirm-dialog");
    if (existing) {
      existing.remove();
    }

    // 建立對話框
    const modeTexts =
      this.syncManager?.MODE_TEXTS || { viewer: "檢視模式", operator: "同步操作" };
    const viewerModeText = modeTexts.viewer;
    const operatorModeText = modeTexts.operator;
    const roleConfig =
      this.syncManager?.ROLE || { VIEWER: "viewer", OPERATOR: "operator" };
    const modalHtml = `
      <div class="modal-overlay sync-confirm-dialog" id="syncConfirmDialog">
        <div class="modal-container">
          <div class="modal-header">
            <h2 class="modal-title">加入同步工作階段</h2>
            <button class="modal-close-btn" title="關閉">×</button>
          </div>
          <div class="modal-body">
              <p class="sync-confirm-subtitle">請確認要加入以下工作階段</p>
              <div class="sync-confirm-items">
                <div class="sync-confirm-item">
                  <div class="sync-confirm-label-row">
                    <span class="sync-confirm-label">分享代碼</span>
                    <div class="sync-confirm-checksum-status">
                      <span class="sync-confirm-checksum-icon">🔍</span>
                      <span class="sync-confirm-checksum-text">驗證中...</span>
                    </div>
                  </div>
                  <div class="sync-confirm-code-container">
                    <input type="text" class="sync-confirm-code-input" value="${escAttr(code)}" maxlength="10" />
                    <button class="sync-confirm-code-reset btn-secondary" title="還原分享代碼">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
                        <path d="M21 3v5h-5"></path>
                        <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>
                        <path d="M3 21v-5h5"></path>
                      </svg>
                    </button>
                  </div>
                </div>
                <div class="sync-confirm-item">
                  <span class="sync-confirm-label">模式</span>
                  <div class="sync-confirm-mode-selector">
                    <button class="sync-confirm-mode-btn" data-role="${escAttr(roleConfig.VIEWER)}">${escAttr(viewerModeText)}</button>
                    <button class="sync-confirm-mode-btn" data-role="${escAttr(roleConfig.OPERATOR)}">${escAttr(operatorModeText)}</button>
                  </div>
                </div>
              </div>
          </div>
          <div class="modal-footer">
            <button class="sync-confirm-btn sync-confirm-btn-cancel modal-btn modal-btn-secondary">取消</button>
            <button class="sync-confirm-btn sync-confirm-btn-confirm modal-btn modal-btn-primary">確認加入</button>
          </div>
        </div>
      </div>
    `;

    const modal = new UIModal({ id: "syncConfirmDialog", html: modalHtml });
    modal.open();
    const confirmDialog = modal.modalEl;
    if (!confirmDialog) {
      Logger.warn("確認對話框建立失敗");
      return;
    }

    // 新增active類別以顯示對話框
    setTimeout(() => {
      confirmDialog.classList.add("active");
    }, 10);

    // 綁定事件
    const btnConfirm = confirmDialog.querySelector(".sync-confirm-btn-confirm");
    const btnCancel = confirmDialog.querySelector(".sync-confirm-btn-cancel");
    const btnClose = confirmDialog.querySelector(".modal-close-btn");
    const overlay = confirmDialog; // confirmDialog itself is the overlay
    const modeButtons = confirmDialog.querySelectorAll(
      ".sync-confirm-mode-btn",
    );
    const codeInput = confirmDialog.querySelector(".sync-confirm-code-input");
    const resetBtn = confirmDialog.querySelector(".sync-confirm-code-reset");

    // 設定初始模式按鈕
    const defaultBtn = confirmDialog.querySelector(`[data-role="${role}"]`);
    if (defaultBtn) {
      defaultBtn.classList.add("sync-confirm-mode-active");
    }

    // 分享代碼輸入變化 - 包含即時驗證狀態顯示
    let validationTimeout;
    codeInput.addEventListener("input", (e) => {
      editedCode = e.target.value.toUpperCase();
      codeInput.value = editedCode;

      // 清除之前的驗證定時器
      clearTimeout(validationTimeout);

      // 取得驗證狀態顯示區域
      const statusEl = confirmDialog.querySelector(
        ".sync-confirm-checksum-status",
      );

      // 如果代碼為空，隱藏驗證狀態
      if (!editedCode.trim()) {
        statusEl.classList.add("is-hidden");
        return;
      }

      // 顯示驗證中的狀態
      statusEl.classList.remove("is-hidden");
      statusEl.classList.remove("valid", "invalid");
      statusEl.querySelector(".sync-confirm-checksum-icon").textContent = "🔍";
      statusEl.querySelector(".sync-confirm-checksum-text").textContent =
        "驗證中...";

      // 延遲驗證（避免頻繁請求）
      validationTimeout = setTimeout(async () => {
        try {
          // 取得 SyncClient 實例驗證代碼有效性
          const syncClient = this.syncClientProvider?.();
          if (!syncClient) {
            throw new Error("SyncClient 未設定");
          }

          const result = await syncClient.getShareCodeInfo(editedCode);
          const currentStatus = confirmDialog.querySelector(
            ".sync-confirm-checksum-status",
          );

          // 有結果且未過期、未使用
          if (result && !result.expired && !result.used) {
            currentStatus.classList.add("valid");
            currentStatus.classList.remove("invalid");
            currentStatus.querySelector(
              ".sync-confirm-checksum-icon",
            ).textContent = "✓";
            currentStatus.querySelector(
              ".sync-confirm-checksum-text",
            ).textContent = "代碼有效";
          } else {
            currentStatus.classList.add("invalid");
            currentStatus.classList.remove("valid");
            currentStatus.querySelector(
              ".sync-confirm-checksum-icon",
            ).textContent = "✗";
            currentStatus.querySelector(
              ".sync-confirm-checksum-text",
            ).textContent = "代碼無效或格式錯誤";
          }
        } catch (error) {
          Logger.error("驗證分享代碼時發生錯誤:", error);
          const currentStatus = confirmDialog.querySelector(
            ".sync-confirm-checksum-status",
          );
          currentStatus.classList.add("invalid");
          currentStatus.classList.remove("valid");
          currentStatus.querySelector(
            ".sync-confirm-checksum-icon",
          ).textContent = "!";
          currentStatus.querySelector(
            ".sync-confirm-checksum-text",
          ).textContent = "驗證錯誤";
        }
      }, 300); // 300ms延遲，使用者停止輸入時觸發
    });

    // 還原按鈕
    resetBtn.addEventListener("click", () => {
      editedCode = originalCode;
      codeInput.value = originalCode;
      codeInput.focus();
    });

    // 模式切換事件
    modeButtons.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        selectedRole = e.target.dataset.role;
        modeButtons.forEach((b) =>
          b.classList.remove("sync-confirm-mode-active"),
        );
        e.target.classList.add("sync-confirm-mode-active");
      });
    });

    const closeDialog = () => {
      modal.close();
      onCancel?.();
    };

    const confirmAction = async () => {
      // 顯示驗證中的狀態
      const confirmBtn = confirmDialog.querySelector(
        ".sync-confirm-btn-confirm",
      );
      const originalText = confirmBtn.textContent;
      confirmBtn.disabled = true;
      confirmBtn.textContent = "驗證中...";

      try {
        // 取得 SyncClient 實例進行最終驗證（在 try 內，確保失敗時能還原按鈕）
        const syncClient = this.syncClientProvider?.();
        if (!syncClient) {
          throw new Error("SyncClient 未設定");
        }

        const result = await syncClient.getShareCodeInfo(editedCode);

        // 還原按鈕狀態
        confirmBtn.disabled = false;
        confirmBtn.textContent = originalText;

        // 檢查代碼是否有效（未過期且未使用）
        if (!result || result.expired || result.used) {
          let reason = "代碼無效";
          if (result?.expired) reason = "代碼已過期";
          if (result?.used) reason = "代碼已被使用";
          this.indicatorManager?.showStatus(
            "error",
            `分享代碼無效: ${reason}`,
          );
          Logger.error("分享代碼驗證失敗:", result);
          return;
        }

        // 驗證通過，關閉對話框並執行Callback
        modal.close();
        onConfirm?.(editedCode, selectedRole);
      } catch (error) {
        Logger.error("驗證分享代碼時發生錯誤:", error);
        this.indicatorManager?.showStatus(
          "error",
          "驗證分享代碼時發生錯誤，請重試",
        );
        confirmBtn.disabled = false;
        confirmBtn.textContent = originalText;
      }
    };

    btnConfirm.addEventListener("click", confirmAction);
    btnCancel.addEventListener("click", closeDialog);
    btnClose.addEventListener("click", closeDialog);
    overlay.addEventListener("click", closeDialog);

    // ESC 鍵支援
    const handleKeyPress = (e) => {
      if (e.key === "Escape") {
        document.removeEventListener("keydown", handleKeyPress);
        closeDialog();
      }
    };
    document.addEventListener("keydown", handleKeyPress);

    // 如果有初始代碼，自動觸發驗證檢查
    if (code?.trim()) {
      // 透過 input 事件觸發驗證流程
      const inputEvent = new Event("input", { bubbles: true });
      codeInput.dispatchEvent(inputEvent);
    }
  }
}

// ES6 模組匯出
export default SyncConfirmDialogManager;
export { SyncConfirmDialogManager };
