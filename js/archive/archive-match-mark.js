/**
 * archive-match-mark.js — 名單比對分頁
 * 匯入受試者名單，比對伺服器上既有日誌檔，列出候選並引導使用者
 * 進入既有的「重新標記」工作流程完成合併／補標記。
 * 比對只給建議與風險分數，是否採用、是否視為無效一律由使用者判斷。
 */

import * as XLSX from "../vendor/xlsx.mjs";
import { getApiUrl } from "../core/url-utils.js";
import { getAdminToken, clearAdminToken } from "../core/admin-auth.js";
import { API_ENDPOINTS } from "../constants/index.js";
import { escapeHtml, parseJsonl, extractSummary, ArchiveFileState } from "./archive-constants.js";
import { parseDelimitedText, formatClock, DRAFT_KEY as ASSIST_MARK_DRAFT_KEY } from "./archive-assist-mark.js";
import manager from "./archive-page-manager.js";

const DRAFT_KEY = "archive_match_mark_draft_v1";

const ROLE_LABELS = { id: "受試者 ID", date: "日期", combo: "預期組合", count: "預期次數", ignore: "忽略" };
const CONFLICT_FIELD_LABELS = {
  experimentId: "實驗ID", date: "日期", matchedFilename: "對應日誌檔",
};
const DEFAULT_ID_REGEX = /^(?<prefix>\D*)(?<number>\d+)(?:\D+(?<trial>\d+))?/;
const DAY_MS = 24 * 60 * 60 * 1000;
const G_TYPE_LABEL = { t: "成功", f: "失敗", n: "未判斷" };

// 只用候選日誌檔比對、沒有另外做輔助標記的受試者，把日誌裡的 gesture_attempt 事件
// 轉譯成跟輔助標記同樣形狀的逐筆資料，作為備用來源，這樣才不會在最終分析裡消失。
// 沒有人工標註欄位（備註），留空即可；花費時間則從日誌時間戳算出：
// 同一個 g_idx 底下，從 gesture_step_start（指令開始）到該筆 gesture_attempt（比手勢）的時間差。
function translateLogEntriesToAttempts(entries, participantName) {
  const stepStartByIdx = new Map();
  const attempts = [];
  for (const e of entries) {
    if (e.type === "gesture_step_start") {
      stepStartByIdx.set(e.g_idx, e.ts);
      continue;
    }
    if (e.type !== "gesture_attempt") continue;
    const startTs = stepStartByIdx.get(e.g_idx);
    const duration = startTs != null && e.ts != null ? formatClock(e.ts - startTs) : "";
    attempts.push({
      participantName: participantName || "",
      gestureCommand: e.g_id || "",
      type: G_TYPE_LABEL[e.g_type] || e.g_type || "",
      typeRaw: e.g_type || "",
      note: "",
      duration,
    });
  }
  return attempts;
}

// 從最後一欄往前找：輔助標記的「花費時間」欄是計時工具自動附加在資料最後面，
// 若原始匯入檔案剛好也有同名欄位，要優先採用最後面、真正由計時器寫入的那一欄。
function guessAssistCol(headers, patterns) {
  for (let i = headers.length - 1; i >= 0; i--) {
    if (patterns.test(String(headers[i] || ""))) return i;
  }
  return -1;
}

function guessRole(header) {
  const h = String(header || "").toLowerCase();
  if (/id|編號|受試者|代號/.test(h)) return "id";
  if (/日期|date|時間/.test(h)) return "date";
  if (/組合|combo|手勢/.test(h)) return "combo";
  if (/次數|count|trial|第.*次/.test(h)) return "count";
  return "ignore";
}

