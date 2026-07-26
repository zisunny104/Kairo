/**
 * archive-questionnaire-cards.js — 問卷分析頁的卡片元件
 * ScaleCard：SSQ／NASA-TLX／SUS／UEQ 共用的「描述統計表＋長條圖＋（可選）雷達圖」卡片外殼，
 * 每個圖表/表格都自動產生可複製的圖說／表說。所有文字說明僅描述已計算出的數值，不做研究推論。
 */
import { escapeHtml } from "./archive-constants.js";
import { downloadXlsx } from "../core/xlsx-export.js";
import { mean } from "./archive-final-analysis-stats.js";
import { ChartSettings, DataTableView, renderBarChart, renderRadarChart } from "./archive-final-analysis-viz.js";

const fmt = v => (v == null || Number.isNaN(v) ? "—" : v.toFixed(2));

export function makeCounter(start = 1) {
  let n = start - 1;
  return { next: () => (n += 1) };
}

// ── 圖說／表說「複製」按鈕：文字存在登記表，按鈕只帶 key，避免把整段文字塞進 HTML 屬性 ──
let _copyRegistry = new Map();
let _copyKeySeq = 0;

export function resetCopyRegistry() { _copyRegistry = new Map(); _copyKeySeq = 0; }

function registerCopyText(text) {
  const key = `k${++_copyKeySeq}`;
  _copyRegistry.set(key, text);
  return key;
}

async function copyPlainText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function wireInlineCopyButton(btn) {
  btn.addEventListener("click", async () => {
    const key = btn.dataset.qnrCopyKey;
    const text = _copyRegistry.get(key) || "";
    const ok = await copyPlainText(text);
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = ok ? "已複製" : "失敗";
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1200);
  });
}

/** 對整份 Dashboard 容器呼叫一次即可，掃描所有圖說/表說的複製按鈕並掛上事件 */
export function wireCaptionCopyButtons(container) {
  container.querySelectorAll("[data-qnr-copy-key]").forEach(wireInlineCopyButton);
}

function renderCaptionDesc(caption, desc) {
  const capKey = registerCopyText(caption);
  const descKey = registerCopyText(desc);
  return `<p class="qnr-caption">${escapeHtml(caption)}
      <button type="button" class="qnr-copy-inline" data-qnr-copy-key="${capKey}">複製</button></p>
    <p class="qnr-desc">${escapeHtml(desc)}
      <button type="button" class="qnr-copy-inline" data-qnr-copy-key="${descKey}">複製</button></p>`;
}

/** 純資料事實描述：最高/最低題項、平均範圍，不含研究推論或未經驗證的結論 */
export function describeItemStats(title, stats) {
  const valid = stats.filter(s => s.mean != null);
  if (!valid.length) return `${title} 尚無足夠數值資料可供分析。`;
  const sorted = [...valid].sort((a, b) => b.mean - a.mean);
  const top = sorted[0], bottom = sorted[sorted.length - 1];
  const overall = mean(valid.map(s => s.mean));
  if (top.colIndex === bottom.colIndex) {
    return `由上表可知，${title}僅一題有效資料，平均分數為 ${fmt(top.mean)}（SD=${fmt(top.sd)}）。`;
  }
  return `由上表可知，${title}各題平均分數介於 ${fmt(bottom.mean)} 至 ${fmt(top.mean)} 之間，整體平均為 ${fmt(overall)}。其中「${top.label}」平均分數最高（M=${fmt(top.mean)}, SD=${fmt(top.sd)}），「${bottom.label}」平均分數最低（M=${fmt(bottom.mean)}, SD=${fmt(bottom.sd)}）。`;
}

export function describeSusExtra(baseDesc, susAvg, rating) {
  if (susAvg == null) return baseDesc;
  const ratingText = rating ? `，等級對照為 ${rating.grade}（${rating.adjective}，參考 Sauro, 2011 SUS 等級對照表）` : "";
  return `${baseDesc} 全體受試者之 SUS 總平均分數為 ${fmt(susAvg)} 分（滿分 100 分）${ratingText}。`;
}

export function renderStatTiles(items) {
  return `<div class="final-analysis-stat-tiles">${items.map(it => `
    <div class="final-analysis-stat-tile">
      <div class="final-analysis-stat-tile-label">${escapeHtml(it.label)}</div>
      <div class="final-analysis-stat-tile-value">${it.value}</div>
    </div>`).join("")}</div>`;
}

// ── SSQ／NASA-TLX／SUS／UEQ 共用卡片：描述統計表 + 長條圖 +（可選）雷達圖 ──
export class ScaleCard {
  constructor(key, def, opts = {}) {
    this.key = key;
    this.title = def.label;
    this.fullName = def.fullName;
    this.withRadar = opts.withRadar !== false;
    this.axisMax = opts.axisMax || null;
    this.formatTick = opts.formatTick || null;
    this.barSettings = new ChartSettings();
    this.radarSettings = new ChartSettings();
    this.table = new DataTableView();
  }

