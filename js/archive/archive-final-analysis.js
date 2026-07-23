/**
 * archive-final-analysis.js — 最終分析分頁
 * 讀取「比對名單」確認、按下「全部儲存」後寫入伺服器 runtime/analysis/ 的三階段資料，
 * 線上預覽（純表格）後再下載 CSV / Excel。
 */
import { getApiUrl } from "../core/url-utils.js";
import { getAdminToken, clearAdminToken } from "../core/admin-auth.js";
import { API_ENDPOINTS } from "../constants/index.js";
import { downloadXlsx, downloadCsv } from "../core/xlsx-export.js";
import { escapeHtml } from "./archive-constants.js";
import { DurationStatsCard, AgreementRateCard } from "./archive-final-analysis-cards.js";

const STAGE_LABELS = { "1": "第一階段", "2-1": "第二階段（第一次）", "2-2": "第二階段（第二次）" };
const ROW_HEADERS = ["idx", "id", "experiment_id", "participant_name", "gesture_command", "type", "type_raw", "note", "花費時間"];

class FinalAnalysisManager {
  constructor() {
    this._container = null;
    this._previewStage = null;
    this._previewRows = null; // 2D 陣列，含表頭
    this._previewMissing = null;
    this._loading = false;
    // 內容區有兩種模式：分析卡片（預設）／原始資料預覽（按上方任一「預覽」按鈕才切換）
    this._contentMode = "analysis";
    // 各分析項目各自一張卡片，之後要加新的分析項目類型就在這裡追加即可；
    // 每張卡片同時是可複製的「模板」——使用者可用「新增卡片」按同一類型再開一張，
    // 各自獨立設定範圍/指標/檢視/標題後分別匯出成論文用圖
    this._cards = [this._makeDurationCard()];
  }

  _makeDurationCard() {
    const card = new DurationStatsCard();
    card.onRemove = () => this._removeCard(card);
    return card;
  }

  _addDurationCard() {
    this._cards.push(this._makeDurationCard());
    this._render();
  }

  _makeAgreementCard() {
    const card = new AgreementRateCard();
    card.onRemove = () => this._removeCard(card);
    return card;
  }

  _addAgreementCard() {
    this._cards.push(this._makeAgreementCard());
    this._render();
  }

  _removeCard(card) {
    this._cards = this._cards.filter(c => c !== card);
    this._render();
  }

