/**
 * archive-questionnaire.js — 問卷分析分頁
 * 貼上／匯入 Google Form 問卷原始回應 → 欄位對應（Timestamp／Email／Participant ID／SSQ／NASA-TLX／SUS／UEQ）
 * → 自動與受試者名冊（trackingId）比對 → 描述統計 + 長條圖／雷達圖 + 可直接複製的圖說／表說／學術描述。
 * 「AI分析」依需求縮減為純資料事實描述 + 已發表之量表參考值（僅 SUS 等級對照），不產生推論性研究結論。
 */
import {
  escapeHtml, showToast, renderActionsCollapseBtn, loadCollapsedPref, saveCollapsedPref,
} from "./archive-constants.js";
import { getParticipantNameMap } from "./archive-roster.js";
import { mean } from "./archive-final-analysis-stats.js";
import { getApiUrl } from "../core/url-utils.js";
import { getAdminToken, clearAdminToken } from "../core/admin-auth.js";
import { API_ENDPOINTS } from "../constants/index.js";
import { downloadCsv, downloadXlsx } from "../core/xlsx-export.js";
import {
  SCALE_ORDER, SCALE_DEFS, parsePastedText, readFile, splitHeaderRows,
  detectColumns, rolesFromDetected, mappingFromRoles, validateData,
} from "./archive-questionnaire-parse.js";
import { itemStats, computeSusScores, susRating } from "./archive-questionnaire-stats.js";
import {
  ScaleCard, makeCounter, resetCopyRegistry, wireCaptionCopyButtons,
  renderStatTiles, describeItemStats, describeSusExtra, renderCaptionDescBlock,
} from "./archive-questionnaire-cards.js";
import { wireChartExports } from "./archive-final-analysis-viz.js";

const DRAFT_KEY = "archive_questionnaire_draft_v1";
const ACTIONS_COLLAPSED_KEY = "archive_questionnaire_actions_collapsed_v1";
const fmt = v => (v == null || Number.isNaN(v) ? "—" : v.toFixed(2));

const ROLE_LABELS = {
  ignore: "（忽略）",
  timestamp: "Timestamp",
  email: "Email",
  participantId: "Participant ID",
  ssq: "SSQ",
  nasa: "NASA-TLX",
  sus: "SUS",
  ueq: "UEQ",
};
const ROLE_OPTIONS = ["ignore", "timestamp", "email", "participantId", "ssq", "nasa", "sus", "ueq"];

const EXPORT_CSS = `
body{font-family:"Noto Sans TC","Microsoft JhengHei",sans-serif;color:#222;max-width:960px;margin:24px auto;padding:0 16px;}
h1{font-size:20px;} h2{font-size:16px;margin-top:32px;border-bottom:2px solid #667eea;padding-bottom:4px;}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:13px;}
th,td{border:1px solid #ccc;padding:5px 8px;text-align:left;}
th{background:#f4f4f8;}
svg{max-width:100%;height:auto;border:1px solid #e5e5e5;background:#fff;}
p{font-size:13.5px;line-height:1.7;}
button{display:none;}
.final-analysis-stat-tiles{display:flex;flex-wrap:wrap;gap:10px;}
.final-analysis-stat-tile{flex:1 1 150px;padding:8px 10px;border:1px solid #e6d3ee;border-radius:6px;background:#faf7fb;}
.final-analysis-stat-tile-label{font-size:11px;color:#8e6a99;font-weight:700;}
.final-analysis-stat-tile-value{font-size:15px;font-weight:700;}
.final-analysis-chart-legend{display:flex;gap:12px;font-size:12px;margin:6px 0;}
.qnr-caption{font-weight:700;margin:10px 0 2px;}
.qnr-desc{color:#444;margin:0 0 10px;}
.final-analysis-datatable-toolbar,.final-analysis-chart-actions,.final-analysis-chart-settings{display:none;}
`;

function nowStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function downloadTextFile(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function createDefaultState() {
  return {
    headers: [],
    dataRows: [],
    columnRoles: [],
    chapter: "4",
    stage: "input", // "input" | "dashboard"
    mappingOpen: true,
  };
}

class QuestionnaireManager {
  constructor() {
    this._container = null;
    this._state = this._loadDraft() || createDefaultState();
    this._nameMap = new Map();
    this._computed = null;
    this._cards = {
      ssq: new ScaleCard("ssq", SCALE_DEFS.ssq, { withRadar: true }),
      nasa: new ScaleCard("nasa", SCALE_DEFS.nasa, { withRadar: true }),
      sus: new ScaleCard("sus", SCALE_DEFS.sus, { withRadar: false }),
      ueq: new ScaleCard("ueq", SCALE_DEFS.ueq, { withRadar: true }),
    };
    this._saveTimer = null;
    this._actionsCollapsed = loadCollapsedPref(ACTIONS_COLLAPSED_KEY);
  }

  // 先用本機草稿立即渲染，再向伺服器要目前共用的草稿並蓋掉本機（讓不同裝置/瀏覽器看到一致的資料），
  // 讀取失敗（離線等）時維持本機草稿即可，不中斷操作
  async init(container) {
    this._container = container;
    this._render();
    await this._loadFromServer();
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

  async _loadFromServer() {
    try {
      const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.QUESTIONNAIRE.DRAFT}`);
      const data = await res.json();
      if (!data.success || !data.draft) return;
      this._state = { ...createDefaultState(), ...data.draft };
      this._saveLocalDraft();
      this._render();
    } catch {
      // 讀取失敗時維持目前（本機）草稿，使用者仍可照常操作
    }
  }

  // 把目前草稿同步到伺服器，debounce 避免每次欄位對應調整都送出請求
  _scheduleServerSync() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._pushToServer(), 800);
  }

  async _pushToServer() {
    try {
      await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.QUESTIONNAIRE.DRAFT}`, {
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
    } catch { return null; }
  }

  _saveLocalDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(this._state)); } catch { /* 容量不足時忽略，不影響操作 */ }
  }

  _saveDraft() {
    this._saveLocalDraft();
    this._scheduleServerSync();
  }

  _loadRows(rows, sourceLabel) {
    if (!rows.length) { showToast("沒有解析到任何資料，請確認貼上內容或檔案格式。", "warning"); return; }
    const { headers, dataRows } = splitHeaderRows(rows);
    if (!dataRows.length) { showToast("只找到表頭，沒有任何資料列。", "warning"); return; }
    const detected = detectColumns(headers);
    this._state.headers = headers;
    this._state.dataRows = dataRows;
    this._state.columnRoles = rolesFromDetected(headers, detected);
    this._state.stage = "input";
    this._state.mappingOpen = true;
    this._saveDraft();
    showToast(`已解析「${sourceLabel}」共 ${dataRows.length} 筆資料，請確認下方欄位對應。`, "success");
    this._render();
  }

  async _importFile(file) {
    try {
      const rows = await readFile(file);
      this._loadRows(rows, file.name);
    } catch (err) {
      showToast(`匯入失敗：${err.message || err}`, "error");
    }
  }

  _setRole(colIndex, role) {
    this._state.columnRoles[colIndex] = role;
    this._saveDraft();
    this._render();
  }

  _backToInput() {
    this._state.stage = "input";
    this._computed = null;
    this._saveDraft();
    this._render();
  }

  _downloadRawData(type) {
    const { headers, dataRows } = this._state;
    if (!headers.length || !dataRows.length) return;
    const rows = [headers, ...dataRows];
    if (type === "xlsx") downloadXlsx(rows, `questionnaire_raw_${nowStamp()}`, "原始資料");
    else downloadCsv(rows, `questionnaire_raw_${nowStamp()}`);
  }

  _resetAll() {
    this._state = createDefaultState();
    this._computed = null;
    this._saveDraft();
    this._render();
  }

  async _applyMapping() {
    this._nameMap = await getParticipantNameMap().catch(() => new Map());
    this._state.stage = "dashboard";
    this._state.mappingOpen = false;
    this._saveDraft();
    this._render();
  }

  _computeAll() {
    const { headers, dataRows, columnRoles } = this._state;
    const mapping = mappingFromRoles(columnRoles);
    const validation = validateData(headers, dataRows, mapping);

    const statsBySale = {};
    SCALE_ORDER.forEach(scale => { statsBySale[scale] = itemStats(headers, dataRows, mapping[scale]); });

    const susScores = computeSusScores(dataRows, mapping.sus);
    const susAvg = susScores.length ? mean(susScores) : null;
    const rating = susRating(susAvg);

    // 與受試者名冊比對：依 Participant ID（=trackingId）查名字，找不到的另外列出
    const idCol = mapping.participantIdCol;
    const matched = [];
    const unmatchedIds = [];
    if (idCol >= 0) {
      const seen = new Set();
      dataRows.forEach(row => {
        const raw = String(row[idCol] ?? "").trim();
        if (!raw || seen.has(raw)) return;
        seen.add(raw);
        const trackingId = Number(raw);
        const name = this._nameMap.get(trackingId);
        if (name) matched.push({ id: raw, name });
        else unmatchedIds.push(raw);
      });
    }

    return { mapping, validation, statsBySale, susScores, susAvg, rating, matched, unmatchedIds };
  }

  // ── 輸入區（貼上／匯入 + 欄位對應） ──────────────────────────────────
  _renderInputPanel() {
    const { headers, columnRoles } = this._state;
    const hasHeaders = headers.length > 0;

    const mappingRows = hasHeaders ? headers.map((h, i) => {
      const options = ROLE_OPTIONS.map(r => `<option value="${r}" ${columnRoles[i] === r ? "selected" : ""}>${ROLE_LABELS[r]}</option>`).join("");
      return `<tr><td class="qnr-mapping-header" title="${escapeHtml(h)}">${escapeHtml(h.length > 40 ? `${h.slice(0, 40)}…` : h)}</td>
        <td><select class="qnr-mapping-select" data-qnr-role-col="${i}">${options}</select></td></tr>`;
    }).join("") : "";

    const countsHtml = hasHeaders ? SCALE_ORDER.map(scale => {
      const count = columnRoles.filter(r => r === scale).length;
      const expected = SCALE_DEFS[scale].count;
      const ok = count === expected;
      return `<span class="qnr-scale-count ${ok ? "is-ok" : "is-warn"}">${SCALE_DEFS[scale].label}：${count} / ${expected} 題</span>`;
    }).join("") : "";

    return `<div class="qnr-input-panel">
      <div class="qnr-input-row">
        <label class="qnr-input-label">貼上 Google Form 原始回應（含表頭列，Tab 或逗號分隔）</label>
        <textarea id="qnrPasteArea" class="qnr-paste-area" placeholder="從 Google Form 試算表全選複製後，貼在這裡…"></textarea>
        <div class="qnr-input-actions">
          <button class="archive-action-btn" id="qnrParsePasteBtn">解析貼上內容</button>
          <button class="archive-action-btn archive-action-btn--upload" id="qnrChooseFileBtn">選擇檔案（.xlsx/.csv/.txt）</button>
          <input type="file" id="qnrFileInput" accept=".xlsx,.xls,.csv,.txt" hidden>
          ${hasHeaders ? "<button class=\"archive-action-btn\" id=\"qnrDownloadRawCsvBtn\">下載原始資料（CSV）</button>" : ""}
          ${hasHeaders ? "<button class=\"archive-action-btn\" id=\"qnrDownloadRawXlsxBtn\">下載原始資料（Excel）</button>" : ""}
          ${hasHeaders ? "<button class=\"archive-action-btn archive-action-btn--danger\" id=\"qnrResetBtn\">清除重來</button>" : ""}
        </div>
      </div>
      ${hasHeaders ? `<div class="qnr-mapping-panel">
        <div class="qnr-mapping-head">
          <h3>欄位對應（已依關鍵字自動猜測，請確認或調整）</h3>
          <div class="qnr-scale-counts">${countsHtml}</div>
        </div>
        <div class="qnr-mapping-table-wrap">
          <table class="qnr-mapping-table"><thead><tr><th>表頭</th><th>對應角色</th></tr></thead><tbody>${mappingRows}</tbody></table>
        </div>
        <div class="qnr-input-actions">
          <button class="archive-action-btn is-active" id="qnrApplyMappingBtn">套用，產生分析</button>
        </div>
      </div>` : ""}
    </div>`;
  }

  _wireInputPanel() {
    const c = this._container;
    const parseBtn = c.querySelector("#qnrParsePasteBtn");
    if (parseBtn) parseBtn.addEventListener("click", () => {
      const text = c.querySelector("#qnrPasteArea")?.value || "";
      this._loadRows(parsePastedText(text), "貼上資料");
    });
    const chooseBtn = c.querySelector("#qnrChooseFileBtn");
    const fileInput = c.querySelector("#qnrFileInput");
    if (chooseBtn && fileInput) {
      chooseBtn.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => {
        if (fileInput.files?.[0]) this._importFile(fileInput.files[0]);
        fileInput.value = "";
      });
    }
    const resetBtn = c.querySelector("#qnrResetBtn");
    if (resetBtn) resetBtn.addEventListener("click", () => this._resetAll());
    const rawCsvBtn = c.querySelector("#qnrDownloadRawCsvBtn");
    if (rawCsvBtn) rawCsvBtn.addEventListener("click", () => this._downloadRawData("csv"));
    const rawXlsxBtn = c.querySelector("#qnrDownloadRawXlsxBtn");
    if (rawXlsxBtn) rawXlsxBtn.addEventListener("click", () => this._downloadRawData("xlsx"));
    c.querySelectorAll("[data-qnr-role-col]").forEach(sel => {
      sel.addEventListener("change", () => this._setRole(Number(sel.dataset.qnrRoleCol), sel.value));
    });
    const applyBtn = c.querySelector("#qnrApplyMappingBtn");
    if (applyBtn) applyBtn.addEventListener("click", () => this._applyMapping());
  }

  // ── 驗證提示橫幅 ───────────────────────────────────────────────────
  _renderValidationBanner(validation, unmatchedIds) {
    const issues = [];
    if (!validation.hasParticipantIdCol) issues.push("尚未指定 Participant ID 欄位，無法與受試者名冊比對。");
    if (validation.missingIdCount) issues.push(`有 ${validation.missingIdCount} 筆資料缺少 Participant ID。`);
    if (validation.duplicateIds.length) issues.push(`發現重複的 Participant ID：${validation.duplicateIds.join(", ")}。`);
    if (validation.missingValueCount) issues.push(`量表欄位共有 ${validation.missingValueCount} 個缺漏值（將排除在該題平均數之外）。`);
    if (validation.invalidValueCount) issues.push(`量表欄位共有 ${validation.invalidValueCount} 個非數值內容。`);
    if (unmatchedIds.length) issues.push(`有 ${unmatchedIds.length} 筆 Participant ID 在受試者名冊中查無資料：${unmatchedIds.slice(0, 10).join(", ")}${unmatchedIds.length > 10 ? " …" : ""}。`);
    SCALE_ORDER.forEach(scale => {
      const count = validation.scaleColumnCounts[scale];
      if (count !== SCALE_DEFS[scale].count) issues.push(`${SCALE_DEFS[scale].label} 目前選取 ${count} 題，與標準題數（${SCALE_DEFS[scale].count} 題）不同，統計仍會依實際選取的欄位計算。`);
    });
    if (!issues.length) return "";
    return `<div class="qnr-validation-banner">
      <strong>資料檢查提示</strong>
      <ul>${issues.map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
    </div>`;
  }

  // ── Dashboard ─────────────────────────────────────────────────────
  _renderDashboard() {
    const computed = this._computeAll();
    this._computed = computed;
    const { validation, statsBySale, susAvg, rating, matched, unmatchedIds } = computed;
    const chapter = this._state.chapter || "4";
    resetCopyRegistry();
    const figCounter = makeCounter(1);
    const tblCounter = makeCounter(1);

    const respondentCount = this._state.dataRows.length;
    const ssqOverall = mean(statsBySale.ssq.filter(s => s.mean != null).map(s => s.mean) || [0]);
    const nasaOverall = mean(statsBySale.nasa.filter(s => s.mean != null).map(s => s.mean) || [0]);
    const ueqOverall = mean(statsBySale.ueq.filter(s => s.mean != null).map(s => s.mean) || [0]);

    const summaryHtml = renderStatTiles([
      { label: "受試者數", value: respondentCount },
      { label: "SSQ 平均", value: fmt(ssqOverall) },
      { label: "NASA-TLX 平均", value: fmt(nasaOverall) },
      { label: "SUS 總分", value: `${fmt(susAvg)}${rating ? `（${rating.grade}）` : ""}` },
      { label: "UEQ 平均", value: fmt(ueqOverall) },
    ]);

    const susExtraTiles = renderStatTiles([
      { label: "SUS Score（0–100）", value: fmt(susAvg) },
      { label: "SUS Rating", value: rating ? `${rating.grade}（${rating.adjective}）` : "—" },
    ]);
    const susDescBase = describeItemStats("SUS", statsBySale.sus);
    const susDesc = describeSusExtra(susDescBase, susAvg, rating);

    const cardsHtml = [
      this._cards.ssq.renderHTML(statsBySale.ssq, { chapter, figCounter, tblCounter }),
      this._cards.nasa.renderHTML(statsBySale.nasa, { chapter, figCounter, tblCounter }),
      this._cards.sus.renderHTML(statsBySale.sus, { chapter, figCounter, tblCounter }, { descOverride: susDesc, extraBlockHtml: `<div class="qnr-block">${susExtraTiles}</div>` }),
      this._cards.ueq.renderHTML(statsBySale.ueq, { chapter, figCounter, tblCounter }),
    ].join("");

    const overallDesc = `本次共計 ${respondentCount} 位受試者完成問卷填答。SSQ 各題平均為 ${fmt(ssqOverall)}，NASA-TLX 各分量表平均為 ${fmt(nasaOverall)}，SUS 總平均分數為 ${fmt(susAvg)} 分${rating ? `（等級 ${rating.grade}，${rating.adjective}）` : ""}，UEQ 各題平均為 ${fmt(ueqOverall)}。以上數據為描述性統計彙整，實際研究解讀請由研究者依研究脈絡自行判斷。`;
    const overallHtml = `<div class="final-analysis-card qnr-card">
      <div class="final-analysis-card-titlebar"><div class="assist-mark-title-wrap"><div class="assist-mark-title">Overall Insights（整體摘要）</div></div></div>
      <div class="qnr-block">${renderCaptionDescBlock(`表${chapter}-${tblCounter.next()}　四項量表整體摘要`, overallDesc)}</div>
    </div>`;

    const matchedTableHtml = matched.length || unmatchedIds.length ? `<div class="qnr-roster-match">
      <h3>受試者名冊比對（依 Participant ID = trackingId）</h3>
      <p class="qnr-roster-match-summary">已比對 ${matched.length} 位、查無 ${unmatchedIds.length} 位。</p>
    </div>` : "";

    return `<div class="qnr-dashboard-content">
      ${this._renderValidationBanner(validation, unmatchedIds)}
      <div class="qnr-summary-block"><h2 class="qnr-section-title">Summary</h2>${summaryHtml}</div>
      ${matchedTableHtml}
      <div class="qnr-scale-cards">${cardsHtml}${overallHtml}</div>
    </div>`;
  }

  _wireDashboard() {
    const c = this._container;
    this._cards.ssq.wire(c, () => this._render());
    this._cards.nasa.wire(c, () => this._render());
    this._cards.sus.wire(c, () => this._render());
    this._cards.ueq.wire(c, () => this._render());
    wireCaptionCopyButtons(c);
    wireChartExports(c);
  }

  _exportHtml() {
    const content = this._container.querySelector(".qnr-dashboard-content");
    if (!content) return;
    const html = `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"><title>問卷分析報告</title><style>${EXPORT_CSS}</style></head><body><h1>問卷分析報告</h1>${content.outerHTML}</body></html>`;
    downloadTextFile(html, `questionnaire_analysis_${nowStamp()}.html`, "text/html;charset=utf-8");
  }

  _exportMarkdown() {
    if (!this._computed) return;
    const chapter = this._state.chapter || "4";
    const { statsBySale, susAvg, rating } = this._computed;
    const lines = ["# 問卷分析報告", ""];
    const tableMd = stats => {
      const rows = ["| 題項 | 填答人數 | 平均數 | 標準差 |", "|---|---|---|---|",
        ...stats.map(s => `| ${s.label.replace(/\|/g, "/")} | ${s.n} | ${fmt(s.mean)} | ${fmt(s.sd)} |`)];
      return rows.join("\n");
    };
    SCALE_ORDER.forEach(scale => {
      lines.push(`## ${SCALE_DEFS[scale].fullName}`, "", tableMd(statsBySale[scale]), "",
        describeItemStats(SCALE_DEFS[scale].label, statsBySale[scale]), "");
    });
    lines.push("## SUS Score / Rating", "", `SUS 總平均分數：${fmt(susAvg)} 分（滿分 100）；等級：${rating ? `${rating.grade}（${rating.adjective}）` : "—"}`, "");
    lines.push("> 圖表請使用頁面上各圖表的「下載 PNG／SVG」按鈕另外匯出後插入論文。", "");
    downloadTextFile(lines.join("\n"), `questionnaire_analysis_${nowStamp()}.md`, "text/markdown;charset=utf-8");
    void chapter;
  }

  _render() {
    if (!this._container) return;
    const isDashboard = this._state.stage === "dashboard" && this._state.dataRows.length;

    const topActions = isDashboard ? `<div class="assist-mark-actions-group">
        ${renderActionsCollapseBtn("data-qnr-toggle-actions", this._actionsCollapsed)}
        <div class="assist-mark-actions${this._actionsCollapsed ? " is-collapsed" : ""}">
          <label class="qnr-chapter-input">章節編號
            <input type="text" id="qnrChapterInput" value="${escapeHtml(this._state.chapter || "4")}" style="width:36px">
          </label>
          <button class="archive-action-btn" id="qnrBackToInputBtn">重新輸入資料</button>
          <button class="archive-action-btn" id="qnrDownloadRawCsvBtn2">下載原始資料（CSV）</button>
          <button class="archive-action-btn" id="qnrDownloadRawXlsxBtn2">下載原始資料（Excel）</button>
          <button class="archive-action-btn" id="qnrExportHtmlBtn">匯出 HTML</button>
          <button class="archive-action-btn" id="qnrExportMdBtn">匯出 Markdown</button>
          <button class="archive-action-btn" id="qnrPrintBtn">列印／另存 PDF</button>
        </div>
      </div>` : "";

    this._container.innerHTML = `<div class="final-analysis-shell qnr-shell">
      <div class="final-analysis-topbar">
        <div class="assist-mark-title-wrap">
          <div class="assist-mark-title">問卷分析</div>
          <div class="assist-mark-subtitle">${isDashboard ? "SSQ／NASA-TLX／SUS／UEQ 描述統計與圖表，內容皆可直接複製或匯出" : "貼上或匯入 Google Form 原始回應，確認欄位對應後產生分析"}</div>
        </div>
        ${topActions}
      </div>
      ${isDashboard ? this._renderDashboard() : this._renderInputPanel()}
    </div>`;

    if (isDashboard) {
      const toggleActionsBtn = this._container.querySelector("[data-qnr-toggle-actions]");
      if (toggleActionsBtn) toggleActionsBtn.addEventListener("click", () => {
        this._actionsCollapsed = !this._actionsCollapsed;
        saveCollapsedPref(ACTIONS_COLLAPSED_KEY, this._actionsCollapsed);
        this._render();
      });
      const chapterInput = this._container.querySelector("#qnrChapterInput");
      if (chapterInput) chapterInput.addEventListener("change", () => {
        this._state.chapter = chapterInput.value.trim() || "4";
        this._saveDraft();
        this._render();
      });
      const backBtn = this._container.querySelector("#qnrBackToInputBtn");
      if (backBtn) backBtn.addEventListener("click", () => this._backToInput());
      const rawCsvBtn2 = this._container.querySelector("#qnrDownloadRawCsvBtn2");
      if (rawCsvBtn2) rawCsvBtn2.addEventListener("click", () => this._downloadRawData("csv"));
      const rawXlsxBtn2 = this._container.querySelector("#qnrDownloadRawXlsxBtn2");
      if (rawXlsxBtn2) rawXlsxBtn2.addEventListener("click", () => this._downloadRawData("xlsx"));
      const htmlBtn = this._container.querySelector("#qnrExportHtmlBtn");
      if (htmlBtn) htmlBtn.addEventListener("click", () => this._exportHtml());
      const mdBtn = this._container.querySelector("#qnrExportMdBtn");
      if (mdBtn) mdBtn.addEventListener("click", () => this._exportMarkdown());
      const printBtn = this._container.querySelector("#qnrPrintBtn");
      if (printBtn) printBtn.addEventListener("click", () => window.print());
      this._wireDashboard();
    } else {
      this._wireInputPanel();
    }
  }
}

const _manager = new QuestionnaireManager();

export function onQuestionnaireActivate() {
  const el = document.getElementById("archiveQuestionnaire");
  if (!el) return;
  _manager.init(el);
}
