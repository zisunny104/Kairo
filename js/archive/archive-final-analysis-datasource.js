/**
 * archive-final-analysis-datasource.js — 最終分析卡片共用的「資料來源」＋「篩選」區塊。
 * 取代原本鎖定單一 Stage 的模式：資料來源改成可複選的資料集（Stage 1 / Stage 2 第一次 / 第二次），
 * 篩選支援受試者、指令兩種，套用後回傳依資料集分組、已 join 好受試者姓名的 attempts，供各卡片的
 * Analysis／Statistics 邏輯直接使用，不必各自重寫篩選迴圈。
 */
import { escapeHtml } from "./archive-constants.js";

export const STAGE_LABELS = { "1": "Stage 1", "2-1": "Stage 2 - Round 1", "2-2": "Stage 2 - Round 2" };
export const STAGE_ORDER = ["1", "2-1", "2-2"];

// ── Data Source：資料集複選框 ──────────────────────────────────────────────
export function renderDatasetPicker(records, selectedStages) {
  const present = new Set(records.map(r => r.stage));
  const items = STAGE_ORDER.filter(stage => present.has(stage)).map(stage => {
    const checked = selectedStages.has(stage) ? "checked" : "";
    const count = records.filter(r => r.stage === stage).length;
    return `<label class="final-analysis-scope-item">
      <input type="checkbox" data-datasource-stage="${stage}" ${checked}>
      <span>${escapeHtml(STAGE_LABELS[stage] || stage)}（${count}）</span>
    </label>`;
  }).join("");
  return `<div class="final-analysis-scope-group">
    <div class="final-analysis-scope-group-title final-analysis-scope-group-title--static"><span>資料來源（可複選）</span></div>
    <div class="final-analysis-scope-items">${items || "<p class=\"final-analysis-donut-empty\">目前沒有已儲存的資料</p>"}</div>
  </div>`;
}

export function wireDatasetPicker(container, onToggle) {
  container.querySelectorAll("[data-datasource-stage]").forEach(el => {
    el.addEventListener("change", () => onToggle(el.dataset.datasourceStage, el.checked));
  });
}

// ── Filter：受試者／指令 ────────────────────────────────────────────────
// id 一律轉字串：checkbox 的 dataset 讀出來永遠是字串，trackingId 在資料裡可能是數字，
// 兩邊型別要一致，Set.has() 才會正確比對（否則勾選框的勾選狀態與篩選都會悄悄失效）
export function discoverParticipants(records) {
  const map = new Map();
  for (const r of records) {
    const id = String(r.trackingId);
    if (!map.has(id)) map.set(id, r.participantName || "");
  }
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0], "zh-Hant"));
}

export function discoverCommands(records) {
  const set = new Set();
  for (const r of records) for (const a of r.attempts || []) set.add(a.gestureCommand || "（未知指令）");
  return Array.from(set).sort((a, b) => a.localeCompare(b, "zh-Hant"));
}

export function renderFilterPanel(records, selectedParticipants, selectedCommands) {
  const participants = discoverParticipants(records);
  const commands = discoverCommands(records);
  const participantItems = participants.map(([id, name]) => {
    const checked = selectedParticipants.has(id) ? "checked" : "";
    return `<label class="final-analysis-scope-item">
      <input type="checkbox" data-filter-participant="${escapeHtml(id)}" ${checked}>
      <span>受試者 ${escapeHtml(id)}${name ? ` ${escapeHtml(name)}` : ""}</span>
    </label>`;
  }).join("");
  const commandItems = commands.map(cmd => {
    const checked = selectedCommands.has(cmd) ? "checked" : "";
    return `<label class="final-analysis-scope-item">
      <input type="checkbox" data-filter-command="${escapeHtml(cmd)}" ${checked}>
      <span>${escapeHtml(cmd)}</span>
    </label>`;
  }).join("");
  return `<div class="final-analysis-scope-group">
    <div class="final-analysis-scope-group-title final-analysis-scope-group-title--static"><span>篩選：受試者（選填，不勾＝全部）</span></div>
    <div class="final-analysis-scope-items final-analysis-scope-items--scroll">${participantItems || "<p class=\"final-analysis-donut-empty\">尚無受試者</p>"}</div>
  </div>
  <div class="final-analysis-scope-group">
    <div class="final-analysis-scope-group-title final-analysis-scope-group-title--static"><span>篩選：指令（選填，不勾＝全部）</span></div>
    <div class="final-analysis-scope-items final-analysis-scope-items--scroll">${commandItems || "<p class=\"final-analysis-donut-empty\">尚無指令資料</p>"}</div>
  </div>`;
}

export function wireFilterPanel(container, onToggleParticipant, onToggleCommand) {
  container.querySelectorAll("[data-filter-participant]").forEach(el => {
    el.addEventListener("change", () => onToggleParticipant(el.dataset.filterParticipant, el.checked));
  });
  container.querySelectorAll("[data-filter-command]").forEach(el => {
    el.addEventListener("change", () => onToggleCommand(el.dataset.filterCommand, el.checked));
  });
}

// ── 套用資料來源＋篩選，回傳依資料集（stage）分組的結果 ──────────────────
// 回傳：[{ stage, label, records, attempts }]，attempts 已附上 trackingId／participantName 方便卡片依受試者分組配對
export function filterAttempts(records, { stages, participantIds, commands }) {
  const groups = [];
  for (const stage of STAGE_ORDER) {
    if (!stages.has(stage)) continue;
    const stageRecords = records.filter(r => r.stage === stage && (!participantIds.size || participantIds.has(String(r.trackingId))));
    if (!stageRecords.length) continue;
    const attempts = [];
    for (const r of stageRecords) {
      for (const a of (r.attempts || [])) {
        const command = a.gestureCommand || "（未知指令）";
        if (commands.size && !commands.has(command)) continue;
        attempts.push({ ...a, gestureCommand: command, trackingId: r.trackingId, participantName: r.participantName || "" });
      }
    }
    groups.push({ stage, label: STAGE_LABELS[stage] || stage, records: stageRecords, attempts });
  }
  return groups;
}
