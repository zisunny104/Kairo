/**
 * archive-final-analysis-cards.js — 最終分析頁「分析總覽」區塊裡的統計卡片
 * 每張卡片各自管理自己的資料範圍勾選、統計模式與呈現方式（長條圖／圓環圖／表格）。
 */
import { getApiUrl } from "../core/url-utils.js";
import { getAdminToken, clearAdminToken } from "../core/admin-auth.js";
import { API_ENDPOINTS } from "../constants/index.js";
import { escapeHtml } from "./archive-constants.js";
import { formatClock, parseClockMs } from "./archive-assist-mark.js";

const STAGE_LABELS = { "1": "第一階段", "2-1": "第二階段（第一次）", "2-2": "第二階段（第二次）" };
const STAGE_ORDER = ["1", "2-1", "2-2"];
// 論文圖表用色：單系列預設灰階，多系列（比較模式）依序取用，維持列印可辨識的對比
const CHART_PALETTE = ["#4a4a4a", "#7d3c98", "#0f8b8d", "#c0392b", "#2980b9", "#e67e22", "#16a085", "#8e44ad"];

function keyOf(r) { return `${r.trackingId}::${r.stage}`; }

// 一筆 record 底下的所有 attempts 理論上共用同一位受試者，取第一筆的 participantName 當顯示用名字即可
function nameOf(r) { return r.attempts?.[0]?.participantName || ""; }

// 依手勢指令分組，算出每組的平均花費時間、標準差，與超過該組自身平均的次數；
// 花費時間空白／解析不到的紀錄直接排除，不計入平均與次數分母。
function aggregateByCommand(attempts) {
  const groups = new Map();
  for (const a of attempts) {
    const command = a.gestureCommand || "（未知指令）";
    if (!groups.has(command)) groups.set(command, []);
    groups.get(command).push(a);
  }
  const rows = [];
  for (const [command, list] of groups) {
    const valid = list.map(a => parseClockMs(a.duration)).filter(ms => ms != null);
    if (!valid.length) {
      rows.push({ command, avgMs: 0, avgLabel: "—", sdMs: null, sampleCount: 0, overCount: 0 });
      continue;
    }
    const avgMs = valid.reduce((sum, ms) => sum + ms, 0) / valid.length;
    const sdMs = valid.length > 1
      ? Math.sqrt(valid.reduce((sum, ms) => sum + (ms - avgMs) ** 2, 0) / (valid.length - 1))
      : null;
    const overCount = valid.filter(ms => ms > avgMs).length;
    rows.push({ command, avgMs, avgLabel: formatClock(avgMs), sdMs, sampleCount: valid.length, overCount });
  }
  rows.sort((a, b) => a.command.localeCompare(b.command, "zh-Hant"));
  return rows;
}

// 找不超過 v 的「好看」數字（1/2/5 × 10^n），當作圖表 Y 軸上限
function niceCeil(v) {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  const norm = v / base;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return niceNorm * base;
}

// Wobbrock et al. (2005) 的同意率公式：A_r = Σ_i (n_i / N)^2。
// referent＝手勢指令（gestureCommand），比較的「提案」欄位由使用者從下拉選單挑——
// 完全不寫死候選清單或欄位名稱標籤，直接從目前載入的 attempts 動態掃出實際出現過的欄位當選項，
// 之後資料格式多了任何新欄位，下拉選單會自動跟著出現，不用回來改程式。
function discoverAgreementKeys(records) {
  const keys = new Set();
  for (const r of records) {
    for (const a of r.attempts || []) {
      for (const k of Object.keys(a)) {
        if (k !== "gestureCommand") keys.add(k); // gestureCommand 本身是分組用的 referent，不當提案欄位選項
      }
    }
  }
  return Array.from(keys).sort();
}

function computeAgreement(attempts, keyField) {
  const byReferent = new Map();
  for (const a of attempts) {
    const command = a.gestureCommand || "（未知指令）";
    const raw = a[keyField];
    const val = raw == null ? "" : String(raw).trim();
    if (!val) continue; // 空值不計入同意率計算
    if (!byReferent.has(command)) byReferent.set(command, []);
    byReferent.get(command).push(val);
  }
  const rows = [];
  for (const [command, vals] of byReferent) {
    const n = vals.length;
    const counts = new Map();
    vals.forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
    let ar = 0;
    const groups = [];
    for (const [value, count] of counts) {
      ar += (count / n) ** 2;
      groups.push({ value, count, pct: count / n });
    }
    groups.sort((a, b) => b.count - a.count);
    rows.push({ command, ar, n, groups });
  }
  rows.sort((a, b) => a.command.localeCompare(b.command, "zh-Hant"));
  return rows;
}

function meanAndSd(values) {
  if (!values.length) return { mean: null, sd: null };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = values.length > 1
    ? Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1))
    : null;
  return { mean, sd };
}

