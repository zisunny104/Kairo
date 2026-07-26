/**
 * archive-audit.js — 檢查異常：掃描目前開啟的檔案，列出具體發現的問題，
 * 每一項修正都要能被解釋、且可透過既有 undo 機制復原，不做黑箱猜測式修正。
 */

import { escapeHtml } from "./archive-constants.js";

const SEVERITY_LABEL = { high: "高", medium: "中", low: "低" };
const SEVERITY_COLOR = { high: "#e74c3c", medium: "#ff9800", low: "#667eea" };

/**
 * 掃描 entries，回傳發現的異常清單。
 * 每筆 finding：{ id, severity, title, detail, entryIndices, fix: { label, apply(fileState) } | null }
 */
export function findAnomalies(entries) {
  const findings = [];

  // ── 1. 步驟重複開始未正常結束 ─────────────────────────────────────────────
  const openByGIdx = new Map(); // g_idx -> startIdx（尚未被 gesture_step_end 關閉）
  const dupGIdx = new Set();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === "gesture_step_start") {
      if (openByGIdx.has(e.g_idx)) dupGIdx.add(e.g_idx);
      else openByGIdx.set(e.g_idx, i);
    } else if (e.type === "gesture_step_end" && openByGIdx.has(e.g_idx)) {
      openByGIdx.delete(e.g_idx);
    }
  }
  for (const gIdx of dupGIdx) {
    const related = entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.g_idx === gIdx && (e.type === "gesture_step_start" || e.type === "gesture_step_end"));
    const starts = related.filter(r => r.e.type === "gesture_step_start");
    const ends   = related.filter(r => r.e.type === "gesture_step_end");
    const sId = starts[0]?.e.s_id || starts[0]?.e.g_id || `g_idx ${gIdx}`;
    const keepIdx = new Set([starts[0].i, ...(ends.length ? [ends[ends.length - 1].i] : [])]);
    const toRemove = related.filter(r => !keepIdx.has(r.i)).map(r => r.i);
    findings.push({
      id: `dup-step-${gIdx}`,
      severity: "high",
      title: `步驟「${sId}」重複開始，被拆成 ${starts.length} 張卡片`,
      detail: `這個步驟出現了 ${starts.length} 次「步驟開始」，中間沒有正常的「步驟結束」銜接，導致時間軸把它拆成多張卡片顯示，但底下的手勢/動作記錄沒有遺失。`,
      entryIndices: related.map(r => r.i),
      fix: toRemove.length ? {
        label: "合併為單一步驟（僅移除多餘的步驟開始/結束標記，不影響手勢紀錄）",
        apply(fileState) {
          fileState.removeEntries(toRemove, `合併重複步驟開始: ${sId}`);
        },
      } : null,
    });
  }

  // ── 2. 手勢嘗試缺少標記 ──────────────────────────────────────────────────
  const unmarked = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type === "gesture_attempt" && !["t", "f", "n"].includes(e.g_type));
  for (const { e, i } of unmarked) {
    const label = e.g_id || e.s_id || `第 ${i + 1} 筆`;
    findings.push({
      id: `unmarked-${i}`,
      severity: "medium",
      title: `手勢嘗試「${label}」沒有標記結果`,
      detail: "這筆手勢嘗試記錄存在，但結果（成功/失敗/未判斷）是空的。需要人工判斷後標記，不會自動代填。",
      entryIndices: [i],
      fix: null,
    });
  }

  return findings;
}

