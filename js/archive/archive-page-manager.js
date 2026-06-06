/**
 * ArchivePageManager - 實驗檔案庫頁面管理器
 */

import { Logger } from "../core/console-manager.js";
import { getApiUrl } from "../core/url-utils.js";
import {
  RECORD_TYPE_LABELS,
  GESTURE_ATTEMPT_TYPE_LABELS,
  API_ENDPOINTS,
} from "../constants/index.js";
import { TimeSyncManager } from "../core/time-sync-manager.js";

// ── 共用 SVG 圖示 ─────────────────────────────────────────────────────────────
const ICON = {
  copy:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  edit:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  refresh: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  chevronDown:  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
  chevronRight: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`,
};

// ── 手勢嘗試標記圖示（對應 board 的三種標記按鈕）─────────────────────────────
const ATTEMPT_ICON = {
  t: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/></svg>`,
  n: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12,4.5 20.5,19.5 3.5,19.5"/></svg>`,
  f: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><line x1="5.5" y1="5.5" x2="18.5" y2="18.5"/><line x1="18.5" y1="5.5" x2="5.5" y2="18.5"/></svg>`,
};
const ATTEMPT_COLOR = { t: "#4caf50", f: "#f44336", n: "#ff9800" };

// ── 步驟卡片顏色（對應 board-ui-manager.js 的 getCardStyle 邏輯）──────────────
function getStepCardStyle(sId, gId) {
  const sid = sId || "";
  const g   = gId || "";
  if (sid === "SYSTEM_OPEN"  || g === "open")
    return { border: "#4caf50", bg: "#e8f5e9", accent: "#4caf50", tag: "教學系統" };
  if (sid === "SYSTEM_CLOSE" || g === "close")
    return { border: "#f44336", bg: "#ffebee", accent: "#f44336", tag: "教學系統" };
  if (sid === "FINAL_CAPTURE" || g === "capture")
    return { border: "#9c27b0", bg: "#f3e5f5", accent: "#9c27b0", tag: "拍攝記錄" };
  if (sid === "FIRST_UNIT_ZOOM_IN" || g === "zoom_in")
    return { border: "#00bcd4", bg: "#e0f7fa", accent: "#00bcd4", tag: "放大操作" };
  if (sid === "LAST_UNIT_ZOOM_OUT" || g === "zoom_out")
    return { border: "#00bcd4", bg: "#e0f7fa", accent: "#00bcd4", tag: "縮小操作" };
  if (sid.startsWith("UNIT_EXIT_") || sid.startsWith("UNIT_NAV_") || sid.startsWith("UNIT_ENTER_"))
    return { border: "#ff9800", bg: "#fff3e0", accent: "#ff9800", tag: "單元切換" };
  return { border: "#667eea", bg: "#f0f4ff", accent: "#667eea", tag: "" };
}

// ── 類型顏色對照（全域統一，避免各處散落色碼）──────────────────────────────────
const TYPE_COLORS = {
  exp_start:           { bg: "#d5f5e3", text: "#1a7a40", border: "#27ae60" },
  exp_end:             { bg: "#fdecea", text: "#c0392b", border: "#e74c3c" },
  exp_pause:           { bg: "#fef9e7", text: "#9a6500", border: "#f39c12" },
  exp_resume:          { bg: "#dbeafe", text: "#1a5276", border: "#3498db" },
  gesture_step_start:  { bg: "#ebf5fb", text: "#1a5276", border: "#2980b9" },
  gesture_step_end:    { bg: "#d5f5e3", text: "#1a7a40", border: "#27ae60" },
  gesture_step_pause:  { bg: "#fef5e7", text: "#ca6f1e", border: "#e67e22" },
  gesture_attempt_t:   { bg: "#e8f5e9", text: "#4caf50", border: "#4caf50" },
  gesture_attempt_f:   { bg: "#ffebee", text: "#f44336", border: "#f44336" },
  gesture_attempt_n:   { bg: "#fff3e0", text: "#ff9800", border: "#ff9800" },
  action:              { bg: "#f5eef8", text: "#7d3c98", border: "#9b59b6" },
  button_action:       { bg: "#f5eef8", text: "#7d3c98", border: "#9b59b6" },
  _default:            { bg: "#f2f3f4", text: "#7f8c8d", border: "#bdc3c7" },
};

function getTypeColor(entry) {
  if (entry.type === "gesture_attempt") {
    return TYPE_COLORS[`gesture_attempt_${entry.g_type}`] ?? TYPE_COLORS._default;
  }
  return TYPE_COLORS[entry.type] ?? TYPE_COLORS._default;
}

// ── 純函式 ────────────────────────────────────────────────────────────────────

function parseJsonl(text) {
  return text.split("\n")
    .map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function extractSummary(entries) {
  const start    = entries.find(e => e.type === "exp_start");
  const end      = entries.find(e => e.type === "exp_end");
  const attempts = entries.filter(e => e.type === "gesture_attempt");
  return {
    expId:        start?.exp_id || entries.find(e => e.exp_id)?.exp_id || "—",
    participant:  start?.participant || "—",
    comboName:    start?.combo_name  || "—",
    comboId:      start?.combo_id    || "",
    startTime:    start?.ts ?? null,
    endTime:      end?.ts   ?? null,
    duration:     start?.ts && end?.ts ? end.ts - start.ts : null,
    attemptCount: attempts.length,
    successCount: attempts.filter(e => e.g_type === "t").length,
  };
}

function groupEntries(entries) {
  const groups = [];
  let currentStep = null;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];

    if (e.type === "gesture_step_start") {
      // 如果前一個步驟尚未結束（缺少 step_end），先關閉它
      if (currentStep !== null && currentStep.endTs === null) {
        currentStep.endTs = e.ts;
      }
      currentStep = {
        type:    "step",
        gIdx:    e.g_idx,
        sId:     e.s_id  || "",
        gId:     e.g_id  || "",
        startTs: e.ts,
        endTs:   null,
        entries: [{ ...e, _idx: i }],
      };
      groups.push(currentStep);

    } else if (currentStep !== null &&
        (e.g_idx === currentStep.gIdx ||
         (e.g_idx === undefined && ["action", "button_action"].includes(e.type)))) {
      currentStep.entries.push({ ...e, _idx: i });
      if (e.type === "gesture_step_end") {
        currentStep.endTs = e.ts;
        currentStep = null;
      }

    } else {
      currentStep = null;
      groups.push({ type: "event", entry: { ...e, _idx: i } });
    }
  }
  return groups;
}

function stripColorTags(s) {
  return s ? s.replace(/\[\/?\w+\]/g, "").replace(/\s+/g, " ").trim() : "";
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// escapeHtml 會把 " 轉成 &quot; 使後續 regex 無法匹配 JSON 引號
// 原始視圖的 text content 只需轉義 &、<、>
function escapeHtmlText(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function colorizeJson(jsonStr) {
  return escapeHtmlText(jsonStr)
    .replace(/"([^"]+)":/g, '<span class="raw-key">"$1"</span>:')
    .replace(/: "([^"]*)"/g, ': <span class="raw-str">"$1"</span>')
    .replace(/: (\d+(?:\.\d+)?)/g, ': <span class="raw-num">$1</span>')
    .replace(/: (true|false)/g, ': <span class="raw-bool">$1</span>')
    .replace(/: (null)/g, ': <span class="raw-null">$1</span>');
}

// ── ArchiveFileState（資料層）──────────────────────────────────────────────────

class ArchiveFileState {
  static MAX_HISTORY = 200;

  constructor({ id, title, source, entries }) {
    this.id     = id;
    this.title  = title;
    this.source = source;
    this._original = JSON.parse(JSON.stringify(entries));
    this.entries   = JSON.parse(JSON.stringify(entries));
    this.history   = [];
    this.viewMode  = "timeline";
    this.isDirty   = false;
  }

  applyEdit(index, field, value, label = "") {
    if (index < 0 || index >= this.entries.length) return;
    const before = this.entries[index]?.[field];
    if (before === value) return;
    this.entries = [
      ...this.entries.slice(0, index),
      { ...this.entries[index], [field]: value },
      ...this.entries.slice(index + 1),
    ];
    this.history.push({ ts: Date.now(), index, field, before, after: value, label });
    this._trimHistory();
    this.isDirty = true;
    this._autoSave();
  }

  applyBatchEdit(changes, label) {
    let newEntries = [...this.entries];
    const recorded = [];
    for (const { index, field, value } of changes) {
      if (index < 0 || index >= newEntries.length) continue;
      const before = newEntries[index]?.[field];
      if (before === value) continue;
      recorded.push({ index, field, before, after: value });
      newEntries = [
        ...newEntries.slice(0, index),
        { ...newEntries[index], [field]: value },
        ...newEntries.slice(index + 1),
      ];
    }
    if (recorded.length === 0) return;
    this.entries = newEntries;
    this.history.push({ ts: Date.now(), op: "batch", changes: recorded, label });
    this._trimHistory();
    this.isDirty = true;
    this._autoSave();
  }

  undo() {
    if (this.history.length === 0) return false;
    const op = this.history.pop();
    this._applyRevert(op);
    this.isDirty = this.history.length > 0;
    this._autoSave();
    return true;
  }

  undoAt(historyIndex) {
    if (historyIndex < 0 || historyIndex >= this.history.length) return false;
    const op = this.history.splice(historyIndex, 1)[0];
    this._applyRevert(op);
    this.isDirty = this.history.length > 0;
    this._autoSave();
    return true;
  }

  _applyRevert(op) {
    if (op.op === "remove") {
      this.entries = [
        ...this.entries.slice(0, op.index),
        op.removed,
        ...this.entries.slice(op.index),
      ];
    } else if (op.op === "batch") {
      let e = [...this.entries];
      for (const { index, field, before } of [...op.changes].reverse()) {
        if (index >= 0 && index < e.length)
          e = [...e.slice(0, index), { ...e[index], [field]: before }, ...e.slice(index + 1)];
      }
      this.entries = e;
    } else {
      if (op.index >= 0 && op.index < this.entries.length)
        this.entries = [
          ...this.entries.slice(0, op.index),
          { ...this.entries[op.index], [op.field]: op.before },
          ...this.entries.slice(op.index + 1),
        ];
    }
  }

  removeEntry(index) {
    if (index < 0 || index >= this.entries.length) return;
    const removed = this.entries[index];
    this.entries = [
      ...this.entries.slice(0, index),
      ...this.entries.slice(index + 1),
    ];
    this.history.push({ ts: Date.now(), op: "remove", index, removed, label: `刪除: ${removed.type}` });
    this._trimHistory();
    this.isDirty = true;
    this._autoSave();
  }

  _trimHistory() {
    if (this.history.length > ArchiveFileState.MAX_HISTORY)
      this.history.splice(0, this.history.length - ArchiveFileState.MAX_HISTORY);
  }

  revert() {
    this.entries = JSON.parse(JSON.stringify(this._original));
    this.history = [];
    this.isDirty = false;
    ArchiveFileState.clearDraft(this.title);
  }

  toOriginalJsonl() { return this._original.map(e => JSON.stringify(e)).join("\n") + "\n"; }
  toEditedJsonl()   { return this.entries.map(e => JSON.stringify(e)).join("\n") + "\n"; }

  _autoSave() {
    try {
      localStorage.setItem(ArchiveFileState.draftKey(this.title), JSON.stringify({
        savedAt: Date.now(), title: this.title,
        entries: this.entries, history: this.history,
      }));
    } catch (e) {
      if (e?.name === "QuotaExceededError")
        Logger.warn("[Archive] localStorage 已滿，草稿無法儲存（請重設或匯出後清理）");
    }
  }

  static draftKey(title) { return `archive_draft_${encodeURIComponent(title)}`; }
  static loadDraft(title) {
    try { const r = localStorage.getItem(ArchiveFileState.draftKey(title)); return r ? JSON.parse(r) : null; }
    catch { return null; }
  }
  static clearDraft(title) {
    try { localStorage.removeItem(ArchiveFileState.draftKey(title)); } catch {}
  }
}

// ── ArchivePageManager（UI 協調層）───────────────────────────────────────────

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
    // 參考資料（ID → 可讀名稱）
    this._gestureMap  = {};
    this._stepMap     = {};
    this._unitMap     = {};
    // 篩選狀態
    this._fileFilter  = "";
    this._entryFilter = "";
    this._selectedFiles = new Set();
  }

  async initialize() {
    this._api = getApiUrl();
    this._setupPanelToggle();
    this._setupUpload();
    await Promise.all([
      this._loadRefData(),
      this._loadServerFiles(),
    ]);
    Logger.info("[Archive] 初始化完成");
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

  // ── 參考資料（手勢／步驟名稱）─────────────────────────────────────────────

  async _loadRefData() {
    try {
      const [scenRes, unitRes] = await Promise.all([
        fetch("./data/scenarios.json"),
        fetch("./data/units.json"),
      ]);
      const scenData = await scenRes.json();
      const unitData = await unitRes.json();

      this._gestureMap = Object.fromEntries(
        (scenData.gesture_list || []).map(g => [g.gesture_id, g.gesture_name])
      );
      this._stepMap = {};
      this._unitMap = {};
      // units.json
      for (const unit of unitData.units || []) {
        this._unitMap[unit.unit_id] = unit.unit_name;
        for (const step of unit.steps || []) {
          if (!step.step_id || !step.step_name) continue;
          const name = stripColorTags(step.step_name);
          if (name && name !== step.step_id) this._stepMap[step.step_id] = name;
        }
      }
      // scenarios.json sections（SA01~SA04 格式的步驟 ID）
      for (const section of scenData.sections || []) {
        for (const unit of section.units || []) {
          for (const step of unit.steps || []) {
            if (!step.step_id || !step.step_name) continue;
            const name = stripColorTags(step.step_name);
            if (name && name !== step.step_id) this._stepMap[step.step_id] = name;
          }
        }
      }
      Logger.info("[Archive] 參考資料載入完成");
    } catch (err) {
      Logger.warn("[Archive] 參考資料載入失敗:", err.message);
    }
  }

  _defaultRemarkState() {
    return {
      status: "idle",   // idle | countdown | recording | paused | done
      countdownLeft: 3,
      startRealTs: null,
      pausedElapsed: 0, // 暫停前已累積的毫秒數
      marks: [],         // [{ relMs }]
      importedFiles: [], // 匯入的額外 JSONL（多個）
      selectedMarkIdx: null,         // 選取的標記點索引
      selectedSrcEntries: new Set(), // 選取的原始事件索引（複選）
      importPanelOpen: false,
      showOriginalInWorkspace: true,
      _countdownInterval: null,
      _timerInterval: null,
      _keyHandler: null,
    };
  }

  _resolveGesture(gId) {
    return (gId && this._gestureMap[gId]) ? this._gestureMap[gId] : (gId || null);
  }
  _resolveStep(sId) {
    return (sId && this._stepMap[sId]) ? this._stepMap[sId] : (sId || null);
  }

  // ── 伺服器檔案 ────────────────────────────────────────────────────────────

  async _loadServerFiles() {
    const list = document.getElementById("serverFilesList");
    if (!list) return;
    list.innerHTML = `<div class="archive-status">載入中…</div>`;
    try {
      const res  = await fetch(`${this._api}${API_ENDPOINTS.RECORD.LIST}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "未知錯誤");
      this._serverFiles = data.files || [];
      this._renderServerList();
    } catch (err) {
      Logger.error("[Archive] 載入失敗:", err.message);
      list.innerHTML = `<div class="archive-status archive-status--error">無法連接伺服器</div>`;
    }
  }

  _renderServerList() {
    const list = document.getElementById("serverFilesList");
    if (!list) return;

    // 確保篩選輸入框存在（只建一次）
    let filterInput = document.getElementById("serverFileFilter");
    if (!filterInput) {
      const wrap = document.createElement("div");
      wrap.className = "archive-file-filter-wrap";
      wrap.innerHTML = `<input type="text" id="serverFileFilter" class="archive-file-filter" placeholder="搜尋檔案名稱…">`;
      list.parentNode.insertBefore(wrap, list);
      filterInput = document.getElementById("serverFileFilter");
      filterInput.addEventListener("input", () => {
        this._fileFilter = filterInput.value.toLowerCase();
        this._renderServerFileItems();
      });
    }
    filterInput.value = this._fileFilter;
    this._renderServerFileItems();
  }

  _renderServerFileItems() {
    const list = document.getElementById("serverFilesList");
    if (!list) return;
    const files = this._fileFilter
      ? this._serverFiles.filter(f => f.filename.toLowerCase().includes(this._fileFilter))
      : this._serverFiles;

    if (files.length === 0) {
      list.innerHTML = `<div class="archive-status">${this._fileFilter ? "無符合的檔案" : "伺服器上尚無日誌"}</div>`;
      return;
    }
    const activeId = this._file?.id || "";
    list.innerHTML = files.map(f => {
      const kb  = (f.size / 1024).toFixed(1);
      const dt  = this._tsm.formatDateTime(f.modified, { includeTime: false });
      const id     = `server:${f.filename}`;
      const safeId = escapeHtml(id);
      const sel    = this._selectedFiles.has(id);
      const active = activeId === id;
      return `<div class="archive-file-card${active ? " is-active" : ""}${sel ? " is-selected" : ""}" data-file-id="${safeId}">
        <input type="checkbox" class="archive-file-checkbox" data-file-id="${safeId}" ${sel ? "checked" : ""}>
        <div class="archive-file-info" data-filename="${escapeHtml(f.filename)}">
          <span class="archive-file-name">${escapeHtml(f.filename)}</span>
          <span class="archive-file-meta">${dt} · ${kb} KB</span>
        </div>
      </div>`;
    }).join("");

    list.querySelectorAll(".archive-file-info").forEach(info =>
      info.addEventListener("click", () => this._openServer(info.dataset.filename))
    );
    list.querySelectorAll(".archive-file-checkbox").forEach(cb =>
      cb.addEventListener("change", () => {
        const id = cb.dataset.fileId;
        if (cb.checked) this._selectedFiles.add(id);
        else this._selectedFiles.delete(id);
        cb.closest(".archive-file-card")?.classList.toggle("is-selected", cb.checked);
      })
    );
  }

  async _openServer(filename) {
    const id = `server:${filename}`;
    this._setActive(id);
    this._showLoading(filename);
    try {
      const res  = await fetch(`${this._api}${API_ENDPOINTS.RECORD.READ(filename)}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "讀取失敗");
      const entries = parseJsonl(data.content);
      const state   = new ArchiveFileState({ id, title: filename, source: "server", entries });
      this._restoreDraft(state);
      this._expandedSteps.clear();
      this._openState(state);
    } catch (err) {
      Logger.error("[Archive] 讀取失敗:", err.message);
      this._showError(filename, err.message);
    }
  }

  // ── 本機上傳 ──────────────────────────────────────────────────────────────

  _setupUpload() {
    const zone    = document.getElementById("uploadZone");
    const input   = document.getElementById("archiveFileInput");
    const btn     = document.getElementById("uploadBtn");
    const refresh = document.getElementById("refreshServerBtn");
    if (!zone || !input || !btn) return;

    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", () => { this._handleFiles(input.files); input.value = ""; });
    zone.addEventListener("dragover",  e => { e.preventDefault(); zone.classList.add("drag-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", e => {
      e.preventDefault(); zone.classList.remove("drag-over");
      this._handleFiles(e.dataTransfer.files);
    });
    refresh?.addEventListener("click", () => this._loadServerFiles());
  }

  _handleFiles(files) {
    for (const file of files) {
      if (!file.name.endsWith(".jsonl")) continue;
      const reader = new FileReader();
      reader.onload = e => {
        const id = `local:${file.name}`;
        this._localFiles.set(id, { name: file.name, content: e.target.result });
        this._renderLocalList();
        const entries = parseJsonl(e.target.result);
        const state   = new ArchiveFileState({ id, title: file.name, source: "local", entries });
        this._restoreDraft(state);
        this._setActive(id);
        this._expandedSteps.clear();
        this._openState(state);
      };
      reader.readAsText(file);
    }
  }

  _renderLocalList() {
    const ctn = document.getElementById("localFilesList");
    if (!ctn) return;
    if (this._localFiles.size === 0) { ctn.innerHTML = ""; return; }
    const activeId = this._file?.id || "";
    ctn.innerHTML = `<div class="archive-local-label">本機（僅此工作階段）</div>` +
      [...this._localFiles.entries()].map(([id, f]) => {
        const safeId = escapeHtml(id);
        const sel    = this._selectedFiles.has(id);
        const active = activeId === id;
        return `<div class="archive-file-card${active ? " is-active" : ""}${sel ? " is-selected" : ""}" data-file-id="${safeId}">
          <input type="checkbox" class="archive-file-checkbox" data-file-id="${safeId}" ${sel ? "checked" : ""}>
          <div class="archive-file-info" data-file-id="${safeId}">
            <span class="archive-file-name">${escapeHtml(f.name)}</span>
            <span class="archive-file-meta">本機</span>
          </div>
        </div>`;
      }).join("");

    ctn.querySelectorAll(".archive-file-info").forEach(info =>
      info.addEventListener("click", () => {
        const id = info.dataset.fileId;
        const f  = this._localFiles.get(id);
        if (!f) return;
        this._setActive(id);
        const entries = parseJsonl(f.content);
        const state   = new ArchiveFileState({ id, title: f.name, source: "local", entries });
        this._restoreDraft(state);
        this._expandedSteps.clear();
        this._openState(state);
      })
    );
    ctn.querySelectorAll(".archive-file-checkbox").forEach(cb =>
      cb.addEventListener("change", () => {
        const id = cb.dataset.fileId;
        if (cb.checked) this._selectedFiles.add(id);
        else this._selectedFiles.delete(id);
        cb.closest(".archive-file-card")?.classList.toggle("is-selected", cb.checked);
      })
    );
  }

  _restoreDraft(state) {
    const draft = ArchiveFileState.loadDraft(state.title);
    if (!draft || draft.history.length === 0) return;
    state.entries = draft.entries;
    state.history = draft.history;
    state.isDirty = true;
    Logger.info(`[Archive] 還原草稿：${draft.history.length} 筆編輯 (${state.title})`);
  }

  // ── 上傳至伺服器 ──────────────────────────────────────────────────────────

  async _uploadToServer(state) {
    const btn = document.querySelector("[data-action='upload']");
    if (btn) { btn.disabled = true; btn.textContent = "上傳中…"; }
    try {
      const res = await fetch(`${this._api}${API_ENDPOINTS.RECORD.SAVE}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: state.title, content: state.toEditedJsonl() }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "上傳失敗");
      Logger.info(`[Archive] 上傳成功: ${data.path}`);
      await this._loadServerFiles();
      this._renderAll();
    } catch (err) {
      Logger.error("[Archive] 上傳失敗:", err.message);
      alert(`上傳失敗：${err.message}`);
      if (btn) { btn.disabled = false; btn.textContent = "上傳至伺服器"; }
    }
  }

  // ── 狀態管理 ──────────────────────────────────────────────────────────────

  _setActive(id) {
    document.querySelectorAll(".archive-file-card").forEach(card =>
      card.classList.toggle("is-active", card.dataset.fileId === id)
    );
  }

  _openState(state) {
    this._cleanupRemark();
    this._file = state;
    this._entryFilter = "";
    this._renderAll();
  }

  _toggleStep(key) {
    const el = document.querySelector(`[data-step-key="${CSS.escape(key)}"]`);
    if (!el) return;
    const body = el.querySelector(".archive-step-body");
    if (!body) return;

    const expanded = this._expandedSteps.has(key);
    if (expanded) {
      this._expandedSteps.delete(key);
      body.hidden = true;
    } else {
      this._expandedSteps.add(key);
      body.hidden = false;
    }

    const toggleBtn = el.querySelector(".archive-step-toggle");
    if (toggleBtn) {
      toggleBtn.innerHTML = this._expandedSteps.has(key) ? ICON.chevronDown : ICON.chevronRight;
    }
  }

  // ── 主渲染入口 ────────────────────────────────────────────────────────────

  _renderAll() {
    const viewer = document.getElementById("archiveViewer");
    if (!viewer || !this._file) return;
    viewer.innerHTML = this._buildToolbarHtml() + this._buildContentHtml();
    this._bindViewerEvents(viewer);
    if (this._file.viewMode === "remark") this._bindRemarkEvents(viewer);
  }

  // ── 工具列 ────────────────────────────────────────────────────────────────

  _buildToolbarHtml() {
    const f = this._file;
    if (!f) return "";
    const dirty     = f.isDirty ? `<span class="archive-toolbar-dirty">● 已編輯</span>` : "";
    const undoCount = f.history.length;
    const isLocal   = f.source === "local";
    return `<div class="archive-toolbar">
      <span class="archive-toolbar-title">${escapeHtml(f.title)}${dirty}</span>
      <div class="archive-view-toggle">
        <button class="archive-view-btn${f.viewMode === "timeline" ? " is-active" : ""}" data-mode="timeline">時間軸</button>
        <button class="archive-view-btn${f.viewMode === "table"    ? " is-active" : ""}" data-mode="table">表格</button>
        <button class="archive-view-btn${f.viewMode === "raw"      ? " is-active" : ""}" data-mode="raw">原始</button>
      </div>
      <button class="archive-action-btn archive-action-btn--remark${f.viewMode === "remark" ? " is-active" : ""}" data-mode="remark">重新標記</button>
      ${isLocal ? `<button class="archive-action-btn archive-action-btn--upload" data-action="upload">上傳至伺服器</button>` : ""}
    </div>`;
  }

  // ── 內容 HTML ─────────────────────────────────────────────────────────────

  _buildContentHtml() {
    const f = this._file;
    if (!f) return "";
    if (f.viewMode === "remark") return this._buildRemarkContent();

    const sum  = extractSummary(f.entries);
    const rate = sum.attemptCount > 0 ? Math.round(sum.successCount / sum.attemptCount * 100) : null;
    const fmtTs = ts => ts ? this._tsm.formatDateTime(ts, { includeSeconds: true }) : "—";
    const combo = sum.comboName !== "—"
      ? (sum.comboId
          ? `${escapeHtml(sum.comboName)}<span class="archive-stat-subid">${escapeHtml(sum.comboId)}</span>`
          : escapeHtml(sum.comboName))
      : "—";

    const summary = `
      <div class="archive-summary">
        <div class="archive-summary-title">
          <h3>${escapeHtml(f.title)}</h3>
        </div>
        <div class="archive-stat-grid">
          ${this._statCopyable("實驗 ID", sum.expId)}
          ${this._statEditable("受試者", sum.participant, 0, "participant")}
          <div class="archive-stat">
            <span class="archive-stat-label">組合</span>
            <span class="archive-stat-value">${combo}</span>
          </div>
          ${this._stat("開始時間", fmtTs(sum.startTime))}
          ${this._stat("持續時間", sum.duration != null ? this._tsm.formatDurationText(Math.floor(sum.duration / 1000)) : "—")}
          ${this._stat("手勢嘗試", `${sum.attemptCount} 次${rate !== null ? ` (${rate}% 成功)` : ""}`)}
        </div>
      </div>`;

    // 篩選列
    const TYPE_OPTIONS = [
      ["", "所有類型"],
      ["exp_start",          "實驗開始"],
      ["exp_end",            "實驗結束"],
      ["exp_pause",          "實驗暫停"],
      ["exp_resume",         "實驗繼續"],
      ["gesture_step_start", "步驟開始"],
      ["gesture_step_end",   "步驟結束"],
      ["gesture_attempt",    "手勢嘗試"],
      ["action",             "動作"],
      ["button_action",      "按鈕操作"],
    ];
    const typeOptions = TYPE_OPTIONS.map(([v, l]) =>
      `<option value="${v}"${this._entryFilter === v ? " selected" : ""}>${l}</option>`
    ).join("");

    const filtered = this._applyEntryFilter(f.entries);
    const editInfo  = f.history.length > 0
      ? `<span class="archive-edit-history" data-action="show-history" title="點按查看編輯記錄">・${f.history.length} 筆編輯</span>` : "";
    const filterNote = filtered.length < f.entries.length
      ? `<span class="archive-filter-note">（篩選：${filtered.length} 筆）</span>` : "";

    const undoCount = f.history.length;
    const expandBtn = f.viewMode === "timeline"
      ? `<button class="archive-count-btn" data-action="toggle-expand">${ICON.chevronDown} 展開全部</button>` : "";
    const countBar = `<div class="archive-count-bar">
      <span class="archive-entries-count">共 ${f.entries.length} 筆記錄${editInfo}${filterNote}</span>
      <div class="archive-filter-row">
        ${expandBtn}
        <button class="archive-count-btn" data-action="undo" ${undoCount === 0 ? "disabled" : ""}>還原${undoCount > 0 ? ` (${undoCount})` : ""}</button>
        <button class="archive-count-btn archive-count-btn--danger" data-action="revert" ${!f.isDirty ? "disabled" : ""}>重設</button>
        <label class="archive-filter-label" for="entryTypeFilter">篩選</label>
        <select class="archive-filter-select" id="entryTypeFilter">${typeOptions}</select>
      </div>
    </div>`;

    let body = "";
    if (f.viewMode === "timeline") body = this._renderTimeline(filtered);
    if (f.viewMode === "table")    body = this._renderTable(filtered);
    if (f.viewMode === "raw")      body = this._renderRaw(filtered);

    return summary + countBar + body;
  }

  _applyEntryFilter(entries) {
    if (!this._entryFilter) return entries;
    return entries.filter(e => e.type === this._entryFilter);
  }

  // ── 統計格輔助 ────────────────────────────────────────────────────────────

  _stat(label, value) {
    return `<div class="archive-stat">
      <span class="archive-stat-label">${label}</span>
      <span class="archive-stat-value">${escapeHtml(String(value))}</span>
    </div>`;
  }

  _statCopyable(label, value) {
    return `<div class="archive-stat archive-stat--copyable" data-copy="${escapeHtml(String(value))}">
      <span class="archive-stat-label">
        ${label}
        <button class="archive-icon-action" title="複製">${ICON.copy}</button>
      </span>
      <span class="archive-stat-value">${escapeHtml(String(value))}</span>
    </div>`;
  }

  _statEditable(label, value, entryIndex, field) {
    return `<div class="archive-stat archive-stat--editable"
        data-edit-index="${entryIndex}" data-edit-field="${field}">
      <span class="archive-stat-label">
        ${label}
        <button class="archive-icon-action" title="編輯">${ICON.edit}</button>
      </span>
      <span class="archive-stat-value">${escapeHtml(String(value))}</span>
    </div>`;
  }

  // ── 事件綁定 ──────────────────────────────────────────────────────────────

  _bindViewerEvents(viewer) {
    viewer.querySelectorAll("[data-mode]").forEach(btn =>
      btn.addEventListener("click", () => this._setViewMode(btn.dataset.mode))
    );
    viewer.querySelector("[data-action='show-history']")?.addEventListener("click", e => {
      e.stopPropagation(); this._showHistoryPopup(e.currentTarget);
    });
    viewer.addEventListener("click", e => {
      if (!e.target.closest("#history-popup") && !e.target.closest("[data-action='show-history']"))
        document.getElementById("history-popup")?.remove();
    });
    // 篩選列的還原/重設/展開按鈕
    viewer.querySelectorAll("[data-action='undo']").forEach(el =>
      el.addEventListener("click", () => this._handleUndo()));
    viewer.querySelectorAll("[data-action='revert']").forEach(el =>
      el.addEventListener("click", () => this._handleRevert()));
    viewer.querySelector("[data-action='upload']")?.addEventListener("click", () => this._uploadToServer(this._file));
    viewer.querySelectorAll("[data-action='toggle-expand']").forEach(el => el.addEventListener("click", () => {
      const allKeys = [...viewer.querySelectorAll(".archive-step-card[data-step-key]")].map(c => c.dataset.stepKey);
      const allOpen = allKeys.every(k => this._expandedSteps.has(k));
      this._expandAll(viewer, !allOpen);
      const btn = viewer.querySelector("[data-action='toggle-expand']");
      if (btn) btn.innerHTML = allOpen
        ? `${ICON.chevronDown} 展開全部`
        : `${ICON.chevronRight} 收折全部`;
    }));

    // 類型篩選
    viewer.querySelector("#entryTypeFilter")?.addEventListener("change", e => {
      this._entryFilter = e.target.value;
      this._renderAll();
    });

    // 摘要互動
    this._bindSummaryEvents(viewer, this._file);

    // 步驟收折
    viewer.querySelectorAll(".archive-step-header[data-step-key]").forEach(hdr =>
      hdr.addEventListener("click", () => this._toggleStep(hdr.dataset.stepKey))
    );

    // 時間戳彈出框
    viewer.addEventListener("click", e => {
      const el = e.target.closest(".ts-editable");
      if (el) {
        e.stopPropagation();
        el.classList.contains("ts-editing") ? this._closeTsPopup() : this._handleTsEdit(el);
        return;
      }
      if (!e.target.closest("#ts-popup")) this._closeTsPopup();
    });

    // 類型 badge 彈出框
    viewer.addEventListener("click", e => {
      const el = e.target.closest("[data-type-edit]");
      if (el) { e.stopPropagation(); this._handleTypeEdit(el); return; }
      if (!e.target.closest("#type-popup")) this._closeTypePopup();
    });

    // 標記欄彈出框（三選一）
    viewer.addEventListener("click", e => {
      const el = e.target.closest("[data-mark-edit]");
      if (el) { e.stopPropagation(); this._handleMarkEdit(el); return; }
      if (!e.target.closest("#mark-popup")) this._closeMarkPopup();
    });
  }

  _expandAll(viewer, expand) {
    viewer.querySelectorAll(".archive-step-card[data-step-key]").forEach(card => {
      const key  = card.dataset.stepKey;
      const body = card.querySelector(".archive-step-body");
      if (!body) return;
      if (expand) {
        this._expandedSteps.add(key);
        body.hidden = false;
      } else {
        this._expandedSteps.delete(key);
        body.hidden = true;
      }
      const toggleBtn = card.querySelector(".archive-step-toggle");
      if (toggleBtn) toggleBtn.innerHTML = expand ? ICON.chevronDown : ICON.chevronRight;
    });
  }

  _handleTsEdit(el) {
    this._closeTsPopup();
    const idx       = parseInt(el.dataset.tsEdit);
    const currentTs = parseInt(el.dataset.ts);
    if (isNaN(idx) || isNaN(currentTs) || !this._file) return;

    const originalTs = this._file._original[idx]?.ts ?? currentTs;
    const expStart   = this._file.entries.find(e => e.type === "exp_start");
    const expStartTs = expStart?.ts ?? null;
    const fmtRel = ts => (!ts || !expStartTs) ? "T+??" : `T+${this._tsm.formatStopwatch(ts - expStartTs)}`;

    el.classList.add("ts-editing");

    const popup = document.createElement("div");
    popup.id        = "ts-popup";
    popup.className = "archive-ts-popup";
    popup.innerHTML = `
      <div class="ts-popup-head">
        調整時間戳 <span class="ts-popup-key">ts</span>
      </div>
      <div class="ts-popup-adj-row">
        <button class="ts-adj-btn" data-delta="-1000">−1 秒</button>
        <button class="ts-adj-btn" data-delta="-100">−0.1 秒</button>
        <button class="ts-adj-btn" data-delta="100">+0.1 秒</button>
        <button class="ts-adj-btn" data-delta="1000">+1 秒</button>
      </div>
      <div class="ts-popup-input-row">
        <label class="ts-input-label">毫秒值</label>
        <input type="number" class="ts-ms-input" value="${currentTs}" step="100">
      </div>
      <div class="ts-popup-preview">相對時間：<span class="ts-rel-preview">${fmtRel(currentTs)}</span></div>
      <div class="ts-popup-actions">
        <button class="ts-action-btn ts-revert-btn">還原</button>
        <button class="ts-action-btn ts-cancel-btn">取消</button>
        <button class="ts-action-btn ts-save-btn">儲存</button>
      </div>`;

    const rect = el.getBoundingClientRect();
    popup.style.top  = `${rect.bottom + 6}px`;
    popup.style.left = `${rect.left}px`;
    document.body.appendChild(popup);

    const input   = popup.querySelector(".ts-ms-input");
    const preview = popup.querySelector(".ts-rel-preview");

    const updatePreview = () => {
      const v = parseInt(input.value);
      preview.textContent = isNaN(v) ? "T+??" : fmtRel(v);
    };

    input.addEventListener("input", updatePreview);
    input.focus(); input.select();

    popup.querySelectorAll(".ts-adj-btn").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        input.value = (parseInt(input.value) || currentTs) + parseInt(btn.dataset.delta);
        updatePreview();
      })
    );

    popup.querySelector(".ts-revert-btn").addEventListener("click", e => {
      e.stopPropagation();
      input.value = originalTs;
      updatePreview();
    });

    popup.querySelector(".ts-cancel-btn").addEventListener("click", e => {
      e.stopPropagation();
      this._closeTsPopup();
    });

    popup.querySelector(".ts-save-btn").addEventListener("click", e => {
      e.stopPropagation();
      const newTs = parseInt(input.value);
      if (!isNaN(newTs) && newTs !== currentTs)
        this._file.applyEdit(idx, "ts", newTs, `時間調整: ${currentTs}→${newTs}`);
      this._closeTsPopup();
      this._renderAll();
    });

    document.addEventListener("keydown", this._tsPopupKeyHandler = ev => {
      if (ev.key === "Escape") this._closeTsPopup();
    }, { once: true });
  }

  // ── 重新標記模式 ──────────────────────────────────────────────────────────

  // ── 來源顏色（原始檔=0, 匯入①②…）──────────────────────────────────────────
  _sourceColor(idx) {
    const palette = ["#6c757d","#2196F3","#4CAF50","#FF9800","#9C27B0","#F44336","#00BCD4"];
    return palette[idx % palette.length];
  }

  _buildRemarkContent() {
    const f   = this._file;
    const sum = extractSummary(f.entries);
    const rs  = this._remarkState;

    const topStats = `<div class="archive-stat-grid">
      ${this._statCopyable("實驗 ID", sum.expId)}
      ${this._statEditable("受試者", sum.participant, 0, "participant")}
      <div class="archive-stat"><span class="archive-stat-label">組合</span>
        <span class="archive-stat-value">${escapeHtml(sum.comboName !== "—" ? sum.comboName : "—")}</span></div>
    </div>`;

    const assignBanner = rs.selectedMarkIdx != null
      ? `<div class="remark-assign-hint">已選取標記點 ${rs.selectedMarkIdx + 1}（T+${this._tsm.formatStopwatch(rs.marks[rs.selectedMarkIdx]?.relMs ?? 0)}）→ 點選左側事件套用此時間</div>`
      : "";

    return `<div class="remark-layout">
      <div class="remark-timeline${rs.selectedMarkIdx != null ? " has-mark-selected" : ""}">
        <div class="archive-summary" style="margin-bottom:12px">
          <div class="archive-summary-title"><h3>${escapeHtml(f.title)}</h3></div>
          ${topStats}
        </div>
        ${assignBanner}
        ${this._renderTimeline(f.entries)}
      </div>
      <div class="remark-workspace">
        ${this._renderMarkWorkspace()}
      </div>
      <div class="remark-import-panel${rs.importPanelOpen ? " is-open" : ""}">
        ${rs.importPanelOpen ? this._renderImportPanel() : ""}
      </div>
      <button class="remark-import-toggle" data-remark="toggle-import"
              title="${rs.importPanelOpen ? "收起匯入面板" : "展開匯入面板"}">
        ${rs.importPanelOpen ? "›" : "‹"}
      </button>
    </div>`;
  }

  _renderMarkWorkspace() {
    const rs     = this._remarkState;
    const fmtRel = ms => `T+${this._tsm.formatStopwatch(ms)}`;
    const hasMarks = rs.marks.length > 0;

    // ── 錄製控制頭部 ────────────────────────────────────────────────────────
    let controlsHtml = "";
    if (rs.status === "idle") {
      controlsHtml = hasMarks
        ? `<div class="remark-btn-row">
             <button class="remark-action-btn" data-remark="start">繼續標記</button>
             <button class="remark-action-btn remark-action-btn--secondary" data-remark="restart-all">從頭開始</button>
           </div>`
        : `<button class="remark-action-btn" data-remark="start">開始標記</button>`;
    } else if (rs.status === "countdown") {
      controlsHtml = `<div class="remark-countdown-wrap">
        <div class="remark-countdown-num" id="remark-countdown">${rs.countdownLeft}</div>
        <div class="remark-countdown-lbl">準備中…</div>
      </div>`;
    } else if (rs.status === "recording" || rs.status === "paused") {
      const isPaused = rs.status === "paused";
      const elapsed  = isPaused ? rs.pausedElapsed : rs.pausedElapsed + Date.now() - rs.startRealTs;
      controlsHtml = `
        <div class="remark-rec-row">
          <span class="remark-rec-timer" id="remark-timer">${fmtRel(elapsed)}</span>
          <span class="remark-status-pill${isPaused ? " paused" : ""}">${isPaused ? "⏸ 已暫停" : "● 標記中"}</span>
        </div>
        <button class="remark-mark-btn${isPaused ? " disabled" : ""}" data-remark="mark" ${isPaused ? "disabled" : ""}>標記</button>
        <div class="remark-key-hint">Space 標記 · P 暫停/繼續 · Esc 停止</div>
        <div class="remark-sec-row">
          <button class="remark-action-btn remark-action-btn--secondary" data-remark="${isPaused ? "resume" : "pause"}">${isPaused ? "繼續" : "暫停"}</button>
          <button class="remark-action-btn remark-action-btn--secondary" data-remark="stop">停止</button>
        </div>`;
    } else if (rs.status === "done") {
      controlsHtml = `
        <div class="remark-rec-row">
          <span class="remark-status-pill done">✓ 已完成</span>
          <span class="remark-done-count">${rs.marks.length} 個標記</span>
        </div>
        <div class="remark-btn-row">
          <button class="remark-action-btn" data-remark="start">繼續標記</button>
          <button class="remark-action-btn remark-action-btn--secondary" data-remark="restart-all">從頭開始</button>
        </div>`;
    }

    // ── 工具列（顯示原始事件切換 + 選取資訊 + 清除全部）─────────────────
    const selCount = rs.selectedSrcEntries.size;
    const toolbarHtml = `<div class="remark-workspace-toolbar">
      <label class="remark-toggle-label">
        <input type="checkbox" id="remark-show-original" ${rs.showOriginalInWorkspace ? "checked" : ""}>
        顯示原始事件
      </label>
      ${selCount > 0 ? `<span class="remark-sel-count">已選 ${selCount} 筆</span>` : ""}
      ${hasMarks ? `<button class="archive-count-btn remark-clear-all-btn" data-remark="clear-all">清除全部</button>` : ""}
    </div>`;

    // ── 輸出按鈕 ──────────────────────────────────────────────────────────
    const outputHtml = hasMarks ? `<div class="remark-workspace-output">
      <button class="remark-finish-btn" data-remark="save-new">另存新檔</button>
    </div>` : "";

    return `<div class="remark-workspace-header">${controlsHtml}</div>
      ${toolbarHtml}
      <div class="remark-workspace-scroll">
        <div class="remark-workspace-track">${this._renderMarkTrack()}</div>
        ${outputHtml}
      </div>`;
  }

  _renderMarkTrack() {
    const rs       = this._remarkState;
    const fmtRel   = ms => `T+${this._tsm.formatStopwatch(ms)}`;
    const canOp    = rs.status === "idle" || rs.status === "done";
    const expStartTs = this._file?.entries.find(e => e.type === "exp_start")?.ts ?? null;

    // ── 收集所有要顯示的項目 ─────────────────────────────────────────────
    const items = [];

    if (rs.showOriginalInWorkspace && this._file) {
      for (let i = 0; i < this._file.entries.length; i++) {
        const entry = this._file.entries[i];
        const relMs = expStartTs != null && entry.ts != null ? entry.ts - expStartTs : null;
        items.push({ relMs, sourceIdx: 0, isNewMark: false, entry, entryFileIdx: i });
      }
    }

    rs.importedFiles.forEach((imp, fi) => {
      const impExpStartTs = imp.entries.find(e => e.type === "exp_start")?.ts ?? null;
      for (const entry of imp.entries) {
        const relMs = impExpStartTs != null && entry.ts != null ? entry.ts - impExpStartTs : null;
        items.push({ relMs, sourceIdx: fi + 1, isNewMark: false, entry, entryFileIdx: null });
      }
    });

    for (let i = 0; i < rs.marks.length; i++) {
      items.push({ relMs: rs.marks[i].relMs, sourceIdx: -1, isNewMark: true, markIdx: i });
    }

    items.sort((a, b) => (a.relMs ?? -Infinity) - (b.relMs ?? -Infinity));

    if (items.length === 0) {
      return `<div class="remark-track-empty">開始標記後，此處將顯示標記點</div>`;
    }

    const totalFiles = 1 + rs.importedFiles.length;
    const hasSrcSel  = rs.selectedSrcEntries.size > 0;

    return items.map(item => {
      if (item.isNewMark) {
        const i     = item.markIdx;
        const isSel = rs.selectedMarkIdx === i;
        return `<div class="remark-track-card remark-track-card--mark${isSel ? " is-selected" : ""}"
                     data-mark-select="${i}" data-drop-mark-idx="${i}"
                     data-rel-ms="${item.relMs ?? -1}">
          <span class="remark-track-source remark-mark-badge">${i + 1}</span>
          <span class="remark-track-time">${fmtRel(item.relMs)}</span>
          <span class="remark-track-label">待指派</span>
          <span class="remark-track-actions">
            ${hasSrcSel ? `<button class="remark-assign-sel" data-remark="assign-selected" data-mark-idx="${i}">指派所選</button>` : ""}
            ${isSel && canOp ? `<button class="remark-mark-continue" data-remark="continue-from-mark" data-mark-idx="${i}">由此繼續</button>` : ""}
            <button class="remark-mark-del" data-mark-idx="${i}">×</button>
          </span>
        </div>`;
      }
      // ── 原始 / 匯入事件 ────────────────────────────────────────────────
      const color     = this._sourceColor(item.sourceIdx);
      const label     = RECORD_TYPE_LABELS[item.entry.type] || item.entry.type || "未知";
      const detail    = [
        item.entry.g_id   ? this._resolveGesture(item.entry.g_id) || item.entry.g_id : null,
        item.entry.s_id   ? this._resolveStep(item.entry.s_id)    || item.entry.s_id : null,
        item.entry.a_id   || null,
        item.entry.g_type ? (GESTURE_ATTEMPT_TYPE_LABELS[item.entry.g_type] ?? item.entry.g_type) : null,
      ].filter(Boolean).join(" · ");
      const srcNum    = totalFiles > 1 ? item.sourceIdx + 1 : null;
      const isDraggable = item.entryFileIdx != null; // 只有原始檔事件可拖曳
      const isSrcSel  = isDraggable && rs.selectedSrcEntries.has(item.entryFileIdx);
      const fileIdxAttr = isDraggable ? ` data-entry-file-idx="${item.entryFileIdx}"` : "";
      return `<div class="remark-track-card remark-track-card--src${isSrcSel ? " is-selected" : ""}"
                   ${fileIdxAttr}${isDraggable ? ' draggable="true"' : ""}
                   data-rel-ms="${item.relMs ?? -1}">
        <span class="remark-track-source" style="background:${color}">${srcNum != null ? srcNum : "·"}</span>
        <span class="remark-track-time">${item.relMs != null ? fmtRel(item.relMs) : "—"}</span>
        <span class="remark-track-label">${escapeHtml(label)}</span>
        ${detail ? `<span class="remark-track-detail">${escapeHtml(detail)}</span>` : ""}
      </div>`;
    }).join("");
  }

  _renderImportPanel() {
    const rs = this._remarkState;
    const hasFiles = rs.importedFiles.length > 0;
    return `<div class="remark-import-content">
      <div class="remark-import-title">匯入標記資料</div>
      ${rs.importedFiles.map((f2, fi) => {
        const color = this._sourceColor(fi + 1);
        return `<div class="remark-second-loaded">
          <span class="remark-track-source" style="background:${color};flex-shrink:0">${fi + 2}</span>
          <span class="remark-second-name">${escapeHtml(f2.title)}</span>
          <button class="archive-count-btn" data-remark="remove-file" data-file-idx="${fi}">移除</button>
        </div>`;}).join("")}
      <div class="remark-drop-zone" id="remark-drop-zone">
        <p>拖放 .jsonl 至此</p>
        <button class="archive-count-btn" id="remark-import-btn">選擇檔案</button>
        <input type="file" id="remark-file-input" accept=".jsonl" multiple style="display:none">
      </div>
      ${hasFiles ? `<div class="remark-finish-row" style="margin-top:8px">
        <button class="remark-finish-btn remark-finish-merge" data-remark="merge">合併輸出</button>
      </div>` : ""}
    </div>`;
  }

  _bindRemarkEvents(viewer) {
    const on = (sel, ev, fn) => viewer.querySelectorAll(sel).forEach(el => el.addEventListener(ev, fn));

    on("[data-remark='start']",              "click", () => this._startRemarkCountdown());
    on("[data-remark='restart-all']",        "click", () => { this._cleanupRemark(); this._remarkState = this._defaultRemarkState(); this._renderAll(); });
    on("[data-remark='mark']",               "click", () => this._addMark());
    on("[data-remark='pause']",              "click", () => this._pauseRemark());
    on("[data-remark='resume']",             "click", () => this._resumeRemark());
    on("[data-remark='stop']",               "click", () => this._stopRemark());
    on("[data-remark='save-new']",           "click", () => this._remarkSaveNew());
    on("[data-remark='merge']",              "click", () => this._remarkMerge());
    on("[data-remark='continue-from-mark']", "click", e => {
      e.stopPropagation();
      this._continueFromMark(parseInt(e.currentTarget.dataset.markIdx));
    });
    on("[data-remark='clear-all']", "click", () => {
      this._remarkState.marks = [];
      this._remarkState.selectedMarkIdx = null;
      this._remarkState.selectedSrcEntries.clear();
      this._renderAll();
    });
    on("[data-remark='toggle-import']", "click", () => {
      this._remarkState.importPanelOpen = !this._remarkState.importPanelOpen;
      this._renderAll();
    });
    on("[data-remark='assign-selected']", "click", e => {
      e.stopPropagation();
      this._assignMarkToSelectedEntries(parseInt(e.currentTarget.dataset.markIdx));
    });

    viewer.querySelector("#remark-show-original")?.addEventListener("change", e => {
      this._remarkState.showOriginalInWorkspace = e.target.checked;
      this._renderAll();
    });

    viewer.querySelectorAll("[data-remark='remove-file']").forEach(btn =>
      btn.addEventListener("click", () => {
        this._remarkState.importedFiles.splice(parseInt(btn.dataset.fileIdx), 1);
        this._renderAll();
      })
    );

    // 標記點卡片點選：切換 selectedMarkIdx
    viewer.querySelectorAll("[data-mark-select]").forEach(card =>
      card.addEventListener("click", e => {
        if (e.target.closest("button")) return;
        const i = parseInt(card.dataset.markSelect);
        this._remarkState.selectedMarkIdx = this._remarkState.selectedMarkIdx === i ? null : i;
        this._renderAll();
      })
    );

    // 原始事件卡片點選：單選 / 複選（Ctrl/Cmd）
    viewer.querySelectorAll(".remark-track-card--src[data-entry-file-idx]").forEach(card =>
      card.addEventListener("click", e => {
        if (e.target.closest("button")) return;
        const idx = parseInt(card.dataset.entryFileIdx);
        if (isNaN(idx)) return;
        const sel = this._remarkState.selectedSrcEntries;
        if (e.ctrlKey || e.metaKey) {
          sel.has(idx) ? sel.delete(idx) : sel.add(idx);
        } else {
          if (sel.size === 1 && sel.has(idx)) sel.clear();
          else { sel.clear(); sel.add(idx); }
        }
        this._renderAll();
      })
    );

    // 拖曳：原始事件卡片
    viewer.querySelectorAll(".remark-track-card--src[draggable='true']").forEach(card => {
      card.addEventListener("dragstart", e => {
        e.dataTransfer.setData("text/plain", card.dataset.entryFileIdx);
        e.dataTransfer.effectAllowed = "move";
      });
    });

    // 拖曳：標記點卡片作為放置目標
    viewer.querySelectorAll("[data-drop-mark-idx]").forEach(card => {
      card.addEventListener("dragover",  e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; card.classList.add("drag-over"); });
      card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
      card.addEventListener("drop", e => {
        e.preventDefault(); card.classList.remove("drag-over");
        const entryIdx = parseInt(e.dataTransfer.getData("text/plain"));
        const markIdx  = parseInt(card.dataset.dropMarkIdx);
        if (!isNaN(entryIdx) && !isNaN(markIdx)) this._assignMarkToEntryIdx(markIdx, entryIdx);
      });
    });

    viewer.querySelectorAll(".remark-mark-del").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const i = parseInt(btn.dataset.markIdx);
        this._remarkState.marks.splice(i, 1);
        if (this._remarkState.selectedMarkIdx === i) this._remarkState.selectedMarkIdx = null;
        else if (this._remarkState.selectedMarkIdx > i) this._remarkState.selectedMarkIdx--;
        this._renderAll();
      })
    );

    const importBtn = viewer.querySelector("#remark-import-btn");
    const fileInput = viewer.querySelector("#remark-file-input");
    importBtn?.addEventListener("click", () => fileInput?.click());
    fileInput?.addEventListener("change", () => this._handleRemarkImport(fileInput.files));

    const dz = viewer.querySelector("#remark-drop-zone");
    dz?.addEventListener("dragover",  e => { e.preventDefault(); dz.classList.add("drag-over"); });
    dz?.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
    dz?.addEventListener("drop", e => { e.preventDefault(); dz.classList.remove("drag-over"); this._handleRemarkImport(e.dataTransfer.files); });

    // 左側時間軸點選：若有選取標記點則套用時間
    viewer.querySelector(".remark-timeline")?.addEventListener("click", e => {
      const item = e.target.closest(".archive-tl-item[data-entry-idx]");
      if (!item) return;
      if (this._remarkState.selectedMarkIdx == null) return;
      const idx = parseInt(item.dataset.entryIdx);
      if (!isNaN(idx)) this._assignMarkToEvent(idx);
    });
  }

  _startRemarkCountdown() {
    this._remarkState.status = "countdown";
    this._remarkState.countdownLeft = 3;
    this._renderAll();
    this._remarkState._countdownInterval = setInterval(() => {
      this._remarkState.countdownLeft--;
      const el = document.getElementById("remark-countdown");
      if (el) el.textContent = this._remarkState.countdownLeft;
      if (this._remarkState.countdownLeft <= 0) {
        clearInterval(this._remarkState._countdownInterval);
        this._startRemarkRecording();
      }
    }, 1000);
  }

  _startRemarkRecording() {
    const rs = this._remarkState;
    rs.status      = "recording";
    rs.startRealTs = Date.now();
    this._renderAll();

    let _scrollTick = 0;
    rs._timerInterval = setInterval(() => {
      const elapsed = rs.pausedElapsed + Date.now() - rs.startRealTs;
      const el = document.getElementById("remark-timer");
      if (el) el.textContent = `T+${this._tsm.formatStopwatch(elapsed)}`;
      if (++_scrollTick % 10 === 0) this._scrollWorkspaceToTime(elapsed);
    }, 50);

    const keyHandler = e => {
      const st = this._remarkState.status;
      if (e.code === "Space") {
        e.preventDefault();
        if (st === "recording") this._addMark();
      } else if (e.code === "KeyP") {
        e.preventDefault();
        if (st === "recording") this._pauseRemark();
        else if (st === "paused") this._resumeRemark();
      } else if (e.code === "Escape") {
        e.preventDefault();
        this._stopRemark();
      }
    };
    document.addEventListener("keydown", keyHandler);
    rs._keyHandler = keyHandler;
  }

  _pauseRemark() {
    const rs = this._remarkState;
    if (rs.status !== "recording") return;
    rs.pausedElapsed += Date.now() - rs.startRealTs;
    clearInterval(rs._timerInterval);
    rs.status = "paused";
    this._renderAll();
  }

  _resumeRemark() {
    const rs = this._remarkState;
    if (rs.status !== "paused") return;
    rs.startRealTs = Date.now();
    rs.status = "recording";
    rs._timerInterval = setInterval(() => {
      const el = document.getElementById("remark-timer");
      if (el) el.textContent = `T+${this._tsm.formatStopwatch(rs.pausedElapsed + Date.now() - rs.startRealTs)}`;
    }, 50);
    this._renderAll();
  }

  _assignMarkToEvent(eventEntryIdx) {
    const rs      = this._remarkState;
    const markIdx = rs.selectedMarkIdx;
    if (markIdx == null || !this._file) return;
    const mark       = rs.marks[markIdx];
    if (!mark) return;
    const expStartTs = this._file.entries.find(e => e.type === "exp_start")?.ts ?? 0;
    const newTs      = expStartTs + mark.relMs;
    this._file.applyEdit(eventEntryIdx, "ts", newTs, `標記點 ${markIdx + 1} 套用`);
    rs.selectedMarkIdx = null;
    this._renderAll();
  }

  _scrollWorkspaceToTime(elapsedMs) {
    const track = document.querySelector(".remark-workspace-track");
    if (!track) return;
    const cards = [...track.querySelectorAll("[data-rel-ms]")];
    let targetIdx = -1;
    for (let i = 0; i < cards.length; i++) {
      const ms = parseFloat(cards[i].dataset.relMs);
      if (!isNaN(ms) && ms <= elapsedMs) targetIdx = i;
      else if (!isNaN(ms)) break;
    }
    if (targetIdx < 0) return;
    // 後面還有卡片才置中，末尾用 nearest 避免拉出空白
    const hasMore = targetIdx < cards.length - 1;
    cards[targetIdx].scrollIntoView({ block: hasMore ? "center" : "nearest", behavior: "smooth" });
  }

  _assignMarkToEntryIdx(markIdx, entryFileIdx) {
    const rs   = this._remarkState;
    const mark = rs.marks[markIdx];
    if (!mark || !this._file) return;
    const expStartTs = this._file.entries.find(e => e.type === "exp_start")?.ts ?? 0;
    this._file.applyEdit(entryFileIdx, "ts", expStartTs + mark.relMs, `標記點 ${markIdx + 1} 套用`);
    // 拖放後消耗標記點
    rs.marks.splice(markIdx, 1);
    if (rs.selectedMarkIdx === markIdx) rs.selectedMarkIdx = null;
    else if (rs.selectedMarkIdx > markIdx) rs.selectedMarkIdx--;
    this._renderAll();
  }

  _assignMarkToSelectedEntries(markIdx) {
    const rs  = this._remarkState;
    const mark = rs.marks[markIdx];
    if (!mark || !this._file || rs.selectedSrcEntries.size === 0) return;
    const expStartTs = this._file.entries.find(e => e.type === "exp_start")?.ts ?? 0;
    const newTs = expStartTs + mark.relMs;
    for (const idx of rs.selectedSrcEntries) {
      this._file.applyEdit(idx, "ts", newTs, `標記點 ${markIdx + 1} 批次套用`);
    }
    rs.selectedSrcEntries.clear();
    rs.selectedMarkIdx = null;
    this._renderAll();
  }

  _continueFromMark(markIdx) {
    const rs   = this._remarkState;
    const mark = rs.marks[markIdx];
    if (!mark) return;
    this._cleanupRemark();
    rs.selectedMarkIdx = null;
    rs.pausedElapsed   = mark.relMs;
    this._startRemarkCountdown();
  }

  _addMark() {
    if (this._remarkState.status !== "recording") return;
    const rs    = this._remarkState;
    const relMs = rs.pausedElapsed + Date.now() - rs.startRealTs;
    rs.marks.push({ relMs });
    this._renderAll();
    // 閃爍 + 捲動到最新標記點
    const markBtn = document.querySelector(".remark-mark-btn");
    if (markBtn) {
      markBtn.classList.add("mark-flash");
      setTimeout(() => markBtn?.classList.remove("mark-flash"), 180);
    }
    // 讓最後一張標記點卡片進入視野（有後續卡片才置中）
    const markCards = [...document.querySelectorAll(".remark-track-card--mark")];
    const last = markCards[markCards.length - 1];
    if (last) {
      const allCards = [...document.querySelectorAll("[data-rel-ms]")];
      const hasMore  = allCards.indexOf(last) < allCards.length - 1;
      last.scrollIntoView({ block: hasMore ? "center" : "nearest", behavior: "smooth" });
    }
  }

  _stopRemark() {
    this._cleanupRemark();
    this._remarkState.status = "done";
    this._renderAll();
  }

  _handleRemarkImport(files) {
    for (const file of files) {
      if (!file.name.endsWith(".jsonl")) continue;
      const reader = new FileReader();
      reader.onload = e => {
        const entries = parseJsonl(e.target.result);
        this._remarkState.importedFiles.push(
          new ArchiveFileState({ id: `remark:${file.name}`, title: file.name, source: "local", entries })
        );
        this._renderAll();
      };
      reader.readAsText(file);
    }
  }

  _remarkSaveNew() {
    if (!this._file || this._remarkState.marks.length === 0) return;
    const expStartTs = this._file.entries.find(e => e.type === "exp_start")?.ts ?? Date.now();
    const newEntries = this._file.entries.map(e => ({ ...e }));
    // 根據標記點重新對齊：保留相對間隔，以第一個標記點為基準
    // 簡單模式：整體時間基準設為標記點對應的絕對時間
    const title = `remark_${Date.now()}.jsonl`;
    const state = new ArchiveFileState({ id: `local:${title}`, title, source: "local", entries: newEntries });
    this._localFiles.set(state.id, { name: title, content: newEntries.map(e => JSON.stringify(e)).join("\n") });
    this._renderLocalList();
    this._remarkState = this._defaultRemarkState();
    this._openState(state);
  }

  _remarkMerge() {
    const rs = this._remarkState;
    if (!this._file || rs.importedFiles.length === 0) return;

    const expStart1 = this._file.entries.find(e => e.type === "exp_start")?.ts ?? 0;
    let allEntries  = [...this._file.entries];

    rs.importedFiles.forEach((importedFile, fi) => {
      const mark      = rs.marks[fi] ?? rs.marks[rs.marks.length - 1];
      const anchorTs  = expStart1 + (mark?.relMs ?? 0);
      const expStart2 = importedFile.entries.find(e => e.type === "exp_start")?.ts ?? 0;
      const offset    = anchorTs - expStart2;
      allEntries = [...allEntries,
        ...importedFile.entries.map(e => ({ ...e, ts: e.ts != null ? e.ts + offset : e.ts }))];
    });

    const merged = allEntries.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    const title  = `merged_${Date.now()}.jsonl`;
    const state  = new ArchiveFileState({ id: `local:${title}`, title, source: "local", entries: merged });
    this._localFiles.set(state.id, { name: title, content: merged.map(e => JSON.stringify(e)).join("\n") });
    this._renderLocalList();
    this._remarkState = this._defaultRemarkState();
    this._openState(state);
  }

  // ── 編輯記錄彈出框 ────────────────────────────────────────────────────────

  _showHistoryPopup(anchor) {
    document.getElementById("history-popup")?.remove();
    if (!this._file) return;

    const history = this._file.history;
    if (history.length === 0) return;

    const fmtTime = ts => {
      const d = new Date(ts);
      return `${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}:${d.getSeconds().toString().padStart(2,"0")}`;
    };

    const rows = [...history].reverse().map((op, ri) => {
      const histIdx = history.length - 1 - ri;
      const i       = history.length - ri;
      const lbl     = op.label || (op.op === "remove" ? `刪除: ${op.removed?.type}` : `編輯 #${op.index}`);
      const time    = fmtTime(op.ts);
      const isCurrent = ri === 0;
      return `<div class="history-item">
        <span class="history-item-num">${i}</span>
        <span class="history-item-label">${escapeHtml(lbl)}</span>
        <span class="history-item-time">${time}</span>
        <span class="history-item-actions">
          <button class="history-revoke-btn" data-hist-idx="${histIdx}" title="只撤銷這一筆，保留其他">撤銷此步</button>
          ${!isCurrent ? `<button class="history-undo-btn" data-undo-steps="${ri}" title="撤銷此步之後所有操作">還原至此</button>` : ""}
        </span>
      </div>`;
    }).join("");

    const popup = document.createElement("div");
    popup.id        = "history-popup";
    popup.className = "archive-history-popup";
    popup.innerHTML = `
      <div class="ts-popup-head">
        編輯記錄 <span class="ts-popup-key">${history.length} 筆</span>
      </div>
      <div class="history-list">${rows}</div>
      <div class="ts-popup-actions">
        <button class="ts-action-btn ts-cancel-btn" id="history-close-btn">關閉</button>
      </div>`;

    const rect = anchor.getBoundingClientRect();
    popup.style.top  = `${rect.bottom + 6}px`;
    popup.style.left = `${Math.max(0, rect.left)}px`;
    document.body.appendChild(popup);

    // 撤銷此步（單獨撤銷，保留其他）
    popup.querySelectorAll(".history-revoke-btn").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        this._file.undoAt(parseInt(btn.dataset.histIdx));
        popup.remove();
        this._renderAll();
      })
    );
    // 還原至此（撤銷此步之後所有操作）
    popup.querySelectorAll(".history-undo-btn").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const steps = parseInt(btn.dataset.undoSteps);
        for (let i = 0; i < steps; i++) this._file.undo();
        popup.remove();
        this._renderAll();
      })
    );
    popup.querySelector("#history-close-btn").addEventListener("click", e => {
      e.stopPropagation();
      popup.remove();
    });

    document.addEventListener("keydown", ev => {
      if (ev.key === "Escape") document.getElementById("history-popup")?.remove();
    }, { once: true });
  }

  // ── 類型 badge 彈出框 ─────────────────────────────────────────────────────

  _handleTypeEdit(el) {
    this._closeTypePopup();
    const idx = parseInt(el.dataset.typeEdit);
    if (isNaN(idx) || !this._file) return;

    const entry      = this._file.entries[idx];
    const currentType = entry?.type || "";

    const options = Object.entries(RECORD_TYPE_LABELS)
      .map(([v, l]) => `<option value="${v}"${v === currentType ? " selected" : ""}>${l}</option>`)
      .join("");

    const popup = document.createElement("div");
    popup.id        = "type-popup";
    popup.className = "archive-ts-popup";
    popup.innerHTML = `
      <div class="ts-popup-head">修改類型 <span class="ts-popup-key">type</span></div>
      <div class="ts-popup-input-row">
        <select class="ts-ms-input" id="type-select" style="padding:6px 10px">${options}</select>
      </div>
      <div class="ts-popup-actions">
        <button class="ts-action-btn type-delete-btn" style="background:#f44336;color:white">刪除此記錄</button>
        <button class="ts-action-btn ts-cancel-btn">取消</button>
        <button class="ts-action-btn ts-save-btn">儲存</button>
      </div>`;

    const rect = el.getBoundingClientRect();
    popup.style.top  = `${rect.bottom + 6}px`;
    popup.style.left = `${rect.left}px`;
    document.body.appendChild(popup);

    popup.querySelector(".type-delete-btn").addEventListener("click", e => {
      e.stopPropagation();
      if (!confirm("確定刪除此記錄？")) return;
      this._file.removeEntry(idx);
      this._closeTypePopup();
      this._renderAll();
    });
    popup.querySelector(".ts-cancel-btn").addEventListener("click", e => {
      e.stopPropagation(); this._closeTypePopup();
    });
    popup.querySelector(".ts-save-btn").addEventListener("click", e => {
      e.stopPropagation();
      const newType = popup.querySelector("#type-select").value;
      if (newType !== currentType)
        this._file.applyEdit(idx, "type", newType, `類型: ${currentType}→${newType}`);
      this._closeTypePopup();
      this._renderAll();
    });

    document.addEventListener("keydown", this._typePopupKeyHandler = ev => {
      if (ev.key === "Escape") this._closeTypePopup();
    }, { once: true });
  }

  _closeTypePopup() {
    document.getElementById("type-popup")?.remove();
    if (this._typePopupKeyHandler) {
      document.removeEventListener("keydown", this._typePopupKeyHandler);
      this._typePopupKeyHandler = null;
    }
  }

  // ── 標記欄彈出框（三選一）────────────────────────────────────────────────

  _handleMarkEdit(el) {
    this._closeMarkPopup();
    const idx      = parseInt(el.dataset.markEdit);
    const currentG = el.dataset.markVal || "";
    if (isNaN(idx) || !this._file) return;

    const popup = document.createElement("div");
    popup.id        = "mark-popup";
    popup.className = "archive-mark-popup";

    const MARKS = [
      { g: "t", label: "成功" },
      { g: "n", label: "未判斷" },
      { g: "f", label: "失敗" },
    ];
    popup.innerHTML = MARKS.map(m =>
      `<button class="mark-choice-btn${m.g === currentG ? " is-current" : ""}"
         style="background:${ATTEMPT_COLOR[m.g]}"
         data-g="${m.g}" title="${m.label}">
        ${ATTEMPT_ICON[m.g]}
      </button>`
    ).join("");

    const rect = el.getBoundingClientRect();
    popup.style.top  = `${rect.bottom + 6}px`;
    popup.style.left = `${rect.left}px`;
    document.body.appendChild(popup);

    popup.querySelectorAll(".mark-choice-btn").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const newG = btn.dataset.g;
        if (newG !== currentG)
          this._file.applyEdit(idx, "g_type", newG, `標記: ${currentG}→${newG}`);
        this._closeMarkPopup();
        this._renderAll();
      })
    );

    document.addEventListener("keydown", ev => {
      if (ev.key === "Escape") this._closeMarkPopup();
    }, { once: true });
  }

  _closeMarkPopup() { document.getElementById("mark-popup")?.remove(); }

  // ── 時間戳彈出框 ──────────────────────────────────────────────────────────

  _closeTsPopup() {
    document.getElementById("ts-popup")?.remove();
    document.querySelectorAll(".ts-editing").forEach(el => el.classList.remove("ts-editing"));
    if (this._tsPopupKeyHandler) {
      document.removeEventListener("keydown", this._tsPopupKeyHandler);
      this._tsPopupKeyHandler = null;
    }
  }

  _setViewMode(mode) {
    if (!this._file || this._file.viewMode === mode) return;
    const sidebar = document.getElementById("archiveLeftPanel");
    const icon    = document.getElementById("panelToggleIcon");
    if (this._file.viewMode === "remark") {
      this._cleanupRemark();
      // 離開標記模式：若側欄是由進入時自動收折的，則恢復
      if (this._remarkState._sidebarAutoCollapsed && sidebar?.classList.contains("collapsed")) {
        sidebar.classList.remove("collapsed");
        if (icon) icon.textContent = "‹";
        this._remarkState._sidebarAutoCollapsed = false;
      }
    }
    this._file.viewMode = mode;
    // 進入標記模式：自動收折側欄
    if (mode === "remark" && sidebar && !sidebar.classList.contains("collapsed")) {
      sidebar.classList.add("collapsed");
      if (icon) icon.textContent = "›";
      this._remarkState._sidebarAutoCollapsed = true;
    }
    this._renderAll();
  }

  _cleanupRemark() {
    const rs = this._remarkState;
    clearInterval(rs._countdownInterval);
    clearInterval(rs._timerInterval);
    if (rs._keyHandler) {
      document.removeEventListener("keydown", rs._keyHandler);
      rs._keyHandler = null;
    }
  }

  _handleUndo() {
    if (!this._file?.undo()) return;
    this._renderAll();
  }

  _handleRevert() {
    if (!this._file) return;
    if (!confirm("確定要還原至原始狀態嗎？所有編輯將遺失。")) return;
    this._file.revert();
    this._renderAll();
  }

  // ── 摘要互動 ──────────────────────────────────────────────────────────────

  _bindSummaryEvents(viewer, fileState) {
    viewer.querySelectorAll(".archive-stat--copyable").forEach(el => {
      const btn = el.querySelector(".archive-icon-action");
      btn?.addEventListener("click", e => {
        e.stopPropagation();
        navigator.clipboard?.writeText(el.dataset.copy).then(() => {
          btn.style.color = "#27ae60";
          setTimeout(() => (btn.style.color = ""), 1500);
        });
      });
    });

    viewer.querySelectorAll(".archive-stat--editable").forEach(el => {
      const editBtn = el.querySelector(".archive-icon-action");
      const valSpan = el.querySelector(".archive-stat-value");
      if (!editBtn) return;

      editBtn.addEventListener("click", e => {
        e.stopPropagation();
        const idx   = parseInt(el.dataset.editIndex, 10);
        const field = el.dataset.editField;
        const relevantIndices = fileState.entries.reduce((acc, entry, i) => {
          if ((entry.type === "exp_start" || entry.type === "exp_end") && i >= idx) acc.push(i);
          return acc;
        }, []);
        const currentVal = fileState.entries[idx]?.[field] || "";
        const input = document.createElement("input");
        input.className = "archive-stat-input";
        input.value = currentVal;
        valSpan.innerHTML = "";
        valSpan.appendChild(input);
        input.focus(); input.select();

        let committed = false;
        const commit = () => {
          if (committed) return;
          committed = true;
          const newVal = input.value.trim();
          if (newVal !== currentVal) {
            fileState.applyBatchEdit(
              relevantIndices.map(i => ({ index: i, field, value: newVal })),
              `修改${field}: ${currentVal} → ${newVal}`
            );
          }
          this._renderAll();
        };

        input.addEventListener("blur", commit);
        input.addEventListener("keydown", e => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          if (e.key === "Escape") { committed = true; this._renderAll(); }
        });
      });
    });
  }

  // ── 狀態畫面 ──────────────────────────────────────────────────────────────

  _showLoading(title) {
    const v = document.getElementById("archiveViewer");
    if (!v) return;
    v.innerHTML = `
      <div class="archive-toolbar"><span class="archive-toolbar-title">${escapeHtml(title)}</span></div>
      <div class="archive-viewer-state"><div class="archive-spinner"></div><p>讀取中…</p></div>`;
  }

  _showError(title, msg) {
    const v = document.getElementById("archiveViewer");
    if (!v) return;
    v.innerHTML = `
      <div class="archive-toolbar"><span class="archive-toolbar-title">${escapeHtml(title)}</span></div>
      <div class="archive-viewer-state archive-viewer-state--error"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(msg)}</p></div>`;
  }

  // ── 時間軸視圖 ────────────────────────────────────────────────────────────

  _renderTimeline(entries) {
    if (entries.length === 0) return `<div class="archive-viewer-state"><p>無記錄</p></div>`;
    const expStart   = entries.find(e => e.type === "exp_start");
    const expStartTs = expStart?.ts ?? entries.find(e => e.ts)?.ts ?? null;
    const relTime    = ts => (!ts || !expStartTs) ? "T+??" : `T+${this._tsm.formatStopwatch(ts - expStartTs)}`;

    const rawGroups = groupEntries(entries);
    const fileId    = this._file?.id || "";

    // 合併相同時間戳的連續頂層事件
    const merged = [];
    let evtBatch = [];

    for (const g of rawGroups) {
      if (g.type === "event") {
        if (evtBatch.length === 0 || evtBatch[evtBatch.length - 1].ts === g.entry.ts) {
          evtBatch.push(g.entry);
        } else {
          merged.push({ type: "events", entries: evtBatch });
          evtBatch = [g.entry];
        }
      } else {
        if (evtBatch.length > 0) {
          merged.push({ type: "events", entries: evtBatch });
          evtBatch = [];
        }
        merged.push(g);
      }
    }
    if (evtBatch.length > 0) merged.push({ type: "events", entries: evtBatch });

    let stepNum = 0;
    const items = merged.map(g => {
      if (g.type === "events") return this._renderEventGroup(g.entries, relTime);
      if (g.type === "step")   return this._renderStepGroup(g, relTime, fileId, ++stepNum);
      return "";
    }).join("");

    return `<div class="archive-timeline">${items}</div>`;
  }

  /** 頂層事件群組（單一或同時間多筆） */
  _renderEventGroup(events, relTime) {
    const mainColor = getTypeColor(events[0]);

    if (events.length === 1) {
      // 單一事件
      const entry = events[0];
      const label = RECORD_TYPE_LABELS[entry.type] || entry.type || "未知";
      const color = mainColor;
      const fields = this._topFields(entry);
      const body = fields.length
        ? `<div class="archive-top-body">${fields.map(([l, v]) =>
            `<span class="archive-top-field"><span class="archive-top-label">${l}</span><span class="archive-top-val">${escapeHtml(String(v))}</span></span>`
          ).join("")}</div>`
        : "";

      return `<div class="archive-tl-item"${entry._idx != null ? ` data-entry-idx="${entry._idx}"` : ""}>
        <div class="archive-tl-dot" style="background:${color.border}"></div>
        <div class="archive-top-card" style="border-color:${color.border}">
          <div class="archive-top-card-header">
            <span class="archive-top-badge" style="background:${color.bg};color:${color.text}">${escapeHtml(label)}</span>
            <span class="archive-top-time">${relTime(entry.ts)}</span>
          </div>
          ${body}
        </div>
      </div>`;
    }

    // 多筆同時間 → 合併卡片
    const rows = events.map((entry, i) => {
      const color = getTypeColor(entry);
      const label = RECORD_TYPE_LABELS[entry.type] || entry.type;
      const fields = this._topFields(entry);
      return `${i > 0 ? '<div class="archive-merged-divider"></div>' : ""}
        <div class="archive-merged-row">
          <span class="archive-top-badge" style="background:${color.bg};color:${color.text}">${escapeHtml(label)}</span>
          ${fields.length ? `<span class="archive-top-body" style="display:inline-flex">${
            fields.map(([l, v]) => `<span class="archive-top-field"><span class="archive-top-label">${l}</span><span class="archive-top-val">${escapeHtml(String(v))}</span></span>`).join("")
          }</span>` : ""}
        </div>`;
    }).join("");

    return `<div class="archive-tl-item">
      <div class="archive-tl-dot" style="background:${mainColor.border}"></div>
      <div class="archive-top-card" style="border-color:${mainColor.border}">
        <div class="archive-top-card-header">
          <span class="archive-top-time">${relTime(events[0].ts)}</span>
          <span class="archive-merged-count">${events.length} 筆同時</span>
        </div>
        ${rows}
      </div>
    </div>`;
  }

  _topFields(entry) {
    const fields = [];
    if (entry.combo_name)  fields.push(["組合", entry.combo_name]);
    if (entry.participant) fields.push(["受試者", entry.participant]);
    if (entry.a_id)        fields.push(["動作", entry.a_id]);
    if (entry.g_id) {
      const gname = this._resolveGesture(entry.g_id);
      fields.push(["手勢", gname || entry.g_id]);
    }
    return fields;
  }

  /** 步驟群組 */
  _renderStepGroup(group, relTime, fileId, stepNum) {
    const key      = `${fileId}:${group.gIdx}`;
    const expanded = this._expandedSteps.has(key);

    const attempts = group.entries.filter(e => e.type === "gesture_attempt");
    const okCount  = attempts.filter(e => e.g_type === "t").length;
    const ngCount  = attempts.filter(e => e.g_type === "f").length;
    const duration = (group.startTs && group.endTs)
      ? this._tsm.formatDurationText(Math.floor((group.endTs - group.startTs) / 1000))
      : null;

    // 使用 board 相同的 SVG 圖示與顏色，數字永遠顯示
    const attemptIcon = (type, count) => {
      const icon  = ATTEMPT_ICON[type] || "";
      const color = ATTEMPT_COLOR[type] || "#999";
      return `<span class="attempt-chip" style="color:${color}">${icon}<b>${count}</b></span>`;
    };
    let summaryHtml = "";
    if (attempts.length > 0) {
      const chips = [];
      if (okCount > 0)  chips.push(attemptIcon("t", okCount));
      if (ngCount > 0)  chips.push(attemptIcon("f", ngCount));
      const unkCount = attempts.length - okCount - ngCount;
      if (unkCount > 0) chips.push(attemptIcon("n", unkCount));
      summaryHtml = chips.join("");
    }
    if (duration) summaryHtml += `${summaryHtml ? " · " : ""}${duration}`;

    // 解析手勢名稱與步驟名稱
    const gestureName = this._resolveGesture(group.gId);
    const stepName    = this._resolveStep(group.sId);
    const mainLabel = gestureName || stepName || group.sId || `手勢 ${group.gIdx}`;

    // 對應 board 的卡片顏色邏輯
    const cs = getStepCardStyle(group.sId, group.gId);

    // rawid：有可讀名稱時才顯示原始 ID（供對照），與 mainLabel 不同才顯示
    const rawIdToShow = (group.sId && group.sId !== mainLabel) ? group.sId : null;

    const subEntries = this._renderSubEntriesGrouped(group.entries, relTime);

    return `<div class="archive-tl-item archive-step-item">
      <div class="archive-tl-dot" style="background:${cs.border};width:12px;height:12px;top:14px;left:-24px"></div>
      <div class="archive-step-card" data-step-key="${escapeHtml(key)}" style="border-color:${cs.border}">
        <div class="archive-step-header" data-step-key="${escapeHtml(key)}" style="background:${cs.bg}">
          <span class="archive-step-num" style="background:${cs.accent}">${stepNum}</span>
          <div class="archive-step-label">
            <span class="archive-step-name">${escapeHtml(mainLabel)}</span>
            ${rawIdToShow ? `<span class="archive-step-rawid">${escapeHtml(rawIdToShow)}</span>` : ""}
          </div>
          <span class="archive-step-summary">
            ${summaryHtml}
            <span class="archive-step-time">${relTime(group.startTs)}</span>
          </span>
          <button class="archive-step-toggle" style="color:${cs.accent}" title="${expanded ? "收折" : "展開"}">
            ${expanded ? ICON.chevronDown : ICON.chevronRight}
          </button>
        </div>
        <div class="archive-step-body" ${expanded ? "" : "hidden"}>
          ${subEntries}
        </div>
      </div>
    </div>`;
  }

  /** 子記錄：以表格呈現，欄位標頭清楚標示資料來源 */
  _renderSubEntriesGrouped(entries, relTime) {
    let prevTs = null;
    const rows = entries.map(e => {
      const sameTs = prevTs !== null && e.ts === prevTs;
      prevTs = e.ts;
      return this._renderSubEntry(e, relTime, sameTs);
    }).join("");
    return `<table class="archive-sub-table">
      <thead>
        <tr>
          <th>時間 <span class="th-raw">ts</span></th>
          <th>類型 <span class="th-raw">type</span></th>
          <th>手勢 <span class="th-raw">g_id</span></th>
          <th>動作 <span class="th-raw">a_id</span></th>
          <th>標記 <span class="th-raw">g_type</span></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  _renderSubEntry(entry, relTime, sameTs = false) {
    const type  = entry.type || "";
    const label = RECORD_TYPE_LABELS[type] || type || "未知";
    const relTs = relTime(entry.ts);
    const color = getTypeColor(entry);

    // 結果欄：使用 board 相同的 SVG 圖示
    const gType = entry.g_type;

    const EMPTY = `<span class="cell-empty">—</span>`;

    // 手勢欄：解析名稱 + 原始 g_id
    let gestureHtml = EMPTY;
    if (entry.g_id) {
      const gname = this._resolveGesture(entry.g_id);
      gestureHtml = (gname && gname !== entry.g_id)
        ? `${escapeHtml(gname)} <span class="archive-sub-rawid">${escapeHtml(entry.g_id)}</span>`
        : escapeHtml(entry.g_id);
    }

    // 動作欄：a_id 原始值
    const actionHtml = entry.a_id ? escapeHtml(entry.a_id) : EMPTY;

    // 結果欄：board 圖示 + 標籤
    const resultHtml = gType && ATTEMPT_ICON[gType]
      ? `<span class="attempt-chip" style="color:${ATTEMPT_COLOR[gType]}">${ATTEMPT_ICON[gType]}<span class="attempt-label">${GESTURE_ATTEMPT_TYPE_LABELS[gType] ?? escapeHtml(String(gType))}</span></span>`
      : EMPTY;

    // 時間欄：可點按微調
    const tsAttr = entry._idx != null && entry.ts != null
      ? `data-ts-edit="${entry._idx}" data-ts="${+entry.ts || 0}" title="點按微調時間"` : "";

    const typeAttr = entry._idx != null
      ? `data-type-edit="${entry._idx}" title="點按修改類型或刪除"` : "";
    const markAttr = entry._idx != null && gType
      ? `data-mark-edit="${entry._idx}" data-mark-val="${escapeHtml(String(gType))}" title="點按更改標記"` : "";

    return `<tr class="${sameTs ? "same-ts-row" : ""}">
      <td><span class="archive-sub-time${tsAttr ? " ts-editable" : ""}" ${tsAttr}>${relTs}</span></td>
      <td><span class="archive-sub-badge badge-clickable" style="background:${color.bg};color:${color.text};border-color:${color.border}" ${typeAttr}>${escapeHtml(label)}</span></td>
      <td class="archive-sub-detail">${gestureHtml}</td>
      <td class="archive-sub-detail">${actionHtml}</td>
      <td class="archive-sub-result">${(() => {
        if (!markAttr) return resultHtml;
        const mc = TYPE_COLORS[`gesture_attempt_${gType}`] || {};
        return `<span class="attempt-chip attempt-editable badge-clickable"
          style="color:${mc.text};background:${mc.bg};border:1.5px solid ${mc.border};padding:2px 9px;border-radius:8px"
          ${markAttr}>${ATTEMPT_ICON[gType] ?? ""}<span class="attempt-label">${GESTURE_ATTEMPT_TYPE_LABELS[gType] ?? escapeHtml(String(gType))}</span></span>`;
      })()}</td>
    </tr>`;
  }

  // ── 表格視圖 ──────────────────────────────────────────────────────────────

  _renderTable(entries) {
    if (entries.length === 0) return `<div class="archive-viewer-state"><p>無記錄</p></div>`;
    const rows = entries.map((e, i) => {
      const time  = e.ts
        ? this._tsm.formatDateTime(e.ts, { includeDate: false, includeSeconds: true, includeMilliseconds: true })
        : "—";
      const label = RECORD_TYPE_LABELS[e.type] || e.type || "未知";
      const color = getTypeColor(e);

      const parts = [];
      if (e.s_id) {
        const sname = this._resolveStep(e.s_id);
        parts.push(sname && sname !== e.s_id ? sname : e.s_id);
      }
      if (e.g_id) {
        const gname = this._resolveGesture(e.g_id);
        parts.push(gname && gname !== e.g_id ? gname : e.g_id);
      }
      if (e.a_id) parts.push(e.a_id);
      if (e.combo_name) parts.push(e.combo_name);
      const detail = parts.join(" · ");

      const resultHtml = e.g_type
        ? `<span style="color:${color.text};font-weight:700">${GESTURE_ATTEMPT_TYPE_LABELS[e.g_type] ?? escapeHtml(String(e.g_type))}</span>`
        : "";

      return `<tr>
        <td class="at-num">${i + 1}</td>
        <td class="at-time">${time}</td>
        <td><span class="at-type-badge" style="background:${color.bg};color:${color.text};border-color:${color.border}">${escapeHtml(label)}</span></td>
        <td class="at-detail">${escapeHtml(detail || "—")}</td>
        <td class="at-result">${resultHtml}</td>
      </tr>`;
    }).join("");
    return `<div class="archive-table-wrap">
      <table class="archive-table">
        <thead><tr><th>#</th><th>時間</th><th>類型</th><th>詳情</th><th>結果</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  // ── 原始視圖 ──────────────────────────────────────────────────────────────

  _renderRaw(entries) {
    if (entries.length === 0) return `<div class="archive-viewer-state"><p>無記錄</p></div>`;
    const lines = entries.map((e, i) =>
      `<div class="archive-raw-line">
        <span class="archive-raw-num">${i + 1}</span>
        <span class="archive-raw-code">${colorizeJson(JSON.stringify(e))}</span>
      </div>`
    ).join("");
    return `<div class="archive-raw">${lines}</div>`;
  }
}

// ── 啟動 ──────────────────────────────────────────────────────────────────────

const manager = new ArchivePageManager();
manager.initialize().catch(err => Logger.error("[Archive] 初始化失敗:", err));

export default manager;