// 論文用表格「複製」：同時放 text/html（貼到 Word 會是真的表格）跟 text/plain（純文字 TSV 備援）
async function copyTableToClipboard(tableEl) {
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

function wireCopyButtons(container) {
  container.querySelectorAll("[data-copy-table]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const tableEl = btn.closest(".final-analysis-series-block")?.querySelector("table");
      if (!tableEl) return;
      const ok = await copyTableToClipboard(tableEl);
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = ok ? "已複製！" : "複製失敗";
      setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1500);
    });
  });
}

function svgToDownloadUrl(svgEl) {
  let source = new XMLSerializer().serializeToString(svgEl);
  if (!/^<svg[^>]+xmlns=/.test(source)) {
    source = source.replace("<svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"");
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
}

function triggerDownload(href, filename) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// 把 SVG 轉成點陣 PNG（放大 2 倍取得列印用解析度），方便直接貼進 Word 論文；
// 用 <img> 載入 data URL 再畫進 canvas，是瀏覽器端不需額外套件的標準做法。
function svgToPngBlob(svgEl, scale = 2) {
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

// 論文用長條圖的共用繪製器：真正的 SVG 座標軸（含格線/刻度、可選誤差線），
// 各卡片只要把 categories/series 準備好、告訴它怎麼從一列資料取值，就能畫出風格一致、
// 可各自匯出成 SVG/PNG 的圖表——DurationStatsCard 跟 AgreementRateCard 都靠它畫長條圖。
function renderAxisBarChart({ title, categories, series, getValue, getError, yLabel, niceMax, ticks, formatTick, ariaLabel }) {
  const width = 680, height = 380;
  const margin = { top: 40, right: 20, bottom: 88, left: 58 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const yScale = v => margin.top + plotH - (v / niceMax) * plotH;

  const gridLines = ticks.map(t => {
    const y = yScale(t);
    return `<line x1="${margin.left}" y1="${y.toFixed(1)}" x2="${width - margin.right}" y2="${y.toFixed(1)}" stroke="#ddd" stroke-width="1" />
      <text x="${margin.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#333">${formatTick(t)}</text>`;
  }).join("");

  const groupWidth = plotW / categories.length;
  const groupPad = 10;
  const barGap = 3;
  const barWidth = Math.max(4, (groupWidth - groupPad * 2 - barGap * (series.length - 1)) / series.length);

  const bars = categories.map((cat, ci) => {
    const groupX = margin.left + ci * groupWidth;
    const barsForGroup = series.map((s, si) => {
      const row = s.rowsByCategory[ci];
      const v = getValue(row);
      const sd = getError ? getError(row) : 0;
      const x = groupX + groupPad + si * (barWidth + barGap);
      const yTop = yScale(v);
      const yBase = yScale(0);
      const color = CHART_PALETTE[si % CHART_PALETTE.length];
      const cx = x + barWidth / 2;
      const errorSvg = sd > 0 ? (() => {
        const yErrTop = yScale(v + sd);
        const yErrBottom = yScale(Math.max(0, v - sd));
        return `<line x1="${cx.toFixed(1)}" y1="${yErrTop.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yErrBottom.toFixed(1)}" stroke="#111" stroke-width="1.2" />
          <line x1="${(cx - 4).toFixed(1)}" y1="${yErrTop.toFixed(1)}" x2="${(cx + 4).toFixed(1)}" y2="${yErrTop.toFixed(1)}" stroke="#111" stroke-width="1.2" />
          <line x1="${(cx - 4).toFixed(1)}" y1="${yErrBottom.toFixed(1)}" x2="${(cx + 4).toFixed(1)}" y2="${yErrBottom.toFixed(1)}" stroke="#111" stroke-width="1.2" />`;
      })() : "";
      return `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0, yBase - yTop).toFixed(1)}" fill="${color}" stroke="#222" stroke-width="0.6" />${errorSvg}`;
    }).join("");
    const labelX = groupX + groupWidth / 2;
    const labelY = height - margin.bottom + 14;
    return `${barsForGroup}<text x="${labelX.toFixed(1)}" y="${labelY}" text-anchor="end" font-size="11" fill="#222" transform="rotate(-35 ${labelX.toFixed(1)} ${labelY})">${escapeHtml(cat)}</text>`;
  }).join("");

  const axisLines = `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#222" stroke-width="1.2" />
    <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#222" stroke-width="1.2" />`;

  const yLabelSvg = `<text x="${-(margin.top + plotH / 2).toFixed(1)}" y="16" text-anchor="middle" font-size="12" fill="#222" transform="rotate(-90)">${escapeHtml(yLabel)}</text>`;
  const titleSvg = `<text x="${width / 2}" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="#111">${escapeHtml(title)}</text>`;

  const svg = `<svg viewBox="0 0 ${width} ${height}" class="final-analysis-chart-svg" role="img" aria-label="${escapeHtml(ariaLabel || "統計長條圖")}">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
    ${titleSvg}${gridLines}${axisLines}${bars}${yLabelSvg}
  </svg>`;

  const legend = series.length > 1
    ? `<div class="final-analysis-chart-legend">${series.map((s, i) => `<span class="final-analysis-chart-legend-item"><span class="final-analysis-chart-swatch" style="background:${CHART_PALETTE[i % CHART_PALETTE.length]}"></span>${escapeHtml(s.label)}</span>`).join("")}</div>`
    : "";

  return `<div class="final-analysis-chart-export">
    ${svg}
    ${legend}
    <div class="final-analysis-chart-actions">
      <button class="archive-action-btn archive-action-btn--sm" data-export-svg>下載向量圖（SVG）</button>
      <button class="archive-action-btn archive-action-btn--sm" data-export-png>下載圖片（PNG）</button>
    </div>
  </div>`;
}

export class DurationStatsCard {
  constructor() {
    this._container = null;
    this._records = null;
    this._loading = false;
    this._error = null;
    this._selectedIds = new Set();
    this._mode = "merge"; // "merge" | "compare"
    this._metric = "avg"; // "avg" | "over" — 只影響長條圖／圓環圖，表格恆常兩欄都顯示
    this._view = "bar"; // "bar" | "donut" | "table"
    // 卡片標題可自行編輯，會一併畫進匯出的圖片裡；每張卡片都是同一個模板的獨立副本，
    // 可各自設定範圍/指標/檢視後各自匯出成論文用圖，onRemove 由外部（manager）注入才會顯示移除按鈕
    this._title = "指令平均時間 / 超過平均次數";
    this.onRemove = null;
  }

  init(container) {
    this._container = container;
    if (this._records == null && !this._loading) {
      this._load();
      return;
    }
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

  _refresh() {
    this._records = null;
    this._load();
  }

  _setTitle(title) {
    this._title = title.trim() || this._title;
    this._render();
  }

  async _load() {
    this._loading = true;
    this._error = null;
    this._render();
    try {
      const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.ANALYSIS.LIST}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "未知錯誤");
      this._records = (data.records || []).filter(r => r.attempts?.length);
    } catch (err) {
      this._error = err.message || String(err);
      this._records = [];
    }
    this._loading = false;
    this._render();
  }

  _toggleSelected(id) {
    if (this._selectedIds.has(id)) this._selectedIds.delete(id);
    else this._selectedIds.add(id);
    this._render();
  }

  _toggleStageAll(stage, checked) {
    for (const r of this._records) {
      if (r.stage !== stage) continue;
      if (checked) this._selectedIds.add(keyOf(r));
      else this._selectedIds.delete(keyOf(r));
    }
    this._render();
  }

  _setMode(mode) { this._mode = mode; this._render(); }
  _setMetric(metric) { this._metric = metric; this._render(); }
  _setView(view) { this._view = view; this._render(); }

  _computeSeries() {
    const selected = this._records.filter(r => this._selectedIds.has(keyOf(r)));
    if (!selected.length) return [];
    if (this._mode === "merge") {
      const pool = selected.flatMap(r => r.attempts);
      return [{ label: "合併統計", rows: aggregateByCommand(pool) }];
    }
    return selected.map(r => ({
      label: `受試者 ${r.trackingId}${nameOf(r) ? ` ${nameOf(r)}` : ""} · ${STAGE_LABELS[r.stage] || r.stage}`,
      rows: aggregateByCommand(r.attempts),
    }));
  }

  _renderScopeList() {
    if (!this._records.length) {
      return `<div class="assist-mark-empty">
        <p>目前沒有可分析的資料，請先在「比對名單」分頁完成比對並按下「全部儲存」。</p>
      </div>`;
    }
    const byStage = new Map();
    for (const r of this._records) {
      if (!byStage.has(r.stage)) byStage.set(r.stage, []);
      byStage.get(r.stage).push(r);
    }
    const groups = STAGE_ORDER.filter(stage => byStage.has(stage)).map(stage => {
      const list = byStage.get(stage);
      const allChecked = list.every(r => this._selectedIds.has(keyOf(r)));
      const items = list.map(r => {
        const id = keyOf(r);
        const checked = this._selectedIds.has(id) ? "checked" : "";
        const name = nameOf(r);
        return `<label class="final-analysis-scope-item">
          <input type="checkbox" data-scope-id="${escapeHtml(id)}" ${checked}>
          <span>受試者 ${escapeHtml(r.trackingId)}${name ? ` ${escapeHtml(name)}` : ""} · ${escapeHtml(r.date || "")}</span>
        </label>`;
      }).join("");
      return `<div class="final-analysis-scope-group">
        <label class="final-analysis-scope-group-title">
          <input type="checkbox" data-scope-stage="${stage}" ${allChecked ? "checked" : ""}>
          <span>${STAGE_LABELS[stage] || stage}</span>
        </label>
        <div class="final-analysis-scope-items">${items}</div>
      </div>`;
    }).join("");
    return `<div class="final-analysis-scope-list">${groups}</div>`;
  }

  // 論文用長條圖：真正的 SVG 座標軸（含格線/刻度），平均時間附 ±SD 誤差線，
  // 超過次數則用整數刻度，避免以往用寬度百分比呈現小整數時看起來很怪。
  _renderChart(series) {
    const metricKey = this._metric === "avg" ? "avgMs" : "overCount";
    const showError = this._metric === "avg";
    const toUnit = v => (this._metric === "avg" ? v / 1000 : v);

    const categories = [];
    const seen = new Set();
    series.forEach(s => s.rows.forEach(r => {
      if (!seen.has(r.command)) { seen.add(r.command); categories.push(r.command); }
    }));
    if (!categories.length) return "<div class=\"assist-mark-empty\"><p>沒有可繪製的資料。</p></div>";

    const rowsByCommand = series.map(s => {
      const map = new Map(s.rows.map(r => [r.command, r]));
      return categories.map(c => map.get(c) || { command: c, avgMs: 0, sdMs: null, sampleCount: 0, overCount: 0, avgLabel: "—" });
    });

    let maxVal = 0;
    rowsByCommand.forEach(rows => rows.forEach(r => {
      const v = toUnit(r[metricKey] || 0);
      const sd = showError && r.sdMs != null ? toUnit(r.sdMs) : 0;
      maxVal = Math.max(maxVal, v + sd);
    }));
    if (maxVal <= 0) maxVal = 1;

    const tickCount = 5;
    let niceMax, ticks;
    if (this._metric === "over") {
      const step = Math.max(1, Math.ceil(Math.ceil(maxVal) / tickCount));
      niceMax = step * tickCount;
      ticks = Array.from({ length: tickCount + 1 }, (_, i) => step * i);
    } else {
      niceMax = niceCeil(maxVal * 1.15);
      ticks = Array.from({ length: tickCount + 1 }, (_, i) => (niceMax / tickCount) * i);
    }

    const seriesWithRows = series.map((s, si) => ({ label: s.label, rowsByCategory: rowsByCommand[si] }));
    const yLabel = this._metric === "avg" ? "平均花費時間（秒）" : "超過平均次數（次）";
    const formatTick = v => (this._metric === "avg" ? v.toFixed(v < 10 ? 1 : 0) : String(Math.round(v)));

    return renderAxisBarChart({
      title: this._title,
      categories,
      series: seriesWithRows,
      getValue: r => toUnit(r[metricKey] || 0),
      getError: showError ? r => (r.sdMs != null ? toUnit(r.sdMs) : 0) : null,
      yLabel,
      niceMax,
      ticks,
      formatTick,
      ariaLabel: "統計長條圖",
    });
  }

  // 論文用圓環圖：改以 SVG 扇形繪製（可直接輸出向量圖），保留百分比圖例；
  // 每個系列各自的 svg 都會各自匯出成一張圖，所以標題連同系列名稱一起畫在圖上，單獨拿出去也看得懂。
  _renderDonut(series) {
    const metricKey = this._metric === "avg" ? "avgMs" : "overCount";
    const size = 220, titleH = 34, r = 82, cx = size / 2, cy = titleH + size / 2 - 6;
    const viewH = size + titleH;
    return series.map(s => {
      const titleText = series.length > 1 ? `${this._title} — ${s.label}` : this._title;
      const titleSvg = `<text x="${size / 2}" y="18" text-anchor="middle" font-size="13" font-weight="700" fill="#111">${escapeHtml(titleText)}</text>`;
      const total = s.rows.reduce((sum, row) => sum + Math.max(0, row[metricKey] || 0), 0);
      let svgInner = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ddd" stroke-width="1.5" />`;
      const legendItems = [];
      if (total > 0) {
        let angleStart = -90;
        const paths = [];
        s.rows.forEach((row, i) => {
          const val = Math.max(0, row[metricKey] || 0);
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
          legendItems.push(`<div class="final-analysis-donut-legend-item">
            <span class="final-analysis-donut-swatch" style="background:${color}"></span>
            <span>${escapeHtml(row.command)}（${pct}%）</span>
          </div>`);
        });
        svgInner = paths.join("") + `<circle cx="${cx}" cy="${cy}" r="${(r * 0.55).toFixed(1)}" fill="#fff" />`;
      }
      const legend = legendItems.length ? legendItems.join("") : "<p class=\"final-analysis-donut-empty\">尚無資料</p>";
      return `<div class="final-analysis-series-block">
        ${series.length > 1 ? `<div class="final-analysis-series-label">${escapeHtml(s.label)}</div>` : ""}
        <div class="final-analysis-chart-export">
          <div class="final-analysis-donut-wrap">
            <svg viewBox="0 0 ${size} ${viewH}" class="final-analysis-donut-svg" role="img" aria-label="圓環圖">
              <rect x="0" y="0" width="${size}" height="${viewH}" fill="#ffffff" />
              ${titleSvg}${svgInner}
            </svg>
            <div class="final-analysis-donut-legend">${legend}</div>
          </div>
          <div class="final-analysis-chart-actions">
            <button class="archive-action-btn archive-action-btn--sm" data-export-svg>下載向量圖（SVG）</button>
            <button class="archive-action-btn archive-action-btn--sm" data-export-png>下載圖片（PNG）</button>
          </div>
        </div>
      </div>`;
    }).join("");
  }

  _renderTable(series) {
    return series.map(s => `
      <div class="final-analysis-series-block">
        ${series.length > 1 ? `<div class="final-analysis-series-label">${escapeHtml(s.label)}</div>` : ""}
        <div class="final-analysis-table-wrap">
          <table class="final-analysis-table">
            <thead><tr><th>手勢指令</th><th>平均時間</th><th>標準差</th><th>超過平均次數</th><th>有效樣本數</th></tr></thead>
            <tbody>${s.rows.map(r => `<tr>
              <td>${escapeHtml(r.command)}</td>
              <td>${escapeHtml(r.avgLabel)}</td>
              <td>${r.sdMs != null ? escapeHtml(formatClock(r.sdMs)) : "—"}</td>
              <td>${r.overCount}</td>
              <td>${r.sampleCount}</td>
            </tr>`).join("")}</tbody>
          </table>
        </div>
        <button class="archive-action-btn archive-action-btn--sm" data-copy-table>複製表格</button>
      </div>
    `).join("");
  }

  _render() {
    if (!this._container) return;

    const scopeHtml = this._loading
      ? "<div class=\"assist-mark-empty\"><h3>載入中…</h3></div>"
      : this._error
        ? `<div class="assist-mark-empty"><h3>載入失敗</h3><p>${escapeHtml(this._error)}</p></div>`
        : this._renderScopeList();

    const series = (!this._loading && !this._error) ? this._computeSeries() : [];
    const manyWarning = series.length > 8
      ? `<p class="final-analysis-missing-note">已選 ${series.length} 筆比較，圖表可能較擁擠，建議切換至表格檢視。</p>`
      : "";

    let statsBody = "";
    if (!this._loading && !this._error) {
      if (!series.length) {
        statsBody = "<div class=\"assist-mark-empty\"><p>請先在左側勾選要分析的實驗。</p></div>";
      } else if (this._view === "bar") {
        statsBody = this._renderChart(series);
      } else if (this._view === "donut") {
        statsBody = this._renderDonut(series);
      } else {
        statsBody = this._renderTable(series);
      }
    }

    this._container.innerHTML = `<div class="final-analysis-card">
      <div class="final-analysis-card-titlebar">
        <div class="assist-mark-title-wrap">
          <input class="final-analysis-card-title-input" data-stats-title value="${escapeHtml(this._title)}" placeholder="圖表標題（會一併畫進匯出的圖片）">
          <div class="assist-mark-subtitle">依手勢指令統計平均花費時間與超過自身平均值的次數（花費時間空白的紀錄不計入統計）</div>
        </div>
        <div class="final-analysis-card-titlebar-actions">
          <button class="archive-action-btn archive-action-btn--sm" data-stats-refresh ${this._loading ? "disabled" : ""}>重新整理</button>
          ${typeof this.onRemove === "function" ? "<button class=\"archive-action-btn archive-action-btn--sm archive-action-btn--danger\" data-stats-remove>移除卡片</button>" : ""}
        </div>
      </div>
      <div class="final-analysis-card-body">
        <div class="final-analysis-card-scope">${scopeHtml}</div>
        <div class="final-analysis-card-stats">
          <div class="final-analysis-card-controls">
            <div class="final-analysis-btn-group">
              <button class="archive-action-btn${this._mode === "merge" ? " is-active" : ""}" data-stats-mode="merge">合併統計</button>
              <button class="archive-action-btn${this._mode === "compare" ? " is-active" : ""}" data-stats-mode="compare">比較</button>
            </div>
            <div class="final-analysis-btn-group">
              <button class="archive-action-btn${this._metric === "avg" ? " is-active" : ""}" data-stats-metric="avg">平均時間</button>
              <button class="archive-action-btn${this._metric === "over" ? " is-active" : ""}" data-stats-metric="over">超過平均次數</button>
            </div>
            <div class="final-analysis-btn-group">
              <button class="archive-action-btn${this._view === "bar" ? " is-active" : ""}" data-stats-view="bar">長條圖</button>
              <button class="archive-action-btn${this._view === "donut" ? " is-active" : ""}" data-stats-view="donut">圓環圖</button>
              <button class="archive-action-btn${this._view === "table" ? " is-active" : ""}" data-stats-view="table">表格</button>
            </div>
          </div>
          ${manyWarning}
          <div class="final-analysis-card-content">${statsBody}</div>
        </div>
      </div>
    </div>`;

    this._wireEvents();
  }

  _wireEvents() {
    wireCopyButtons(this._container);
    const refreshBtn = this._container.querySelector("[data-stats-refresh]");
    if (refreshBtn) refreshBtn.addEventListener("click", () => this._refresh());
    const removeBtn = this._container.querySelector("[data-stats-remove]");
    if (removeBtn) removeBtn.addEventListener("click", () => this.onRemove?.());
    const titleInput = this._container.querySelector("[data-stats-title]");
    if (titleInput) titleInput.addEventListener("change", () => this._setTitle(titleInput.value));
    this._container.querySelectorAll("[data-scope-id]").forEach(el => {
      el.addEventListener("change", () => this._toggleSelected(el.dataset.scopeId));
    });
    this._container.querySelectorAll("[data-scope-stage]").forEach(el => {
      el.addEventListener("change", () => this._toggleStageAll(el.dataset.scopeStage, el.checked));
    });
    this._container.querySelectorAll("[data-stats-mode]").forEach(el => {
      el.addEventListener("click", () => this._setMode(el.dataset.statsMode));
    });
    this._container.querySelectorAll("[data-stats-metric]").forEach(el => {
      el.addEventListener("click", () => this._setMetric(el.dataset.statsMetric));
    });
    this._container.querySelectorAll("[data-stats-view]").forEach(el => {
      el.addEventListener("click", () => this._setView(el.dataset.statsView));
    });
    const filenameBase = () => {
      const safeTitle = this._title.replace(/[\\/:*?"<>|]+/g, "_").trim() || "chart";
      return `${safeTitle}_${this._metric}`;
    };
    this._container.querySelectorAll("[data-export-svg]").forEach(btn => {
      btn.addEventListener("click", () => {
        const svgEl = btn.closest(".final-analysis-chart-export")?.querySelector("svg");
        if (!svgEl) return;
        triggerDownload(svgToDownloadUrl(svgEl), `${filenameBase()}.svg`);
      });
    });
    this._container.querySelectorAll("[data-export-png]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const svgEl = btn.closest(".final-analysis-chart-export")?.querySelector("svg");
        if (!svgEl) return;
        btn.disabled = true;
        try {
          const blob = await svgToPngBlob(svgEl);
          const url = URL.createObjectURL(blob);
          triggerDownload(url, `${filenameBase()}.png`);
          URL.revokeObjectURL(url);
        } catch (err) {
          alert(`圖片匯出失敗：${err.message || err}`);
        } finally {
          btn.disabled = false;
        }
      });
    });
  }
}

// Wobbrock et al. (2005) 同意率卡片：以「實驗組」（此研究的 stage）為主要分析範圍，
// 可再選填限定受試者，分析用的「Key」欄位完全動態——直接列出目前資料裡實際出現過的欄位讓使用者挑，
// 不管是二三態的判定結果還是之後任何多狀態欄位都能套用同一套公式。
export class AgreementRateCard {
  constructor() {
    this._container = null;
    this._records = null;
    this._loading = false;
    this._error = null;
    this._selectedStages = new Set(STAGE_ORDER);
    this._selectedParticipants = new Set(); // 空集合＝不限定，全部受試者
    this._key = null; // 載入資料後才知道有哪些欄位可選，預設優先挑 "type"
    this._mode = "merge"; // "merge" | "compare"（比較＝依實驗組分別列出）
    this._view = "table"; // "table" | "bar"
    this._title = "同意率（Wobbrock et al., 2005）";
    this.onRemove = null;
  }

  init(container) {
    this._container = container;
    if (this._records == null && !this._loading) {
      this._load();
      return;
    }
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

  _refresh() {
    this._records = null;
    this._load();
  }

  _setTitle(title) {
    this._title = title.trim() || this._title;
    this._render();
  }

  async _load() {
    this._loading = true;
    this._error = null;
    this._render();
    try {
      const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.ANALYSIS.LIST}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "未知錯誤");
      this._records = (data.records || []).filter(r => r.attempts?.length);
      if (!this._key) {
        const keys = discoverAgreementKeys(this._records);
        this._key = keys.includes("type") ? "type" : (keys[0] || null);
      }
    } catch (err) {
      this._error = err.message || String(err);
      this._records = [];
    }
    this._loading = false;
    this._render();
  }

  _toggleStage(stage, checked) {
    if (checked) this._selectedStages.add(stage);
    else this._selectedStages.delete(stage);
    this._render();
  }

  _toggleParticipant(id, checked) {
    if (checked) this._selectedParticipants.add(id);
    else this._selectedParticipants.delete(id);
    this._render();
  }

  _setKey(key) { this._key = key || null; this._render(); }
  _setMode(mode) { this._mode = mode; this._render(); }
  _setView(view) { this._view = view; this._render(); }

  _participantList() {
    const map = new Map();
    for (const r of this._records) {
      if (!map.has(r.trackingId)) map.set(r.trackingId, nameOf(r));
    }
    return Array.from(map.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0]), "zh-Hant"));
  }

  _computeSeries() {
    if (!this._key) return [];
    let selected = this._records.filter(r => this._selectedStages.has(r.stage));
    if (this._selectedParticipants.size) {
      selected = selected.filter(r => this._selectedParticipants.has(r.trackingId));
    }
    if (!selected.length) return [];
    if (this._mode === "merge") {
      const pool = selected.flatMap(r => r.attempts);
      return [{ label: "合併統計", rows: computeAgreement(pool, this._key) }];
    }
    return STAGE_ORDER.filter(stage => selected.some(r => r.stage === stage)).map(stage => ({
      label: STAGE_LABELS[stage] || stage,
      rows: computeAgreement(selected.filter(r => r.stage === stage).flatMap(r => r.attempts), this._key),
    }));
  }

  _renderControls() {
    if (!this._records.length) {
      return `<div class="assist-mark-empty">
        <p>目前沒有可分析的資料，請先在「比對名單」分頁完成比對並按下「全部儲存」。</p>
      </div>`;
    }
    const availableKeys = discoverAgreementKeys(this._records);
    const stageItems = STAGE_ORDER.filter(stage => this._records.some(r => r.stage === stage)).map(stage => {
      const checked = this._selectedStages.has(stage) ? "checked" : "";
      return `<label class="final-analysis-scope-item">
        <input type="checkbox" data-agreement-stage="${stage}" ${checked}>
        <span>${STAGE_LABELS[stage] || stage}</span>
      </label>`;
    }).join("");

    const participantItems = this._participantList().map(([id, name]) => {
      const checked = this._selectedParticipants.has(id) ? "checked" : "";
      return `<label class="final-analysis-scope-item">
        <input type="checkbox" data-agreement-participant="${escapeHtml(id)}" ${checked}>
        <span>受試者 ${escapeHtml(id)}${name ? ` ${escapeHtml(name)}` : ""}</span>
      </label>`;
    }).join("");

    const keyOptions = availableKeys.length
      ? availableKeys.map(k => `<option value="${escapeHtml(k)}" ${this._key === k ? "selected" : ""}>${escapeHtml(k)}</option>`).join("")
      : "<option value=\"\">（無可用欄位）</option>";

    return `<div class="final-analysis-scope-list">
      <div class="final-analysis-scope-group">
        <div class="final-analysis-scope-group-title final-analysis-scope-group-title--static"><span>實驗組（階段）</span></div>
        <div class="final-analysis-scope-items">${stageItems}</div>
      </div>
      <div class="final-analysis-scope-group">
        <div class="final-analysis-scope-group-title final-analysis-scope-group-title--static"><span>限定受試者（選填，不勾＝全部）</span></div>
        <div class="final-analysis-scope-items final-analysis-scope-items--scroll">${participantItems}</div>
      </div>
      <div class="final-analysis-scope-group">
        <label class="final-analysis-key-label">分析 Key（原始資料欄位，自動偵測）
          <select class="final-analysis-key-select" data-agreement-key>${keyOptions}</select>
        </label>
      </div>
    </div>`;
  }

  _renderTable(series) {
    return series.map(s => {
      const validAr = s.rows.filter(r => r.n > 0).map(r => r.ar);
      const { mean, sd } = meanAndSd(validAr);
      return `<div class="final-analysis-series-block">
        ${series.length > 1 ? `<div class="final-analysis-series-label">${escapeHtml(s.label)}</div>` : ""}
        <div class="final-analysis-table-wrap">
          <table class="final-analysis-table">
            <thead><tr><th>手勢指令</th><th>同意率 A_r</th><th>樣本數 N</th><th>最大宗類別（佔比）</th></tr></thead>
            <tbody>${s.rows.map(r => `<tr>
              <td>${escapeHtml(r.command)}</td>
              <td>${r.n ? r.ar.toFixed(3) : "—"}</td>
              <td>${r.n}</td>
              <td>${r.groups[0] ? `${escapeHtml(r.groups[0].value)}（${Math.round(r.groups[0].pct * 100)}%）` : "—"}</td>
            </tr>`).join("")}</tbody>
          </table>
        </div>
        <p class="final-analysis-agreement-summary">平均同意率 = ${mean != null ? mean.toFixed(3) : "—"}${sd != null ? `（SD = ${sd.toFixed(3)}）` : ""}，共 ${s.rows.length} 個指令</p>
        <button class="archive-action-btn archive-action-btn--sm" data-copy-table>複製表格</button>
      </div>`;
    }).join("");
  }

  _renderChart(series) {
    const categories = [];
    const seen = new Set();
    series.forEach(s => s.rows.forEach(r => {
      if (!seen.has(r.command)) { seen.add(r.command); categories.push(r.command); }
    }));
    if (!categories.length) return "<div class=\"assist-mark-empty\"><p>沒有可繪製的資料。</p></div>";

    const seriesWithRows = series.map(s => {
      const map = new Map(s.rows.map(r => [r.command, r]));
      return { label: s.label, rowsByCategory: categories.map(c => map.get(c) || { command: c, ar: 0, n: 0, groups: [] }) };
    });

    const tickCount = 5;
    const ticks = Array.from({ length: tickCount + 1 }, (_, i) => i / tickCount);

    return renderAxisBarChart({
      title: this._title,
      categories,
      series: seriesWithRows,
      getValue: r => r.ar || 0,
      getError: null,
      yLabel: "同意率 A_r",
      niceMax: 1,
      ticks,
      formatTick: v => v.toFixed(1),
      ariaLabel: "同意率長條圖",
    });
  }

  _render() {
    if (!this._container) return;

    const scopeHtml = this._loading
      ? "<div class=\"assist-mark-empty\"><h3>載入中…</h3></div>"
      : this._error
        ? `<div class="assist-mark-empty"><h3>載入失敗</h3><p>${escapeHtml(this._error)}</p></div>`
        : this._renderControls();

    const series = (!this._loading && !this._error) ? this._computeSeries() : [];

    let statsBody = "";
    if (!this._loading && !this._error) {
      if (!this._key) {
        statsBody = "<div class=\"assist-mark-empty\"><p>目前資料沒有可分析的欄位。</p></div>";
      } else if (!series.length) {
        statsBody = "<div class=\"assist-mark-empty\"><p>請先在左側選擇要分析的實驗組（階段）。</p></div>";
      } else if (this._view === "bar") {
        statsBody = this._renderChart(series);
      } else {
        statsBody = this._renderTable(series);
      }
    }

    this._container.innerHTML = `<div class="final-analysis-card">
      <div class="final-analysis-card-titlebar">
        <div class="assist-mark-title-wrap">
          <input class="final-analysis-card-title-input" data-stats-title value="${escapeHtml(this._title)}" placeholder="圖表標題（會一併畫進匯出的圖片）">
          <div class="assist-mark-subtitle">Wobbrock et al. (2005) 同意率 A_r = Σ(n_i/N)²，依手勢指令分組計算，可自選要比對的原始資料欄位</div>
        </div>
        <div class="final-analysis-card-titlebar-actions">
          <button class="archive-action-btn archive-action-btn--sm" data-stats-refresh ${this._loading ? "disabled" : ""}>重新整理</button>
          ${typeof this.onRemove === "function" ? "<button class=\"archive-action-btn archive-action-btn--sm archive-action-btn--danger\" data-stats-remove>移除卡片</button>" : ""}
        </div>
      </div>
      <div class="final-analysis-card-body">
        <div class="final-analysis-card-scope">${scopeHtml}</div>
        <div class="final-analysis-card-stats">
          <div class="final-analysis-card-controls">
            <div class="final-analysis-btn-group">
              <button class="archive-action-btn${this._mode === "merge" ? " is-active" : ""}" data-stats-mode="merge">合併統計</button>
              <button class="archive-action-btn${this._mode === "compare" ? " is-active" : ""}" data-stats-mode="compare">依實驗組比較</button>
            </div>
            <div class="final-analysis-btn-group">
              <button class="archive-action-btn${this._view === "table" ? " is-active" : ""}" data-stats-view="table">表格</button>
              <button class="archive-action-btn${this._view === "bar" ? " is-active" : ""}" data-stats-view="bar">長條圖</button>
            </div>
          </div>
          <div class="final-analysis-card-content">${statsBody}</div>
        </div>
      </div>
    </div>`;

    this._wireEvents();
  }

  _wireEvents() {
    wireCopyButtons(this._container);
    const refreshBtn = this._container.querySelector("[data-stats-refresh]");
    if (refreshBtn) refreshBtn.addEventListener("click", () => this._refresh());
    const removeBtn = this._container.querySelector("[data-stats-remove]");
    if (removeBtn) removeBtn.addEventListener("click", () => this.onRemove?.());
    const titleInput = this._container.querySelector("[data-stats-title]");
    if (titleInput) titleInput.addEventListener("change", () => this._setTitle(titleInput.value));
    this._container.querySelectorAll("[data-agreement-stage]").forEach(el => {
      el.addEventListener("change", () => this._toggleStage(el.dataset.agreementStage, el.checked));
    });
    this._container.querySelectorAll("[data-agreement-participant]").forEach(el => {
      el.addEventListener("change", () => this._toggleParticipant(el.dataset.agreementParticipant, el.checked));
    });
    const keySelect = this._container.querySelector("[data-agreement-key]");
    if (keySelect) keySelect.addEventListener("change", () => this._setKey(keySelect.value));
    this._container.querySelectorAll("[data-stats-mode]").forEach(el => {
      el.addEventListener("click", () => this._setMode(el.dataset.statsMode));
    });
    this._container.querySelectorAll("[data-stats-view]").forEach(el => {
      el.addEventListener("click", () => this._setView(el.dataset.statsView));
    });
    const filenameBase = () => {
      const safeTitle = this._title.replace(/[\\/:*?"<>|]+/g, "_").trim() || "chart";
      return `${safeTitle}_${this._key || "agreement"}`;
    };
    this._container.querySelectorAll("[data-export-svg]").forEach(btn => {
      btn.addEventListener("click", () => {
        const svgEl = btn.closest(".final-analysis-chart-export")?.querySelector("svg");
        if (!svgEl) return;
        triggerDownload(svgToDownloadUrl(svgEl), `${filenameBase()}.svg`);
      });
    });
    this._container.querySelectorAll("[data-export-png]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const svgEl = btn.closest(".final-analysis-chart-export")?.querySelector("svg");
        if (!svgEl) return;
        btn.disabled = true;
        try {
          const blob = await svgToPngBlob(svgEl);
          const url = URL.createObjectURL(blob);
          triggerDownload(url, `${filenameBase()}.png`);
          URL.revokeObjectURL(url);
        } catch (err) {
          alert(`圖片匯出失敗：${err.message || err}`);
        } finally {
          btn.disabled = false;
        }
      });
    });
  }
}
