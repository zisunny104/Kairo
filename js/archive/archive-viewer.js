/**
 * archive-viewer.js — 內容渲染
 */

import {
  ICON, ATTEMPT_ICON, ATTEMPT_COLOR, TYPE_COLORS,
  getStepCardStyle, getTypeColor,
  extractSummary, groupEntries,
  escapeHtml, colorizeJson,
} from "./archive-constants.js";
import {
  RECORD_TYPE_LABELS,
  GESTURE_ATTEMPT_TYPE_LABELS,
} from "../constants/index.js";

export const archiveViewerMethods = {

  _resolveGesture(gId) {
    return (gId && this._gestureMap[gId]) ? this._gestureMap[gId] : (gId || null);
  },

  _resolveStep(sId) {
    return (sId && this._stepMap[sId]) ? this._stepMap[sId] : (sId || null);
  },

  // ── 狀態管理 ──────────────────────────────────────────────────────────────

  _setActive(id) {
    document.querySelectorAll(".archive-file-card").forEach(card =>
      card.classList.toggle("is-active", card.dataset.fileId === id)
    );
  },

  _openState(state) {
    this._cleanupRemark();
    this._file = state;
    this._entryFilter = "";
    this._renderAll();
  },

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
  },

  // ── 主渲染入口 ────────────────────────────────────────────────────────────

  _renderAll() {
    const viewer = document.getElementById("archiveViewer");
    if (!viewer || !this._file) return;
    viewer.innerHTML = this._buildToolbarHtml() + this._buildContentHtml();
    this._bindViewerEvents(viewer);
    if (this._file.viewMode === "remark") this._bindRemarkEvents(viewer);
  },

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
  },

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
    const isTimeline = f.viewMode === "timeline";
    const expandBtn = isTimeline
      ? `<button class="archive-count-btn" data-action="toggle-expand">${ICON.chevronDown} 展開全部</button>` : "";
    const masterCheck = isTimeline
      ? `<input type="checkbox" id="timelineSelectAll" class="archive-select-all" title="全選／全不選">` : "";
    const countBar = `<div class="archive-count-bar">
      ${masterCheck}
      <span class="archive-entries-count">共 ${f.entries.length} 筆記錄${editInfo}${filterNote}</span>
      <div class="archive-filter-row">
        ${expandBtn}
        <button class="archive-count-btn" data-action="undo" ${undoCount === 0 ? "disabled" : ""}>還原${undoCount > 0 ? ` (${undoCount})` : ""}</button>
        <button class="archive-count-btn archive-count-btn--danger" data-action="revert" ${!f.isDirty ? "disabled" : ""}>重設</button>
        <span class="archive-toolbar-sep"></span>
        <select class="archive-filter-select" id="entryTypeFilter">${typeOptions}</select>
      </div>
    </div>`;

    let body = "";
    if (f.viewMode === "timeline") body = this._renderTimeline(filtered);
    if (f.viewMode === "table")    body = this._renderTable(filtered);
    if (f.viewMode === "raw")      body = this._renderRaw(filtered);

    return summary + countBar + body;
  },

  _applyEntryFilter(entries) {
    if (!this._entryFilter) return entries;
    return entries.filter(e => e.type === this._entryFilter);
  },

  // ── 統計格輔助 ────────────────────────────────────────────────────────────

  _stat(label, value) {
    return `<div class="archive-stat">
      <span class="archive-stat-label">${label}</span>
      <span class="archive-stat-value">${escapeHtml(String(value))}</span>
    </div>`;
  },

  _statCopyable(label, value) {
    return `<div class="archive-stat archive-stat--copyable" data-copy="${escapeHtml(String(value))}">
      <span class="archive-stat-label">
        ${label}
        <button class="archive-icon-action" title="複製">${ICON.copy}</button>
      </span>
      <span class="archive-stat-value">${escapeHtml(String(value))}</span>
    </div>`;
  },

  _statEditable(label, value, entryIndex, field) {
    return `<div class="archive-stat archive-stat--editable"
        data-edit-index="${entryIndex}" data-edit-field="${field}">
      <span class="archive-stat-label">
        ${label}
        <button class="archive-icon-action" title="編輯">${ICON.edit}</button>
      </span>
      <span class="archive-stat-value">${escapeHtml(String(value))}</span>
    </div>`;
  },

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
  },

  // ── 來源顏色（原始檔=0, 匯入①②…）──────────────────────────────────────────
  _sourceColor(idx) {
    const palette = ["#6c757d","#2196F3","#4CAF50","#FF9800","#9C27B0","#F44336","#00BCD4"];
    return palette[idx % palette.length];
  },

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
  },

  // ── 狀態畫面 ──────────────────────────────────────────────────────────────

  _showLoading(title) {
    const v = document.getElementById("archiveViewer");
    if (!v) return;
    v.innerHTML = `
      <div class="archive-toolbar"><span class="archive-toolbar-title">${escapeHtml(title)}</span></div>
      <div class="archive-viewer-state"><div class="archive-spinner"></div><p>讀取中…</p></div>`;
  },

  _showError(title, msg) {
    const v = document.getElementById("archiveViewer");
    if (!v) return;
    v.innerHTML = `
      <div class="archive-toolbar"><span class="archive-toolbar-title">${escapeHtml(title)}</span></div>
      <div class="archive-viewer-state archive-viewer-state--error"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(msg)}</p></div>`;
  },

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
  },

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
            <input type="checkbox" class="archive-tl-check" data-tl-id="${entry._idx ?? ""}">
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
          <input type="checkbox" class="archive-tl-check" data-tl-id="m-${events[0].ts ?? ""}">
          <span class="archive-top-time">${relTime(events[0].ts)}</span>
          <span class="archive-merged-count">${events.length} 筆同時</span>
        </div>
        ${rows}
      </div>
    </div>`;
  },

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
  },

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
          <input type="checkbox" class="archive-tl-check" data-tl-id="step-${escapeHtml(key)}">
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
  },

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
  },

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
  },

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
  },

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
  },

};
