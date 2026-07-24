/**
 * archive-final-analysis-cards.js — 最終分析頁的三張分析卡片。
 * 每張卡片各自獨立：Data Source（複選資料集）→ Filter（受試者／指令）→ Analysis → Statistics →
 * Visualization（表格／長條圖／圓餅圖／箱型圖，各自獨立設定）→ Output（CSV／PNG／SVG）。
 * 卡片之間互不影響；之後要加新的分析只需再寫一個 class，不必動這三張既有的。
 */
import { getApiUrl } from "../core/url-utils.js";
import { getAdminToken, clearAdminToken } from "../core/admin-auth.js";
import { API_ENDPOINTS } from "../constants/index.js";
import { escapeHtml } from "./archive-constants.js";
import { getParticipantNameMap } from "./archive-roster.js";
import { parseClockMs } from "./archive-assist-mark.js";
import {
  mean, descriptiveStats, boxPlotStats, computeAgreement, discoverAgreementKeys,
  errorRateCounts, chiSquareTest, fisherExactTest2x2, fisherExactSuitability,
  pairedTTest, wilcoxonSignedRank, oneWayRepeatedMeasuresAnova,
} from "./archive-final-analysis-stats.js";
import { ChartSettings, DataTableView, renderBarChart, renderPieChart, renderBoxPlot, wireChartExports } from "./archive-final-analysis-viz.js";
import {
  renderDatasetPicker, wireDatasetPicker, renderFilterPanel, wireFilterPanel, filterAttempts,
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
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "未知錯誤");
      const nameMap = await getParticipantNameMap();
      this._records = (data.records || []).filter(r => r.attempts?.length)
        .map(r => ({ ...r, participantName: nameMap.get(r.trackingId) || "" }));
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

  _refresh() { this._records = null; this._render(); this._load(); }
  _setTitle(title) { this._title = title.trim() || this._title; this._render(); }
  _toggleStage(stage, checked) { checked ? this._selectedStages.add(stage) : this._selectedStages.delete(stage); this._render(); }
  _toggleParticipant(id, checked) { checked ? this._selectedParticipants.add(id) : this._selectedParticipants.delete(id); this._render(); }
  _toggleCommand(cmd, checked) { checked ? this._selectedCommands.add(cmd) : this._selectedCommands.delete(cmd); this._render(); }
  _setView(view) { this._view = view; this._render(); }

  _groups() {
    if (!this._records) return [];
    return filterAttempts(this._records, {
      stages: this._selectedStages,
      participantIds: this._selectedParticipants,
      commands: this._selectedCommands,
    });
  }

  _filenameBase() {
    return this._title.replace(/[\\/:*?"<>|]+/g, "_").trim() || "final_analysis";
  }

  // ── 子類別覆寫這幾個 ──
  _defaultView() { return "table"; }
  _renderAnalysisBody(_groups) { return "<p>未實作</p>"; }
  _wireAnalysisBody(_container, _groups) { /* no-op by default */ }

  _render() {
    if (!this._container) return;
    const scopeHtml = this._loading
      ? "<div class=\"assist-mark-empty\"><h3>載入中…</h3></div>"
      : this._error
        ? `<div class="assist-mark-empty"><h3>載入失敗</h3><p>${escapeHtml(this._error)}</p></div>`
        : renderDatasetPicker(this._records, this._selectedStages) + renderFilterPanel(this._records, this._selectedParticipants, this._selectedCommands);

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

    this._wireCommon(groups);
  }

  _wireCommon(groups) {
    const c = this._container;
    const titleInput = c.querySelector("[data-card-title]");
    if (titleInput) titleInput.addEventListener("change", () => this._setTitle(titleInput.value));
    const collapseBtn = c.querySelector("[data-card-collapse-toggle]");
    if (collapseBtn) collapseBtn.addEventListener("click", () => { this._collapsed = !this._collapsed; this._render(); });
    const refreshBtn = c.querySelector("[data-card-refresh]");
    if (refreshBtn) refreshBtn.addEventListener("click", () => this._refresh());
    if (this._collapsed || this._loading || this._error) return;
    wireDatasetPicker(c, (stage, checked) => this._toggleStage(stage, checked));
    wireFilterPanel(c, (id, checked) => this._toggleParticipant(id, checked), (cmd, checked) => this._toggleCommand(cmd, checked));
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

    const rows = computeAgreement(pooled, this._key).filter(r => r.n > 0);
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

    return `<div class="final-analysis-card-controls">
      <label class="final-analysis-key-label">分析 Key（原始資料欄位，自動偵測）
        <select class="final-analysis-key-select" data-agreement-key>${keyOptions}</select>
      </label>
      ${viewButtons}
    </div>
    ${tiles}
    ${settingsHtml}
    <div class="final-analysis-card-content">${content}</div>`;
  }

  _wireAnalysisBody(container) {
    const keySelect = container.querySelector("[data-agreement-key]");
    if (keySelect) keySelect.addEventListener("change", () => { this._key = keySelect.value || null; this._render(); });
    container.querySelectorAll("[data-view-btn]").forEach(btn => {
      btn.addEventListener("click", () => this._setView(btn.dataset.viewBtn));
    });
    if (this._view === "table") this._table.wire(container, () => this._render());
    this._chartSettings.wire(container, () => this._render());
  }
}

// ══════════════════════════════════════════════════════════════════════
// 2. Error Rate Comparison — 資料集之間的正確／錯誤比例比較
// ══════════════════════════════════════════════════════════════════════
export class ErrorRateComparisonCard extends BaseAnalysisCard {
  constructor() {
    super("錯誤率比較 Error Rate Comparison", "各資料集的正確／錯誤次數與錯誤率，並列卡方檢定與 Fisher's Exact Test（自行選擇要執行哪一個）");
    this._ranTests = new Set();
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

    return `<div class="final-analysis-card-controls">${viewButtons}</div>
    ${testsHtml}
    ${settingsHtml}
    <div class="final-analysis-card-content">${content}</div>`;
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
  }
}

// ══════════════════════════════════════════════════════════════════════
// 3. Reaction Time — 描述統計 + 配對 t 檢定 / Wilcoxon（兩兩比較）+ 重複量數 ANOVA（整體）
// ══════════════════════════════════════════════════════════════════════
export class ReactionTimeCard extends BaseAnalysisCard {
  constructor() {
    super("反應時間 Reaction Time", "各資料集的反應時間描述統計；2 個以上資料集時自動列出所有兩兩配對比較（Paired t-test / Wilcoxon）與整體重複量數 ANOVA");
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

    return `<div class="final-analysis-card-controls">${viewButtons}</div>
    ${comparisonHtml}
    ${settingsHtml}
    <div class="final-analysis-card-content">${content}</div>`;
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
  }
}
