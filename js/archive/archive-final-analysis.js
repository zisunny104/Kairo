/**
 * archive-final-analysis.js — 最終分析分頁
 * 讀取「比對名單」確認、按下「全部儲存」後寫入伺服器 runtime/analysis/ 的三階段資料，
 * 線上預覽（純表格）後再下載 CSV / Excel。
 */
import { getApiUrl } from "../core/url-utils.js";
import { getAdminToken, clearAdminToken } from "../core/admin-auth.js";
import { API_ENDPOINTS } from "../constants/index.js";
import { downloadXlsx, downloadCsv } from "../core/xlsx-export.js";
import {
  escapeHtml, showToast, parseJsonResponse,
  renderActionsCollapseBtn, loadCollapsedPref, saveCollapsedPref,
} from "./archive-constants.js";
import { getParticipants, getParticipantNameMap } from "./archive-roster.js";
import { GestureAgreementCard, ErrorRateComparisonCard, ReactionTimeCard } from "./archive-final-analysis-cards.js";
import { parseClockMs, formatSecondsMs } from "./archive-assist-mark.js";

const ACTIONS_COLLAPSED_KEY = "archive_final_analysis_actions_collapsed_v1";
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
    // 三張分析卡片固定存在，之後要加新的分析項目類型就在這裡追加一個 new XxxCard() 即可
    this._cards = [new GestureAgreementCard(), new ErrorRateComparisonCard(), new ReactionTimeCard()];
    this._actionsCollapsed = loadCollapsedPref(ACTIONS_COLLAPSED_KEY);
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
    const participants = await getParticipants();
    const hasStage = p => {
      if (stage === "1") return !!p.stage1?.experimentId;
      if (stage === "2-1") return !!p.stage2?.attempt1?.experimentId;
      if (stage === "2-2") return !!p.stage2?.attempt2?.experimentId;
      return false;
    };
    return participants.filter(hasStage).length;
  }

  async _buildStageRows(stage) {
    const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.ANALYSIS.LIST}`);
    const data = await parseJsonResponse(res);
    if (!data.success) throw new Error(data.error || "未知錯誤");
    const records = (data.records || []).filter(r => r.stage === stage);
    const withAttempts = records.filter(r => r.attempts?.length);
    // 受試者姓名一律用 trackingId 去名單（participants.json）查，不從分析紀錄裡讀，避免到處存重複的值
    const nameMap = await getParticipantNameMap();

    // idx：這個檔案（該階段）所有列的總序列，從 1 連續編號到底，不因人／實驗切段重來。
    // 之後不管在 Excel 或分析時怎麼篩選、排序，都能靠 idx 還原原始順序，
    // 最後一筆的 idx 也就是這個檔案的總資料筆數，方便核對。
    const rows = [ROW_HEADERS];
    let idx = 0;
    for (const r of withAttempts) {
      const name = nameMap.get(r.trackingId) || "";
      r.attempts.forEach(a => {
        idx += 1;
        rows.push([idx, r.trackingId, r.experimentId, name, a.gestureCommand || "", a.type || "", a.typeRaw || "", a.note || "", formatSecondsMs(parseClockMs(a.duration))]);
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
        showToast(`目前還沒有階段「${STAGE_LABELS[stage]}」的資料，請先到「比對名單」分頁完成比對，並按下「全部儲存」。`, "warning", 6000);
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
      showToast(`預覽失敗：${err.message || err}`, "error");
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

    const cardsHtml = `<div class="final-analysis-cards">${this._cards.map((_, i) => `<div class="final-analysis-card-slot" id="finalAnalysisCardSlot${i}"></div>`).join("")}</div>`;

    this._container.innerHTML = `<div class="final-analysis-shell">
      <div class="final-analysis-topbar">
        <div class="assist-mark-title-wrap">
          <div class="assist-mark-title">最終分析</div>
          <div class="assist-mark-subtitle">${isPreviewMode ? "預覽「比對名單」已確認儲存的三階段逐筆手勢紀錄，確認無誤後再下載" : "各項統計分析卡片，點卡片內選項可切換要分析的資料範圍與呈現方式"}</div>
        </div>
        <div class="assist-mark-actions-group">
          ${renderActionsCollapseBtn("data-final-toggle-actions", this._actionsCollapsed)}
          <div class="assist-mark-actions${this._actionsCollapsed ? " is-collapsed" : ""}">
            <button class="archive-action-btn${!isPreviewMode ? " is-active" : ""}" data-final-mode="analysis">分析總覽</button>
            <button class="archive-action-btn${isPreviewMode && this._previewStage === "1" ? " is-active" : ""}" data-final-preview="1" ${this._loading ? "disabled" : ""}>預覽第一階段</button>
            <button class="archive-action-btn${isPreviewMode && this._previewStage === "2-1" ? " is-active" : ""}" data-final-preview="2-1" ${this._loading ? "disabled" : ""}>預覽第二階段（第一次）</button>
            <button class="archive-action-btn${isPreviewMode && this._previewStage === "2-2" ? " is-active" : ""}" data-final-preview="2-2" ${this._loading ? "disabled" : ""}>預覽第二階段（第二次）</button>
            <button class="archive-action-btn" data-final-download="csv" ${isPreviewMode && hasPreview ? "" : "disabled"}>下載 CSV</button>
            <button class="archive-action-btn" data-final-download="xlsx" ${isPreviewMode && hasPreview ? "" : "disabled"}>下載 Excel</button>
          </div>
        </div>
      </div>
      ${isPreviewMode ? missingHtml + tableHtml : cardsHtml}
    </div>`;

    const toggleActionsBtn = this._container.querySelector("[data-final-toggle-actions]");
    if (toggleActionsBtn) toggleActionsBtn.addEventListener("click", () => {
      this._actionsCollapsed = !this._actionsCollapsed;
      saveCollapsedPref(ACTIONS_COLLAPSED_KEY, this._actionsCollapsed);
      this._render();
    });

    this._container.querySelector("[data-final-mode=\"analysis\"]").addEventListener("click", () => this._showAnalysis());
    this._container.querySelectorAll("[data-final-preview]").forEach(btn => {
      btn.addEventListener("click", () => this._preview(btn.dataset.finalPreview));
    });
    this._container.querySelectorAll("[data-final-download]").forEach(btn => {
      btn.addEventListener("click", () => this._downloadCurrent(btn.dataset.finalDownload));
    });

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