function parseFlexibleDate(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().replace(/[年月]/g, "-").replace(/日/g, "").replace(/\//g, "-");
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function parseCompositeId(raw, ruleStr) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let re = DEFAULT_ID_REGEX;
  if (ruleStr) {
    try { re = new RegExp(ruleStr); } catch { re = DEFAULT_ID_REGEX; }
  }
  const m = s.match(re);
  if (!m || !m.groups) return { prefix: s, number: null, trial: null };
  return {
    prefix: m.groups.prefix || "",
    number: m.groups.number != null ? Number(m.groups.number) : null,
    trial:  m.groups.trial  != null ? Number(m.groups.trial)  : null,
  };
}

function dayKey(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function fmtDateTime(ts) {
  if (ts == null) return "—";
  return new Date(ts).toLocaleString("zh-TW", { hour12: false });
}

function createDefaultState() {
  return {
    rawHeaders: [],
    rawBody: [],
    columnRoles: {},
    idSplitRule: "",
    dateToleranceDays: 1,
    sourceName: "",
    rosterMode: false,
    rows: [],
    filterDecision: "all",
    lastSavedAt: null,
  };
}

function rosterRowsFromParticipants(participants) {
  const rows = [];
  for (const p of participants || []) {
    if (p.stage1?.experimentId) {
      rows.push({
        idRaw: p.stage1.experimentId,
        trackingId: p.trackingId,
        participantName: p.name || "",
        stage: "1",
        groupLabel: `受試者 ${p.trackingId} · 第一階段`,
        date: p.stage1.date || null,
        dateTs: parseFlexibleDate(p.stage1.date),
        combo: null,
        count: null,
      });
    }
    if (p.stage2) {
      if (p.stage2.attempt1?.experimentId) {
        rows.push({
          idRaw: p.stage2.attempt1.experimentId,
          trackingId: p.trackingId,
          participantName: p.name || "",
          stage: "2-1",
          groupLabel: `受試者 ${p.trackingId} · 第二階段（第一次）`,
          date: p.stage2.date || null,
          dateTs: parseFlexibleDate(p.stage2.date),
          combo: null,
          count: null,
        });
      }
      if (p.stage2.attempt2?.experimentId) {
        rows.push({
          idRaw: p.stage2.attempt2.experimentId,
          trackingId: p.trackingId,
          participantName: p.name || "",
          stage: "2-2",
          groupLabel: `受試者 ${p.trackingId} · 第二階段（第二次）`,
          date: p.stage2.date || null,
          dateTs: parseFlexibleDate(p.stage2.date),
          combo: null,
          count: null,
        });
      }
    }
  }
  return rows.map(r => ({
    ...r,
    idParsed: parseCompositeId(r.idRaw, ""),
    candidates: [],
    decision: "pending",
    selectedFilenames: [],
  }));
}

class MatchMarkManager {
  constructor() {
    this._container = null;
    this._state = this._loadDraft() || createDefaultState();
    this._serverFiles = [];
    this._serverFilesLoaded = false;
    this._candidateCache = new Map(); // filename -> { entries, summary }
    this._expanded = new Set();
    this._loadingCandidates = new Set();
  }

  async init(container) {
    this._container = container;
    this._render();
    if (!this._serverFilesLoaded) await this._loadServerFiles();
  }

  // ── 伺服器溝通（獨立於 ArchivePageManager，僅在跳轉重新標記時借用其實例）──

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

  async _loadServerFiles() {
    try {
      const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.RECORD.LIST}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "未知錯誤");
      this._serverFiles = (data.files || []).slice().sort((a, b) => a.modified - b.modified);
      this._serverFilesLoaded = true;
    } catch {
      this._serverFiles = [];
    }
    this._recomputeAllCandidates();
    this._render();
  }

  async _fetchEntries(filename) {
    const cached = this._candidateCache.get(filename);
    if (cached) return cached;
    const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.RECORD.READ(filename)}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || "讀取失敗");
    const entries = parseJsonl(data.content);
    const info = { entries, summary: extractSummary(entries) };
    this._candidateCache.set(filename, info);
    return info;
  }

  // ── 草稿 ──────────────────────────────────────────────────────────────────

  _loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  _saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(this._state));
      this._state.lastSavedAt = Date.now();
    } catch { /* localStorage 不可用時不中斷 */ }
  }

  // ── 匯入 ──────────────────────────────────────────────────────────────────

  _importFile(file) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const reader = new FileReader();
    reader.onload = e => {
      const result = e.target?.result;
      if (result == null) return;
      if (ext === "xlsx" || ext === "xls") {
        const workbook = XLSX.read(result, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false });
        this._loadImportedRows(rows, file.name);
        return;
      }
      this._loadImportedRows(parseDelimitedText(result), file.name);
    };
    if (ext === "xlsx" || ext === "xls") reader.readAsArrayBuffer(file);
    else reader.readAsText(file, "utf-8");
  }

  _importClipboardText(text) {
    this._loadImportedRows(parseDelimitedText(text), "貼上資料");
  }

  async _loadSavedRoster() {
    try {
      const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.ROSTER.PARTICIPANTS}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "尚未建立受試者名單資料");
      const rows = rosterRowsFromParticipants(data.participants);
      await this._hydrateFromSavedAnalysis(rows);
      this._state = {
        ...createDefaultState(),
        sourceName: "已存名單（participants.json）",
        rosterMode: true,
        rows,
      };
      this._recomputeAllCandidates();
      this._saveDraft();
      this._render();
    } catch (err) {
      alert(`載入名單失敗：${err.message}`);
    }
  }

  // 把伺服器上已經存過的分析原始資料（其他客戶端或先前操作按過「全部儲存」的結果）
  // 依「受試者＋階段」帶回目前的列，這樣不同客戶端載入名單時比對進度是一致的，
  // 不用重新比對已經完成的部分。
  async _hydrateFromSavedAnalysis(rows) {
    try {
      const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.ANALYSIS.LIST}`);
      const data = await res.json();
      if (!data.success) return;
      const byKey = new Map();
      for (const r of data.records || []) byKey.set(`${r.trackingId}::${r.stage}`, r);
      for (const row of rows) {
        const rec = byKey.get(`${row.trackingId}::${row.stage}`);
        if (!rec) continue;
        if (rec.matchedFilename) row.matchedFilename = rec.matchedFilename;
        if (rec.attempts?.length) row.assistDataRows = rec.attempts;
      }
    } catch {
      // 讀取失敗時維持空白，使用者仍可照常重新比對、儲存
    }
  }

  // 輔助標記通常一個受試者＋一個實驗代碼會有多列（每列一次手勢指令），
  // 因此比對鍵改用「人員 id ＋ experiment_id」組合，且保留全部列（不再只留最後一列）。
  _importFromAssistMark() {
    let assistState;
    try {
      const raw = localStorage.getItem(ASSIST_MARK_DRAFT_KEY);
      assistState = raw ? JSON.parse(raw) : null;
    } catch { assistState = null; }
    if (!assistState || !assistState.rows?.length) {
      alert("找不到「輔助標記」的暫存資料，請先在該分頁載入並標記過一次。");
      return;
    }

    const headers = assistState.headers || [];
    const trackingIdCol = guessAssistCol(headers, /^id$/i);
    const experimentIdCol = guessAssistCol(headers, /experiment_id|實驗代碼|^代碼$/i);
    const participantNameCol = guessAssistCol(headers, /participant_name|受試者姓名|^姓名$/i);
    const gestureCommandCol = guessAssistCol(headers, /gesture_command|手勢指令/i);
    const typeCol = guessAssistCol(headers, /^type$/i);
    const typeRawCol = guessAssistCol(headers, /type_raw|原始類型/i);
    const noteCol = guessAssistCol(headers, /note|備註/i);
    const durationCol = guessAssistCol(headers, /花費時間|duration|耗時/i);

    if (experimentIdCol < 0) {
      alert("輔助標記的資料裡找不到可辨識的實驗代碼欄位（experiment_id）。");
      return;
    }

    const cellAt = (cells, col) => (col >= 0 ? String(cells[col] ?? "").trim() : "");
    const keyOf = (expId, tId) => (tId ? `${tId}::${expId}` : expId);

    const lookup = new Map();
    for (const cells of assistState.rows) {
      const expId = cellAt(cells, experimentIdCol).toLowerCase();
      if (!expId) continue;
      const tId = trackingIdCol >= 0 ? cellAt(cells, trackingIdCol).toLowerCase() : "";
      const key = keyOf(expId, tId);
      const entry = {
        participantName: cellAt(cells, participantNameCol),
        gestureCommand: cellAt(cells, gestureCommandCol),
        type: cellAt(cells, typeCol),
        typeRaw: cellAt(cells, typeRawCol),
        note: cellAt(cells, noteCol),
        duration: cellAt(cells, durationCol),
      };
      if (!lookup.has(key)) lookup.set(key, []);
      lookup.get(key).push(entry);
    }

    let matched = 0;
    let totalRows = 0;
    for (const row of this._state.rows) {
      const expId = String(row.idRaw || "").trim().toLowerCase();
      if (!expId) continue;
      const tId = row.trackingId != null && trackingIdCol >= 0 ? String(row.trackingId).trim().toLowerCase() : "";
      const rows = lookup.get(keyOf(expId, tId));
      // 對應到名單後，姓名一律改用名單資料（row.participantName）為準，
      // 不採用輔助標記貼上檔案裡逐列可能空白/打錯的姓名欄，確保同一人在同一份輸出裡姓名一致。
      if (rows?.length) {
        row.assistDataRows = rows.map(r => ({ ...r, participantName: row.participantName || r.participantName }));
        matched++;
        totalRows += rows.length;
      }
    }
    this._saveDraft();
    this._render();
    alert(`已從「輔助標記」匯入（依人員 ID ＋ 實驗 ID 比對），共比對到 ${matched} 位受試者、合計 ${totalRows} 列手勢紀錄。`);
  }

  _loadImportedRows(rows, sourceName) {
    if (!rows || rows.length < 1) return;
    const headers = rows[0].map((c, i) => String(c ?? "").trim() || `欄位 ${i + 1}`);
    const body = rows.slice(1).filter(r => r.some(c => String(c ?? "").trim() !== ""));

    const columnRoles = {};
    headers.forEach((h, i) => { columnRoles[i] = guessRole(h); });

    this._state = {
      ...createDefaultState(),
      rawHeaders: headers,
      rawBody: body,
      columnRoles,
      sourceName,
    };
    this._deriveRows();
    this._saveDraft();
    this._render();
  }

  // ── 依欄位對應 + ID 拆解規則，從原始表格重新推導 rows ──────────────────────

  _deriveRows() {
    const st = this._state;
    const roleOf = idx => st.columnRoles[idx] || "ignore";
    const idCol    = Object.keys(st.columnRoles).find(i => roleOf(i) === "id");
    const dateCol  = Object.keys(st.columnRoles).find(i => roleOf(i) === "date");
    const comboCol = Object.keys(st.columnRoles).find(i => roleOf(i) === "combo");
    const countCol = Object.keys(st.columnRoles).find(i => roleOf(i) === "count");

    st.rows = st.rawBody.map(cells => {
      const idRaw = idCol != null ? String(cells[idCol] ?? "").trim() : "";
      const dateRaw = dateCol != null ? String(cells[dateCol] ?? "").trim() : "";
      const combo = comboCol != null ? String(cells[comboCol] ?? "").trim() : "";
      const countRaw = countCol != null ? String(cells[countCol] ?? "").trim() : "";
      return {
        idRaw,
        idParsed: idRaw ? parseCompositeId(idRaw, st.idSplitRule) : null,
        date: dateRaw || null,
        dateTs: parseFlexibleDate(dateRaw),
        combo: combo || null,
        count: countRaw && !Number.isNaN(Number(countRaw)) ? Number(countRaw) : null,
        candidates: [],
        decision: "pending", // pending | sent-to-remark | needs-remark | skipped
        selectedFilenames: [],
      };
    });
    this._recomputeAllCandidates();
  }

  _recomputeAllCandidates() {
    if (!this._serverFiles.length) return;
    for (const row of this._state.rows) row.candidates = this._computeCandidates(row);
  }

  _computeCandidates(row) {
    // 階段一沒有對應的單一日誌檔（該階段的資料只來自輔助標記匯入），
    // 不做檔案比對，避免用日期／前綴誤配到其他階段的日誌檔
    if (row.stage === "1") return [];

    const files = this._serverFiles;
    const tolMs = (this._state.dateToleranceDays ?? 1) * DAY_MS;

    // 檔名前綴與受試者代碼完全相符時（如 roster 匯入的 experimentId），直接視為精確比對，優先於日期篩選
    const idRaw = (row.idRaw || "").toLowerCase();
    if (idRaw) {
      const exact = files.filter(f => f.filename.toLowerCase().split("_")[0] === idRaw);
      if (exact.length) {
        return exact.slice().sort((a, b) => a.modified - b.modified)
          .map(f => ({ filename: f.filename, modified: f.modified, size: f.size, suggested: true, exact: true }));
      }
    }

    let pool;
    if (row.dateTs != null) {
      const target = dayKey(row.dateTs);
      pool = files.filter(f => Math.abs(dayKey(f.modified) - target) <= tolMs);
    } else if (row.idParsed?.prefix) {
      const p = row.idParsed.prefix.toLowerCase();
      pool = files.filter(f => f.filename.toLowerCase().includes(p));
    } else {
      pool = [];
    }
    pool = pool.slice().sort((a, b) => a.modified - b.modified);
    const suggestIdx = row.idParsed?.trial != null ? row.idParsed.trial - 1 : 0;
    return pool.map((f, i) => ({
      filename: f.filename, modified: f.modified, size: f.size,
      suggested: i === suggestIdx,
    }));
  }

  // ── 風險評分（lazy，展開列時才抓內容）───────────────────────────────────────

  async _ensureRisk(row) {
    for (const c of row.candidates) {
      if (c.risk) continue;
      try {
        const { summary } = await this._fetchEntries(c.filename);
        c.summary = summary;
      } catch {
        c.summary = null;
      }
    }
    // 群內衝突/斷點偵測（依時間排序後比較相鄰候選）
    const withTime = row.candidates.filter(c => c.summary?.startTime != null);
    withTime.sort((a, b) => a.summary.startTime - b.summary.startTime);
    const expected = String(row.idRaw || "").trim().toLowerCase();
    for (let i = 0; i < withTime.length; i++) {
      const c = withTime[i];
      const reasons = [];
      if (!c.summary) { reasons.push("無法讀取內容"); }
      else {
        if (c.summary.endTime == null) reasons.push("缺少結束事件");
        if (row.count != null && Math.abs((c.summary.attemptCount || 0) - row.count) > 0) {
          reasons.push(`嘗試次數 ${c.summary.attemptCount} ≠ 預期 ${row.count}`);
        }
        // 內容比對：日誌內嵌的 exp_id 與這一列預期的實驗ID 是否一致（不只靠檔名猜測）
        const actualExpId = String(c.summary.expId || "").trim().toLowerCase();
        if (expected && actualExpId && actualExpId !== "—" && actualExpId !== expected) {
          reasons.push(`日誌內容 exp_id「${c.summary.expId}」與預期「${row.idRaw}」不符`);
        }
        const prev = withTime[i - 1];
        if (prev?.summary?.endTime != null && c.summary.startTime < prev.summary.endTime) {
          reasons.push("與前一候選時間重疊");
        } else if (prev?.summary?.endTime != null && c.summary.startTime - prev.summary.endTime > 5 * 60 * 1000) {
          reasons.push("與前一候選間隔較大，可能為中斷續錄");
        }
      }
      c.riskReasons = reasons;
      c.risk = reasons.length === 0 ? "low" : reasons.length === 1 ? "medium" : "high";
    }

    // 合併建議：前一候選缺少結束事件（疑似錄製中斷），且與下一候選時間相近、
    // exp_id 相同或其中一邊未知時，提示使用者這兩個檔案可能是同一次記錄被拆成兩檔，建議一併勾選合併
    for (let i = 1; i < withTime.length; i++) {
      const prev = withTime[i - 1];
      const cur = withTime[i];
      if (!prev.summary || !cur.summary || prev.summary.endTime != null) continue;
      const gapMs = cur.summary.startTime - prev.summary.startTime;
      if (gapMs < 0 || gapMs > 30 * 60 * 1000) continue;
      const prevExp = String(prev.summary.expId || "").trim().toLowerCase();
      const curExp  = String(cur.summary.expId  || "").trim().toLowerCase();
      const sameOrUnknownExp = !prevExp || !curExp || prevExp === "—" || curExp === "—" || prevExp === curExp;
      if (sameOrUnknownExp) {
        prev.mergeSuggestFilename = cur.filename;
        cur.mergeSuggestFilename = prev.filename;
      }
    }
  }

  // ── 動作 ──────────────────────────────────────────────────────────────────

  async _toggleExpand(idx) {
    if (this._expanded.has(idx)) { this._expanded.delete(idx); this._render(); return; }
    this._expanded.add(idx);
    this._render();
    const row = this._state.rows[idx];
    if (row && row.candidates.length) {
      this._loadingCandidates.add(idx);
      this._render();
      await this._ensureRisk(row);
      this._loadingCandidates.delete(idx);
      this._render();
    }
  }

  _toggleCandidateSelect(idx, filename) {
    const row = this._state.rows[idx];
    if (!row) return;
    const sel = row.selectedFilenames;
    const at = sel.indexOf(filename);
    if (at >= 0) sel.splice(at, 1); else sel.push(filename);
    this._saveDraft();
    this._render();
  }

  // 合併建議 chip：一次把疑似續錄的兩個候選檔案都勾選起來，方便使用者送進重新標記工作區合併
  _selectMergePair(idx, fileA, fileB) {
    const row = this._state.rows[idx];
    if (!row) return;
    for (const fn of [fileA, fileB]) {
      if (fn && !row.selectedFilenames.includes(fn)) row.selectedFilenames.push(fn);
    }
    this._saveDraft();
    this._render();
  }

  // 這一列要存進分析用資料的逐筆手勢紀錄：優先用「輔助標記」匯入的人工標記資料；
  // 若這一列只用候選日誌檔比對、沒有另外做輔助標記，改讀該日誌檔內容轉譯成同樣形狀的資料，
  // 這樣單靠比對名單完成配對的受試者也不會在最終分析裡消失。
  async _resolveAttempts(row) {
    if (row.assistDataRows?.length) return row.assistDataRows;
    const filename = row.matchedFilename || row.selectedFilenames?.[0];
    if (!filename) return [];
    try {
      const { entries } = await this._fetchEntries(filename);
      return translateLogEntriesToAttempts(entries, row.participantName);
    } catch {
      return [];
    }
  }

  // 確認配對（直接讀入 / 送往重新標記合併）時，把這一列目前已有的分析用原始資料
  // 寫入伺服器 runtime/analysis/（衍生資料，欄位可不齊全，之後可被覆寫更新）
  async _saveAnalysisFile(row) {
    if (row.trackingId == null || !row.stage) return; // 非 roster 匯入的列沒有階段代號，不寫入
    try {
      const attempts = await this._resolveAttempts(row);
      await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.ANALYSIS.SAVE}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trackingId: row.trackingId,
          stage: row.stage,
          experimentId: row.idRaw,
          date: row.date,
          matchedFilename: row.matchedFilename || row.selectedFilenames?.[0] || "",
          attempts,
        }),
      });
    } catch { /* 寫入失敗不中斷比對流程，草稿仍保留資料，之後可重新觸發 */ }
  }

  // 手動「儲存」按鈕：把目前這列的資料存進伺服器，會跟既有檔案合併；
  // 欄位若兩邊都有值但不同，伺服器回傳衝突清單，改顯示衝突解決面板讓使用者選擇。
  async _saveRow(idx, overrides = null) {
    const row = this._state.rows[idx];
    if (!row || row.trackingId == null || !row.stage) return;
    const attempts = await this._resolveAttempts(row);
    const payload = {
      trackingId: row.trackingId,
      stage: row.stage,
      experimentId: row.idRaw,
      date: row.date,
      matchedFilename: row.matchedFilename || row.selectedFilenames?.[0] || "",
      attempts,
    };
    if (overrides) payload.overrides = overrides;

    try {
      const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.ANALYSIS.SAVE}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.status === 409 && data.conflict) {
        row.saveConflict = data.conflicts.map(cf => ({ ...cf, choice: "incoming" }));
        this._render();
        return;
      }
      if (!data.success) throw new Error(data.error || "儲存失敗");
      row.saveConflict = null;
      this._saveDraft();
      this._render();
    } catch (err) {
      alert(`儲存失敗：${err.message}`);
    }
  }

  // 上方「全部儲存」按鈕：逐列送出（伺服器一次只認一列），若某列有欄位衝突就停在該列的衝突面板等待選擇，
  // 其餘列繼續送出，最後統一回報結果。
  async _saveAllRows() {
    const rows = this._state.rows;
    let saved = 0, conflicts = 0, skipped = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].trackingId == null || !rows[i].stage) { skipped++; continue; }
      await this._saveRow(i);
      if (this._state.rows[i]?.saveConflict) conflicts++;
      else saved++;
    }
    if (conflicts) {
      alert(`已儲存 ${saved} 筆，其中 ${conflicts} 筆有欄位衝突，請在下方列表中確認並儲存。`);
    } else {
      alert(`已全部儲存，共 ${saved} 筆${skipped ? `（${skipped} 筆非名單匯入列，已略過）` : ""}。`);
    }
  }

  _setConflictChoice(idx, conflictIdx, choice) {
    const row = this._state.rows[idx];
    if (!row?.saveConflict?.[conflictIdx]) return;
    row.saveConflict[conflictIdx].choice = choice;
  }

  _confirmConflictSave(idx) {
    const row = this._state.rows[idx];
    if (!row?.saveConflict) return;
    const overrides = {};
    for (const cf of row.saveConflict) {
      overrides[cf.field] = cf.choice === "existing" ? cf.existing : cf.incoming;
    }
    this._saveRow(idx, overrides);
  }

  _cancelConflictSave(idx) {
    const row = this._state.rows[idx];
    if (!row) return;
    row.saveConflict = null;
    this._render();
  }

  async _viewFile(filename) {
    document.querySelector("[data-tab=\"viewer\"]")?.click();
    await manager._openServer(filename);
  }

  async _openInRemark(idx) {
    const row = this._state.rows[idx];
    if (!row || row.selectedFilenames.length === 0) return;
    const [primary, ...rest] = row.selectedFilenames;

    document.querySelector("[data-tab=\"viewer\"]")?.click();
    await manager._openServer(primary);

    for (const fn of rest) {
      try {
        const { entries } = await this._fetchEntries(fn);
        manager._remarkState.importedFiles.push(
          new ArchiveFileState({ id: `remark:${fn}`, title: fn, source: "server", entries }),
        );
      } catch { /* 個別檔案讀取失敗時略過，不中斷整體流程 */ }
    }
    if (manager._file) manager._file.viewMode = "remark";
    manager._renderAll?.();

    row.decision = "sent-to-remark";
    this._saveDraft();
    this._render();
    this._saveAnalysisFile(row);
  }

  _markMatched(idx) {
    const row = this._state.rows[idx];
    if (!row || row.selectedFilenames.length !== 1) return;
    row.matchedFilename = row.selectedFilenames[0];
    row.decision = "matched";
    this._saveDraft();
    this._render();
    this._saveAnalysisFile(row);
  }

  _gotoQuickRemark(idx) {
    const row = this._state.rows[idx];
    if (!row) return;
    row.decision = "needs-remark";
    this._saveDraft();
    this._render();
    const hint = `${row.idRaw}${row.combo ? " · " + row.combo : ""}`;
    navigator.clipboard?.writeText(hint).catch(() => {});
    alert(`已將「${hint}」標記為需重新標記，識別碼已複製到剪貼簿，可在「簡易標記」錄製時對照。`);
    document.querySelector("[data-tab=\"quick-remark\"]")?.click();
  }

  _skipRow(idx) {
    const row = this._state.rows[idx];
    if (!row) return;
    row.decision = "skipped";
    this._saveDraft();
    this._render();
  }

  _setColumnRole(colIdx, role) {
    this._state.columnRoles[colIdx] = role;
    this._deriveRows();
    this._saveDraft();
    this._render();
  }

  _setIdSplitRule(rule) {
    this._state.idSplitRule = rule;
    this._deriveRows();
    this._saveDraft();
    this._render();
  }

  _setDateTolerance(days) {
    this._state.dateToleranceDays = Math.max(0, Number(days) || 0);
    this._recomputeAllCandidates();
    this._saveDraft();
    this._render();
  }

  _resetAll() {
    this._state = createDefaultState();
    this._expanded.clear();
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* noop */ }
    this._render();
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  _render() {
    if (!this._container) return;
    const scrollTop = this._container.querySelector(".match-mark-rows-wrap")?.scrollTop ?? 0;
    const st = this._state;
    const hasData = st.rows.length > 0;

    const statsHtml = this._renderStats();
    // 欄位對應 UI（預期組合/預期次數/忽略）：實際工作流程只用「載入已存名單」與「從輔助標記匯入」，
    // 通用檔案/貼上匯入已不再使用，故隱藏此區塊，保留 _renderMapping() 以備未來需要。
    const mappingHtml = "";
    const listHtml = hasData ? this._renderRows() : `<div class="assist-mark-empty">
      <h3>名單比對</h3>
      <p>載入已建立的受試者名單，或上傳含受試者 ID 的 Excel / CSV／直接貼上表格內容，系統會嘗試比對伺服器上既有的日誌檔。</p>
      <div class="assist-mark-empty-actions">
        <button class="archive-action-btn" data-match-action="load-roster">載入已存名單</button>
        <button class="archive-action-btn" data-match-action="paste">貼上內容</button>
        <button class="archive-action-btn" data-match-action="file">選擇檔案</button>
      </div>
    </div>`;

    this._container.innerHTML = `
      <div class="match-mark-shell">
        <div class="match-mark-topbar">
          <div class="assist-mark-title-wrap">
            <div class="assist-mark-title">名單比對</div>
            <div class="assist-mark-subtitle">${escapeHtml(st.sourceName || "尚未匯入名單")}</div>
          </div>
          <div class="assist-mark-actions">
            <button class="archive-action-btn" data-match-action="load-roster">載入已存名單</button>
            <button class="archive-action-btn" data-match-action="import-assist" ${hasData ? "" : "disabled"}>從輔助標記匯入</button>
            <button class="archive-action-btn" data-match-action="paste">貼上內容</button>
            <button class="archive-action-btn" data-match-action="file">選擇檔案</button>
            <button class="archive-action-btn" data-match-action="refresh-server">重新載入伺服器清單</button>
            <button class="archive-action-btn" data-match-action="save-all" ${hasData ? "" : "disabled"}>全部儲存</button>
            <button class="archive-action-btn archive-action-btn--danger" data-match-action="reset" ${hasData ? "" : "disabled"}>清空</button>
          </div>
        </div>
        ${statsHtml}
        <textarea class="assist-mark-pastebox" id="matchMarkPasteBox" placeholder="在這裡直接貼上 Excel 複製的名單內容，或先點選「貼上內容」再貼上。"></textarea>
        <input type="file" id="matchMarkFileInput" accept=".xlsx,.xls,.csv,.txt" hidden>
        ${mappingHtml}
        <div class="match-mark-rows-wrap">${listHtml}</div>
      </div>`;

    this._bindEvents();
    const rowsWrap = this._container.querySelector(".match-mark-rows-wrap");
    if (rowsWrap) rowsWrap.scrollTop = scrollTop;
  }

  _renderStats() {
    const rows = this._state.rows;
    if (!rows.length) return "";
    const count = d => rows.filter(r => r.decision === d).length;
    const noMatch = rows.filter(r => r.candidates.length === 0 && r.decision === "pending" && r.stage !== "1").length;
    return `<div class="match-mark-stats">
      <span class="match-mark-stat-chip">共 ${rows.length} 筆</span>
      <span class="match-mark-stat-chip">待確認 ${count("pending")}</span>
      <span class="match-mark-stat-chip match-mark-stat-chip--ok">已直接讀入 ${count("matched")}</span>
      <span class="match-mark-stat-chip match-mark-stat-chip--ok">已送往標記工作區 ${count("sent-to-remark")}</span>
      <span class="match-mark-stat-chip match-mark-stat-chip--warn">建議重新標記 ${count("needs-remark") + noMatch}</span>
      <span class="match-mark-stat-chip">已略過 ${count("skipped")}</span>
      <label class="match-mark-tolerance">
        日期容忍天數
        <input type="number" min="0" max="14" id="matchMarkTolerance" value="${this._state.dateToleranceDays}" style="width:48px">
      </label>
    </div>`;
  }

  _renderMapping() {
    const st = this._state;
    const cols = st.rawHeaders.map((h, i) => {
      const role = st.columnRoles[i] || "ignore";
      const options = Object.entries(ROLE_LABELS)
        .map(([v, label]) => `<option value="${v}" ${role === v ? "selected" : ""}>${label}</option>`).join("");
      return `<div class="match-mark-col-map">
        <span class="match-mark-col-name">${escapeHtml(h)}</span>
        <select data-match-col="${i}">${options}</select>
      </div>`;
    }).join("");

    return `<div class="match-mark-mapping">
      <div class="match-mark-mapping-title">欄位對應</div>
      <div class="match-mark-mapping-cols">${cols}</div>
      <label class="match-mark-id-rule">
        ID 拆解規則（選填，正規表示式，需含 named group prefix/number/trial）
        <input type="text" id="matchMarkIdRule" value="${escapeHtml(st.idSplitRule)}" placeholder="例：^(?<prefix>[A-Za-z]+)(?<number>\\d+)_T(?<trial>\\d+)$">
      </label>
    </div>`;
  }

  _renderRows() {
    const st = this._state;
    return st.rows.map((row, idx) => this._renderRow(row, idx)).join("");
  }

  _renderRow(row, idx) {
    const expanded = this._expanded.has(idx);
    const loading  = this._loadingCandidates.has(idx);
    const decisionLabel = {
      pending: "待確認", matched: "已直接讀入", "sent-to-remark": "已送往標記工作區",
      "needs-remark": "建議重新標記", skipped: "已略過",
    }[row.decision] || row.decision;
    const decisionClass = {
      pending: "", matched: "is-ok", "sent-to-remark": "is-ok", "needs-remark": "is-warn", skipped: "is-muted",
    }[row.decision] || "";

    const noCandidates = row.candidates.length === 0;
    const candidatesHtml = expanded ? this._renderCandidates(row, idx, loading) : "";
    const assistRows = row.assistDataRows;
    const assistHtml = assistRows?.length ? `<div class="match-mark-row-assist">
      <span class="match-mark-assist-count">輔助標記 ${assistRows.length} 筆</span>
      ${assistRows.map(a => `<span class="match-mark-assist-item">${a.gestureCommand ? escapeHtml(a.gestureCommand) : ""}${a.type ? " " + escapeHtml(a.type) : ""}${a.typeRaw ? "（" + escapeHtml(a.typeRaw) + "）" : ""}${a.note ? " · " + escapeHtml(a.note) : ""}</span>`).join("")}
    </div>` : "";
    const saveHtml = row.saveConflict ? `<div class="match-mark-row-actions match-mark-row-actions--save">
      ${this._renderConflictPanel(row, idx)}
    </div>` : "";

    return `<div class="match-mark-row${expanded ? " is-expanded" : ""}" data-row-idx="${idx}">
      <div class="match-mark-row-head" data-match-toggle="${idx}">
        <span class="match-mark-row-id">${row.groupLabel ? escapeHtml(row.groupLabel) : escapeHtml(row.idRaw || "（未填）")}</span>
        <span class="match-mark-row-meta">${row.date ? escapeHtml(row.date) : "—"}${row.groupLabel ? " · 代碼 " + escapeHtml(row.idRaw) : ""}${row.combo ? " · " + escapeHtml(row.combo) : ""}${row.count != null ? ` · 預期 ${row.count} 次` : ""}${row.matchedFilename ? " · 已讀入 " + escapeHtml(row.matchedFilename) : ""}</span>
        <span class="match-mark-row-cand-count">${row.stage === "1" ? "階段一無日誌檔（正常）" : noCandidates ? "無候選" : `${row.candidates.length} 個候選`}</span>
        <span class="match-mark-decision-badge ${decisionClass}">${decisionLabel}</span>
        <span class="match-mark-row-caret">${expanded ? "▾" : "▸"}</span>
      </div>
      ${assistHtml}
      ${saveHtml}
      ${candidatesHtml}
    </div>`;
  }

  _renderConflictPanel(row, idx) {
    const items = row.saveConflict.map((cf, i) => `
      <div class="match-mark-conflict-field">
        <div class="match-mark-conflict-label">${CONFLICT_FIELD_LABELS[cf.field] || cf.field}</div>
        <label><input type="radio" name="match-conflict-${idx}-${i}" data-match-conflict="${idx}" data-match-conflict-idx="${i}" value="existing" ${cf.choice === "existing" ? "checked" : ""}> 保留現有：${escapeHtml(cf.existing)}</label>
        <label><input type="radio" name="match-conflict-${idx}-${i}" data-match-conflict="${idx}" data-match-conflict-idx="${i}" value="incoming" ${cf.choice === "incoming" ? "checked" : ""}> 使用新的：${escapeHtml(cf.incoming)}</label>
      </div>`).join("");
    return `<div class="match-mark-conflict-panel">
      <p class="match-mark-conflict-title">儲存衝突：伺服器上已有不同的值，請選擇要保留哪一邊</p>
      ${items}
      <div class="match-mark-row-actions">
        <button class="archive-action-btn" data-match-conflict-confirm="${idx}">確認並儲存</button>
        <button class="archive-action-btn archive-action-btn--secondary" data-match-conflict-cancel="${idx}">取消</button>
      </div>
    </div>`;
  }

  _renderCandidates(row, idx, loading) {
    if (row.candidates.length === 0) {
      const hint = row.stage === "1"
        ? "階段一沒有對應的單一日誌檔案，資料只來自「從輔助標記匯入」。請確認上方已顯示輔助標記筆數，再按下方「儲存」即可，不需要在這裡選檔案。"
        : "找不到日期或名稱相符的日誌檔案。";
      return `<div class="match-mark-row-body">
        <p class="match-mark-empty-hint">${hint}</p>
        <div class="match-mark-row-actions">
          ${row.stage === "1" ? "" : `<button class="archive-action-btn" data-match-goto-remark="${idx}">標示需重新標記</button>`}
          <button class="archive-action-btn archive-action-btn--secondary" data-match-skip="${idx}">略過此列</button>
        </div>
      </div>`;
    }

    const items = row.candidates.map(c => {
      const sel = row.selectedFilenames.includes(c.filename);
      const riskBadge = loading
        ? "<span class=\"match-mark-risk is-loading\">評估中…</span>"
        : c.risk
          ? `<span class="match-mark-risk match-mark-risk--${c.risk}" title="${escapeHtml((c.riskReasons || []).join("；"))}">${{ low: "低風險", medium: "中風險", high: "高風險" }[c.risk]}</span>`
          : "";
      const mergeTag = c.mergeSuggestFilename
        ? `<span class="match-mark-merge-tag" data-match-merge-pair="${idx}" data-match-merge-file="${escapeHtml(c.filename)}" data-match-merge-with="${escapeHtml(c.mergeSuggestFilename)}" title="與「${escapeHtml(c.mergeSuggestFilename)}」時間相近，且前段疑似缺少結束事件，可能是同一次記錄被中斷後拆成兩個檔案。點擊可一併勾選兩者以合併">疑似續錄，建議合併</span>`
        : "";
      return `<label class="match-mark-candidate${sel ? " is-selected" : ""}${c.suggested ? " is-suggested" : ""}">
        <input type="checkbox" data-match-cand="${idx}" data-match-cand-file="${escapeHtml(c.filename)}" ${sel ? "checked" : ""}>
        <span class="match-mark-cand-name" data-match-view-file="${escapeHtml(c.filename)}" title="點擊在「檢視」分頁開啟此檔案">${escapeHtml(c.filename)}</span>
        <span class="match-mark-cand-time">${fmtDateTime(c.modified)}</span>
        ${c.exact ? "<span class=\"match-mark-suggest-tag\">代碼精確比對</span>" : c.suggested ? "<span class=\"match-mark-suggest-tag\">建議</span>" : ""}
        ${mergeTag}
        ${riskBadge}
      </label>`;
    }).join("");

    const canOpen = row.selectedFilenames.length > 0;
    const canAccept = row.selectedFilenames.length === 1;
    return `<div class="match-mark-row-body">
      <div class="match-mark-candidate-list">${items}</div>
      <div class="match-mark-row-actions">
        <button class="archive-action-btn" data-match-accept="${idx}" ${canAccept ? "" : "disabled"} title="僅選取單一候選檔案時可用，直接採用該檔案作為比對結果，不進入重新標記工作區">直接讀入已選候選</button>
        <button class="archive-action-btn" data-match-open-remark="${idx}" ${canOpen ? "" : "disabled"}>在重新標記工作區開啟已選候選（合併）</button>
        <button class="archive-action-btn archive-action-btn--secondary" data-match-goto-remark="${idx}">標示需重新標記</button>
        <button class="archive-action-btn archive-action-btn--secondary" data-match-skip="${idx}">略過此列</button>
      </div>
    </div>`;
  }

  _bindEvents() {
    const c = this._container;
    if (!c) return;
    const fileInput = c.querySelector("#matchMarkFileInput");
    const pasteBox  = c.querySelector("#matchMarkPasteBox");

    c.querySelectorAll("[data-match-action]").forEach(btn => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.matchAction;
        if (action === "load-roster") this._loadSavedRoster();
        if (action === "import-assist") this._importFromAssistMark();
        if (action === "file") fileInput?.click();
        if (action === "paste") pasteBox?.focus();
        if (action === "refresh-server") this._loadServerFiles();
        if (action === "save-all") this._saveAllRows();
        if (action === "reset") this._resetAll();
      });
    });

    fileInput?.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) this._importFile(file);
      fileInput.value = "";
    });
    pasteBox?.addEventListener("paste", e => {
      e.preventDefault();
      this._importClipboardText(e.clipboardData?.getData("text/plain") || "");
    });

    c.querySelector("#matchMarkTolerance")?.addEventListener("change", e => this._setDateTolerance(e.target.value));
    c.querySelector("#matchMarkIdRule")?.addEventListener("change", e => this._setIdSplitRule(e.target.value));
    c.querySelectorAll("[data-match-col]").forEach(sel =>
      sel.addEventListener("change", e => this._setColumnRole(Number(sel.dataset.matchCol), e.target.value)));

    c.querySelectorAll("[data-match-toggle]").forEach(head =>
      head.addEventListener("click", () => this._toggleExpand(Number(head.dataset.matchToggle))));

    c.querySelectorAll("[data-match-cand]").forEach(cb =>
      cb.addEventListener("click", e => {
        e.stopPropagation();
        this._toggleCandidateSelect(Number(cb.dataset.matchCand), cb.dataset.matchCandFile);
      }));
    c.querySelectorAll("[data-match-view-file]").forEach(el =>
      el.addEventListener("click", e => {
        e.stopPropagation();
        e.preventDefault();
        this._viewFile(el.dataset.matchViewFile);
      }));
    c.querySelectorAll("[data-match-merge-pair]").forEach(el =>
      el.addEventListener("click", e => {
        e.stopPropagation();
        e.preventDefault();
        this._selectMergePair(Number(el.dataset.matchMergePair), el.dataset.matchMergeFile, el.dataset.matchMergeWith);
      }));

    c.querySelectorAll("[data-match-accept]").forEach(btn =>
      btn.addEventListener("click", e => { e.stopPropagation(); this._markMatched(Number(btn.dataset.matchAccept)); }));
    c.querySelectorAll("[data-match-open-remark]").forEach(btn =>
      btn.addEventListener("click", e => { e.stopPropagation(); this._openInRemark(Number(btn.dataset.matchOpenRemark)); }));
    c.querySelectorAll("[data-match-goto-remark]").forEach(btn =>
      btn.addEventListener("click", e => { e.stopPropagation(); this._gotoQuickRemark(Number(btn.dataset.matchGotoRemark)); }));
    c.querySelectorAll("[data-match-skip]").forEach(btn =>
      btn.addEventListener("click", e => { e.stopPropagation(); this._skipRow(Number(btn.dataset.matchSkip)); }));

    c.querySelectorAll("[data-match-conflict]").forEach(radio =>
      radio.addEventListener("change", e => {
        e.stopPropagation();
        this._setConflictChoice(Number(radio.dataset.matchConflict), Number(radio.dataset.matchConflictIdx), radio.value);
      }));
    c.querySelectorAll("[data-match-conflict-confirm]").forEach(btn =>
      btn.addEventListener("click", e => { e.stopPropagation(); this._confirmConflictSave(Number(btn.dataset.matchConflictConfirm)); }));
    c.querySelectorAll("[data-match-conflict-cancel]").forEach(btn =>
      btn.addEventListener("click", e => { e.stopPropagation(); this._cancelConflictSave(Number(btn.dataset.matchConflictCancel)); }));
  }
}

const _manager = new MatchMarkManager();

export function onMatchMarkActivate() {
  const el = document.getElementById("archiveMatchMark");
  if (!el) return;
  _manager.init(el);
}
