/**
 * archive-final-analysis-cards.js — 最終分析頁的三張分析卡片。
 * 每張卡片各自獨立：Data Source（複選資料集）→ Filter（受試者／指令）→ Analysis → Statistics →
 * Visualization（表格／長條圖／圓餅圖／箱型圖，各自獨立設定）→ Output（CSV／PNG／SVG）。
 * 卡片之間互不影響；之後要加新的分析只需再寫一個 class，不必動這三張既有的。
 */
import { getApiUrl } from "../core/url-utils.js";
import { getAdminToken, clearAdminToken } from "../core/admin-auth.js";
import { API_ENDPOINTS } from "../constants/index.js";
import { escapeHtml, parseJsonResponse } from "./archive-constants.js";
import { getParticipantNameMap, getParticipantInfoMap } from "./archive-roster.js";
import { parseClockMs } from "./archive-assist-mark.js";
import {
  mean, median, descriptiveStats, boxPlotStats, computeAgreement, discoverAgreementKeys,
  errorRateCounts, groupByCommand, countAboveThreshold, chiSquareTest, fisherExactTest2x2, fisherExactSuitability,
  pairedTTest, wilcoxonSignedRank, oneWayRepeatedMeasuresAnova, independentTTest, mannWhitneyU, sortByCommandOrder,
} from "./archive-final-analysis-stats.js";
import { ChartSettings, DataTableView, renderBarChart, renderPieChart, renderBoxPlot, wireChartExports } from "./archive-final-analysis-viz.js";
import {
  renderDatasetPicker, wireDatasetPicker, renderFilterPanel, wireFilterPanel, filterAttempts,
  discoverParticipants, discoverCommands, discoverGenders, getGestureOrderMap,
} from "./archive-final-analysis-datasource.js";

// ── 卡片外殼共用的小元件 ────────────────────────────────────────────────
function renderCollapseToggle(collapsed) {
  const arrow = collapsed
    ? "<polyline points=\"9 18 15 12 9 6\"></polyline>"
    : "<polyline points=\"6 9 12 15 18 9\"></polyline>";
  return `<button type="button" class="archive-action-btn archive-action-btn--sm" data-card-collapse-toggle aria-label="${collapsed ? "展開" : "收合"}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${arrow}</svg>${collapsed ? "展開" : "收合"}</button>`;
}

function suitabilityBadge(result) {
  if (!result) return "";
  return result.suitable
    ? `<span class="final-analysis-suitability is-ok">✓ 適用${result.reason ? `：${escapeHtml(result.reason)}` : ""}</span>`
    : `<span class="final-analysis-suitability is-warn">⚠ 不建議：${escapeHtml(result.reason || "")}</span>`;
}

function renderStatTiles(items) {
  return `<div class="final-analysis-stat-tiles">${items.map(it => `
    <div class="final-analysis-stat-tile">
      <div class="final-analysis-stat-tile-label">${escapeHtml(it.label)}</div>
      <div class="final-analysis-stat-tile-value">${it.value}</div>
    </div>`).join("")}</div>`;
}

function pFmt(p) { return p == null ? "—" : p < 0.001 ? "< .001" : p.toFixed(3); }

function perParticipantMeanMs(attempts) {
  const byId = new Map();
  for (const a of attempts) {
    const ms = parseClockMs(a.duration);
    if (ms == null) continue;
    if (!byId.has(a.trackingId)) byId.set(a.trackingId, []);
    byId.get(a.trackingId).push(ms);
  }
  const result = new Map();
  for (const [id, vals] of byId) result.set(id, mean(vals));
  return result;
}

function pairwiseCombos(items) {
  const combos = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) combos.push([items[i], items[j]]);
  return combos;
}

// ── 共用卡片外殼：資料載入、Data Source／Filter、標題／收合／移除 ─────────
class BaseAnalysisCard {
  constructor(defaultTitle, subtitle) {
    this._container = null;
    this._records = null;
    this._loading = false;
    this._error = null;
    this._selectedStages = new Set();
    this._selectedParticipants = new Set();
    this._selectedCommands = new Set();
    this._selectedGenders = new Set();
    this._gestureOrder = new Map();
    this._view = this._defaultView();
    this._chartSettings = new ChartSettings();
    this._table = new DataTableView();
    this._title = defaultTitle;
    this._subtitle = subtitle;
    this._collapsed = false;
  }

