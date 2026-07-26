/**
 * ArchivePageManager - 實驗檔案庫頁面管理器（協調器）
 */

import { Logger } from "../core/console-manager.js";
import { getApiUrl } from "../core/url-utils.js";
import { getAdminToken, clearAdminToken } from "../core/admin-auth.js";
import { TimeSyncManager } from "../core/time-sync-manager.js";
import { SyncManager } from "../sync/sync-manager.js";
import { archiveSidebarMethods } from "./archive-sidebar.js";
import { archiveViewerMethods } from "./archive-viewer.js";
import { archiveEditorMethods } from "./archive-editor.js";
import { archiveRemarkMethods } from "./archive-remark.js";
import { archiveAuditMethods } from "./archive-audit.js";

class ArchivePageManager {
  constructor() {
    this._api         = null;
    this._tsm         = new TimeSyncManager();
    this._serverFiles = [];
    this._localFiles  = new Map();
    this._file        = null;
    this._expandedSteps = new Set();
    this._tsPopupKeyHandler   = null;
    this._typePopupKeyHandler = null;
    this._remarkState = this._defaultRemarkState();
    this._auditOpen     = false;
    this._auditFindings = [];
    this._insertState   = null; // 步驟卡片內嵌「＋新增記錄」的即時計時狀態
    // 參考資料（ID → 可讀名稱）
    this._gestureMap  = {};
    this._stepMap     = {};
    this._unitMap     = {};
    // 篩選狀態
    this._fileFilter  = "";
    this._entryFilter = "";
    this._selectedFiles = new Set();
    this._serverSizeFilter = { min: 0, max: null, maxAvailable: 0 };
    this._serverDateFilter = { min: null, max: null, minAvailable: null, maxAvailable: null };
    this._serverFilterPopover = null;
  }

  // 先以無授權方式請求；若遇到 401 才取得 token 並重試
  async _authedFetch(url, opts = {}) {
    const first = await fetch(url, opts);
    if (first.status === 401) {
      const token = await getAdminToken();
      if (!token) return first;
      const headers = { ...(opts.headers || {}), "X-Admin-Token": token };
      return fetch(url, { ...opts, headers });
    }
    if (first.status === 403) clearAdminToken();
    return first;
  }

  async initialize() {
    this._api = getApiUrl();
    this._syncManager = new SyncManager();
    this._setupPanelToggle();
    this._setupUpload();
    await Promise.all([
      this._loadRefData(),
      this._loadServerFiles(),
    ]);
    Logger.debug("[Archive] 初始化完成");
  }

  _setupPanelToggle() {
    const btn   = document.getElementById("archivePanelToggle");
    const panel = document.getElementById("archiveLeftPanel");
    const icon  = document.getElementById("panelToggleIcon");
    if (!btn || !panel || !icon) return;
    btn.addEventListener("click", () => {
      const collapsed = panel.classList.toggle("collapsed");
      icon.innerHTML  = collapsed ? "›" : "‹";
      btn.style.left  = collapsed ? "0" : "";
    });
  }
}

Object.assign(ArchivePageManager.prototype,
  archiveSidebarMethods,
  archiveViewerMethods,
  archiveEditorMethods,
  archiveRemarkMethods,
  archiveAuditMethods,
);

// ── 啟動 ──────────────────────────────────────────────────────────────────────

const manager = new ArchivePageManager();
manager.initialize().catch(err => Logger.error("[Archive] 初始化失敗:", err));

export default manager;
