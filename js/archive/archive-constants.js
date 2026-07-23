/**
 * archive-constants.js — 共用常數、工具函式與 ArchiveFileState
 */

import { Logger } from "../core/console-manager.js";

// ── 共用 SVG 圖示 ─────────────────────────────────────────────────────────────
export const ICON = {
  copy:    "<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"9\" y=\"9\" width=\"13\" height=\"13\" rx=\"2\"/><path d=\"M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\"/></svg>",
  edit:    "<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7\"/><path d=\"M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z\"/></svg>",
  refresh: "<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M23 4v6h-6\"/><path d=\"M1 20v-6h6\"/><path d=\"M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15\"/></svg>",
  chevronDown:  "<svg width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"6 9 12 15 18 9\"/></svg>",
  chevronRight: "<svg width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"9 6 15 12 9 18\"/></svg>",
};

// ── 手勢嘗試標記圖示（對應 board 的三種標記按鈕）─────────────────────────────
export const ATTEMPT_ICON = {
  t: "<svg width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"3.5\" stroke-linecap=\"round\"><circle cx=\"12\" cy=\"12\" r=\"8.5\"/></svg>",
  n: "<svg width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"3.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polygon points=\"12,4.5 20.5,19.5 3.5,19.5\"/></svg>",
  f: "<svg width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"3.5\" stroke-linecap=\"round\"><line x1=\"5.5\" y1=\"5.5\" x2=\"18.5\" y2=\"18.5\"/><line x1=\"18.5\" y1=\"5.5\" x2=\"5.5\" y2=\"18.5\"/></svg>",
};
export const ATTEMPT_COLOR = { t: "#4caf50", f: "#f44336", n: "#ff9800" };

// ── 步驟卡片顏色（對應 board-ui-manager.js 的 getCardStyle 邏輯）──────────────
export function getStepCardStyle(sId, gId) {
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
export const TYPE_COLORS = {
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

export function getTypeColor(entry) {
  if (entry.type === "gesture_attempt") {
    return TYPE_COLORS[`gesture_attempt_${entry.g_type}`] ?? TYPE_COLORS._default;
  }
  return TYPE_COLORS[entry.type] ?? TYPE_COLORS._default;
}

// ── 工具函式 ──────────────────────────────────────────────────────────────────

export function parseJsonl(text) {
  return text.split("\n")
    .map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export function extractSummary(entries) {
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

export function groupEntries(entries) {
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

export function stripColorTags(s) {
  return s ? s.replace(/\[\/?\w+\]/g, "").replace(/\s+/g, " ").trim() : "";
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// escapeHtml 會把 " 轉成 &quot; 使後續 regex 無法匹配 JSON 引號
// 原始視圖的 text content 只需轉義 &、<、>
export function escapeHtmlText(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function colorizeJson(jsonStr) {
  return escapeHtmlText(jsonStr)
    .replace(/"([^"]+)":/g, "<span class=\"raw-key\">\"$1\"</span>:")
    .replace(/: "([^"]*)"/g, ": <span class=\"raw-str\">\"$1\"</span>")
    .replace(/: (\d+(?:\.\d+)?)/g, ": <span class=\"raw-num\">$1</span>")
    .replace(/: (true|false)/g, ": <span class=\"raw-bool\">$1</span>")
    .replace(/: (null)/g, ": <span class=\"raw-null\">$1</span>");
}

// ── ArchiveFileState（資料層）──────────────────────────────────────────────────

export class ArchiveFileState {
  static MAX_HISTORY = 200;

  constructor({ id, title, source, entries }) {
    this.id     = id;
    this.title  = title;
    this.source = source;
    this._original = JSON.parse(JSON.stringify(entries));
    this.entries   = JSON.parse(JSON.stringify(entries));
    this._original.forEach((e, i) => { e._origIdx = i; });
    this.entries.forEach((e, i) => { e._origIdx = i; });
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

  commitAsOriginal() {
    this._original = JSON.parse(JSON.stringify(this.entries));
    this._original.forEach((e, i) => { e._origIdx = i; });
    this.entries.forEach((e, i) => { e._origIdx = i; });
    this.history  = [];
    this.isDirty  = false;
    ArchiveFileState.clearDraft(this.title);
  }

  static _stripInternal({ _origIdx, ...e }) { return e; }

  toOriginalJsonl() { return this._original.map(e => JSON.stringify(ArchiveFileState._stripInternal(e))).join("\n") + "\n"; }
  toEditedJsonl()   { return this.entries.map(e => JSON.stringify(ArchiveFileState._stripInternal(e))).join("\n") + "\n"; }

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
