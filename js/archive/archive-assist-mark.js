/**
 * archive-assist-mark.js — 輔助標記分頁
 * 支援 Excel/CSV/貼上資料匯入、鍵盤選格、計時、草稿儲存與匯出
 */

import * as XLSX from "../vendor/xlsx.mjs";
import { escapeHtml } from "./archive-constants.js";
import { downloadXlsx, downloadCsv } from "../core/xlsx-export.js";
import { getApiUrl } from "../core/url-utils.js";
import { getAdminToken, clearAdminToken } from "../core/admin-auth.js";
import { API_ENDPOINTS } from "../constants/index.js";

export const DRAFT_KEY = "archive_assist_mark_draft_v1";
const EMPTY_TEXT = "";

function nowIso() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatClock(ms) {
  const totalMs = Math.max(0, Math.floor(ms));
  const total = Math.floor(totalMs / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const msPart = totalMs % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(msPart).padStart(3, "0")}`;
}

// formatClock 的反向函式，把 "HH:MM:SS.mmm" 轉回毫秒；格式不符回傳 null。
export function parseClockMs(str) {
  const m = /^(\d+):(\d{2}):(\d{2})\.(\d{3})$/.exec(String(str || "").trim());
  if (!m) return null;
  const [, h, mi, s, msPart] = m;
  return ((Number(h) * 3600 + Number(mi) * 60 + Number(s)) * 1000) + Number(msPart);
}

export function parseDelimitedText(text) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const lines = normalized.split("\n");
  const sample = lines.slice(0, 5).join("\n");
  const tabCount = (sample.match(/\t/g) || []).length;
  const commaCount = (sample.match(/,/g) || []).length;
  const delimiter = tabCount >= commaCount ? "\t" : ",";

  return lines
    .map(line => line.split(delimiter).map(cell => cell.trim()))
    .filter(row => row.some(cell => cell !== EMPTY_TEXT));
}

function sanitizeCellText(value) {
  return value == null ? "" : String(value);
}

function cloneRows(rows) {
  return rows.map(row => row.map(cell => sanitizeCellText(cell)));
}

function detectHeaders(rows) {
  const first = rows[0] || [];
  const lowered = first.map(cell => String(cell).toLowerCase());
  const startIndex = lowered.findIndex(cell => /(開始|start)/i.test(cell));
  const endIndex = lowered.findIndex(cell => /(結束|end)/i.test(cell));
  const durationIndex = lowered.findIndex(cell => /(花費|duration|耗時|time)/i.test(cell));
  return {
    hasHeader: first.some(cell => /[A-Za-z\u4e00-\u9fff]/.test(String(cell))) && (startIndex >= 0 || endIndex >= 0 || durationIndex >= 0),
    startIndex,
    endIndex,
    durationIndex,
  };
}

function createDefaultState() {
  return {
    title: "",
    sourceName: "",
    headers: [],
    rows: [],
    currentRow: 0,
    currentCol: 0,
    activeTimer: null,
    pendingResult: null, // 已停止但尚未選擇「儲存」或「重錄」的計時結果 { rowIndex, startTs, endTs }
    recordCol: null,
    durationCol: null,
    sortCol: null,
    sortDir: "asc",
    headerMode: "auto", // auto | force | never — 第一列是否讀為表頭(key)
    exportName: `assist_mark_${Date.now()}`,
    lastSavedAt: null,
  };
}

class AssistMarkManager {
  constructor() {
    this._container = null;
    this._state = this._loadDraft() || createDefaultState();
    this._migrateLegacyDraft();
    this._keyHandler = null;
    this._saveTimer = null;
    this._syncTimer = null;
  }

  // 相容改版前（沒有「錄製」「花費時間」欄位）的舊草稿：直接在既有資料後面補上這兩欄，
  // 不清空使用者已貼上/上傳的資料。
  _migrateLegacyDraft() {
    const st = this._state;
    if (!st.rows?.length || (st.recordCol != null && st.durationCol != null)) return;
    const recordCol = st.headers.length;
    const durationCol = st.headers.length + 1;
    st.headers = [...st.headers, "錄製", "花費時間"];
    st.rows = st.rows.map(row => { const copy = row.slice(); copy.push(EMPTY_TEXT, EMPTY_TEXT); return copy; });
    st.recordCol = recordCol;
    st.durationCol = durationCol;
    st.activeTimer = null;
    st.pendingResult = null;
    this._saveDraft();
  }

  async init(container) {
    this._container = container;
    this._render();
    this._bindGlobalKeys();
    this._startClock();
    this._loadFromServer();
  }

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

  // 開啟時向伺服器要目前共用的草稿並蓋掉本機暫存，這樣不同客戶端打開時看到的進度一致，
  // 不會像純 localStorage 那樣各自為政。讀取失敗（離線等）時維持目前本機草稿即可。
  async _loadFromServer() {
    try {
      const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.ASSIST_MARK.DRAFT}`);
      const data = await res.json();
      if (!data.success || !data.draft) return;
      this._state = data.draft;
      this._migrateLegacyDraft();
      this._saveLocalDraft();
      this._render();
    } catch {
      // 讀取失敗時維持目前（本機）草稿，使用者仍可照常操作
    }
  }

  // 把目前草稿同步到伺服器，debounce 避免每個按鍵輸入都送出請求
  _scheduleServerSync() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._pushToServer(), 800);
  }

  async _pushToServer() {
    try {
      await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.ASSIST_MARK.DRAFT}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this._state),
      });
    } catch {
      // 同步失敗不中斷編輯，本機仍保留最新內容，下次異動會再次觸發同步
    }
  }

  _loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  _saveDraft() {
    this._saveLocalDraft();
    this._scheduleServerSync();
  }

  _saveLocalDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(this._state));
      this._state.lastSavedAt = Date.now();
      this._updateStatusText();
    } catch {
      // localStorage 滿了或不可用時，保持不中斷
    }
  }

  _clearDraft() {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {}
  }

  _startClock() {
    if (this._syncTimer) clearInterval(this._syncTimer);
    this._syncTimer = setInterval(() => {
      if (this._state.activeTimer) {
        this._updateTimerText();
      }
    }, 250);
  }

  _updateStatusText() {
    const el = this._container?.querySelector("[data-assist-status]");
    if (!el) return;
    const saved = this._state.lastSavedAt ? new Date(this._state.lastSavedAt).toLocaleTimeString("zh-TW", { hour12: false }) : "尚未儲存";
    el.textContent = `草稿已暫存：${saved}`;
  }

  _updateTimerText() {
    const el = this._container?.querySelector("[data-assist-timer]");
    if (!el || !this._state.activeTimer) return;
    el.textContent = formatClock(Date.now() - this._state.activeTimer.startTs);
  }

  _setState(partial) {
    this._state = { ...this._state, ...partial };
    this._saveDraft();
    this._render();
  }

  _setCurrent(row, col) {
    const maxRow = Math.max(0, this._state.rows.length - 1);
    const maxCol = Math.max(0, this._getColumnCount() - 1);
    this._state.currentRow = Math.min(Math.max(row, 0), maxRow);
    this._state.currentCol = Math.min(Math.max(col, 0), maxCol);
    this._saveDraft();
    this._render();
    const cell = this._container?.querySelector(`[data-cell-row="${this._state.currentRow}"][data-cell-col="${this._state.currentCol}"]`);
    cell?.focus();
  }

  _getColumnCount() {
    const headerCount = this._state.headers.length;
    const rowCount = this._state.rows.reduce((max, row) => Math.max(max, row.length), 0);
    return Math.max(headerCount, rowCount, 1);
  }

  _ensureShape() {
    const columnCount = this._getColumnCount();
    this._state.rows = this._state.rows.map(row => {
      const copy = row.slice();
      while (copy.length < columnCount) copy.push(EMPTY_TEXT);
      return copy;
    });
    while (this._state.headers.length < columnCount) {
      this._state.headers.push(`欄位 ${this._state.headers.length + 1}`);
    }
  }

  _loadData(rows, sourceName = "") {
    if (!rows.length) return;
    const headerMode = this._state.headerMode || "auto";
    const normalized = cloneRows(rows);
    const hasHeader = headerMode === "force" ? true : headerMode === "never" ? false : detectHeaders(normalized).hasHeader;
    const baseHeaders = hasHeader ? normalized.shift() : normalized[0].map((_, idx) => `欄位 ${idx + 1}`);
    // 若來源資料本身已經有「花費時間」欄（例如最終分析匯出的檔案），直接沿用該欄當計時欄，
    // 不再另外加一欄重複的「花費時間」。
    const existingDurationCol = hasHeader ? baseHeaders.findIndex(h => /花費時間|duration|耗時/i.test(String(h))) : -1;
    const recordCol = baseHeaders.length;
    const durationCol = existingDurationCol >= 0 ? existingDurationCol : recordCol + 1;
    const rowsWithTime = normalized.map(row => {
      const copy = row.slice();
      copy.push(EMPTY_TEXT);
      if (existingDurationCol < 0) copy.push(EMPTY_TEXT);
      return copy;
    });

    const nextState = {
      ...createDefaultState(),
      headerMode,
      title: sourceName || `匯入資料 ${nowIso()}`,
      sourceName,
      headers: existingDurationCol >= 0 ? [...baseHeaders, "錄製"] : [...baseHeaders, "錄製", "花費時間"],
      rows: rowsWithTime,
      recordCol,
      durationCol,
      currentRow: 0,
      currentCol: 0,
      activeTimer: null,
      pendingResult: null,
      exportName: sourceName ? sourceName.replace(/\.[^.]+$/, "") : `assist_mark_${Date.now()}`,
      lastSavedAt: Date.now(),
    };

    this._state = nextState;
    this._ensureShape();
    this._saveDraft();
    this._render();
  }

  _bindGlobalKeys() {
    if (this._keyHandler) document.removeEventListener("keydown", this._keyHandler);
    this._keyHandler = e => {
      const c = this._container;
      if (!c || c.classList.contains("is-hidden")) return;
      if (e.target && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;

      const hasData = this._state.rows.length > 0;
      if (!hasData) return;

      if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        if (this._state.pendingResult) { this._confirmPending(); return; }
        this._toggleTimer();
        return;
      }
      if (e.code === "Escape") {
        e.preventDefault();
        if (this._state.pendingResult) { this._redoPending(); return; }
        this._cancelTimer();
        return;
      }
      if (e.code === "ArrowUp") { e.preventDefault(); this._setCurrent(this._state.currentRow - 1, this._state.currentCol); return; }
      if (e.code === "ArrowDown") { e.preventDefault(); this._setCurrent(this._state.currentRow + 1, this._state.currentCol); return; }
      if (e.code === "ArrowLeft") { e.preventDefault(); this._setCurrent(this._state.currentRow, this._state.currentCol - 1); return; }
      if (e.code === "ArrowRight") { e.preventDefault(); this._setCurrent(this._state.currentRow, this._state.currentCol + 1); return; }
      if (e.code === "Tab") {
        e.preventDefault();
        const step = e.shiftKey ? -1 : 1;
        const next = this._state.currentRow * this._getColumnCount() + this._state.currentCol + step;
        const total = this._state.rows.length * this._getColumnCount();
        const normalized = ((next % total) + total) % total;
        this._setCurrent(Math.floor(normalized / this._getColumnCount()), normalized % this._getColumnCount());
      }
    };
    document.addEventListener("keydown", this._keyHandler);
  }

  // 開始／停止錄製：每列自己的「錄製」按鈕控制，同時間只能有一列在錄製或待確認。
  // 停止後不直接寫入表格，先進入「待確認」狀態，由使用者在同一格按「儲存」或「重錄」。
  _startTimer(rowIndex) {
    if (this._state.pendingResult || this._state.activeTimer) return; // 已有其他列在錄製或待確認
    if (!this._state.rows[rowIndex]) return;
    this._state.activeTimer = { rowIndex, startTs: Date.now() };
    this._saveDraft();
    this._render();
  }

  // Space/Enter 快捷鍵：對目前選取列開始計時，或結束目前正在錄製的那一列
  _toggleTimer() {
    if (this._state.pendingResult) return; // 尚有未確認的計時結果，需先儲存或重錄
    if (this._state.activeTimer) {
      this._stopTimer();
      return;
    }
    this._startTimer(this._state.currentRow);
  }

  _stopTimer() {
    const timer = this._state.activeTimer;
    if (!timer) return;
    this._state.pendingResult = { rowIndex: timer.rowIndex, startTs: timer.startTs, endTs: Date.now() };
    this._state.activeTimer = null;
    this._saveDraft();
    this._render();
  }

  // Escape：錄製中尚未停止時，直接取消（不留下任何暫存結果）
  _cancelTimer() {
    if (!this._state.activeTimer) return;
    this._state.activeTimer = null;
    this._saveDraft();
    this._render();
  }

  // 儲存：把待確認的花費時間寫入「花費時間」欄
  _confirmPending() {
    const p = this._state.pendingResult;
    if (!p) return;
    const row = this._state.rows[p.rowIndex];
    if (row) {
      const { durationCol } = this._state;
      row[durationCol != null ? durationCol : row.length - 1] = formatClock(p.endTs - p.startTs);
    }
    this._state.pendingResult = null;
    this._saveDraft();
    this._render();
  }

  // 重錄：捨棄待確認結果，立刻對同一列重新開始計時
  _redoPending() {
    const p = this._state.pendingResult;
    if (!p) return;
    this._state.pendingResult = null;
    this._state.activeTimer = { rowIndex: p.rowIndex, startTs: Date.now() };
    this._saveDraft();
    this._render();
  }

  _setHeaderMode(mode) {
    this._state.headerMode = mode;
    this._saveDraft();
    this._render();
  }

  _sortByColumn(colIndex) {
    if (this._state.activeTimer || this._state.pendingResult) {
      alert("請先儲存或重錄目前的計時結果，再進行排序。");
      return;
    }
    const dir = this._state.sortCol === colIndex && this._state.sortDir === "asc" ? "desc" : "asc";
    const mul = dir === "asc" ? 1 : -1;
    this._state.rows.sort((a, b) => {
      const va = sanitizeCellText(a[colIndex]);
      const vb = sanitizeCellText(b[colIndex]);
      const na = Number(va);
      const nb = Number(vb);
      if (va !== "" && vb !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) return (na - nb) * mul;
      return va.localeCompare(vb, "zh-Hant") * mul;
    });
    this._state.sortCol = colIndex;
    this._state.sortDir = dir;
    this._state.currentRow = 0;
    this._state.currentCol = 0;
    this._saveDraft();
    this._render();
  }

  _updateCell(rowIndex, colIndex, value) {
    if (!this._state.rows[rowIndex]) return;
    while (this._state.rows[rowIndex].length <= colIndex) {
      this._state.rows[rowIndex].push(EMPTY_TEXT);
    }
    this._state.rows[rowIndex][colIndex] = value;
    this._saveDraft();
  }

  _importFile(file) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const reader = new FileReader();
    reader.onload = e => {
      const result = e.target?.result;
      if (result == null) return;
      if (ext === "xlsx" || ext === "xls") {
        const workbook = XLSX.read(result, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
        this._loadData(rows, file.name);
        return;
      }
      const rows = parseDelimitedText(result);
      this._loadData(rows, file.name);
    };
    if (ext === "xlsx" || ext === "xls") reader.readAsArrayBuffer(file);
    else reader.readAsText(file, "utf-8");
  }

  _importClipboardText(text) {
    const rows = parseDelimitedText(text);
    this._loadData(rows, "貼上資料");
  }

  _exportCsv() {
    if (!this._state.rows.length) return;
    downloadCsv([this._state.headers, ...this._state.rows], this._state.exportName || "assist_mark");
  }

  _exportXlsx() {
    if (!this._state.rows.length) return;
    downloadXlsx([this._state.headers, ...this._state.rows], this._state.exportName || "assist_mark", "輔助標記");
  }

  _resetAll() {
    this._state = createDefaultState();
    this._clearDraft();
    this._scheduleServerSync();
    this._render();
  }

  _render() {
    if (!this._container) return;
    const st = this._state;
    const hasData = st.rows.length > 0;
    this._ensureShape();

    const headerModeOptions = [
      ["auto", "自動判斷"],
      ["force", "第一列為表頭"],
      ["never", "第一列為資料"],
    ].map(([v, label]) => `<option value="${v}" ${st.headerMode === v ? "selected" : ""}>${label}</option>`).join("");
    const headerModeSelect = `<label class="assist-mark-header-mode">
      第一列
      <select id="assistMarkHeaderMode">${headerModeOptions}</select>
    </label>`;

    const tableHtml = hasData ? this._renderTable() : `<div class="assist-mark-empty">
      <h3>輔助標記</h3>
      <p>先上傳 Excel / CSV，或直接貼上從 Excel 複製的表格內容。</p>
      <div class="assist-mark-empty-actions">
        ${headerModeSelect}
        <button class="archive-action-btn" data-assist-action="paste">貼上內容</button>
        <button class="archive-action-btn" data-assist-action="file">選擇檔案</button>
      </div>
    </div>`;

    this._container.innerHTML = `
      <div class="assist-mark-shell">
        <div class="assist-mark-topbar">
          <div class="assist-mark-title-wrap">
            <div class="assist-mark-title">輔助標記</div>
            <div class="assist-mark-subtitle">${escapeHtml(st.title || "尚未載入資料")}</div>
          </div>
          <div class="assist-mark-actions">
            ${headerModeSelect}
            <button class="archive-action-btn" data-assist-action="paste">貼上內容</button>
            <button class="archive-action-btn" data-assist-action="file">選擇檔案</button>
            <button class="archive-action-btn" data-assist-action="export-csv" ${hasData ? "" : "disabled"}>下載 CSV</button>
            <button class="archive-action-btn" data-assist-action="export-xlsx" ${hasData ? "" : "disabled"}>下載 Excel</button>
            <button class="archive-action-btn archive-action-btn--danger" data-assist-action="reset" ${hasData ? "" : "disabled"}>清空</button>
          </div>
        </div>
        <div class="assist-mark-status-bar">
          <span data-assist-status>草稿已暫存</span>
          <span class="assist-mark-help">每列右側「錄製」欄可開始／停止計時，停止後在同一格選擇儲存或重錄；方向鍵切格、Tab 連續移動、Space/Enter 開始或結束計時、Esc 取消計時</span>
          <input type="file" id="assistMarkFileInput" accept=".xlsx,.xls,.csv,.txt" hidden>
        </div>
        <textarea class="assist-mark-pastebox" id="assistMarkPasteBox" placeholder="在這裡直接貼上 Excel 複製的表格內容，或先點選「貼上內容」再貼上。"></textarea>
        <div class="assist-mark-table-wrap">
          ${tableHtml}
        </div>
      </div>`;

    this._bindEvents();
    this._updateStatusText();
    this._updateTimerText();
  }

  // 「錄製」欄：每列自己的計時控制按鈕（開始／停止／儲存／重錄）
  _renderRecordCell(rowIndex) {
    const st = this._state;
    const isRecording = st.activeTimer?.rowIndex === rowIndex;
    const isPending = st.pendingResult?.rowIndex === rowIndex;
    if (isRecording) {
      return `<button class="archive-action-btn archive-action-btn--sm" data-assist-stop="${rowIndex}">■ 停止</button>`;
    }
    if (isPending) {
      return `<button class="archive-action-btn archive-action-btn--sm" data-assist-confirm="${rowIndex}">儲存</button>
        <button class="archive-action-btn archive-action-btn--sm archive-action-btn--secondary" data-assist-redo="${rowIndex}">重錄</button>`;
    }
    const busyElsewhere = !!(st.activeTimer || st.pendingResult);
    return `<button class="archive-action-btn archive-action-btn--sm" data-assist-start="${rowIndex}" ${busyElsewhere ? "disabled" : ""}>● 開始錄製</button>`;
  }

  _renderTable() {
    const st = this._state;
    const headers = st.headers;
    const rows = st.rows;
    const recordCol = st.recordCol;
    const durationCol = st.durationCol;

    return `
      <table class="assist-mark-table">
        <thead>
          <tr>
            <th class="assist-mark-row-index">#</th>
            ${headers.map((head, idx) => {
              const arrow = st.sortCol === idx ? (st.sortDir === "asc" ? " ▲" : " ▼") : "";
              const badge = idx === recordCol ? " <span class=\"assist-mark-badge\">控制</span>"
                : idx === durationCol ? " <span class=\"assist-mark-badge\">計時</span>" : "";
              return `<th class="assist-mark-sortable" data-sort-col="${idx}" title="點擊依此欄排序">${escapeHtml(head)}${arrow}${badge}</th>`;
            }).join("")}
          </tr>
        </thead>
        <tbody>
          ${rows.map((row, rowIndex) => {
            const isCurrentRow = rowIndex === st.currentRow;
            const isRecording = st.activeTimer?.rowIndex === rowIndex;
            const isPending = st.pendingResult?.rowIndex === rowIndex;
            const rowState = isRecording ? " is-timing-row" : isPending ? " is-pending-row" : "";
            return `<tr class="${isCurrentRow ? "is-current-row" : ""}${rowState}">
              <td class="assist-mark-row-index">${rowIndex + 1}</td>
              ${headers.map((_, colIndex) => {
                if (colIndex === recordCol) {
                  return `<td class="assist-mark-record-td">${this._renderRecordCell(rowIndex)}</td>`;
                }
                const isCurrent = isCurrentRow && colIndex === st.currentCol;
                const isDurationCol = colIndex === durationCol;
                let value = sanitizeCellText(row[colIndex]);
                let stateClass = "";
                if (isDurationCol && isRecording) {
                  value = formatClock(Date.now() - st.activeTimer.startTs);
                  stateClass = " is-recording";
                } else if (isDurationCol && isPending) {
                  value = formatClock(st.pendingResult.endTs - st.pendingResult.startTs);
                  stateClass = " is-pending";
                }
                const editable = isDurationCol && (isRecording || isPending) ? "false" : "true";
                const timerAttr = isDurationCol && isRecording ? " data-assist-timer" : "";
                return `<td>
                  <div class="assist-mark-cell${isCurrent ? " is-current" : ""}${isDurationCol ? " assist-mark-cell--timer" : ""}${stateClass}" tabindex="0"
                       data-cell-row="${rowIndex}" data-cell-col="${colIndex}" contenteditable="${editable}" spellcheck="false"${timerAttr}>${escapeHtml(value)}</div>
                </td>`;
              }).join("")}
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;
  }

  _bindEvents() {
    const fileInput = this._container?.querySelector("#assistMarkFileInput");
    const pasteBox = this._container?.querySelector("#assistMarkPasteBox");

    this._container?.querySelectorAll("[data-assist-action]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.assistAction;
        if (action === "file") fileInput?.click();
        if (action === "paste") pasteBox?.focus();
        if (action === "export-csv") this._exportCsv();
        if (action === "export-xlsx") this._exportXlsx();
        if (action === "reset") this._resetAll();
      });
    });

    this._container?.querySelectorAll("[data-assist-start]").forEach(btn =>
      btn.addEventListener("click", e => { e.stopPropagation(); this._startTimer(Number(btn.dataset.assistStart)); }));
    this._container?.querySelectorAll("[data-assist-stop]").forEach(btn =>
      btn.addEventListener("click", e => { e.stopPropagation(); this._stopTimer(); }));
    this._container?.querySelectorAll("[data-assist-confirm]").forEach(btn =>
      btn.addEventListener("click", e => { e.stopPropagation(); this._confirmPending(); }));
    this._container?.querySelectorAll("[data-assist-redo]").forEach(btn =>
      btn.addEventListener("click", e => { e.stopPropagation(); this._redoPending(); }));

    fileInput?.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) this._importFile(file);
      fileInput.value = "";
    });

    this._container?.querySelector("#assistMarkHeaderMode")?.addEventListener("change", e => {
      this._setHeaderMode(e.target.value);
    });

    this._container?.querySelectorAll("[data-sort-col]").forEach(th => {
      th.addEventListener("click", () => {
        this._sortByColumn(Number(th.dataset.sortCol));
      });
    });

    pasteBox?.addEventListener("paste", e => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain") || "";
      this._importClipboardText(text);
    });

    this._container?.querySelectorAll(".assist-mark-cell").forEach(cell => {
      cell.addEventListener("focus", () => {
        const row = Number(cell.dataset.cellRow);
        const col = Number(cell.dataset.cellCol);
        if (Number.isFinite(row) && Number.isFinite(col)) {
          this._state.currentRow = row;
          this._state.currentCol = col;
        }
      });
      cell.addEventListener("input", () => {
        const row = Number(cell.dataset.cellRow);
        const col = Number(cell.dataset.cellCol);
        if (Number.isFinite(row) && Number.isFinite(col)) {
          this._updateCell(row, col, cell.textContent || "");
        }
      });
      cell.addEventListener("keydown", e => {
        if (e.code === "Enter" || e.code === "Space") {
          e.preventDefault();
          if (this._state.pendingResult) { this._confirmPending(); return; }
          this._toggleTimer();
          return;
        }
        if (e.code === "ArrowUp" || e.code === "ArrowDown" || e.code === "ArrowLeft" || e.code === "ArrowRight" || e.code === "Tab") {
          e.preventDefault();
          const row = Number(cell.dataset.cellRow);
          const col = Number(cell.dataset.cellCol);
          const totalCols = this._getColumnCount();
          let nextRow = row;
          let nextCol = col;
          if (e.code === "ArrowUp") nextRow -= 1;
          if (e.code === "ArrowDown") nextRow += 1;
          if (e.code === "ArrowLeft") nextCol -= 1;
          if (e.code === "ArrowRight") nextCol += 1;
          if (e.code === "Tab") {
            const step = e.shiftKey ? -1 : 1;
            const index = row * totalCols + col + step;
            const normalized = ((index % (this._state.rows.length * totalCols)) + (this._state.rows.length * totalCols)) % (this._state.rows.length * totalCols);
            nextRow = Math.floor(normalized / totalCols);
            nextCol = normalized % totalCols;
          }
          this._setCurrent(nextRow, nextCol);
        }
      });
    });
  }
}

const _manager = new AssistMarkManager();

export function onAssistMarkActivate() {
  const el = document.getElementById("archiveAssistMark");
  if (!el) return;
  _manager.init(el);
}
