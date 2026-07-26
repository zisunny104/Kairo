/**
 * archive-final-analysis-viz.js — 最終分析卡片共用的視覺化元件。
 * 表格（排序／搜尋／複製／匯出）、長條圖、圓餅圖、箱型圖、圖表設定（標題/軸標籤/顯示標籤/顯示數值/顏色/重設），
 * 均與分析邏輯無關，卡片只需準備好資料就能呼叫這裡的 render 函式。
 */
import { escapeHtml, showToast } from "./archive-constants.js";
import { downloadCsv } from "../core/xlsx-export.js";

// 論文圖表用色：單系列預設灰階，多系列（比較模式）依序取用，維持列印可辨識的對比
export const CHART_PALETTE = ["#4a4a4a", "#7d3c98", "#0f8b8d", "#c0392b", "#2980b9", "#e67e22", "#16a085", "#8e44ad"];

// 找不超過 v 的「好看」數字（1/2/5 × 10^n），當作圖表座標軸上限
function niceCeil(v) {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  const norm = v / base;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return niceNorm * base;
}

export function svgToDownloadUrl(svgEl) {
  let source = new XMLSerializer().serializeToString(svgEl);
  if (!/^<svg[^>]+xmlns=/.test(source)) {
    source = source.replace("<svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"");
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
}

export function triggerDownload(href, filename) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// 把 SVG 轉成點陣 PNG（放大 2 倍取得列印用解析度）
export function svgToPngBlob(svgEl, scale = 2) {
  return new Promise((resolve, reject) => {
    const vb = svgEl.viewBox?.baseVal;
    const w = (vb && vb.width) || svgEl.clientWidth || 680;
    const h = (vb && vb.height) || svgEl.clientHeight || 360;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("PNG 轉換失敗"))), "image/png");
    };
    img.onerror = () => reject(new Error("圖表轉換失敗"));
    img.src = svgToDownloadUrl(svgEl);
  });
}

// 論文用表格「複製」：同時放 text/html（貼到 Word 會是真的表格）跟 text/plain（純文字 TSV 備援）
export async function copyTableToClipboard(tableEl) {
  const html = `<table>${tableEl.innerHTML}</table>`;
  const text = Array.from(tableEl.rows)
    .map(row => Array.from(row.cells).map(cell => cell.textContent.trim()).join("\t"))
    .join("\n");
  try {
    if (window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      })]);
    } else {
      await navigator.clipboard.writeText(text);
    }
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}

