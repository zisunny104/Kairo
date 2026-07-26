/**
 * archive-sidebar.js — 伺服器/本機檔案管理
 */

import { Logger } from "../core/console-manager.js";
import { UIPopover } from "../ui/popover.js";
import { API_ENDPOINTS } from "../constants/index.js";
import { ArchiveFileState, parseJsonl, escapeHtml, stripColorTags, showToast, parseJsonResponse } from "./archive-constants.js";

function nowStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export const archiveSidebarMethods = {

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
        (scenData.gesture_list || []).map(g => [g.gesture_id, g.gesture_name]),
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
      Logger.debug("[Archive] 參考資料載入完成");
    } catch (err) {
      Logger.warn("[Archive] 參考資料載入失敗:", err.message);
    }
  },

  // ── 伺服器檔案 ────────────────────────────────────────────────────────────

  async _loadServerFiles() {
    const list = document.getElementById("serverFilesList");
    if (!list) return;
    list.innerHTML = "<div class=\"archive-status\">載入中…</div>";
    try {
      const res  = await this._authedFetch(`${this._api}${API_ENDPOINTS.RECORD.LIST}`);
      if (!res.ok) { list.innerHTML = `<div class="archive-status archive-status--error">無法取得檔案列表 (${res.status})</div>`; return; }
      const data = await parseJsonResponse(res);
      if (!data.success) throw new Error(data.error || "未知錯誤");
      this._serverFiles = data.files || [];
      this._renderServerList();
    } catch (err) {
      Logger.error("[Archive] 載入失敗:", err.message);
      list.innerHTML = "<div class=\"archive-status archive-status--error\">無法連接伺服器</div>";
    }
  },

  _renderServerList() {
    const list = document.getElementById("serverFilesList");
    if (!list) return;

    // 搜尋輸入框（只建一次）
    if (!document.getElementById("serverFileFilter")) {
      const wrap = document.createElement("div");
      wrap.className = "archive-file-filter-wrap";
      wrap.id = "serverFileFilterWrap";
      wrap.innerHTML = "<input type=\"text\" id=\"serverFileFilter\" class=\"archive-file-filter\" placeholder=\"搜尋檔案名稱…\">";
      list.parentNode.insertBefore(wrap, list);
      document.getElementById("serverFileFilter").addEventListener("input", e => {
        this._fileFilter = e.target.value.toLowerCase();
        this._renderServerFileItems();
      });
    }

    // 批次操作列（只建一次）
    if (!document.getElementById("serverBatchBar")) {
      const bar = document.createElement("div");
      bar.id = "serverBatchBar";
      bar.className = "archive-batch-bar is-hidden";
      list.parentNode.insertBefore(bar, list);
    }

    // 搜尋按鈕 toggle（只綁一次）
    if (!this._serverSearchBound) {
      document.getElementById("serverSearchToggleBtn")?.addEventListener("click", () => {
        const wrap = document.getElementById("serverFileFilterWrap");
        const input = document.getElementById("serverFileFilter");
        if (!wrap) return;
        const isOpen = wrap.classList.toggle("is-open");
        if (isOpen) input?.focus();
        else {
          input.value = "";
          this._fileFilter = "";
          this._renderServerFileItems();
        }
      });
      this._serverSearchBound = true;
    }

    // 篩選 popover（只建一次）
    if (!this._serverFilterPopover) {
      const popoverEl = document.createElement("div");
      popoverEl.id = "serverFilterPopover";
      popoverEl.className = "record-filter-popover is-hidden";
      popoverEl.setAttribute("aria-hidden", "true");
      popoverEl.innerHTML = `
        <div class="record-filter-block">
          <div class="record-filter-title">檔案大小（KB）</div>
          <div class="record-filter-range">
            <div class="record-filter-values">
              <span id="serverSizeMinVal">0</span>
              <span class="record-filter-sep">~</span>
              <span id="serverSizeMaxVal">0</span>
            </div>
            <div class="record-filter-sliders" id="serverSizeSliders">
              <input id="serverSizeMinRange" class="range-min" type="range" min="0" max="0" value="0" step="1">
              <input id="serverSizeMaxRange" class="range-max" type="range" min="0" max="0" value="0" step="1">
            </div>
          </div>
        </div>
        <div class="record-filter-block">
          <div class="record-filter-title">修改日期</div>
          <div class="record-filter-range">
            <div class="record-filter-values">
              <span id="serverDateMinVal">--</span>
              <span class="record-filter-sep">~</span>
              <span id="serverDateMaxVal">--</span>
            </div>
            <div class="record-filter-sliders" id="serverDateSliders">
              <input id="serverDateMinRange" class="range-min" type="range" min="0" max="0" value="0" step="1">
              <input id="serverDateMaxRange" class="range-max" type="range" min="0" max="0" value="0" step="1">
            </div>
          </div>
        </div>
        <div class="record-filter-actions">
          <button class="btn-secondary" id="serverFilterReset">重置</button>
          <button class="btn-primary" id="serverFilterApply">套用</button>
        </div>`;
      document.getElementById("serverFilesSection")?.appendChild(popoverEl);

      const anchorEl = document.getElementById("serverFilterToggleBtn");
      this._serverFilterPopover = new UIPopover({ popoverEl, anchorEl, placement: "right-start", offset: 8 });

      // 篩選滑桿事件
      const bindRange = (minId, maxId, filterObj, labelFn) => {
        const update = () => {
          const minEl = document.getElementById(minId);
          const maxEl = document.getElementById(maxId);
          if (!minEl || !maxEl) return;
          let min = parseInt(minEl.value, 10), max = parseInt(maxEl.value, 10);
          if (min > max) { max = min; maxEl.value = String(max); }
          if (max < min) { min = max; minEl.value = String(min); }
          filterObj.min = min; filterObj.max = max;
          this._updateServerFilterLabels();
        };
        document.getElementById(minId)?.addEventListener("input", update);
        document.getElementById(maxId)?.addEventListener("input", update);
      };
      bindRange("serverSizeMinRange", "serverSizeMaxRange", this._serverSizeFilter,
        v => `${v} KB`);
      bindRange("serverDateMinRange", "serverDateMaxRange", this._serverDateFilter,
        v => this._tsm.formatDateTime(v, { includeTime: false }));

      document.getElementById("serverFilterApply")?.addEventListener("click", () => {
        this._serverFilterPopover.close();
        this._renderServerFileItems();
      });
      document.getElementById("serverFilterReset")?.addEventListener("click", () => {
        this._serverSizeFilter.min = 0;
        this._serverSizeFilter.max = this._serverSizeFilter.maxAvailable;
        this._serverDateFilter.min = this._serverDateFilter.minAvailable;
        this._serverDateFilter.max = this._serverDateFilter.maxAvailable;
        this._updateServerFilterBounds();
        this._serverFilterPopover.close();
        this._renderServerFileItems();
      });

      document.getElementById("serverFilterToggleBtn")?.addEventListener("click", () => {
        this._serverFilterPopover.toggle();
      });
    }

    // 事件委派（只建一次）
    if (!this._serverListBound) {
      list.addEventListener("click", e => {
        const btn = e.target.closest("[data-card-action]");
        if (!btn) return;
        e.stopPropagation();
        const filename = btn.dataset.filename;
        if (btn.dataset.cardAction === "download") this._downloadServerFile(filename);
        else if (btn.dataset.cardAction === "delete")  this._deleteServerFile(filename);
      });
      this._serverListBound = true;
    }

    document.getElementById("serverFileFilter").value = this._fileFilter;
    this._updateServerFilterBounds();
    this._renderServerFileItems();
  },

  _renderServerFileItems() {
    const list = document.getElementById("serverFilesList");
    if (!list) return;
    const files = this._serverFiles.filter(f => {
      if (this._fileFilter && !f.filename.toLowerCase().includes(this._fileFilter)) return false;
      const kb = Math.round(f.size / 1024);
      const sizeMin = this._serverSizeFilter.min ?? 0;
      const sizeMax = this._serverSizeFilter.max ?? this._serverSizeFilter.maxAvailable;
      if (Number.isFinite(sizeMax) && (kb < sizeMin || kb > sizeMax)) return false;
      const dateMin = this._serverDateFilter.min ?? this._serverDateFilter.minAvailable;
      const dateMax = this._serverDateFilter.max ?? this._serverDateFilter.maxAvailable;
      if (Number.isFinite(dateMin) && f.modified < dateMin) return false;
      if (Number.isFinite(dateMax) && f.modified > dateMax) return false;
      return true;
    });

    const isFiltered = this._fileFilter || this._isServerFilterActive();
    if (files.length === 0) {
      list.innerHTML = `<div class="archive-status">${isFiltered ? "無符合篩選條件的檔案" : "伺服器上尚無日誌"}</div>`;
      return;
    }
    const activeId = this._file?.id || "";
    list.innerHTML = files.map(f => {
      const kb     = (f.size / 1024).toFixed(1);
      const dt     = this._tsm.formatDateTime(f.modified, { includeTime: false });
      const id     = `server:${f.filename}`;
      const safeId = escapeHtml(id);
      const safeFn = escapeHtml(f.filename);
      const sel    = this._selectedFiles.has(id);
      const active = activeId === id;
      return `<div class="archive-file-card${active ? " is-active" : ""}${sel ? " is-selected" : ""}" data-file-id="${safeId}">
        <input type="checkbox" class="archive-file-checkbox" data-file-id="${safeId}" ${sel ? "checked" : ""}>
        <div class="archive-file-info" data-filename="${safeFn}">
          <span class="archive-file-name">${safeFn}</span>
          <span class="archive-file-meta">${dt} · ${kb} KB</span>
        </div>
        <div class="file-card-actions">
          <button class="file-card-btn" data-card-action="download" data-filename="${safeFn}" title="下載">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2"/><polyline points="8 12 12 16 16 12"/><line x1="12" y1="3" x2="12" y2="16"/>
            </svg>
          </button>
          <button class="file-card-btn file-card-btn--danger" data-card-action="delete" data-filename="${safeFn}" title="刪除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          </button>
        </div>
      </div>`;
    }).join("");

    // 點擊檔案資訊區 = 開啟
    list.querySelectorAll(".archive-file-info").forEach(info =>
      info.addEventListener("click", () => this._openServer(info.dataset.filename)),
    );
    // checkbox 選取
    list.querySelectorAll(".archive-file-checkbox").forEach(cb =>
      cb.addEventListener("change", () => {
        const id = cb.dataset.fileId;
        if (cb.checked) this._selectedFiles.add(id);
        else this._selectedFiles.delete(id);
        cb.closest(".archive-file-card")?.classList.toggle("is-selected", cb.checked);
        this._updateServerBatchBar();
      }),
    );
  },

  async _openServer(filename) {
    const id = `server:${filename}`;
    this._setActive(id);
    this._showLoading(filename);
    try {
      const res  = await this._authedFetch(`${this._api}${API_ENDPOINTS.RECORD.READ(filename)}`);
      if (!res.ok) { this._showError(filename, `無法讀取 (${res.status})`); return; }
      const data = await parseJsonResponse(res);
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
  },

  _updateServerFilterBounds() {
    const files = this._serverFiles;
    if (!files.length) return;
    const sizes = files.map(f => Math.round(f.size / 1024));
    const dates = files.map(f => f.modified).filter(Number.isFinite);
    const maxKb = Math.max(...sizes);
    const minDate = Math.min(...dates);
    const maxDate = Math.max(...dates);

    this._serverSizeFilter.maxAvailable = maxKb;
    if (this._serverSizeFilter.max === null) this._serverSizeFilter.max = maxKb;
    if (this._serverSizeFilter.max > maxKb)  this._serverSizeFilter.max = maxKb;

    this._serverDateFilter.minAvailable = minDate;
    this._serverDateFilter.maxAvailable = maxDate;
    if (this._serverDateFilter.min === null) this._serverDateFilter.min = minDate;
    if (this._serverDateFilter.max === null) this._serverDateFilter.max = maxDate;

    const setSlider = (minId, maxId, minVal, maxVal, curMin, curMax) => {
      const mn = document.getElementById(minId);
      const mx = document.getElementById(maxId);
      if (!mn || !mx) return;
      mn.min = String(minVal); mn.max = String(maxVal); mn.value = String(curMin ?? minVal);
      mx.min = String(minVal); mx.max = String(maxVal); mx.value = String(curMax ?? maxVal);
    };
    setSlider("serverSizeMinRange", "serverSizeMaxRange", 0, maxKb,
      this._serverSizeFilter.min, this._serverSizeFilter.max);
    setSlider("serverDateMinRange", "serverDateMaxRange", minDate, maxDate,
      this._serverDateFilter.min, this._serverDateFilter.max);
    this._updateServerFilterLabels();
  },

  _updateServerFilterLabels() {
    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    setText("serverSizeMinVal", `${this._serverSizeFilter.min ?? 0} KB`);
    setText("serverSizeMaxVal", `${this._serverSizeFilter.max ?? 0} KB`);
    setText("serverDateMinVal", this._tsm.formatDateTime(this._serverDateFilter.min, { includeTime: false }));
    setText("serverDateMaxVal", this._tsm.formatDateTime(this._serverDateFilter.max, { includeTime: false }));

    const sizeRange = this._serverSizeFilter.maxAvailable || 1;
    const dateRange = (this._serverDateFilter.maxAvailable - this._serverDateFilter.minAvailable) || 1;
    const setSep = (id, min, max, minBound, maxBound, total) => {
      const el = document.getElementById(id);
      if (!el || !Number.isFinite(minBound) || !Number.isFinite(maxBound) || total <= 0) return;
      const start = ((( min ?? minBound) - minBound) / total) * 100;
      const end   = ((( max ?? maxBound) - minBound) / total) * 100;
      el.style.setProperty("--range-start", `${Math.max(0, start)}%`);
      el.style.setProperty("--range-end",   `${Math.min(100, end)}%`);
    };
    setSep("serverSizeSliders", this._serverSizeFilter.min, this._serverSizeFilter.max, 0, this._serverSizeFilter.maxAvailable, sizeRange);
    setSep("serverDateSliders", this._serverDateFilter.min, this._serverDateFilter.max, this._serverDateFilter.minAvailable, this._serverDateFilter.maxAvailable, dateRange);
  },

  _isServerFilterActive() {
    const sz = this._serverSizeFilter;
    const dt = this._serverDateFilter;
    return (sz.min > 0) || (sz.maxAvailable > 0 && sz.max < sz.maxAvailable) ||
      (dt.minAvailable !== null && dt.min > dt.minAvailable) ||
      (dt.maxAvailable !== null && dt.max < dt.maxAvailable);
  },

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
  },

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
  },

  _renderLocalList() {
    const ctn = document.getElementById("localFilesList");
    if (!ctn) return;
    if (this._localFiles.size === 0) { ctn.innerHTML = ""; return; }
    const activeId = this._file?.id || "";
    ctn.innerHTML = "<div class=\"archive-local-label\">本機（僅此工作階段）</div>" +
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
          <div class="file-card-actions">
            <button class="file-card-btn file-card-btn--upload" data-local-action="upload" data-file-id="${safeId}" title="上傳至伺服器">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>
              </svg>
            </button>
            <button class="file-card-btn file-card-btn--danger" data-local-action="remove" data-file-id="${safeId}" title="從清單移除">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
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
      }),
    );
    ctn.querySelectorAll(".archive-file-checkbox").forEach(cb =>
      cb.addEventListener("change", () => {
        const id = cb.dataset.fileId;
        if (cb.checked) this._selectedFiles.add(id);
        else this._selectedFiles.delete(id);
        cb.closest(".archive-file-card")?.classList.toggle("is-selected", cb.checked);
      }),
    );
    ctn.querySelectorAll("[data-local-action]").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const id = btn.dataset.fileId;
        if (btn.dataset.localAction === "upload") this._uploadLocalFileById(id);
        else if (btn.dataset.localAction === "remove") this._removeLocalFile(id);
      }),
    );
  },

  _restoreDraft(state) {
    const draft = ArchiveFileState.loadDraft(state.title);
    if (!draft || draft.history.length === 0) return;
    state.entries = draft.entries;
    state.history = draft.history;
    state.isDirty = true;
    Logger.info(`[Archive] 還原草稿：${draft.history.length} 筆編輯 (${state.title})`);
  },

  // ── 卡片動作 ──────────────────────────────────────────────────────────────

  async _downloadServerFile(filename) {
    try {
      const res  = await this._authedFetch(`${this._api}${API_ENDPOINTS.RECORD.READ(filename)}`);
      if (!res.ok) { Logger.error("[Archive] 下載失敗: HTTP", res.status); return; }
      const data = await parseJsonResponse(res);
      if (!data.success) { Logger.error("[Archive] 下載失敗:", data.error); return; }
      const blob = new Blob([data.content], { type: "application/x-jsonlines" });
      const a = Object.assign(document.createElement("a"), {
        href: URL.createObjectURL(blob), download: filename,
      });
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (err) {
      Logger.error("[Archive] 下載失敗:", err.message);
    }
  },

  async _deleteServerFile(filename) {
    if (!confirm(`確定要從伺服器刪除「${filename}」嗎？此操作無法復原。`)) return;
    try {
      const res  = await this._authedFetch(`${this._api}${API_ENDPOINTS.RECORD.DELETE(filename)}`, { method: "DELETE" });
      if (!res.ok) { showToast(`刪除失敗 (${res.status})`, "error"); return; }
      const data = await parseJsonResponse(res);
      if (!data.success) throw new Error(data.error || "刪除失敗");
      if (this._file?.title === filename) this._file = null;
      await this._loadServerFiles();
    } catch (err) {
      Logger.error("[Archive] 刪除失敗:", err.message);
      showToast(`刪除失敗：${err.message}`, "error");
    }
  },

  async _deleteServerFile_silent(filename) {
    try {
      const res  = await this._authedFetch(`${this._api}${API_ENDPOINTS.RECORD.DELETE(filename)}`, { method: "DELETE" });
      if (!res.ok) return;
      const data = await parseJsonResponse(res);
      if (!data.success) throw new Error(data.error);
      if (this._file?.title === filename) this._file = null;
    } catch (err) {
      Logger.error(`[Archive] 刪除 ${filename} 失敗:`, err.message);
    }
  },

  async _uploadLocalFileById(id) {
    const f = this._localFiles.get(id);
    if (!f) return;
    const state = { title: f.name, source: "local", toEditedJsonl: () => f.content };
    const btn = document.querySelector(`[data-local-action="upload"][data-file-id="${CSS.escape(id)}"]`);
    if (btn) { btn.disabled = true; }
    try {
      const res = await this._authedFetch(`${this._api}${API_ENDPOINTS.RECORD.SAVE}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: state.title, content: state.toEditedJsonl() }),
      });
      const data = await parseJsonResponse(res);
      if (!data.success) throw new Error(data.error || "上傳失敗");
      await this._loadServerFiles();
    } catch (err) {
      Logger.error("[Archive] 上傳失敗:", err.message);
      showToast(`上傳失敗：${err.message}`, "error");
    } finally {
      if (btn) { btn.disabled = false; }
    }
  },

  _removeLocalFile(id) {
    this._localFiles.delete(id);
    this._selectedFiles.delete(id);
    if (this._file?.id === id) this._file = null;
    this._renderLocalList();
  },

  // ── 另存新檔（不覆蓋原始檔）──────────────────────────────────────────────

  _saveWithSuffix(state) {
    if (!state) return;
    const orig = state.title;
    const dot  = orig.lastIndexOf(".");
    // 加時間戳，同一個原始檔案編輯存檔多次也不會撞名（伺服器端 wx 寫入本來就拒絕覆蓋既有檔）。
    const suffix = `_edited_${nowStamp()}`;
    const newName = dot >= 0
      ? orig.slice(0, dot) + suffix + orig.slice(dot)
      : orig + suffix;

    if (state.source === "local") {
      const blob = new Blob([state.toEditedJsonl()], { type: "application/x-ndjson" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = newName; a.click();
      URL.revokeObjectURL(url);
      state.commitAsOriginal();
      this._renderAll();
      return;
    }
    this._saveToServerWithSuffix(state, newName);
  },

  async _saveToServerWithSuffix(state, newName) {
    const btn = document.querySelector("[data-action='save-file']");
    if (btn) { btn.disabled = true; btn.textContent = "儲存中…"; }
    try {
      const res = await this._authedFetch(`${this._api}${API_ENDPOINTS.RECORD.SAVE}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: newName, content: state.toEditedJsonl() }),
      });
      const data = await parseJsonResponse(res);
      if (!data.success) throw new Error(data.error || "儲存失敗");
      Logger.info(`[Archive] 另存成功: ${data.path}`);
      state.commitAsOriginal();
      await this._loadServerFiles();
      this._renderAll();
    } catch (err) {
      Logger.error("[Archive] 另存失敗:", err.message);
      showToast(`另存失敗：${err.message}`, "error");
      const b = document.querySelector("[data-action='save-file']");
      if (b) { b.disabled = false; b.textContent = "另存新檔"; }
    }
  },

  // ── 上傳至伺服器 ──────────────────────────────────────────────────────────

  async _uploadToServer(state) {
    const btn = document.querySelector("[data-action='upload']");
    if (btn) { btn.disabled = true; btn.textContent = "上傳中…"; }
    try {
      const res = await this._authedFetch(`${this._api}${API_ENDPOINTS.RECORD.SAVE}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: state.title, content: state.toEditedJsonl() }),
      });
      const data = await parseJsonResponse(res);
      if (!data.success) throw new Error(data.error || "上傳失敗");
      Logger.info(`[Archive] 上傳成功: ${data.path}`);
      await this._loadServerFiles();
      this._renderAll();
    } catch (err) {
      Logger.error("[Archive] 上傳失敗:", err.message);
      showToast(`上傳失敗：${err.message}`, "error");
      if (btn) { btn.disabled = false; btn.textContent = "上傳至伺服器"; }
    }
  },

  _updateServerBatchBar() {
    const bar = document.getElementById("serverBatchBar");
    if (!bar) return;
    const serverSelected = [...this._selectedFiles].filter(id => id.startsWith("server:"));
    if (serverSelected.length === 0) { bar.classList.add("is-hidden"); return; }
    bar.classList.remove("is-hidden");
    bar.innerHTML = `
      <span class="archive-batch-count">${serverSelected.length} 項已選</span>
      <button class="archive-batch-btn archive-batch-btn--success" id="batchDownloadBtn">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2"/><polyline points="8 12 12 16 16 12"/><line x1="12" y1="3" x2="12" y2="16"/>
        </svg>全部下載
      </button>
      <button class="archive-batch-btn archive-batch-btn--danger" id="batchDeleteBtn">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>
        </svg>批次刪除
      </button>`;

    bar.querySelector("#batchDownloadBtn")?.addEventListener("click", () => {
      serverSelected.forEach(id => this._downloadServerFile(id.replace(/^server:/, "")));
    });
    bar.querySelector("#batchDeleteBtn")?.addEventListener("click", async () => {
      const names = serverSelected.map(id => id.replace(/^server:/, ""));
      if (!confirm(`確定要刪除這 ${names.length} 個檔案嗎？\n${names.join("\n")}`)) return;
      for (const name of names) await this._deleteServerFile_silent(name);
      this._selectedFiles.clear();
      await this._loadServerFiles();
    });
  },

};