  init(container) {
    this._container = container;
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

  // 依階段統計名單裡「預期應該有」的受試者數，用來偵測預覽時是否還有未完成比對／儲存的筆數
  async _countExpectedForStage(stage) {
    try {
      const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.ROSTER.PARTICIPANTS}`);
      const data = await res.json();
      if (!data.success) return null;
      const hasStage = p => {
        if (stage === "1") return !!p.stage1?.experimentId;
        if (stage === "2-1") return !!p.stage2?.attempt1?.experimentId;
        if (stage === "2-2") return !!p.stage2?.attempt2?.experimentId;
        return false;
      };
      return (data.participants || []).filter(hasStage).length;
    } catch {
      return null;
    }
  }

  async _buildStageRows(stage) {
    const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.ANALYSIS.LIST}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || "未知錯誤");
    const records = (data.records || []).filter(r => r.stage === stage);
    const withAttempts = records.filter(r => r.attempts?.length);

    // idx：這個檔案（該階段）所有列的總序列，從 1 連續編號到底，不因人／實驗切段重來。
    // 之後不管在 Excel 或分析時怎麼篩選、排序，都能靠 idx 還原原始順序，
    // 最後一筆的 idx 也就是這個檔案的總資料筆數，方便核對。
    const rows = [ROW_HEADERS];
    let idx = 0;
    for (const r of withAttempts) {
      r.attempts.forEach(a => {
        idx += 1;
        rows.push([idx, r.trackingId, r.experimentId, a.participantName || "", a.gestureCommand || "", a.type || "", a.typeRaw || "", a.note || "", a.duration || ""]);
      });
    }
    return { rows, count: withAttempts.length };
  }

  _showAnalysis() {
    this._contentMode = "analysis";
    this._render();
  }

  async _preview(stage) {
    if (this._loading) return;
    this._contentMode = "preview";
    this._loading = true;
    this._render();
    try {
      const { rows, count } = await this._buildStageRows(stage);
      if (!count) {
        alert(`目前還沒有階段「${STAGE_LABELS[stage]}」的資料，請先到「比對名單」分頁完成比對，並按下「全部儲存」。`);
        this._loading = false;
        this._render();
        return;
      }
      const expectedTotal = await this._countExpectedForStage(stage);
      const missing = expectedTotal != null ? Math.max(0, expectedTotal - count) : null;
      this._previewStage = stage;
      this._previewRows = rows;
      this._previewMissing = missing;
    } catch (err) {
      alert(`預覽失敗：${err.message || err}`);
    }
    this._loading = false;
    this._render();
  }

  _downloadCurrent(type) {
    if (!this._previewRows || !this._previewStage) return;
    const filename = `final_analysis_stage_${this._previewStage}`;
    if (type === "csv") downloadCsv(this._previewRows, filename);
    else downloadXlsx(this._previewRows, filename, STAGE_LABELS[this._previewStage]);
  }

  _render() {
    if (!this._container) return;
    const hasPreview = !!this._previewRows;
    const isPreviewMode = this._contentMode === "preview";

    const tableHtml = hasPreview
      ? `<div class="final-analysis-table-wrap">
        <table class="final-analysis-table">
          <thead><tr>${this._previewRows[0].map(h => `<th>${escapeHtml(String(h))}</th>`).join("")}</tr></thead>
          <tbody>${this._previewRows.slice(1).map(row => `<tr>${row.map(cell => `<td>${escapeHtml(String(cell ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
      </div>`
      : `<div class="assist-mark-empty">
        <h3>${this._loading ? "載入中…" : "尚未預覽資料"}</h3>
        <p>請先在「比對名單」分頁完成比對並按下「全部儲存」，再回這裡按上方任一「預覽」按鈕。</p>
      </div>`;

    const missingHtml = hasPreview && this._previewMissing
      ? `<p class="final-analysis-missing-note">階段「${STAGE_LABELS[this._previewStage]}」名單上還有 ${this._previewMissing} 位受試者尚未完成比對／儲存，目前僅預覽已有的 ${this._previewRows.length - 1} 筆。</p>`
      : "";

    const emptyCardsHtml = this._cards.length
      ? ""
      : "<div class=\"assist-mark-empty\"><p>目前沒有卡片，按下方「新增卡片」開始一張新的統計圖表。</p></div>";
    const cardsHtml = `<div class="final-analysis-cards-toolbar">
      <button class="archive-action-btn archive-action-btn--sm" data-final-add-card="duration">+ 新增卡片（指令平均時間 / 超過平均次數）</button>
      <button class="archive-action-btn archive-action-btn--sm" data-final-add-card="agreement">+ 新增卡片（同意率 Agreement Rate）</button>
    </div>
    ${emptyCardsHtml}
    <div class="final-analysis-cards">${this._cards.map((_, i) => `<div class="final-analysis-card-slot" id="finalAnalysisCardSlot${i}"></div>`).join("")}</div>`;

    this._container.innerHTML = `<div class="final-analysis-shell">
      <div class="final-analysis-topbar">
        <div class="assist-mark-title-wrap">
          <div class="assist-mark-title">最終分析</div>
          <div class="assist-mark-subtitle">${isPreviewMode ? "預覽「比對名單」已確認儲存的三階段逐筆手勢紀錄，確認無誤後再下載" : "各項統計分析卡片，點卡片內選項可切換要分析的資料範圍與呈現方式"}</div>
        </div>
        <div class="assist-mark-actions">
          <button class="archive-action-btn${!isPreviewMode ? " is-active" : ""}" data-final-mode="analysis">分析總覽</button>
          <button class="archive-action-btn${isPreviewMode && this._previewStage === "1" ? " is-active" : ""}" data-final-preview="1" ${this._loading ? "disabled" : ""}>預覽第一階段</button>
          <button class="archive-action-btn${isPreviewMode && this._previewStage === "2-1" ? " is-active" : ""}" data-final-preview="2-1" ${this._loading ? "disabled" : ""}>預覽第二階段（第一次）</button>
          <button class="archive-action-btn${isPreviewMode && this._previewStage === "2-2" ? " is-active" : ""}" data-final-preview="2-2" ${this._loading ? "disabled" : ""}>預覽第二階段（第二次）</button>
          <button class="archive-action-btn" data-final-download="csv" ${isPreviewMode && hasPreview ? "" : "disabled"}>下載 CSV</button>
          <button class="archive-action-btn" data-final-download="xlsx" ${isPreviewMode && hasPreview ? "" : "disabled"}>下載 Excel</button>
        </div>
      </div>
      ${isPreviewMode ? missingHtml + tableHtml : cardsHtml}
    </div>`;

    this._container.querySelector("[data-final-mode=\"analysis\"]").addEventListener("click", () => this._showAnalysis());
    this._container.querySelectorAll("[data-final-preview]").forEach(btn => {
      btn.addEventListener("click", () => this._preview(btn.dataset.finalPreview));
    });
    this._container.querySelectorAll("[data-final-download]").forEach(btn => {
      btn.addEventListener("click", () => this._downloadCurrent(btn.dataset.finalDownload));
    });
    const addDurationBtn = this._container.querySelector("[data-final-add-card=\"duration\"]");
    if (addDurationBtn) addDurationBtn.addEventListener("click", () => this._addDurationCard());
    const addAgreementBtn = this._container.querySelector("[data-final-add-card=\"agreement\"]");
    if (addAgreementBtn) addAgreementBtn.addEventListener("click", () => this._addAgreementCard());

    if (!isPreviewMode) {
      this._cards.forEach((card, i) => {
        const slot = this._container.querySelector(`#finalAnalysisCardSlot${i}`);
        if (slot) card.init(slot);
      });
    }
  }
}

const _manager = new FinalAnalysisManager();

export function onFinalAnalysisActivate() {
  const el = document.getElementById("archiveFinalAnalysis");
  if (!el) return;
  _manager.init(el);
}