function wireChartExportButtons(container) {
  container.querySelectorAll("[data-export-svg]").forEach(btn => {
    btn.addEventListener("click", () => {
      const svgEl = btn.closest(".final-analysis-chart-export")?.querySelector("svg");
      if (!svgEl) return;
      triggerDownload(svgToDownloadUrl(svgEl), `${btn.dataset.exportSvg || "chart"}.svg`);
    });
  });
  container.querySelectorAll("[data-export-png]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const svgEl = btn.closest(".final-analysis-chart-export")?.querySelector("svg");
      if (!svgEl) return;
      btn.disabled = true;
      try {
        const blob = await svgToPngBlob(svgEl);
        const url = URL.createObjectURL(blob);
        triggerDownload(url, `${btn.dataset.exportPng || "chart"}.png`);
        URL.revokeObjectURL(url);
      } catch (err) {
        showToast(`圖片匯出失敗：${err.message || err}`, "error");
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function chartActionsHtml(filenameBase) {
  return `<div class="final-analysis-chart-actions">
    <button class="archive-action-btn archive-action-btn--sm" data-export-svg="${escapeHtml(filenameBase)}">下載向量圖（SVG）</button>
    <button class="archive-action-btn archive-action-btn--sm" data-export-png="${escapeHtml(filenameBase)}">下載圖片（PNG）</button>
  </div>`;
}

// ── 圖表設定：標題／X 軸標籤／Y 軸標籤／顯示標籤／顯示數值／顏色，可個別重設 ──
const SETTINGS_DEFAULTS = { title: "", xLabel: "", yLabel: "", showLabels: true, showValues: false, color: "" };

export class ChartSettings {
  constructor() { this._s = { ...SETTINGS_DEFAULTS }; }
  get(key) { return this._s[key]; }
  set(key, value) { this._s[key] = value; }
  resetToDefault() { this._s = { ...SETTINGS_DEFAULTS }; }

  renderPanel() {
    const s = this._s;
    return `<div class="final-analysis-chart-settings">
      <label class="final-analysis-chart-settings-field">圖表標題
        <input type="text" data-chart-setting="title" value="${escapeHtml(s.title)}" placeholder="（自動）">
      </label>
      <label class="final-analysis-chart-settings-field">X 軸標籤
        <input type="text" data-chart-setting="xLabel" value="${escapeHtml(s.xLabel)}" placeholder="（自動）">
      </label>
      <label class="final-analysis-chart-settings-field">Y 軸標籤
        <input type="text" data-chart-setting="yLabel" value="${escapeHtml(s.yLabel)}" placeholder="（自動）">
      </label>
      <label class="final-analysis-chart-settings-checkbox">
        <input type="checkbox" data-chart-setting="showLabels" ${s.showLabels ? "checked" : ""}>顯示標籤
      </label>
      <label class="final-analysis-chart-settings-checkbox">
        <input type="checkbox" data-chart-setting="showValues" ${s.showValues ? "checked" : ""}>顯示數值
      </label>
      <label class="final-analysis-chart-settings-field final-analysis-chart-settings-field--color">顏色
        <input type="color" data-chart-setting="color" value="${s.color || "#4a4a4a"}">
      </label>
      <button type="button" class="archive-action-btn archive-action-btn--sm" data-chart-settings-reset>重設為預設值</button>
    </div>`;
  }

  wire(container, onChange) {
    container.querySelectorAll("[data-chart-setting]").forEach(el => {
      const key = el.dataset.chartSetting;
      el.addEventListener("change", () => {
        this._s[key] = el.type === "checkbox" ? el.checked : el.value;
        onChange();
      });
    });
    const resetBtn = container.querySelector("[data-chart-settings-reset]");
    if (resetBtn) resetBtn.addEventListener("click", () => { this.resetToDefault(); onChange(); });
  }
}

// ── 長條圖：真正的 SVG 座標軸（含格線/刻度、可選誤差線），settings 可覆蓋標題/軸標籤/顯示標籤/顯示數值/顏色 ──
export function renderBarChart({ categories, series, getValue, getError, defaultTitle, defaultYLabel, defaultXLabel, formatTick, ariaLabel, settings, filenameBase }) {
  if (!categories.length) return "<div class=\"assist-mark-empty\"><p>沒有可繪製的資料。</p></div>";

  const title = settings?.get("title") || defaultTitle || "";
  const yLabel = settings?.get("yLabel") || defaultYLabel || "";
  const xLabel = settings?.get("xLabel") || defaultXLabel || "";
  const showLabels = settings ? settings.get("showLabels") : true;
  const showValues = settings ? settings.get("showValues") : false;
  const customColor = settings?.get("color");
  const colorFor = i => (i === 0 && customColor) ? customColor : CHART_PALETTE[i % CHART_PALETTE.length];
  const fmtTick = formatTick || (v => String(Math.round(v * 100) / 100));

  let maxVal = 0;
  series.forEach(s => s.rowsByCategory.forEach(row => {
    const v = getValue(row) || 0;
    const err = getError ? (getError(row) || 0) : 0;
    maxVal = Math.max(maxVal, v + err);
  }));
  if (maxVal <= 0) maxVal = 1;
  const tickCount = 5;
  const niceMax = niceCeil(maxVal * 1.15);
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (niceMax / tickCount) * i);

  const width = 680, height = 380;
  const margin = { top: 40, right: 20, bottom: xLabel ? 108 : 88, left: 58 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const yScale = v => margin.top + plotH - (v / niceMax) * plotH;

  const gridLines = ticks.map(t => {
    const y = yScale(t);
    return `<line x1="${margin.left}" y1="${y.toFixed(1)}" x2="${width - margin.right}" y2="${y.toFixed(1)}" stroke="#ddd" stroke-width="1" />
      <text x="${margin.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#333">${fmtTick(t)}</text>`;
  }).join("");

  const groupWidth = plotW / categories.length;
  const groupPad = 10;
  const barGap = 3;
  const barWidth = Math.max(4, (groupWidth - groupPad * 2 - barGap * (series.length - 1)) / series.length);

  const bars = categories.map((cat, ci) => {
    const groupX = margin.left + ci * groupWidth;
    const barsForGroup = series.map((s, si) => {
      const row = s.rowsByCategory[ci];
      const v = getValue(row) || 0;
      const sd = getError ? (getError(row) || 0) : 0;
      const x = groupX + groupPad + si * (barWidth + barGap);
      const yTop = yScale(v);
      const yBase = yScale(0);
      const color = colorFor(si);
      const cx = x + barWidth / 2;
      const errorSvg = sd > 0 ? (() => {
        const yErrTop = yScale(v + sd);
        const yErrBottom = yScale(Math.max(0, v - sd));
        return `<line x1="${cx.toFixed(1)}" y1="${yErrTop.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yErrBottom.toFixed(1)}" stroke="#111" stroke-width="1.2" />
          <line x1="${(cx - 4).toFixed(1)}" y1="${yErrTop.toFixed(1)}" x2="${(cx + 4).toFixed(1)}" y2="${yErrTop.toFixed(1)}" stroke="#111" stroke-width="1.2" />
          <line x1="${(cx - 4).toFixed(1)}" y1="${yErrBottom.toFixed(1)}" x2="${(cx + 4).toFixed(1)}" y2="${yErrBottom.toFixed(1)}" stroke="#111" stroke-width="1.2" />`;
      })() : "";
      const valueSvg = showValues ? `<text x="${cx.toFixed(1)}" y="${(yTop - 6).toFixed(1)}" text-anchor="middle" font-size="10" fill="#111">${fmtTick(v)}</text>` : "";
      return `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0, yBase - yTop).toFixed(1)}" fill="${color}" stroke="#222" stroke-width="0.6" />${errorSvg}${valueSvg}`;
    }).join("");
    const labelX = groupX + groupWidth / 2;
    const labelY = height - margin.bottom + 14;
    const labelSvg = showLabels ? `<text x="${labelX.toFixed(1)}" y="${labelY}" text-anchor="end" font-size="11" fill="#222" transform="rotate(-35 ${labelX.toFixed(1)} ${labelY})">${escapeHtml(cat)}</text>` : "";
    return `${barsForGroup}${labelSvg}`;
  }).join("");

  const axisLines = `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#222" stroke-width="1.2" />
    <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#222" stroke-width="1.2" />`;

  const yLabelSvg = yLabel ? `<text x="${-(margin.top + plotH / 2).toFixed(1)}" y="16" text-anchor="middle" font-size="12" fill="#222" transform="rotate(-90)">${escapeHtml(yLabel)}</text>` : "";
  const xLabelSvg = xLabel ? `<text x="${width / 2}" y="${height - 8}" text-anchor="middle" font-size="12" fill="#222">${escapeHtml(xLabel)}</text>` : "";
  const titleSvg = title ? `<text x="${width / 2}" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="#111">${escapeHtml(title)}</text>` : "";

  const svg = `<svg viewBox="0 0 ${width} ${height}" class="final-analysis-chart-svg" role="img" aria-label="${escapeHtml(ariaLabel || "統計長條圖")}">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
    ${titleSvg}${gridLines}${axisLines}${bars}${yLabelSvg}${xLabelSvg}
  </svg>`;

  const legend = series.length > 1
    ? `<div class="final-analysis-chart-legend">${series.map((s, i) => `<span class="final-analysis-chart-legend-item"><span class="final-analysis-chart-swatch" style="background:${colorFor(i)}"></span>${escapeHtml(s.label)}</span>`).join("")}</div>`
    : "";

  return `<div class="final-analysis-chart-export">
    ${svg}
    ${legend}
    ${chartActionsHtml(filenameBase || "chart")}
  </div>`;
}

// ── 圓餅圖：SVG 扇形（真圓餅，非圓環），供只選 1 個指令時的手勢分布用 ──
export function renderPieChart({ rows, getValue, defaultTitle, settings, filenameBase, ariaLabel }) {
  const title = settings?.get("title") || defaultTitle || "";
  const showLabels = settings ? settings.get("showLabels") : true;
  const showValues = settings ? settings.get("showValues") : false;
  const size = 240, titleH = 34, r = 96, cx = size / 2, cy = titleH + size / 2 - 6;
  const viewH = size + titleH;
  const titleSvg = title ? `<text x="${size / 2}" y="18" text-anchor="middle" font-size="13" font-weight="700" fill="#111">${escapeHtml(title)}</text>` : "";
  const total = rows.reduce((sum, row) => sum + Math.max(0, getValue(row) || 0), 0);
  let svgInner = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ddd" stroke-width="1.5" />`;
  const legendItems = [];
  if (total > 0) {
    let angleStart = -90;
    const paths = [];
    rows.forEach((row, i) => {
      const val = Math.max(0, getValue(row) || 0);
      if (val <= 0) return;
      const angle = (val / total) * 360;
      const angleEnd = angleStart + angle;
      const largeArc = angle > 180 ? 1 : 0;
      const rad = deg => (deg * Math.PI) / 180;
      const x1 = cx + r * Math.cos(rad(angleStart));
      const y1 = cy + r * Math.sin(rad(angleStart));
      const x2 = cx + r * Math.cos(rad(angleEnd));
      const y2 = cy + r * Math.sin(rad(angleEnd));
      const color = CHART_PALETTE[i % CHART_PALETTE.length];
      paths.push(`<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${largeArc} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${color}" stroke="#fff" stroke-width="1.5" />`);
      angleStart = angleEnd;
      const pct = Math.round((val / total) * 100);
      if (showLabels) legendItems.push(`<div class="final-analysis-donut-legend-item">
        <span class="final-analysis-donut-swatch" style="background:${color}"></span>
        <span>${escapeHtml(row.label)}${showValues ? `（${pct}%，${val}）` : `（${pct}%）`}</span>
      </div>`);
    });
    svgInner = paths.join("");
  }
  const legend = legendItems.length ? legendItems.join("") : (showLabels ? "<p class=\"final-analysis-donut-empty\">尚無資料</p>" : "");
  return `<div class="final-analysis-chart-export">
    <div class="final-analysis-donut-wrap">
      <svg viewBox="0 0 ${size} ${viewH}" class="final-analysis-donut-svg" role="img" aria-label="${escapeHtml(ariaLabel || "圓餅圖")}">
        <rect x="0" y="0" width="${size}" height="${viewH}" fill="#ffffff" />
        ${titleSvg}${svgInner}
      </svg>
      <div class="final-analysis-donut-legend">${legend}</div>
    </div>
    ${chartActionsHtml(filenameBase || "pie")}
  </div>`;
}

// ── 箱型圖：五數概括（min/Q1/median/Q3/max），一個分類一個箱體 ──
export function renderBoxPlot({ categories, boxStats, defaultTitle, defaultYLabel, defaultXLabel, formatTick, ariaLabel, settings, filenameBase }) {
  if (!categories.length) return "<div class=\"assist-mark-empty\"><p>沒有可繪製的資料。</p></div>";

  const title = settings?.get("title") || defaultTitle || "";
  const yLabel = settings?.get("yLabel") || defaultYLabel || "";
  const xLabel = settings?.get("xLabel") || defaultXLabel || "";
  const showLabels = settings ? settings.get("showLabels") : true;
  const showValues = settings ? settings.get("showValues") : false;
  const customColor = settings?.get("color");
  const fmtTick = formatTick || (v => String(Math.round(v * 100) / 100));

  let maxVal = 0;
  boxStats.forEach(b => { if (b) maxVal = Math.max(maxVal, b.max); });
  if (maxVal <= 0) maxVal = 1;
  const tickCount = 5;
  const niceMax = niceCeil(maxVal * 1.15);
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (niceMax / tickCount) * i);

  const width = 680, height = 380;
  const margin = { top: 40, right: 20, bottom: xLabel ? 108 : 88, left: 58 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const yScale = v => margin.top + plotH - (v / niceMax) * plotH;

  const gridLines = ticks.map(t => {
    const y = yScale(t);
    return `<line x1="${margin.left}" y1="${y.toFixed(1)}" x2="${width - margin.right}" y2="${y.toFixed(1)}" stroke="#ddd" stroke-width="1" />
      <text x="${margin.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#333">${fmtTick(t)}</text>`;
  }).join("");

  const groupWidth = plotW / categories.length;
  const boxWidth = Math.min(60, groupWidth * 0.4);
  const color = customColor || CHART_PALETTE[0];

  const boxes = categories.map((cat, ci) => {
    const b = boxStats[ci];
    const groupX = margin.left + ci * groupWidth + groupWidth / 2;
    const labelY = height - margin.bottom + 14;
    const labelSvg = showLabels ? `<text x="${groupX.toFixed(1)}" y="${labelY}" text-anchor="end" font-size="11" fill="#222" transform="rotate(-35 ${groupX.toFixed(1)} ${labelY})">${escapeHtml(cat)}</text>` : "";
    if (!b) return labelSvg;
    const yMin = yScale(b.min), yMax = yScale(b.max), yQ1 = yScale(b.q1), yQ3 = yScale(b.q3), yMed = yScale(b.median);
    const x1 = groupX - boxWidth / 2, x2 = groupX + boxWidth / 2;
    const valueSvg = showValues ? `<text x="${groupX.toFixed(1)}" y="${(yMax - 8).toFixed(1)}" text-anchor="middle" font-size="10" fill="#111">${fmtTick(b.median)}</text>` : "";
    return `<line x1="${groupX.toFixed(1)}" y1="${yMin.toFixed(1)}" x2="${groupX.toFixed(1)}" y2="${yQ1.toFixed(1)}" stroke="#222" stroke-width="1.2" />
      <line x1="${groupX.toFixed(1)}" y1="${yQ3.toFixed(1)}" x2="${groupX.toFixed(1)}" y2="${yMax.toFixed(1)}" stroke="#222" stroke-width="1.2" />
      <line x1="${(x1 + boxWidth * 0.25).toFixed(1)}" y1="${yMin.toFixed(1)}" x2="${(x2 - boxWidth * 0.25).toFixed(1)}" y2="${yMin.toFixed(1)}" stroke="#222" stroke-width="1.2" />
      <line x1="${(x1 + boxWidth * 0.25).toFixed(1)}" y1="${yMax.toFixed(1)}" x2="${(x2 - boxWidth * 0.25).toFixed(1)}" y2="${yMax.toFixed(1)}" stroke="#222" stroke-width="1.2" />
      <rect x="${x1.toFixed(1)}" y="${Math.min(yQ1, yQ3).toFixed(1)}" width="${boxWidth.toFixed(1)}" height="${Math.abs(yQ1 - yQ3).toFixed(1)}" fill="${color}" fill-opacity="0.35" stroke="#222" stroke-width="1.2" />
      <line x1="${x1.toFixed(1)}" y1="${yMed.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${yMed.toFixed(1)}" stroke="#111" stroke-width="1.8" />
      ${valueSvg}${labelSvg}`;
  }).join("");

  const axisLines = `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#222" stroke-width="1.2" />
    <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#222" stroke-width="1.2" />`;
  const yLabelSvg = yLabel ? `<text x="${-(margin.top + plotH / 2).toFixed(1)}" y="16" text-anchor="middle" font-size="12" fill="#222" transform="rotate(-90)">${escapeHtml(yLabel)}</text>` : "";
  const xLabelSvg = xLabel ? `<text x="${width / 2}" y="${height - 8}" text-anchor="middle" font-size="12" fill="#222">${escapeHtml(xLabel)}</text>` : "";
  const titleSvg = title ? `<text x="${width / 2}" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="#111">${escapeHtml(title)}</text>` : "";

  const svg = `<svg viewBox="0 0 ${width} ${height}" class="final-analysis-chart-svg" role="img" aria-label="${escapeHtml(ariaLabel || "箱型圖")}">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
    ${titleSvg}${gridLines}${axisLines}${boxes}${yLabelSvg}${xLabelSvg}
  </svg>`;

  return `<div class="final-analysis-chart-export">${svg}${chartActionsHtml(filenameBase || "boxplot")}</div>`;
}

// ── 雷達圖：多構面比較用的 SVG 蜘蛛網圖，settings 可覆蓋標題/顯示標籤/顯示數值/顏色 ──
export function renderRadarChart({ categories, series, getValue, defaultTitle, axisMax, formatTick, ariaLabel, settings, filenameBase }) {
  if (!categories.length || categories.length < 3) return "<div class=\"assist-mark-empty\"><p>雷達圖至少需要 3 個構面才能繪製。</p></div>";

  const title = settings?.get("title") || defaultTitle || "";
  const showLabels = settings ? settings.get("showLabels") : true;
  const showValues = settings ? settings.get("showValues") : false;
  const customColor = settings?.get("color");
  const colorFor = i => (i === 0 && customColor) ? customColor : CHART_PALETTE[i % CHART_PALETTE.length];
  const fmtTick = formatTick || (v => String(Math.round(v * 100) / 100));

  let maxVal = axisMax;
  if (!maxVal) {
    let observed = 0;
    series.forEach(s => s.rowsByCategory.forEach(row => { observed = Math.max(observed, getValue(row) || 0); }));
    maxVal = niceCeil((observed || 1) * 1.15);
  }

  const N = categories.length;
  const size = 520, titleH = 34, legendH = series.length > 1 ? 30 : 0;
  const R = size / 2 - 70;
  const cx = size / 2, cy = titleH + (size - titleH) / 2 - 20;
  const viewH = size + legendH;

  const angleFor = i => -90 + i * (360 / N);
  const pointAt = (r, angleDeg) => {
    const rad = (angleDeg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };

  const rings = 4;
  const gridPolys = Array.from({ length: rings }, (_, k) => {
    const r = R * ((k + 1) / rings);
    const pts = categories.map((_, i) => pointAt(r, angleFor(i)).map(n => n.toFixed(1)).join(",")).join(" ");
    return `<polygon points="${pts}" fill="none" stroke="#ddd" stroke-width="1" />`;
  }).join("");

  const ringLabels = Array.from({ length: rings }, (_, k) => {
    const val = maxVal * ((k + 1) / rings);
    const [tx, ty] = pointAt(R * ((k + 1) / rings), -90);
    return `<text x="${(tx + 4).toFixed(1)}" y="${(ty - 2).toFixed(1)}" font-size="10" fill="#888">${fmtTick(val)}</text>`;
  }).join("");

  const axisLines = categories.map((_, i) => {
    const [x, y] = pointAt(R, angleFor(i));
    return `<line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#ccc" stroke-width="1" />`;
  }).join("");

  const axisLabels = showLabels ? categories.map((cat, i) => {
    const ang = angleFor(i);
    const [x, y] = pointAt(R + 24, ang);
    const cosv = Math.cos((ang * Math.PI) / 180);
    const anchor = Math.abs(cosv) < 0.2 ? "middle" : (cosv > 0 ? "start" : "end");
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" font-size="11" fill="#222">${escapeHtml(cat)}</text>`;
  }).join("") : "";

  const seriesSvg = series.map((s, si) => {
    const color = colorFor(si);
    const pts = categories.map((_, i) => {
      const row = s.rowsByCategory[i];
      const v = Math.max(0, Math.min(maxVal, getValue(row) || 0));
      return pointAt((v / maxVal) * R, angleFor(i));
    });
    const polyPts = pts.map(p => p.map(n => n.toFixed(1)).join(",")).join(" ");
    const dots = pts.map(([x, y], i) => {
      const row = s.rowsByCategory[i];
      const v = getValue(row) || 0;
      const valueSvg = showValues ? `<text x="${x.toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle" font-size="10" fill="#111">${fmtTick(v)}</text>` : "";
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${color}" />${valueSvg}`;
    }).join("");
    return `<polygon points="${polyPts}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="2" />${dots}`;
  }).join("");

  const titleSvg = title ? `<text x="${size / 2}" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="#111">${escapeHtml(title)}</text>` : "";

  const svg = `<svg viewBox="0 0 ${size} ${viewH}" class="final-analysis-chart-svg" role="img" aria-label="${escapeHtml(ariaLabel || "雷達圖")}">
    <rect x="0" y="0" width="${size}" height="${viewH}" fill="#ffffff" />
    ${titleSvg}${gridPolys}${axisLines}${ringLabels}${seriesSvg}${axisLabels}
  </svg>`;

  const legend = series.length > 1
    ? `<div class="final-analysis-chart-legend">${series.map((s, i) => `<span class="final-analysis-chart-legend-item"><span class="final-analysis-chart-swatch" style="background:${colorFor(i)}"></span>${escapeHtml(s.label)}</span>`).join("")}</div>`
    : "";

  return `<div class="final-analysis-chart-export">
    ${svg}
    ${legend}
    ${chartActionsHtml(filenameBase || "radar")}
  </div>`;
}

export function wireChartExports(container) {
  wireChartExportButtons(container);
}

// ── 通用資料表格：排序／搜尋／複製／匯出 CSV ──────────────────────────────
export class DataTableView {
  constructor() {
    this._headers = [];
    this._rows = [];
    this._sortCol = null;
    this._sortDir = 1;
    this._query = "";
    this._searchFocused = false;
  }

  setData(headers, rows) {
    this._headers = headers;
    this._rows = rows;
  }

  _visibleRows() {
    let rows = this._rows;
    if (this._query) {
      const q = this._query.toLowerCase();
      rows = rows.filter(r => r.some(c => String(c ?? "").toLowerCase().includes(q)));
    }
    if (this._sortCol != null) {
      const col = this._sortCol, dir = this._sortDir;
      rows = [...rows].sort((a, b) => {
        const av = a[col], bv = b[col];
        const an = Number(av), bn = Number(bv);
        const bothNumeric = av !== "" && bv !== "" && av != null && bv != null && !Number.isNaN(an) && !Number.isNaN(bn);
        const cmp = bothNumeric ? an - bn : String(av ?? "").localeCompare(String(bv ?? ""), "zh-Hant");
        return cmp * dir;
      });
    }
    return rows;
  }

  render(filenameBase) {
    this._filenameBase = filenameBase || "table";
    const rows = this._visibleRows();
    const theadHtml = `<tr>${this._headers.map((h, i) => {
      const arrow = this._sortCol === i ? (this._sortDir === 1 ? " ▲" : " ▼") : "";
      return `<th data-table-sort="${i}">${escapeHtml(String(h))}${arrow}</th>`;
    }).join("")}</tr>`;
    const tbodyHtml = rows.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(String(cell ?? ""))}</td>`).join("")}</tr>`).join("");
    return `<div class="final-analysis-datatable">
      <div class="final-analysis-datatable-toolbar">
        <input type="search" class="final-analysis-datatable-search" placeholder="搜尋表格內容…" value="${escapeHtml(this._query)}">
        <div class="final-analysis-chart-actions">
          <button class="archive-action-btn archive-action-btn--sm" data-table-copy>複製表格</button>
          <button class="archive-action-btn archive-action-btn--sm" data-table-export-csv>匯出 CSV</button>
        </div>
      </div>
      <div class="final-analysis-table-wrap">
        <table class="final-analysis-table" data-table-el>
          <thead>${theadHtml}</thead>
          <tbody>${tbodyHtml}</tbody>
        </table>
      </div>
    </div>`;
  }

  wire(container, onChange) {
    container.querySelectorAll("[data-table-sort]").forEach(th => {
      th.addEventListener("click", () => {
        const col = Number(th.dataset.tableSort);
        if (this._sortCol === col) this._sortDir *= -1;
        else { this._sortCol = col; this._sortDir = 1; }
        onChange();
      });
    });
    const search = container.querySelector(".final-analysis-datatable-search");
    if (search) {
      search.addEventListener("input", () => {
        this._query = search.value;
        this._searchFocused = true;
        onChange();
      });
      search.addEventListener("blur", () => { this._searchFocused = false; });
      if (this._searchFocused) {
        search.focus();
        const pos = search.value.length;
        search.setSelectionRange(pos, pos);
      }
    }
    const copyBtn = container.querySelector("[data-table-copy]");
    if (copyBtn) copyBtn.addEventListener("click", async () => {
      const tableEl = container.querySelector("[data-table-el]");
      const ok = await copyTableToClipboard(tableEl);
      const original = copyBtn.textContent;
      copyBtn.disabled = true;
      copyBtn.textContent = ok ? "已複製！" : "複製失敗";
      setTimeout(() => { copyBtn.textContent = original; copyBtn.disabled = false; }, 1500);
    });
    const csvBtn = container.querySelector("[data-table-export-csv]");
    if (csvBtn) csvBtn.addEventListener("click", () => {
      downloadCsv([this._headers, ...this._visibleRows()], this._filenameBase || "table");
    });
  }
}