  renderHTML(stats, ctx, extra = {}) {
    const { chapter, figCounter, tblCounter } = ctx;
    const desc = extra.descOverride || describeItemStats(this.title, stats);
    this._lastStats = stats;
    this._lastDesc = desc;

    const rows = stats.map(s => [s.label, s.n, fmt(s.mean), fmt(s.sd)]);
    this.table.setData(["題項", "填答人數", "平均數", "標準差"], rows);

    const tblNo = tblCounter.next();
    const tableCaption = `表${chapter}-${tblNo}　${this.fullName}各題平均值與標準差`;

    const categories = stats.map(s => s.label);
    const barFigNo = figCounter.next();
    const barCaption = `圖${chapter}-${barFigNo}　${this.fullName}各題平均分數長條圖`;
    const barHtml = renderBarChart({
      categories,
      series: [{ label: this.title, rowsByCategory: stats }],
      getValue: s => s.mean,
      getError: s => s.sd,
      defaultTitle: `${this.title}各題平均分數`,
      defaultYLabel: "平均分數",
      formatTick: this.formatTick,
      settings: this.barSettings,
      filenameBase: `${this.key}_bar`,
      ariaLabel: barCaption,
    });

    let radarBlockHtml = "";
    if (this.withRadar) {
      const radarFigNo = figCounter.next();
      const radarCaption = `圖${chapter}-${radarFigNo}　${this.fullName}各構面平均分數雷達圖`;
      const radarHtml = renderRadarChart({
        categories,
        series: [{ label: this.title, rowsByCategory: stats }],
        getValue: s => s.mean,
        defaultTitle: `${this.title}各構面平均分數`,
        axisMax: this.axisMax,
        formatTick: this.formatTick,
        settings: this.radarSettings,
        filenameBase: `${this.key}_radar`,
        ariaLabel: radarCaption,
      });
      radarBlockHtml = `<div class="qnr-block">
        <div id="qnrRadarSettings-${this.key}">${this.radarSettings.renderPanel()}</div>
        ${radarHtml}
        ${renderCaptionDesc(radarCaption, desc)}
      </div>`;
    }

    this._statsText = stats.map(s => `${s.label}\tM=${fmt(s.mean)}\tSD=${fmt(s.sd)}\tn=${s.n}`).join("\n");

    return `<div class="final-analysis-card qnr-card">
      <div class="final-analysis-card-titlebar">
        <div class="assist-mark-title-wrap">
          <div class="assist-mark-title">${escapeHtml(this.fullName)}</div>
        </div>
        <div class="final-analysis-card-titlebar-actions">
          <button class="archive-action-btn archive-action-btn--sm" data-qnr-copy-stats>複製統計</button>
          <button class="archive-action-btn archive-action-btn--sm" data-qnr-copy-desc>複製學術描述</button>
          <button class="archive-action-btn archive-action-btn--sm" data-qnr-export-xlsx>匯出 Excel</button>
        </div>
      </div>
      <div class="qnr-block">
        ${this.table.render(`${this.key}_stats`)}
        ${renderCaptionDesc(tableCaption, desc)}
      </div>
      ${extra.extraBlockHtml || ""}
      <div class="qnr-block">
        <div id="qnrBarSettings-${this.key}">${this.barSettings.renderPanel()}</div>
        ${barHtml}
        ${renderCaptionDesc(barCaption, desc)}
      </div>
      ${radarBlockHtml}
    </div>`;
  }

  wire(container, onChange) {
    this.table.wire(container, onChange);
    const barWrap = container.querySelector(`#qnrBarSettings-${this.key}`);
    if (barWrap) this.barSettings.wire(barWrap, onChange);
    if (this.withRadar) {
      const radarWrap = container.querySelector(`#qnrRadarSettings-${this.key}`);
      if (radarWrap) this.radarSettings.wire(radarWrap, onChange);
    }
    const statsBtn = container.querySelector("[data-qnr-copy-stats]");
    if (statsBtn) statsBtn.addEventListener("click", async () => {
      const ok = await copyPlainText(this._statsText || "");
      const original = statsBtn.textContent;
      statsBtn.disabled = true;
      statsBtn.textContent = ok ? "已複製！" : "複製失敗";
      setTimeout(() => { statsBtn.textContent = original; statsBtn.disabled = false; }, 1500);
    });
    const descBtn = container.querySelector("[data-qnr-copy-desc]");
    if (descBtn) descBtn.addEventListener("click", async () => {
      const ok = await copyPlainText(this._lastDesc || "");
      const original = descBtn.textContent;
      descBtn.disabled = true;
      descBtn.textContent = ok ? "已複製！" : "複製失敗";
      setTimeout(() => { descBtn.textContent = original; descBtn.disabled = false; }, 1500);
    });
    const xlsxBtn = container.querySelector("[data-qnr-export-xlsx]");
    if (xlsxBtn) xlsxBtn.addEventListener("click", () => {
      downloadXlsx([["題項", "填答人數", "平均數", "標準差"], ...(this._lastStats || []).map(s => [s.label, s.n, fmt(s.mean), fmt(s.sd)])], `${this.key}_stats`, this.title);
    });
  }
}

export function renderCaptionDescBlock(caption, desc) { return renderCaptionDesc(caption, desc); }