  init(container) {
    this._container = container;
    if (this._records == null && !this._loading) { this._load(); return; }
    this._render();
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

  async _load() {
    this._loading = true;
    this._error = null;
    this._render();
    try {
      const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.ANALYSIS.LIST}`);
      const data = await parseJsonResponse(res);
      if (!data.success) throw new Error(data.error || "未知錯誤");
      const nameMap = await getParticipantNameMap();
      const infoMap = await getParticipantInfoMap();
      this._gestureOrder = await getGestureOrderMap();
      this._records = (data.records || []).filter(r => r.attempts?.length)
        .map(r => ({ ...r, participantName: nameMap.get(r.trackingId) || "", participantGender: infoMap.get(r.trackingId)?.gender || "" }));
      if (!this._selectedStages.size) {
        for (const r of this._records) this._selectedStages.add(r.stage);
      }
      this._onLoaded?.();
    } catch (err) {
      this._error = err.message || String(err);
      this._records = [];
    }
    this._loading = false;
    this._render();
  }

  _refresh() { this._loading = true; this._records = null; this._render(); this._load(); }
  _setTitle(title) { this._title = title.trim() || this._title; this._render(); }
  _toggleStage(stage, checked) { checked ? this._selectedStages.add(stage) : this._selectedStages.delete(stage); this._render(); }
  _toggleParticipant(id, checked) { checked ? this._selectedParticipants.add(id) : this._selectedParticipants.delete(id); this._render(); }
  _toggleCommand(cmd, checked) { checked ? this._selectedCommands.add(cmd) : this._selectedCommands.delete(cmd); this._render(); }
  _toggleGender(gender, checked) { checked ? this._selectedGenders.add(gender) : this._selectedGenders.delete(gender); this._render(); }
  _setView(view) { this._view = view; this._render(); }

  // 「全選」按鈕：只針對目前資料來源（已勾選的 stage）內實際出現的受試者／指令清單做全選或清除全選，
  // 不會選到跟目前資料來源無關的舊選取項目——這樣切換全選狀態時結果才可預期。
  _toggleAllParticipants(stageRecords) {
    const ids = discoverParticipants(stageRecords).map(([id]) => id);
    const allSelected = ids.length > 0 && ids.every(id => this._selectedParticipants.has(id));
    this._selectedParticipants.clear();
    if (!allSelected) for (const id of ids) this._selectedParticipants.add(id);
    this._render();
  }

  _toggleAllCommands(stageRecords) {
    const cmds = discoverCommands(stageRecords, this._gestureOrder);
    const allSelected = cmds.length > 0 && cmds.every(cmd => this._selectedCommands.has(cmd));
    this._selectedCommands.clear();
    if (!allSelected) for (const cmd of cmds) this._selectedCommands.add(cmd);
    this._render();
  }

  _toggleAllGenders(stageRecords) {
    const genders = discoverGenders(stageRecords);
    const allSelected = genders.length > 0 && genders.every(g => this._selectedGenders.has(g));
    this._selectedGenders.clear();
    if (!allSelected) for (const g of genders) this._selectedGenders.add(g);
    this._render();
  }

  _groups() {
    if (!this._records) return [];
    return filterAttempts(this._records, {
      stages: this._selectedStages,
      participantIds: this._selectedParticipants,
      commands: this._selectedCommands,
      genders: this._selectedGenders,
    });
  }

  _filenameBase() {
    return this._title.replace(/[\\/:*?"<>|]+/g, "_").trim() || "final_analysis";
  }

  // ── 子類別覆寫這幾個 ──
  _defaultView() { return "table"; }
  _renderAnalysisBody(_groups) { return "<p>未實作</p>"; }
  _wireAnalysisBody(_container, _groups) { /* no-op by default */ }

  // 資料來源／篩選勾選框、右側統計結果都可能各自捲動，但整張卡片每次都是整包 innerHTML 重繪，
  // 不記錄就會在勾選任何一項之後把這些小清單的捲動位置打回最頂部。
  _scrollPreserveSelector() {
    return ".final-analysis-card-scope, .final-analysis-scope-items--scroll, .final-analysis-card-content";
  }

  _render() {
    if (!this._container) return;
    const scrollTops = Array.from(this._container.querySelectorAll(this._scrollPreserveSelector())).map(el => el.scrollTop);
    // 受試者／指令篩選清單只看目前資料來源（已勾選的 stage）裡實際出現的資料，
    // 不然切換 stage 之後，清單還是列出跟目前資料來源無關的人或指令。
    const stageRecords = (this._records || []).filter(r => this._selectedStages.has(r.stage));
    const scopeHtml = this._loading
      ? "<div class=\"assist-mark-empty\"><h3>載入中…</h3></div>"
      : this._error
        ? `<div class="assist-mark-empty"><h3>載入失敗</h3><p>${escapeHtml(this._error)}</p></div>`
        : renderDatasetPicker(this._records, this._selectedStages) + renderFilterPanel(stageRecords, this._selectedParticipants, this._selectedCommands, this._selectedGenders, this._gestureOrder);

    const groups = (!this._loading && !this._error) ? this._groups() : [];
    const analysisHtml = (!this._loading && !this._error)
      ? this._renderAnalysisBody(groups)
      : "";

    const collapsed = this._collapsed;
    const bodyHtml = collapsed ? "" : `
      <div class="final-analysis-card-body">
        <div class="final-analysis-card-scope">${scopeHtml}</div>
        <div class="final-analysis-card-stats">${analysisHtml}</div>
      </div>`;

    this._container.innerHTML = `<div class="final-analysis-card">
      <div class="final-analysis-card-titlebar">
        <div class="assist-mark-title-wrap">
          <input class="final-analysis-card-title-input" data-card-title value="${escapeHtml(this._title)}" placeholder="圖表標題（會一併畫進匯出的圖片）">
          <div class="assist-mark-subtitle">${escapeHtml(this._subtitle)}</div>
        </div>
        <div class="final-analysis-card-titlebar-actions">
          ${renderCollapseToggle(collapsed)}
          <button class="archive-action-btn archive-action-btn--sm" data-card-refresh ${this._loading ? "disabled" : ""}>重新整理</button>
        </div>
      </div>
      ${bodyHtml}
    </div>`;

    this._wireCommon(groups, stageRecords);
    this._container.querySelectorAll(this._scrollPreserveSelector()).forEach((el, i) => {
      if (scrollTops[i] != null) el.scrollTop = scrollTops[i];
    });
  }

  _wireCommon(groups, stageRecords) {
    const c = this._container;
    const titleInput = c.querySelector("[data-card-title]");
    if (titleInput) titleInput.addEventListener("change", () => this._setTitle(titleInput.value));
    const collapseBtn = c.querySelector("[data-card-collapse-toggle]");
    if (collapseBtn) collapseBtn.addEventListener("click", () => { this._collapsed = !this._collapsed; this._render(); });
    const refreshBtn = c.querySelector("[data-card-refresh]");
    if (refreshBtn) refreshBtn.addEventListener("click", () => this._refresh());
    if (this._collapsed || this._loading || this._error) return;
    wireDatasetPicker(c, (stage, checked) => this._toggleStage(stage, checked));
    wireFilterPanel(c,
      (id, checked) => this._toggleParticipant(id, checked),
      (cmd, checked) => this._toggleCommand(cmd, checked),
      (gender, checked) => this._toggleGender(gender, checked),
      () => this._toggleAllParticipants(stageRecords),
      () => this._toggleAllCommands(stageRecords),
      () => this._toggleAllGenders(stageRecords),
    );
    this._wireAnalysisBody(c, groups);
    wireChartExports(c);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 1. Gesture Agreement — Wobbrock et al. (2005) 同意率
// ══════════════════════════════════════════════════════════════════════
export class GestureAgreementCard extends BaseAnalysisCard {
  constructor() {
    super("手勢同意率 Gesture Agreement", "依手勢指令分組計算同意率 A_r = Σ(n_i/N)²，可自選要比對的原始資料欄位");
    this._key = null;
    this._genderTable = new DataTableView("agreement-by-gender");
  }

  _defaultView() { return "table"; }

  _onLoaded() {
    if (this._key) return;
    const allAttempts = this._records.flatMap(r => r.attempts || []);
    const keys = discoverAgreementKeys(allAttempts);
    this._key = keys.includes("type") ? "type" : (keys[0] || null);
  }

  _renderAnalysisBody(groups) {
    const pooled = groups.flatMap(g => g.attempts);
    const allAttempts = (this._records || []).flatMap(r => r.attempts || []);
    const availableKeys = discoverAgreementKeys(allAttempts);
    const keyOptions = availableKeys.length
      ? availableKeys.map(k => `<option value="${escapeHtml(k)}" ${this._key === k ? "selected" : ""}>${escapeHtml(k)}</option>`).join("")
      : "<option value=\"\">（無可用欄位）</option>";

    if (!pooled.length || !this._key) {
      return `<div class="final-analysis-card-controls">
        <label class="final-analysis-key-label">分析 Key（原始資料欄位，自動偵測）
          <select class="final-analysis-key-select" data-agreement-key>${keyOptions}</select>
        </label>
      </div>
      <div class="assist-mark-empty"><p>目前沒有可分析的資料，請確認左側「資料來源」／「篩選」已勾選至少一項有資料的範圍。</p></div>`;
    }

    const rows = computeAgreement(pooled, this._key, this._gestureOrder).filter(r => r.n > 0);
    const avgAr = rows.length ? mean(rows.map(r => r.ar)) : null;
    const highest = rows.reduce((best, r) => (!best || r.ar > best.ar) ? r : best, null);
    const tiles = renderStatTiles([
      { label: "平均同意率 Agreement Rate", value: avgAr != null ? avgAr.toFixed(3) : "—" },
      { label: "Highest Agreement", value: highest ? `${escapeHtml(highest.command)}（${highest.ar.toFixed(3)}）` : "—" },
      { label: "Gesture Category Count", value: String(rows.length) },
    ]);

    const pieAvailable = this._selectedCommands.size === 1;
    const view = (this._view === "pie" && !pieAvailable) ? "table" : this._view;
    const viewButtons = `<div class="final-analysis-btn-group">
      <button class="archive-action-btn${view === "table" ? " is-active" : ""}" data-view-btn="table">表格</button>
      <button class="archive-action-btn${view === "bar" ? " is-active" : ""}" data-view-btn="bar">長條圖</button>
      <button class="archive-action-btn${view === "pie" ? " is-active" : ""}" data-view-btn="pie" ${pieAvailable ? "" : "disabled title=\"只選 1 個指令時才可用\""}>圓餅圖</button>
    </div>`;

    let content;
    if (view === "bar") {
      content = renderBarChart({
        categories: rows.map(r => r.command),
        series: [{ label: "", rowsByCategory: rows }],
        getValue: r => r.ar,
        defaultTitle: this._title,
        defaultYLabel: "同意率 A_r",
        defaultXLabel: "手勢指令",
        formatTick: v => v.toFixed(1),
        ariaLabel: "同意率長條圖",
        settings: this._chartSettings,
        filenameBase: this._filenameBase(),
      });
    } else if (view === "pie") {
      const command = [...this._selectedCommands][0];
      const commandRow = rows.find(r => r.command === command);
      content = renderPieChart({
        rows: (commandRow?.groups || []).map(g => ({ label: g.value, count: g.count })),
        getValue: r => r.count,
        defaultTitle: this._title || `手勢分布：${command}`,
        settings: this._chartSettings,
        filenameBase: this._filenameBase(),
        ariaLabel: "手勢分布圓餅圖",
      });
    } else {
      this._table.setData(["手勢指令", "同意率 A_r", "樣本數 N", "最大宗類別（佔比）"], rows.map(r => [
        r.command, r.ar.toFixed(3), r.n, r.groups[0] ? `${r.groups[0].value}（${Math.round(r.groups[0].pct * 100)}%）` : "—",
      ]));
      content = this._table.render(this._filenameBase());
    }

    const settingsHtml = view !== "table" ? `<div class="final-analysis-chart-settings-wrap">${this._chartSettings.renderPanel()}</div>` : "";

    // 「（未知指令）」代表這幾筆原始資料沒有手勢指令欄位，容易讓人誤以為統計算錯，
    // 這裡直接列出來源受試者（trackingId），方便回頭找是哪筆資料漏了指令。
    const unknownRow = rows.find(r => r.command === "（未知指令）");
    const unknownHint = unknownRow ? `<div class="match-mark-hidden-hint">
      「（未知指令）」共 ${unknownRow.n} 筆缺少手勢指令欄位，來源受試者：${
        unknownRow.sources.map(s => escapeHtml(s.trackingId + (s.participantName ? ` ${s.participantName}` : ""))).join("、")
      }</div>` : "";

    return `<div class="final-analysis-card-controls">
      <label class="final-analysis-key-label">分析 Key（原始資料欄位，自動偵測）
        <select class="final-analysis-key-select" data-agreement-key>${keyOptions}</select>
      </label>
      ${viewButtons}
    </div>
    ${tiles}
    ${unknownHint}
    ${settingsHtml}
    <div class="final-analysis-card-content">${content}</div>
    ${this._renderByGender(pooled)}`;
  }

  // 「個別（依性別）」：把目前已勾選範圍的資料，依受試者性別拆開各自算一次同意率，
  // 並針對兩性別都有資料的手勢指令，用卡方檢定比較「同一手勢指令下，兩性別選擇的分析 Key 分布」是否有差異。
  // 樣本數小的組別卡方檢定可能不準確，這裡沿用既有 chiSquareTest 的 suitable 判斷來標示。
  _renderByGender(pooled) {
    const genders = Array.from(new Set(pooled.map(a => a.participantGender).filter(Boolean))).sort((a, b) => a.localeCompare(b, "zh-Hant"));
    if (!genders.length || !this._key) return "";

    const tableRows = [];
    for (const gender of genders) {
      const subset = pooled.filter(a => a.participantGender === gender);
      const rows = computeAgreement(subset, this._key, this._gestureOrder).filter(r => r.n > 0);
      for (const r of rows) {
        tableRows.push([gender, r.command, r.ar.toFixed(3), r.n, r.groups[0] ? `${r.groups[0].value}（${Math.round(r.groups[0].pct * 100)}%）` : "—"]);
      }
    }
    this._genderTable.setData(["性別", "手勢指令", "同意率 A_r", "樣本數 N", "最大宗類別（佔比）"], tableRows);

    let testHtml = "<p class=\"final-analysis-missing-note\">需同時有 2 個性別的資料才會顯示分布差異的卡方檢定。</p>";
    if (genders.length === 2) {
      const [gA, gB] = genders;
      const commands = sortByCommandOrder(Array.from(new Set(pooled.map(a => a.gestureCommand))), this._gestureOrder, cmd => cmd);
      const testRows = [];
      for (const cmd of commands) {
        const cmdAttempts = pooled.filter(a => a.gestureCommand === cmd);
        const attemptsA = cmdAttempts.filter(a => a.participantGender === gA);
        const attemptsB = cmdAttempts.filter(a => a.participantGender === gB);
        if (!attemptsA.length || !attemptsB.length) continue;
        const values = Array.from(new Set(cmdAttempts.map(a => String(a[this._key] ?? "").trim()).filter(Boolean)));
        if (values.length < 2) continue;
        const table = [
          values.map(v => attemptsA.filter(a => String(a[this._key] ?? "").trim() === v).length),
          values.map(v => attemptsB.filter(a => String(a[this._key] ?? "").trim() === v).length),
        ];
        const chi2 = chiSquareTest(table);
        testRows.push([cmd, chi2.chi2 != null ? chi2.chi2.toFixed(3) : "—", chi2.df, pFmt(chi2.p), chi2.suitable ? "✓" : "⚠"]);
      }
      testHtml = testRows.length
        ? `<div class="final-analysis-table-wrap"><table class="final-analysis-table">
            <thead><tr><th>手勢指令</th><th>χ²</th><th>df</th><th>p</th><th>期望次數適用性</th></tr></thead>
            <tbody>${testRows.map(r => `<tr>${r.map(c => `<td>${escapeHtml(String(c))}</td>`).join("")}</tr>`).join("")}</tbody>
          </table></div>
          <p class="final-analysis-agreement-summary">比較「同一手勢指令下，${escapeHtml(gA)} vs ${escapeHtml(gB)} 選擇的 ${escapeHtml(this._key)} 分布」是否有差異；期望次數適用性標「⚠」代表部分期望次數 &lt; 5，結果僅供參考。</p>`
        : "<p class=\"final-analysis-missing-note\">目前沒有兩性別都有資料的手勢指令可供檢定。</p>";
    }

    return `<div class="final-analysis-series-block">
      <div class="final-analysis-series-label">個別（依性別）By Gender</div>
      <div class="final-analysis-card-content">${this._genderTable.render(`${this._filenameBase()}_by_gender`)}</div>
      ${testHtml}
    </div>`;
  }

  _wireAnalysisBody(container) {
    const keySelect = container.querySelector("[data-agreement-key]");
    if (keySelect) keySelect.addEventListener("change", () => { this._key = keySelect.value || null; this._render(); });
    container.querySelectorAll("[data-view-btn]").forEach(btn => {
      btn.addEventListener("click", () => this._setView(btn.dataset.viewBtn));
    });
    if (this._view === "table") this._table.wire(container, () => this._render());
    this._chartSettings.wire(container, () => this._render());
    this._genderTable.wire(container, () => this._render());
  }
}

// ══════════════════════════════════════════════════════════════════════
// 2. Error Rate Comparison — 資料集之間的正確／錯誤比例比較
// ══════════════════════════════════════════════════════════════════════
export class ErrorRateComparisonCard extends BaseAnalysisCard {
  constructor() {
    super("錯誤率比較 Error Rate Comparison", "各資料集的正確／錯誤次數與錯誤率，並列卡方檢定與 Fisher's Exact Test（自行選擇要執行哪一個）");
    this._ranTests = new Set();
    this._chartSettings = new ChartSettings("overall");
    this._cmdView = "table";
    this._cmdChartSettings = new ChartSettings("by-command");
    this._cmdTable = new DataTableView("error-rate-by-command");
    this._genderRanTests = new Set();
    this._genderTable = new DataTableView("error-rate-by-gender");
  }

  _defaultView() { return "table"; }

  _renderAnalysisBody(groups) {
    if (!groups.length) {
      return "<div class=\"assist-mark-empty\"><p>請先在左側「資料來源」勾選至少一個資料集。</p></div>";
    }
    const counts = groups.map(g => errorRateCounts(g.attempts));
    const table = counts.map(c => [c.correct, c.wrong]);

    const view = this._view;
    const viewButtons = `<div class="final-analysis-btn-group">
      <button class="archive-action-btn${view === "table" ? " is-active" : ""}" data-view-btn="table">表格</button>
      <button class="archive-action-btn${view === "bar" ? " is-active" : ""}" data-view-btn="bar">長條圖</button>
    </div>`;

    let content;
    if (view === "bar") {
      content = renderBarChart({
        categories: groups.map(g => g.label),
        series: [{ label: "", rowsByCategory: counts }],
        getValue: r => r.errorRate != null ? r.errorRate * 100 : 0,
        defaultTitle: this._title,
        defaultYLabel: "錯誤率（%）",
        defaultXLabel: "資料集",
        formatTick: v => `${v.toFixed(0)}%`,
        ariaLabel: "錯誤率長條圖",
        settings: this._chartSettings,
        filenameBase: this._filenameBase(),
      });
    } else {
      this._table.setData(["資料集", "Correct", "Wrong", "Error Rate"], groups.map((g, i) => [
        g.label, counts[i].correct, counts[i].wrong, counts[i].errorRate != null ? `${(counts[i].errorRate * 100).toFixed(1)}%` : "—",
      ]));
      content = this._table.render(this._filenameBase());
    }
    const settingsHtml = view !== "table" ? `<div class="final-analysis-chart-settings-wrap">${this._chartSettings.renderPanel()}</div>` : "";

    const chi2 = groups.length >= 2 ? chiSquareTest(table) : null;
    const fisherStatus = fisherExactSuitability(groups.length);
    const fisher = (groups.length === 2 && fisherStatus.suitable) ? fisherExactTest2x2(table[0][0], table[0][1], table[1][0], table[1][1]) : null;

    const chi2Result = this._ranTests.has("chi2")
      ? (chi2?.chi2 != null ? `χ² = ${chi2.chi2.toFixed(3)}，df = ${chi2.df}，p = ${pFmt(chi2.p)}` : "資料不足")
      : "－ 尚未執行 －";
    const fisherResult = this._ranTests.has("fisher")
      ? (fisher ? `p = ${pFmt(fisher.p)}` : (fisherStatus.suitable ? "資料不足" : "不適用"))
      : "－ 尚未執行 －";

    const testsHtml = `<div class="final-analysis-test-panel">
      <div class="final-analysis-test-row">
        <div class="final-analysis-test-row-head">
          <span class="final-analysis-test-name">Chi-square Test</span>
          ${suitabilityBadge(chi2 ? { suitable: chi2.suitable, reason: chi2.reason } : { suitable: false, reason: "至少需要 2 個資料集" })}
          <button type="button" class="archive-action-btn archive-action-btn--sm" data-run-test="chi2" ${chi2 ? "" : "disabled"}>執行</button>
        </div>
        <div class="final-analysis-test-result">${chi2Result}</div>
      </div>
      <div class="final-analysis-test-row">
        <div class="final-analysis-test-row-head">
          <span class="final-analysis-test-name">Fisher's Exact Test</span>
          ${suitabilityBadge(fisherStatus)}
          <button type="button" class="archive-action-btn archive-action-btn--sm" data-run-test="fisher" ${fisher ? "" : "disabled"}>執行</button>
        </div>
        <div class="final-analysis-test-result">${fisherResult}</div>
      </div>
    </div>`;

    const overallHtml = `<div class="final-analysis-series-block">
      <div class="final-analysis-series-label">總覽 Overall</div>
      <div class="final-analysis-card-controls">${viewButtons}</div>
      ${testsHtml}
      ${settingsHtml}
      <div class="final-analysis-card-content">${content}</div>
    </div>`;

    return `${overallHtml}${this._renderByCommand(groups)}${this._renderByGender(groups)}`;
  }

  // 「個別（依性別）」：把目前已勾選的資料集全部匯集起來，改依受試者性別拆開列出正確／錯誤次數與錯誤率，
  // 跟「個別（依指令）」互不影響——這裡的分組維度是性別，不再細分資料集或指令。
  _renderByGender(groups) {
    const pooled = groups.flatMap(g => g.attempts);
    const genders = Array.from(new Set(pooled.map(a => a.participantGender).filter(Boolean))).sort((a, b) => a.localeCompare(b, "zh-Hant"));
    if (!genders.length) return "";

    const counts = genders.map(g => errorRateCounts(pooled.filter(a => a.participantGender === g)));
    const table = counts.map(c => [c.correct, c.wrong]);
    this._genderTable.setData(["性別", "Correct", "Wrong", "Error Rate"], genders.map((g, i) => [
      g, counts[i].correct, counts[i].wrong, counts[i].errorRate != null ? `${(counts[i].errorRate * 100).toFixed(1)}%` : "—",
    ]));

    const chi2 = genders.length >= 2 ? chiSquareTest(table) : null;
    const fisherStatus = fisherExactSuitability(genders.length);
    const fisher = (genders.length === 2 && fisherStatus.suitable) ? fisherExactTest2x2(table[0][0], table[0][1], table[1][0], table[1][1]) : null;

    const chi2Result = this._genderRanTests.has("chi2")
      ? (chi2?.chi2 != null ? `χ² = ${chi2.chi2.toFixed(3)}，df = ${chi2.df}，p = ${pFmt(chi2.p)}` : "資料不足")
      : "－ 尚未執行 －";
    const fisherResult = this._genderRanTests.has("fisher")
      ? (fisher ? `p = ${pFmt(fisher.p)}` : (fisherStatus.suitable ? "資料不足" : "不適用"))
      : "－ 尚未執行 －";

    const testsHtml = `<div class="final-analysis-test-panel">
      <div class="final-analysis-test-row">
        <div class="final-analysis-test-row-head">
          <span class="final-analysis-test-name">Chi-square Test</span>
          ${suitabilityBadge(chi2 ? { suitable: chi2.suitable, reason: chi2.reason } : { suitable: false, reason: "至少需要 2 個性別" })}
          <button type="button" class="archive-action-btn archive-action-btn--sm" data-run-gender-test="chi2" ${chi2 ? "" : "disabled"}>執行</button>
        </div>
        <div class="final-analysis-test-result">${chi2Result}</div>
      </div>
      <div class="final-analysis-test-row">
        <div class="final-analysis-test-row-head">
          <span class="final-analysis-test-name">Fisher's Exact Test</span>
          ${suitabilityBadge(fisherStatus)}
          <button type="button" class="archive-action-btn archive-action-btn--sm" data-run-gender-test="fisher" ${fisher ? "" : "disabled"}>執行</button>
        </div>
        <div class="final-analysis-test-result">${fisherResult}</div>
      </div>
    </div>`;

    return `<div class="final-analysis-series-block">
      <div class="final-analysis-series-label">個別（依性別）By Gender</div>
      ${testsHtml}
      <div class="final-analysis-card-content">${this._genderTable.render(`${this._filenameBase()}_by_gender`)}</div>
    </div>`;
  }

  // 「個別（依指令）」：把目前已勾選的資料集，再依手勢指令拆開列出正確／錯誤次數與錯誤率，
  // 用來看是不是某幾個指令特別容易出錯，而不只是資料集整體的錯誤率。
  _renderByCommand(groups) {
    const allCommands = sortByCommandOrder(
      Array.from(new Set(groups.flatMap(g => g.attempts.map(a => a.gestureCommand || "（未知指令）")))),
      this._gestureOrder, cmd => cmd,
    );
    if (!allCommands.length) return "";

    const perGroup = groups.map(g => ({
      group: g,
      byCommand: new Map(groupByCommand(g.attempts, this._gestureOrder).map(({ command, attempts }) => [command, errorRateCounts(attempts)])),
    }));

    const view = this._cmdView;
    const viewButtons = `<div class="final-analysis-btn-group">
      <button class="archive-action-btn${view === "table" ? " is-active" : ""}" data-cmd-view-btn="table">表格</button>
      <button class="archive-action-btn${view === "bar" ? " is-active" : ""}" data-cmd-view-btn="bar">長條圖</button>
    </div>`;

    let content;
    if (view === "bar") {
      content = renderBarChart({
        categories: allCommands,
        series: perGroup.map(({ group, byCommand }) => ({
          label: group.label,
          rowsByCategory: allCommands.map(cmd => byCommand.get(cmd) || { correct: 0, wrong: 0, total: 0, errorRate: null }),
        })),
        getValue: r => r.errorRate != null ? r.errorRate * 100 : 0,
        defaultTitle: `${this._title}（依指令）`,
        defaultYLabel: "錯誤率（%）",
        defaultXLabel: "手勢指令",
        formatTick: v => `${v.toFixed(0)}%`,
        ariaLabel: "依指令錯誤率長條圖",
        settings: this._cmdChartSettings,
        filenameBase: `${this._filenameBase()}_by_command`,
      });
    } else {
      const rows = [];
      for (const { group, byCommand } of perGroup) {
        for (const cmd of allCommands) {
          const c = byCommand.get(cmd);
          if (!c || !c.total) continue;
          rows.push([group.label, cmd, c.correct, c.wrong, c.errorRate != null ? `${(c.errorRate * 100).toFixed(1)}%` : "—"]);
        }
      }
      this._cmdTable.setData(["資料集", "指令", "Correct", "Wrong", "Error Rate"], rows);
      content = this._cmdTable.render(`${this._filenameBase()}_by_command`);
    }
    const settingsHtml = view !== "table" ? `<div class="final-analysis-chart-settings-wrap">${this._cmdChartSettings.renderPanel()}</div>` : "";

    return `<div class="final-analysis-series-block">
      <div class="final-analysis-series-label">個別（依指令）By Command</div>
      <div class="final-analysis-card-controls">${viewButtons}</div>
      ${settingsHtml}
      <div class="final-analysis-card-content">${content}</div>
    </div>`;
  }

  _wireAnalysisBody(container) {
    container.querySelectorAll("[data-view-btn]").forEach(btn => {
      btn.addEventListener("click", () => this._setView(btn.dataset.viewBtn));
    });
    container.querySelectorAll("[data-run-test]").forEach(btn => {
      btn.addEventListener("click", () => { this._ranTests.add(btn.dataset.runTest); this._render(); });
    });
    if (this._view === "table") this._table.wire(container, () => this._render());
    this._chartSettings.wire(container, () => this._render());

    container.querySelectorAll("[data-cmd-view-btn]").forEach(btn => {
      btn.addEventListener("click", () => { this._cmdView = btn.dataset.cmdViewBtn; this._render(); });
    });
    if (this._cmdView === "table") this._cmdTable.wire(container, () => this._render());
    this._cmdChartSettings.wire(container, () => this._render());

    container.querySelectorAll("[data-run-gender-test]").forEach(btn => {
      btn.addEventListener("click", () => { this._genderRanTests.add(btn.dataset.runGenderTest); this._render(); });
    });
    this._genderTable.wire(container, () => this._render());
  }
}

// ══════════════════════════════════════════════════════════════════════
// 3. Reaction Time — 描述統計 + 配對 t 檢定 / Wilcoxon（兩兩比較）+ 重複量數 ANOVA（整體）
// ══════════════════════════════════════════════════════════════════════
export class ReactionTimeCard extends BaseAnalysisCard {
  constructor() {
    super("反應時間 Reaction Time", "各資料集的反應時間描述統計；2 個以上資料集時自動列出所有兩兩配對比較（Paired t-test / Wilcoxon）與整體重複量數 ANOVA");
    this._chartSettings = new ChartSettings("overall");
    this._cmdView = "table";
    this._cmdChartSettings = new ChartSettings("by-command");
    this._cmdTable = new DataTableView("reaction-time-by-command");
    this._threshold = null;
    this._thresholdTouched = false;
    this._thresholdTable = new DataTableView("reaction-time-threshold");
    this._genderTable = new DataTableView("reaction-time-by-gender");
  }

  _defaultView() { return "table"; }

  _renderAnalysisBody(groups) {
    if (!groups.length) {
      return "<div class=\"assist-mark-empty\"><p>請先在左側「資料來源」勾選至少一個資料集。</p></div>";
    }
    const desc = groups.map(g => descriptiveStats(g.attempts.map(a => parseClockMs(a.duration)).filter(v => v != null)));

    const view = this._view;
    const viewButtons = `<div class="final-analysis-btn-group">
      <button class="archive-action-btn${view === "table" ? " is-active" : ""}" data-view-btn="table">表格</button>
      <button class="archive-action-btn${view === "bar" ? " is-active" : ""}" data-view-btn="bar">長條圖</button>
      <button class="archive-action-btn${view === "box" ? " is-active" : ""}" data-view-btn="box">箱型圖</button>
    </div>`;

    const secFmt = ms => ms == null ? "—" : (ms / 1000).toFixed(2);
    let content;
    if (view === "bar") {
      content = renderBarChart({
        categories: groups.map(g => g.label),
        series: [{ label: "", rowsByCategory: desc }],
        getValue: r => r.mean != null ? r.mean / 1000 : 0,
        getError: r => r.sd != null ? r.sd / 1000 : 0,
        defaultTitle: this._title,
        defaultYLabel: "平均反應時間（秒）",
        defaultXLabel: "資料集",
        formatTick: v => v.toFixed(v < 10 ? 1 : 0),
        ariaLabel: "反應時間長條圖",
        settings: this._chartSettings,
        filenameBase: this._filenameBase(),
      });
    } else if (view === "box") {
      content = renderBoxPlot({
        categories: groups.map(g => g.label),
        boxStats: groups.map(g => {
          const b = boxPlotStats(g.attempts.map(a => parseClockMs(a.duration)).filter(v => v != null));
          return b ? { min: b.min / 1000, q1: b.q1 / 1000, median: b.median / 1000, q3: b.q3 / 1000, max: b.max / 1000 } : null;
        }),
        defaultTitle: this._title,
        defaultYLabel: "反應時間（秒）",
        defaultXLabel: "資料集",
        formatTick: v => v.toFixed(1),
        ariaLabel: "反應時間箱型圖",
        settings: this._chartSettings,
        filenameBase: this._filenameBase(),
      });
    } else {
      this._table.setData(["資料集", "N", "Mean", "Median", "SD", "Min", "Max"], groups.map((g, i) => [
        g.label, desc[i].n, secFmt(desc[i].mean), secFmt(desc[i].median), secFmt(desc[i].sd), secFmt(desc[i].min), secFmt(desc[i].max),
      ]));
      content = this._table.render(this._filenameBase());
    }
    const settingsHtml = view !== "table" ? `<div class="final-analysis-chart-settings-wrap">${this._chartSettings.renderPanel()}</div>` : "";

    const comparisonHtml = this._renderComparisons(groups);

    const overallHtml = `<div class="final-analysis-series-block">
      <div class="final-analysis-series-label">總覽 Overall</div>
      <div class="final-analysis-card-controls">${viewButtons}</div>
      ${comparisonHtml}
      ${settingsHtml}
      <div class="final-analysis-card-content">${content}</div>
    </div>`;

    return `${overallHtml}${this._renderByCommand(groups)}${this._renderThreshold(groups)}${this._renderByGender(groups)}`;
  }

  // 「個別（依性別）」：兩性別是不同受試者（獨立樣本），跟上面「兩兩配對比較」（同一受試者跨資料集）
  // 不同，不能用差值配對，改用每位受試者的平均反應時間各自成一組樣本，再做獨立樣本 t 檢定／Mann-Whitney U。
  _renderByGender(groups) {
    const pooled = groups.flatMap(g => g.attempts);
    const genders = Array.from(new Set(pooled.map(a => a.participantGender).filter(Boolean))).sort((a, b) => a.localeCompare(b, "zh-Hant"));
    if (!genders.length) return "";

    const secFmt = ms => ms == null ? "—" : (ms / 1000).toFixed(2);
    const desc = genders.map(g => descriptiveStats(pooled.filter(a => a.participantGender === g).map(a => parseClockMs(a.duration)).filter(v => v != null)));
    this._genderTable.setData(["性別", "N", "Mean", "Median", "SD", "Min", "Max"], genders.map((g, i) => [
      g, desc[i].n, secFmt(desc[i].mean), secFmt(desc[i].median), secFmt(desc[i].sd), secFmt(desc[i].min), secFmt(desc[i].max),
    ]));

    let testHtml = "<p class=\"final-analysis-missing-note\">需同時有 2 個性別的資料才會顯示獨立樣本比較。</p>";
    if (genders.length === 2) {
      const [gA, gB] = genders;
      const meansA = Array.from(perParticipantMeanMs(pooled.filter(a => a.participantGender === gA)).values());
      const meansB = Array.from(perParticipantMeanMs(pooled.filter(a => a.participantGender === gB)).values());
      const tResult = independentTTest(meansA, meansB);
      const uResult = mannWhitneyU(meansA, meansB);
      testHtml = `<div class="final-analysis-test-panel">
        <div class="final-analysis-series-label">${escapeHtml(gA)} vs ${escapeHtml(gB)}（獨立樣本，受試者數 n = ${meansA.length} / ${meansB.length}）</div>
        <div class="final-analysis-test-row">
          <div class="final-analysis-test-row-head"><span class="final-analysis-test-name">Welch's t-test（獨立樣本）</span></div>
          <div class="final-analysis-test-result">${tResult.t != null ? `t(${tResult.df.toFixed(1)}) = ${tResult.t.toFixed(3)}，p = ${pFmt(tResult.p)}` : (tResult.reason || "無法計算")}</div>
        </div>
        <div class="final-analysis-test-row">
          <div class="final-analysis-test-row-head"><span class="final-analysis-test-name">Mann-Whitney U Test</span></div>
          <div class="final-analysis-test-result">${uResult.z != null ? `z = ${uResult.z.toFixed(3)}，p = ${pFmt(uResult.p)}${uResult.note ? `（${uResult.note}）` : ""}` : (uResult.reason || "無法計算")}</div>
        </div>
        <p class="final-analysis-agreement-summary">兩性別是不同受試者（獨立樣本），不能比照上面同一受試者跨資料集的配對檢定；樣本數較大且分布近似常態時可參考 Welch's t-test，樣本數小或明顯偏態時建議參考 Mann-Whitney U Test。</p>
      </div>`;
    }

    return `<div class="final-analysis-series-block">
      <div class="final-analysis-series-label">個別（依性別）By Gender</div>
      ${testHtml}
      <div class="final-analysis-card-content">${this._genderTable.render(`${this._filenameBase()}_by_gender`)}</div>
    </div>`;
  }

  // 「個別（依指令）」：把目前已勾選的資料集，再依手勢指令拆開列出反應時間描述統計，
  // 用來看是不是某幾個指令特別花時間，而不只是資料集整體的平均反應時間。
  _renderByCommand(groups) {
    const allCommands = sortByCommandOrder(
      Array.from(new Set(groups.flatMap(g => g.attempts.map(a => a.gestureCommand || "（未知指令）")))),
      this._gestureOrder, cmd => cmd,
    );
    if (!allCommands.length) return "";

    const perGroup = groups.map(g => ({
      group: g,
      byCommand: new Map(groupByCommand(g.attempts, this._gestureOrder).map(({ command, attempts }) => {
        const values = attempts.map(a => parseClockMs(a.duration)).filter(v => v != null);
        return [command, { desc: descriptiveStats(values), box: boxPlotStats(values) }];
      })),
    }));

    // 箱型圖一個分類只能畫一個箱體，選多個資料集時疊在一起會看不清楚，比照圓餅圖的做法只在單一資料集時開放。
    const boxAvailable = groups.length === 1;
    const view = (this._cmdView === "box" && !boxAvailable) ? "table" : this._cmdView;
    const viewButtons = `<div class="final-analysis-btn-group">
      <button class="archive-action-btn${view === "table" ? " is-active" : ""}" data-cmd-view-btn="table">表格</button>
      <button class="archive-action-btn${view === "bar" ? " is-active" : ""}" data-cmd-view-btn="bar">長條圖</button>
      <button class="archive-action-btn${view === "box" ? " is-active" : ""}" data-cmd-view-btn="box" ${boxAvailable ? "" : "disabled title=\"只選 1 個資料集時才可用\""}>箱型圖</button>
    </div>`;

    const secFmt = ms => ms == null ? "—" : (ms / 1000).toFixed(2);
    let content;
    if (view === "bar") {
      content = renderBarChart({
        categories: allCommands,
        series: perGroup.map(({ group, byCommand }) => ({
          label: group.label,
          rowsByCategory: allCommands.map(cmd => byCommand.get(cmd)?.desc || { mean: null, sd: null }),
        })),
        getValue: r => r.mean != null ? r.mean / 1000 : 0,
        getError: r => r.sd != null ? r.sd / 1000 : 0,
        defaultTitle: `${this._title}（依指令）`,
        defaultYLabel: "平均反應時間（秒）",
        defaultXLabel: "手勢指令",
        formatTick: v => v.toFixed(v < 10 ? 1 : 0),
        ariaLabel: "依指令反應時間長條圖",
        settings: this._cmdChartSettings,
        filenameBase: `${this._filenameBase()}_by_command`,
      });
    } else if (view === "box") {
      content = renderBoxPlot({
        categories: allCommands,
        boxStats: allCommands.map(cmd => {
          const b = perGroup[0]?.byCommand.get(cmd)?.box;
          return b ? { min: b.min / 1000, q1: b.q1 / 1000, median: b.median / 1000, q3: b.q3 / 1000, max: b.max / 1000 } : null;
        }),
        defaultTitle: `${this._title}（依指令）`,
        defaultYLabel: "反應時間（秒）",
        defaultXLabel: "手勢指令",
        formatTick: v => v.toFixed(1),
        ariaLabel: "依指令反應時間箱型圖",
        settings: this._cmdChartSettings,
        filenameBase: `${this._filenameBase()}_by_command`,
      });
    } else {
      const rows = [];
      for (const { group, byCommand } of perGroup) {
        for (const cmd of allCommands) {
          const d = byCommand.get(cmd)?.desc;
          if (!d || !d.n) continue;
          rows.push([group.label, cmd, d.n, secFmt(d.mean), secFmt(d.median), secFmt(d.sd), secFmt(d.min), secFmt(d.max)]);
        }
      }
      this._cmdTable.setData(["資料集", "指令", "N", "Mean", "Median", "SD", "Min", "Max"], rows);
      content = this._cmdTable.render(`${this._filenameBase()}_by_command`);
    }
    const settingsHtml = view !== "table" ? `<div class="final-analysis-chart-settings-wrap">${this._cmdChartSettings.renderPanel()}</div>` : "";

    return `<div class="final-analysis-series-block">
      <div class="final-analysis-series-label">個別（依指令）By Command</div>
      <div class="final-analysis-card-controls">${viewButtons}</div>
      ${settingsHtml}
      <div class="final-analysis-card-content">${content}</div>
    </div>`;
  }

  // 「超時次數」：門檻秒數預設取目前篩選範圍的反應時間中位數（比平均值更不受極端值影響），
  // 使用者手動改過門檻之後就不再跟著篩選範圍自動變動，除非按「還原為中位數」。
  _renderThreshold(groups) {
    const allDurations = groups.flatMap(g => g.attempts.map(a => parseClockMs(a.duration)).filter(v => v != null));
    const defaultThresholdSec = allDurations.length ? median(allDurations) / 1000 : null;
    if (!this._thresholdTouched) this._threshold = defaultThresholdSec;
    const thresholdMs = this._threshold != null ? this._threshold * 1000 : null;

    const rows = groups.map(g => {
      const durations = g.attempts.map(a => parseClockMs(a.duration)).filter(v => v != null);
      const r = countAboveThreshold(durations, thresholdMs);
      return [g.label, r.count, r.total, r.pct != null ? `${(r.pct * 100).toFixed(1)}%` : "—"];
    });
    this._thresholdTable.setData(["資料集", "超過門檻次數", "總筆數", "佔比"], rows);

    return `<div class="final-analysis-series-block">
      <div class="final-analysis-series-label">超時次數 Trials Above Threshold</div>
      <div class="final-analysis-card-controls">
        <label class="final-analysis-key-label">門檻秒數（預設＝目前篩選範圍中位數，可自行調整）
          <input type="number" step="0.1" min="0" class="final-analysis-key-select final-analysis-threshold-input" data-threshold-input value="${this._threshold != null ? this._threshold.toFixed(2) : ""}">
        </label>
        ${this._thresholdTouched ? "<button type=\"button\" class=\"archive-action-btn archive-action-btn--sm\" data-threshold-reset>還原為中位數</button>" : ""}
      </div>
      <div class="final-analysis-card-content">${this._thresholdTable.render(`${this._filenameBase()}_threshold`)}</div>
    </div>`;
  }

  _renderComparisons(groups) {
    if (groups.length < 2) {
      return "<p class=\"final-analysis-missing-note\">勾選 2 個以上資料集才會顯示配對比較與整體 ANOVA。</p>";
    }
    const perGroupMeans = groups.map(g => perParticipantMeanMs(g.attempts));
    const pairHtml = pairwiseCombos(groups.map((g, i) => ({ g, i }))).map(([{ g: gA, i: ia }, { g: gB, i: ib }]) => {
      const mapA = perGroupMeans[ia], mapB = perGroupMeans[ib];
      const commonIds = [...mapA.keys()].filter(id => mapB.has(id));
      const diffs = commonIds.map(id => mapA.get(id) - mapB.get(id));
      const tResult = pairedTTest(diffs);
      const wResult = wilcoxonSignedRank(diffs);
      return `<div class="final-analysis-test-panel">
        <div class="final-analysis-series-label">${escapeHtml(gA.label)} vs ${escapeHtml(gB.label)}（配對樣本數 n = ${diffs.length}）</div>
        <div class="final-analysis-test-row">
          <div class="final-analysis-test-row-head"><span class="final-analysis-test-name">Paired t-test</span></div>
          <div class="final-analysis-test-result">${tResult.t != null ? `t(${tResult.df}) = ${tResult.t.toFixed(3)}，p = ${pFmt(tResult.p)}` : (tResult.reason || "無法計算")}</div>
        </div>
        <div class="final-analysis-test-row">
          <div class="final-analysis-test-row-head"><span class="final-analysis-test-name">Wilcoxon Signed-Rank Test</span></div>
          <div class="final-analysis-test-result">${wResult.z != null ? `z = ${wResult.z.toFixed(3)}，p = ${pFmt(wResult.p)}${wResult.note ? `（${wResult.note}）` : ""}` : (wResult.reason || "無法計算")}</div>
        </div>
        <p class="final-analysis-agreement-summary">建議（不自動選擇）：樣本數較大且差值近似常態分布時可參考 Paired t-test；樣本數小或差值明顯偏態時建議參考 Wilcoxon Signed-Rank Test。</p>
      </div>`;
    }).join("");

    const commonAllIds = [...perGroupMeans[0].keys()].filter(id => perGroupMeans.every(m => m.has(id)));
    const matrix = commonAllIds.map(id => perGroupMeans.map(m => m.get(id)));
    const anova = oneWayRepeatedMeasuresAnova(matrix);
    const anovaHtml = `<div class="final-analysis-test-panel">
      <div class="final-analysis-series-label">整體比較（單因子重複量數 ANOVA，受試者 n = ${anova.n || 0}，條件數 k = ${anova.k || groups.length}）</div>
      <div class="final-analysis-test-row">
        <div class="final-analysis-test-result">${anova.F != null ? `F(${anova.df1}, ${anova.df2}) = ${anova.F.toFixed(3)}，p = ${pFmt(anova.p)}` : (anova.reason || "無法計算")}</div>
      </div>
      ${groups.length === 2 ? "<p class=\"final-analysis-agreement-summary\">僅選 2 個資料集時，本結果與上方配對 t 檢定等價（F ≈ t²），建議主要參考配對比較。</p>" : ""}
    </div>`;

    return `<div class="final-analysis-comparisons">${pairHtml}${anovaHtml}</div>`;
  }

  _wireAnalysisBody(container) {
    container.querySelectorAll("[data-view-btn]").forEach(btn => {
      btn.addEventListener("click", () => this._setView(btn.dataset.viewBtn));
    });
    if (this._view === "table") this._table.wire(container, () => this._render());
    this._chartSettings.wire(container, () => this._render());

    container.querySelectorAll("[data-cmd-view-btn]").forEach(btn => {
      btn.addEventListener("click", () => { this._cmdView = btn.dataset.cmdViewBtn; this._render(); });
    });
    if (this._cmdView === "table") this._cmdTable.wire(container, () => this._render());
    this._cmdChartSettings.wire(container, () => this._render());

    const thresholdInput = container.querySelector("[data-threshold-input]");
    if (thresholdInput) thresholdInput.addEventListener("change", () => {
      const v = parseFloat(thresholdInput.value);
      if (!Number.isNaN(v) && v >= 0) { this._threshold = v; this._thresholdTouched = true; this._render(); }
    });
    const thresholdResetBtn = container.querySelector("[data-threshold-reset]");
    if (thresholdResetBtn) thresholdResetBtn.addEventListener("click", () => { this._thresholdTouched = false; this._render(); });
    this._thresholdTable.wire(container, () => this._render());
    this._genderTable.wire(container, () => this._render());
  }
}