export const archiveAuditMethods = {

  _runAudit() {
    this._auditFindings = this._file ? findAnomalies(this._file.entries) : [];
  },

  _toggleAudit() {
    this._auditOpen = !this._auditOpen;
    if (this._auditOpen) this._runAudit();
    this._renderAll();
  },

  _auditToolbarBtnHtml() {
    if (!this._file) return "";
    // 面板未開啟時不主動掃描，避免每次重繪都重算；開啟過一次後保持結果同步顯示徽章。
    const count = this._auditOpen ? (this._auditFindings?.length || 0) : null;
    return `<button class="archive-action-btn archive-action-btn--audit${this._auditOpen ? " is-active" : ""}" data-action="toggle-audit">
      檢查異常${count != null && count > 0 ? `<span class="archive-audit-badge">${count}</span>` : ""}
    </button>`;
  },

  _renderAuditPanel() {
    if (!this._auditOpen) return "";
    const findings = this._auditFindings || [];
    if (findings.length === 0) {
      return `<div class="archive-audit-panel archive-audit-panel--clean">未發現明顯的儲存異常。</div>`;
    }
    const rows = findings.map(f => {
      const color = SEVERITY_COLOR[f.severity] || SEVERITY_COLOR.low;
      return `<div class="archive-audit-row" data-audit-id="${escapeHtml(f.id)}">
        <span class="archive-audit-sev" style="background:${color}">${SEVERITY_LABEL[f.severity] || "?"}</span>
        <div class="archive-audit-body">
          <div class="archive-audit-title">${escapeHtml(f.title)}</div>
          <div class="archive-audit-detail">${escapeHtml(f.detail)}</div>
        </div>
        <div class="archive-audit-actions">
          <button class="archive-count-btn" data-audit-jump="${escapeHtml(f.id)}">定位</button>
          ${f.fix ? `<button class="archive-count-btn archive-count-btn--fix" data-audit-fix="${escapeHtml(f.id)}">${escapeHtml(f.fix.label)}</button>` : ""}
        </div>
      </div>`;
    }).join("");
    return `<div class="archive-audit-panel">${rows}</div>`;
  },

  _bindAuditPanelEvents(viewer) {
    viewer.querySelector("[data-action='toggle-audit']")?.addEventListener("click", () => this._toggleAudit());
    if (!this._auditOpen) return;

    viewer.querySelectorAll("[data-audit-jump]").forEach(btn =>
      btn.addEventListener("click", () => this._jumpToFinding(btn.dataset.auditJump)));
    viewer.querySelectorAll("[data-audit-fix]").forEach(btn =>
      btn.addEventListener("click", () => this._applyAuditFix(btn.dataset.auditFix)));
  },

  _findingEntryIdx(id) {
    const finding = (this._auditFindings || []).find(f => f.id === id);
    return finding?.entryIndices?.[0] ?? null;
  },

  _jumpToFinding(id) {
    const idx = this._findingEntryIdx(id);
    if (idx == null) return;
    const entry = this._file?.entries[idx];
    if (!entry) return;

    // 屬於某個步驟卡片內的記錄：展開該卡片並捲動過去；否則直接找頂層事件節點。
    const stepCard = [...document.querySelectorAll(".archive-step-card[data-step-key]")]
      .find(card => card.querySelector(`[data-mark-edit="${idx}"], [data-ts-edit="${idx}"], [data-type-edit="${idx}"]`));
    if (stepCard) {
      const key = stepCard.dataset.stepKey;
      if (!this._expandedSteps.has(key)) this._toggleStep(key);
      stepCard.scrollIntoView({ block: "center", behavior: "smooth" });
      this._flashHighlight(stepCard);
      return;
    }
    const topItem = document.querySelector(`.archive-tl-item[data-entry-idx="${idx}"]`);
    if (topItem) {
      topItem.scrollIntoView({ block: "center", behavior: "smooth" });
      this._flashHighlight(topItem);
    }
  },

  _flashHighlight(el) {
    el.classList.add("archive-audit-flash");
    setTimeout(() => el.classList.remove("archive-audit-flash"), 1600);
  },

  _applyAuditFix(id) {
    const finding = (this._auditFindings || []).find(f => f.id === id);
    if (!finding?.fix || !this._file) return;
    finding.fix.apply(this._file);
    this._runAudit();
    this._renderAll();
  },

};
