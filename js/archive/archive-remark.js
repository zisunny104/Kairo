/**
 * archive-remark.js — 重新標記模式
 */

import {
  ArchiveFileState, parseJsonl,
  extractSummary, escapeHtml,
} from "./archive-constants.js";
import {
  RECORD_TYPE_LABELS,
  GESTURE_ATTEMPT_TYPE_LABELS,
} from "../constants/index.js";

export const archiveRemarkMethods = {

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
  },

  _cleanupRemark() {
    const rs = this._remarkState;
    clearInterval(rs._countdownInterval);
    clearInterval(rs._timerInterval);
    if (rs._keyHandler) {
      document.removeEventListener("keydown", rs._keyHandler);
      rs._keyHandler = null;
    }
  },

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
  },

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
  },

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
      const srcNum      = totalFiles > 1 ? item.sourceIdx + 1 : null;
      const isDraggable = item.entryFileIdx != null;
      const isSrcSel    = isDraggable && rs.selectedSrcEntries.has(item.entryFileIdx);
      const _curEntry   = isDraggable ? this._file?.entries[item.entryFileIdx] : null;
      const _origEntry  = _curEntry?._origIdx != null ? this._file?._original[_curEntry._origIdx] : null;
      const isEdited    = isDraggable && _origEntry != null && _origEntry.ts !== _curEntry.ts;
      const fileIdxAttr = isDraggable ? ` data-entry-file-idx="${item.entryFileIdx}"` : "";
      return `<div class="remark-track-card remark-track-card--src${isSrcSel ? " is-selected" : ""}${isEdited ? " is-edited" : ""}"
                   ${fileIdxAttr}${isDraggable ? ' draggable="true"' : ""}
                   data-rel-ms="${item.relMs ?? -1}">
        <span class="remark-track-source" style="background:${color}">${srcNum != null ? srcNum : "·"}</span>
        <span class="remark-track-time">${item.relMs != null ? fmtRel(item.relMs) : "—"}</span>
        <span class="remark-track-label">${escapeHtml(label)}</span>
        ${detail ? `<span class="remark-track-detail">${escapeHtml(detail)}</span>` : ""}
        ${isDraggable ? `<span class="remark-track-actions"><button class="remark-src-del" data-src-del-idx="${item.entryFileIdx}">×</button></span>` : ""}
      </div>`;
    }).join("");
  },

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
  },

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
    viewer.querySelectorAll(".remark-src-del").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.srcDelIdx);
        if (isNaN(idx) || !this._file) return;
        this._file.removeEntry(idx);
        this._remarkState.selectedSrcEntries.clear();
        this._remarkState.selectedMarkIdx = null;
        this._renderAll();
      })
    );

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
        const entryFileIdx = parseInt(card.dataset.entryFileIdx);
        const relMs        = parseFloat(card.dataset.relMs);
        const sel          = this._remarkState.selectedSrcEntries;
        const isMultiDrag  = sel.has(entryFileIdx) && sel.size > 1;
        e.dataTransfer.setData("text/plain", JSON.stringify({ entryFileIdx, relMs, isMultiDrag }));
        e.dataTransfer.effectAllowed = "move";
      });
    });

    // 拖曳：標記點卡片作為放置目標
    viewer.querySelectorAll("[data-drop-mark-idx]").forEach(card => {
      card.addEventListener("dragover",  e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; card.classList.add("drag-over"); });
      card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
      card.addEventListener("drop", e => {
        e.preventDefault(); card.classList.remove("drag-over");
        let data;
        try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        const { entryFileIdx, relMs: anchorRelMs, isMultiDrag } = data;
        const markIdx = parseInt(card.dataset.dropMarkIdx);
        if (isNaN(entryFileIdx) || isNaN(markIdx)) return;
        if (isMultiDrag) this._assignMarkToMultiDrag(markIdx, anchorRelMs);
        else             this._assignMarkToEntryIdx(markIdx, entryFileIdx);
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
  },

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
  },

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
  },

  _pauseRemark() {
    const rs = this._remarkState;
    if (rs.status !== "recording") return;
    rs.pausedElapsed += Date.now() - rs.startRealTs;
    clearInterval(rs._timerInterval);
    rs.status = "paused";
    this._renderAll();
  },

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
  },

  _stopRemark() {
    this._cleanupRemark();
    this._remarkState.status = "done";
    this._renderAll();
  },

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
  },

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
  },

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
  },

  _assignMarkToMultiDrag(markIdx, anchorRelMs) {
    const rs  = this._remarkState;
    const mark = rs.marks[markIdx];
    if (!mark || !this._file || rs.selectedSrcEntries.size === 0) return;
    const expStartTs = this._file.entries.find(e => e.type === "exp_start")?.ts ?? 0;
    const delta = mark.relMs - anchorRelMs;
    for (const idx of rs.selectedSrcEntries) {
      const entry = this._file.entries[idx];
      if (!entry || entry.ts == null) continue;
      this._file.applyEdit(idx, "ts", entry.ts + delta, `標記點 ${markIdx + 1} 多選平移`);
    }
    rs.marks.splice(markIdx, 1);
    if (rs.selectedMarkIdx === markIdx) rs.selectedMarkIdx = null;
    else if (rs.selectedMarkIdx != null && rs.selectedMarkIdx > markIdx) rs.selectedMarkIdx--;
    rs.selectedSrcEntries.clear();
    this._renderAll();
  },

  _continueFromMark(markIdx) {
    const rs   = this._remarkState;
    const mark = rs.marks[markIdx];
    if (!mark) return;
    this._cleanupRemark();
    rs.selectedMarkIdx = null;
    rs.pausedElapsed   = mark.relMs;
    this._startRemarkCountdown();
  },

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
  },

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
  },

  _remarkSaveNew() {
    if (!this._file || this._remarkState.marks.length === 0) return;
    const expStartTs = this._file.entries.find(e => e.type === "exp_start")?.ts ?? Date.now();
    const newEntries = this._file.entries.map(e => ({ ...e }));
    // 根據標記點重新對齊：保留相對間隔，以第一個標記點為基準
    // 簡單模式：整體時間基準設為標記點對應的絕對時間
    const title = `remark_${Date.now()}.jsonl`;
    const state = new ArchiveFileState({ id: `local:${title}`, title, source: "local", entries: newEntries });
    this._localFiles.set(state.id, { name: title, content: newEntries.map(e => JSON.stringify(ArchiveFileState._stripInternal(e))).join("\n") });
    this._renderLocalList();
    this._remarkState = this._defaultRemarkState();
    this._openState(state);
  },

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
    this._localFiles.set(state.id, { name: title, content: merged.map(e => JSON.stringify(ArchiveFileState._stripInternal(e))).join("\n") });
    this._renderLocalList();
    this._remarkState = this._defaultRemarkState();
    this._openState(state);
  },

};
