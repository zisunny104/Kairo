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
import {
  escapeHtml, parseJsonl, extractSummary, ArchiveFileState, showToast, parseJsonResponse,
  renderActionsCollapseBtn, loadCollapsedPref, saveCollapsedPref,
} from "./archive-constants.js";
import { parseDelimitedText, formatClock, parseClockMs, formatSecondsMs, DRAFT_KEY as ASSIST_MARK_DRAFT_KEY, importAttemptRowsToAssistMark } from "./archive-assist-mark.js";
import { getParticipants } from "./archive-roster.js";
import manager from "./archive-page-manager.js";

const DRAFT_KEY = "archive_match_mark_draft_v1";
const ACTIONS_COLLAPSED_KEY = "archive_match_mark_actions_collapsed_v1";
const HIDE_COMPLETED_KEY = "archive_match_mark_hide_completed_v1";

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
    hiddenFilenames: [],
  }));
}

class MatchMarkManager {
  constructor() {
    this._container = null;
    this._state = this._loadDraft() || createDefaultState();
    this._saveTimer = null;
    this._serverFiles = [];
    this._serverFilesLoaded = false;
    this._candidateCache = new Map(); // filename -> { entries, summary }
    this._expanded = new Set();
    this._loadingCandidates = new Set();
    this._showHiddenRows = new Set(); // 已展開「顯示已隱藏的檔案」的列（僅本次畫面狀態，不寫入草稿）
    this._participantIndex = null; // 實驗代碼(小寫) -> { trackingId, participantName, stage }
    this._actionsCollapsed = loadCollapsedPref(ACTIONS_COLLAPSED_KEY);
    this._previewOpen = new Set(); // 已展開「候選檔案內容預覽」的 "idx::filename" 鍵值，畫面狀態不寫入草稿
    this._previewLoading = new Set();
    this._savingAll = null; // { current, total, label } | null，全部儲存進行中的進度
    this._hideCompleted = loadCollapsedPref(HIDE_COMPLETED_KEY, true); // 收合（隱藏）已完成（已讀入／已送往標記工作區）的列，減少畫面雜訊；預設收合，避免每次都要手動點
    // 貼上區是否展開：純粹本次畫面狀態，不寫入草稿也不記本機偏好——一定要按過「貼上內容」才會展開，
    // 收合「操作」時也會一併重置成 false，避免展開操作後貼上區無緣無故自己冒出來。
    this._pasteOpen = false;
  }

  async init(container) {
    this._container = container;
    this._render();
    // 先等伺服器草稿同步完成再繼續，避免在同步的空檔誤動到即將被伺服器版本蓋掉的本機資料
    await this._loadFromServer();
    this._bindFlushOnLeave();
    const tasks = [this._ensureParticipantIndex().then(() => this._applyParticipantIndexToAllRows())];
    if (!this._serverFilesLoaded) tasks.push(this._loadServerFiles());
    await Promise.all(tasks);
    this._render();
  }

  // 分頁被切走／關閉前，把還在 debounce 排隊中的儲存立刻送出，
  // 避免「操作完成→馬上切頁或重新整理」時，最後一筆還沒送到伺服器就被下次讀取的舊草稿蓋掉。
  _bindFlushOnLeave() {
    const flush = () => {
      if (!this._saveTimer) return;
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this._pushToServer({ keepalive: true });
    };
    document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
    window.addEventListener("pagehide", flush);
  }

  // 建立「實驗代碼 → 受試者ID／姓名」對照表（來自已存名單），只抓一次、快取起來，
  // 讓只有實驗代碼欄的匯入表格也能自動帶出受試者資料，不用每次都手動比對。
  // 姓名只在這裡查一次名單就地顯示用，不會存進伺服器的分析紀錄裡（那邊只存 trackingId）。
  async _ensureParticipantIndex() {
    if (this._participantIndex) return this._participantIndex;
    const index = new Map();
    const participants = await getParticipants();
    for (const p of participants) {
      const add = (expId, stage) => {
        const key = String(expId || "").trim().toLowerCase();
        if (key) index.set(key, { trackingId: p.trackingId, participantName: p.name || "", stage });
      };
      add(p.stage1?.experimentId, "1");
      add(p.stage2?.attempt1?.experimentId, "2-1");
      add(p.stage2?.attempt2?.experimentId, "2-2");
    }
    this._participantIndex = index;
    return index;
  }

  // 依實驗代碼(idRaw)自動帶入受試者ID／姓名／階段；已有資料的列（例如 roster 匯入）不覆蓋
  _applyParticipantIndexToAllRows() {
    if (!this._participantIndex?.size) return;
    for (const row of this._state.rows) {
      if (row.trackingId != null) continue;
      const hit = this._participantIndex.get(String(row.idRaw || "").trim().toLowerCase());
      if (hit) { row.trackingId = hit.trackingId; row.participantName = hit.participantName; row.stage = hit.stage; }
    }
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
      const data = await parseJsonResponse(res);
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
    const data = await parseJsonResponse(res);
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

  // 開啟時向伺服器要目前共用的草稿並蓋掉本機暫存，這樣不同裝置／不同分頁打開時看到的進度一致，
  // 不會像純 localStorage 那樣各自為政、互相覆蓋。讀取失敗（離線等）時維持目前本機草稿即可。
  // 但如果本機草稿的 lastSavedAt 比伺服器新（例如剛存完一筆、debounce 還沒送出就重新整理），
  // 代表伺服器那份還是舊的，此時不能覆蓋本機，反而要把本機這份補送上去，否則剛做的標記會憑空消失。
  async _loadFromServer() {
    try {
      const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.MATCH_MARK.DRAFT}`);
      const data = await parseJsonResponse(res);
      if (!data.success || !data.draft) return;
      if ((this._state.lastSavedAt || 0) > (data.draft.lastSavedAt || 0)) {
        this._pushToServer();
        return;
      }
      this._state = data.draft;
      this._saveLocalDraft();
      this._render();
    } catch {
      // 讀取失敗時維持目前（本機）草稿，使用者仍可照常操作
    }
  }

  // 把目前草稿同步到伺服器，debounce 避免每個小動作都送出請求
  _scheduleServerSync() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._pushToServer(), 800);
  }

  async _pushToServer({ keepalive = false } = {}) {
    try {
      await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.MATCH_MARK.DRAFT}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this._state),
        keepalive,
      });
    } catch {
      // 同步失敗不中斷編輯，本機仍保留最新內容，下次異動會再次觸發同步
    }
  }

  _saveDraft() {
    this._saveLocalDraft();
    this._scheduleServerSync();
  }

  _saveLocalDraft() {
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
      const data = await parseJsonResponse(res);
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
      showToast(`載入名單失敗：${err.message}`, "error");
    }
  }

  // 把伺服器上已經存過的分析原始資料（其他客戶端或先前操作按過「全部儲存」的結果）
  // 依「受試者＋階段」帶回目前的列，這樣不同客戶端載入名單時比對進度是一致的，
  // 不用重新比對已經完成的部分。
  async _hydrateFromSavedAnalysis(rows) {
    try {
      const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.ANALYSIS.LIST}`);
      const data = await parseJsonResponse(res);
      if (!data.success) return;
      const byKey = new Map();
      for (const r of data.records || []) byKey.set(`${r.trackingId}::${r.stage}`, r);
      for (const row of rows) {
        const rec = byKey.get(`${row.trackingId}::${row.stage}`);
        if (!rec) continue;
        if (rec.matchedFilename) row.matchedFilename = rec.matchedFilename;
        // 只有伺服器標記過這批 attempts 是真的輔助標記人工資料才寫進 assistDataRows，
        // 不然名單比對這邊自己用日誌檔翻譯出來、當初只是為了不讓最終分析漏掉這個人的
        // 備援資料，重新整理後會被誤標成「輔助標記」，但輔助標記那邊根本沒有這筆資料。
        if (rec.hasAssistData && rec.attempts?.length) row.assistDataRows = rec.attempts;
        else if (rec.attempts?.length) row._logAttemptsCache = { filename: rec.matchedFilename || "", attempts: rec.attempts };
        // 記下目前狀態＝伺服器現況的簽章，「全部儲存」才知道這一列跟上次存的一樣、可以跳過
        row._savedSignature = this._rowSignature(row);
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
      showToast("找不到「輔助標記」的暫存資料，請先在該分頁載入並標記過一次。", "warning");
      return;
    }

    const headers = assistState.headers || [];
    const trackingIdCol = guessAssistCol(headers, /^(id|受試者id)$/i);
    // 原本只認 experiment_id/實驗代碼/代碼，沒認到本專案實際在用的「實驗ID」寫法，
    // 導致欄位猜不到、整個匯入直接中止（連花費時間都沒機會讀），格式一符合就沒問題
    const experimentIdCol = guessAssistCol(headers, /experiment_?id|實驗(代碼|id)|^代碼$/i);
    const participantNameCol = guessAssistCol(headers, /participant_name|受試者姓名|^姓名$/i);
    const gestureCommandCol = guessAssistCol(headers, /gesture_command|手勢指令/i);
    const typeCol = guessAssistCol(headers, /^type$/i);
    const typeRawCol = guessAssistCol(headers, /type_raw|原始類型/i);
    const noteCol = guessAssistCol(headers, /note|備註/i);
    // 花費時間欄位優先直接採用輔助標記自己記錄的 durationCol（權威值），不要用正規表達式重猜——
    // 如果原始來源檔案本身就有欄位名稱同樣符合 /花費時間|duration|耗時/i 的欄（例如舊的日誌匯出
    // 欄位「耗時(ms)」），輔助標記那邊是認第一個符合的欄位當作真正的計時欄，但這裡的
    // guessAssistCol 是從最後一欄往前找、抓到的可能是完全不同的另一欄，導致讀到的花費時間
    // 全部是空的（使用者明明已經標記完成，比對出來卻變成 0 筆）。
    const durationCol = Number.isInteger(assistState.durationCol) ? assistState.durationCol : guessAssistCol(headers, /花費時間|duration|耗時/i);

    if (experimentIdCol < 0) {
      showToast(`輔助標記的資料裡找不到可辨識的實驗代碼欄位。\n目前的欄位名稱是：${headers.join("、") || "（無）"}\n請把該欄位改名為「實驗ID」「實驗代碼」或「experiment_id」其中之一，再重新匯入。`, "error", 8000);
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
    const kept = []; // { label, existingDurationCount, incomingDurationCount }
    const overwroteLogSource = []; // 原本靠日誌檔確認過、這次被輔助標記資料蓋過去的受試者，只提醒不阻擋
    const updatedRowIdx = []; // 這次匯入實際讓內容產生變化（新增/修改花費時間等）的列，供畫面上定位、高亮
    const filledIn = []; // { label, count } 這次比對到「新填入的花費時間」筆數，讓使用者能看出具體是哪些人補上了時間
    for (let idx = 0; idx < this._state.rows.length; idx++) {
      const row = this._state.rows[idx];
      const expId = String(row.idRaw || "").trim().toLowerCase();
      if (!expId) continue;
      const tId = row.trackingId != null && trackingIdCol >= 0 ? String(row.trackingId).trim().toLowerCase() : "";
      const rows = lookup.get(keyOf(expId, tId));
      if (!rows?.length) continue;
      // 對應到名單後，姓名一律改用名單資料（row.participantName）為準，
      // 不採用輔助標記貼上檔案裡逐列可能空白/打錯的姓名欄，確保同一人在同一份輸出裡姓名一致。
      const incoming = rows.map(r => ({ ...r, participantName: row.participantName || r.participantName }));
      const label = row.participantName || row.idRaw || `受試者 ${row.trackingId}`;
      const existingDurationCount = (row.assistDataRows || []).filter(a => a.duration).length;
      const incomingDurationCount = incoming.filter(a => a.duration).length;
      // 這一列已經有資料、且這次比對到的花費時間筆數比目前少（例如輔助標記端本機資料遺失後
      // 又重新匯入一次），視為比較不完整的資料，不覆蓋目前這一列已有的計時結果，
      // 避免「重新匯入」把先前已經記錄成功的時間洗掉。
      if (row.assistDataRows?.length && incomingDurationCount < existingDurationCount) {
        kept.push({ label, existingDurationCount, incomingDurationCount });
        continue;
      }
      // 資料來源理論上唯一：這一列如果已經用日誌檔讀入確認過（matchedFilename），代表當初
      // 認定的來源是日誌檔，現在卻又要被輔助標記資料覆蓋——不擋流程，但要留下紀錄讓使用者
      // 事後能檢查是不是誤觸，避免同一筆資料的來源被無聲切換掉。
      if (row.matchedFilename && !row.assistDataRows?.length) {
        overwroteLogSource.push(label);
      }
      // 內容跟目前完全相同就不算「更新」，避免每次重新匯入都被算進「這次有變化」的清單，
      // 讓使用者分不出這次到底真的補了什麼、還是資料本來就沒變。
      const identical = JSON.stringify(row.assistDataRows || []) === JSON.stringify(incoming);
      if (!identical) {
        updatedRowIdx.push(idx);
        const newlyFilled = incomingDurationCount - existingDurationCount;
        if (newlyFilled > 0) filledIn.push({ label, count: newlyFilled });
      }
      row.assistDataRows = incoming;
      matched++;
      totalRows += incoming.length;
    }
    this._saveDraft();
    this._render();
    if (updatedRowIdx.length) {
      requestAnimationFrame(() => {
        updatedRowIdx.forEach(idx => {
          const el = this._container?.querySelector(`[data-row-idx="${idx}"]`);
          if (!el) return;
          el.classList.add("is-jump-highlight");
          setTimeout(() => el.classList.remove("is-jump-highlight"), 1500);
        });
      });
    }
    // 花費時間欄位沒被辨識到、或比對到的資料裡花費時間全是空白，都要明確提示，
    // 不要讓「有匯入」跟「有花費時間可用」被誤會成同一件事
    const durationWarning = durationCol < 0
      ? "\n⚠ 沒有辨識到「花費時間」欄位，匯入的資料不含計時結果。"
      : totalRows > 0 && this._state.rows.every(r => !r.assistDataRows?.some(a => a.duration))
        ? `\n⚠ 有比對到資料，但讀到的「${headers[durationCol] || "（未命名欄）"}」欄內容全是空白，請確認輔助標記那邊是否都已完成計時、且該欄位就是實際計時的那一欄。`
        : "";
    // 把實際筆數列出來，才能判斷是輔助標記真的漏了幾筆、還是名單比對這邊存的資料本身比較多／有重複，
    // 不要只說「比較少」卻不給數字，逼使用者用猜的。
    const keptWarning = kept.length > 0
      ? `\n⚠ 以下受試者這次比對到的花費時間筆數比目前已有的少，已保留原本資料，未覆蓋：\n${kept.map(k => `　${k.label}：名單比對現有 ${k.existingDurationCount} 筆，輔助標記這次比對到 ${k.incomingDurationCount} 筆`).join("\n")}`
      : "";
    const sourceWarning = overwroteLogSource.length > 0
      ? `\n⚠ 以下受試者原本是用日誌檔讀入確認的，這次改用輔助標記資料覆蓋，請確認是否為誤觸：\n${overwroteLogSource.map(l => `　${l}`).join("\n")}`
      : "";
    // 只列出「這次真的新填入花費時間」的人，讓使用者能明確看出補了誰的時間，
    // 而不是每次都只看到一個總數、猜不出跟上次比對到底差在哪裡。
    const filledWarning = filledIn.length > 0
      ? `\n✅ 這次新填入花費時間：\n${filledIn.map(f => `　${f.label}：新增 ${f.count} 筆`).join("\n")}`
      : "";
    const noChangeNote = updatedRowIdx.length === 0 && matched > 0
      ? "\nℹ 這次比對到的資料跟目前已有的完全相同，沒有任何欄位被更新。"
      : "";
    showToast(`已從「輔助標記」匯入（依人員 ID ＋ 實驗 ID 比對），共比對到 ${matched} 位受試者、合計 ${totalRows} 列手勢紀錄。${filledWarning}${noChangeNote}${durationWarning}${keptWarning}${sourceWarning}`, durationWarning || keptWarning || sourceWarning ? "warning" : "success", filledWarning || keptWarning || sourceWarning ? 15000 : 6000);
  }

  // 反向操作：把目前已比對好、且已有花費時間的 assistDataRows 回填進「輔助標記」目前已有的表格，
  // 只補空白的花費時間欄，不動其他欄位，因此不需要覆蓋確認（輔助標記那邊沒有資料會被洗掉）。
  // 用途是輔助標記端本機/伺服器草稿意外遺失花費時間時，從名單比對這邊留存的副本補回來。
  _exportToAssistMark() {
    const attemptRows = [];
    for (const row of this._state.rows) {
      if (!row.assistDataRows?.length) continue;
      for (const a of row.assistDataRows) {
        if (!a.duration) continue;
        attemptRows.push({
          trackingId: row.trackingId,
          experimentId: row.idRaw,
          gestureCommand: a.gestureCommand || "",
          duration: a.duration,
        });
      }
    }
    if (!attemptRows.length) {
      showToast("目前名單裡沒有可回填的花費時間（每一列都還沒有比對到有計時的手勢紀錄）。", "warning");
      return;
    }
    importAttemptRowsToAssistMark(attemptRows, "名單比對");
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
        hiddenFilenames: [],
      };
    });
    this._applyParticipantIndexToAllRows();
    this._recomputeAllCandidates();
  }

  _recomputeAllCandidates() {
    if (!this._serverFiles.length) return;
    for (const row of this._state.rows) {
      row.candidates = this._computeCandidates(row);
      // 候選規則變嚴或伺服器清單變動後，之前隱藏的檔名可能已經不在新的候選名單裡了；
      // 這種殘留紀錄留著只會讓「已隱藏」筆數比候選總數還多，算出負的「顯示中」筆數。
      if (row.hiddenFilenames?.length) {
        const validFilenames = new Set(row.candidates.map(c => c.filename));
        row.hiddenFilenames = row.hiddenFilenames.filter(f => validFilenames.has(f));
      }
    }
  }

  _computeCandidates(row) {
    const files = this._serverFiles;

    // 檔名前綴與受試者代碼完全相符時（如 roster 匯入的 experimentId），直接視為精確比對，
    // 優先於任何其他篩選——只要實驗ID相同就一定要出現，且一律直接讀取當前的伺服器檔案列表
    // 現算現比對，不額外建立/快取索引，也不受階段限制（原本階段一會整列跳過，導致
    // 即使檔名精確相符也不會顯示，這裡改成精確比對永遠先做）。
    const idRaw = (row.idRaw || "").toLowerCase();
    if (idRaw) {
      const exact = files.filter(f => f.filename.toLowerCase().split("_")[0] === idRaw);
      if (exact.length) {
        return exact.slice().sort((a, b) => a.modified - b.modified)
          .map(f => ({ filename: f.filename, modified: f.modified, size: f.size, suggested: true, exact: true }));
      }
    }

    // 階段一沒有對應的單一日誌檔（該階段的資料只來自輔助標記匯入），沒有精確比對時
    // 不做模糊比對，避免用日期／前綴誤配到其他階段的日誌檔
    if (row.stage === "1") return [];

    const tolMs = (this._state.dateToleranceDays ?? 1) * DAY_MS;
    let pool;
    // 模糊比對一定要先看「編號」是否相同，日期只能當輔助的額外限制——
    // 之前日期在、就只靠日期相近選候選，完全不看 ID，結果一堆不同人、甚至沒有 ID 的
    // 檔案只因為存檔時間相近就被當成候選（誤導使用者以為是自己要找的檔案改了名字）。
    if (row.idParsed?.number != null) {
      const num = row.idParsed.number;
      const prefix = (row.idParsed.prefix || "").toLowerCase();
      pool = files.filter(f => {
        const fParsed = parseCompositeId(f.filename.split("_")[0], this._state.idSplitRule);
        return fParsed?.number === num && (!prefix || (fParsed.prefix || "").toLowerCase() === prefix);
      });
      if (row.dateTs != null) {
        const target = dayKey(row.dateTs);
        pool = pool.filter(f => Math.abs(dayKey(f.modified) - target) <= tolMs);
      }
    } else if (row.idParsed?.prefix) {
      // 這一列的 ID 完全解析不出編號（純文字代號），只能退回用字首子字串比對，
      // 但比對的是「完整代號」，不是日期，所以至少還是跟這個人的代號有關。
      const p = row.idParsed.prefix.toLowerCase();
      pool = files.filter(f => f.filename.toLowerCase().includes(p));
    } else if (row.dateTs != null) {
      const target = dayKey(row.dateTs);
      pool = files.filter(f => Math.abs(dayKey(f.modified) - target) <= tolMs);
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
        } else if (row.count == null && (c.summary.attemptCount || 0) <= 1) {
          // 名單沒填「預期次數」時無法比對出入，改用一個保守的絕對下限自我把關：
          // 只有 0～1 筆手勢紀錄的檔案，即使正常結束，也很可能是誤觸或中途放棄，值得提醒。
          reasons.push(`只有 ${c.summary.attemptCount || 0} 筆手勢紀錄，內容可能不完整`);
        }
        // 內容比對：日誌內嵌的 exp_id 與這一列預期的實驗ID 是否一致（不只靠檔名猜測）
        const actualExpId = String(c.summary.expId || "").trim().toLowerCase();
        if (expected && actualExpId && actualExpId !== "—" && actualExpId !== expected) {
          reasons.push(`日誌內容 exp_id「${c.summary.expId}」與預期「${row.idRaw}」不符`);
        }
        const prev = withTime[i - 1];
        if (prev?.summary?.endTime != null && c.summary.startTime < prev.summary.endTime) {
          reasons.push("與前一候選時間重疊");
        }
        // 「與前一候選間隔較大」不算風險：只要前一筆已經正常結束，這一筆就只是同一天／
        // 同一實驗代碼底下另一次獨立的記錄，不該因為時間隔得比較開就被扣分。
        // 真正「疑似中斷續錄」的判斷（前一筆沒有結束事件）已經交給下面的合併建議處理。
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

  // 候選檔案的內容預覽：直接在名單比對頁的卡片內展開，不切換到「檢視」分頁，
  // 這樣確認完是否為同一人之後，位置、捲動、展開狀態都不會跑掉。
  async _togglePreview(idx, filename) {
    const key = `${idx}::${filename}`;
    if (this._previewOpen.has(key)) { this._previewOpen.delete(key); this._render(); return; }
    this._previewOpen.add(key);
    this._render();
    if (this._candidateCache.has(filename)) return;
    this._previewLoading.add(key);
    this._render();
    try { await this._fetchEntries(filename); } catch { /* 讀取失敗時 _renderCandidatePreview 會顯示錯誤提示 */ }
    this._previewLoading.delete(key);
    this._render();
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

  // 把已確認不OK的候選檔案從列表中隱藏（僅此列、此檔案），若原本已勾選則一併取消勾選
  _hideCandidate(idx, filename) {
    const row = this._state.rows[idx];
    if (!row || !filename) return;
    if (!row.hiddenFilenames) row.hiddenFilenames = [];
    if (!row.hiddenFilenames.includes(filename)) row.hiddenFilenames.push(filename);
    const at = row.selectedFilenames.indexOf(filename);
    if (at >= 0) row.selectedFilenames.splice(at, 1);
    this._saveDraft();
    this._render();
  }

  _unhideCandidate(idx, filename) {
    const row = this._state.rows[idx];
    if (!row?.hiddenFilenames) return;
    const at = row.hiddenFilenames.indexOf(filename);
    if (at >= 0) row.hiddenFilenames.splice(at, 1);
    this._saveDraft();
    this._render();
  }

  _toggleShowHidden(idx) {
    if (this._showHiddenRows.has(idx)) this._showHiddenRows.delete(idx);
    else this._showHiddenRows.add(idx);
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
    // 快取翻譯結果，這樣「缺時間」提示才能在存檔後直接從記憶體讀出來顯示，不用每次都重新抓檔；
    // 用檔名當快取鍵，換了對應檔案（重新讀入／改選候選）就自然作廢，不會顯示舊檔案的結果。
    if (row._logAttemptsCache?.filename === filename) return row._logAttemptsCache.attempts;
    try {
      const { entries } = await this._fetchEntries(filename);
      const attempts = translateLogEntriesToAttempts(entries, row.participantName);
      row._logAttemptsCache = { filename, attempts };
      return attempts;
    } catch {
      return [];
    }
  }

  // 名單比對頁不用另外抓檔就能算出「缺時間」提示所需的逐筆資料：優先用已知的
  // assistDataRows（人工輔助標記或從伺服器讀回的紀錄），否則用上面那個以檔名為鍵的
  // 翻譯快取（存檔後才會有）；兩者都沒有就代表還沒解析過，不顯示提示（而不是誤判為沒問題）。
  _knownAttemptsFor(row) {
    if (row.assistDataRows?.length) return row.assistDataRows;
    const filename = row.matchedFilename || row.selectedFilenames?.[0];
    if (filename && row._logAttemptsCache?.filename === filename) return row._logAttemptsCache.attempts;
    return null;
  }

  // 這一列「有沒有變更過」直接比對目前會存出去的內容跟上次成功存檔當下記錄的簽章，
  // 而不是另外維護一個 dirty 布林值——布林值需要在每個修改點手動同步，容易漏掉（就像
  // 先前 decision 狀態忘記同步的教訓一樣），簽章則是從實際資料算出來，不會跟真實狀態脫節。
  _rowSignature(row) {
    return JSON.stringify([row.matchedFilename || row.selectedFilenames?.[0] || "", row.assistDataRows || null]);
  }

  // 確認配對（直接讀入 / 送往重新標記合併）時，把這一列目前已有的分析用原始資料
  // 寫入伺服器 runtime/analysis/（衍生資料，欄位可不齊全，之後可被覆寫更新）
  async _saveAnalysisFile(row) {
    if (row.trackingId == null || !row.stage) return; // 非 roster 匯入的列沒有階段代號，不寫入
    try {
      const attempts = await this._resolveAttempts(row);
      const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.ANALYSIS.SAVE}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trackingId: row.trackingId,
          stage: row.stage,
          experimentId: row.idRaw,
          date: row.date,
          matchedFilename: row.matchedFilename || row.selectedFilenames?.[0] || "",
          attempts,
          hasAssistData: !!row.assistDataRows?.length,
        }),
      });
      const data = await parseJsonResponse(res);
      if (data.success) row._savedSignature = this._rowSignature(row);
    } catch { /* 寫入失敗不中斷比對流程，草稿仍保留資料，之後可重新觸發 */ }
  }

  // 手動「儲存」按鈕：把目前這列的資料存進伺服器，會跟既有檔案合併；
  // 欄位若兩邊都有值但不同，伺服器回傳衝突清單，改顯示衝突解決面板讓使用者選擇。
  // 回傳值：伺服器是否判定這次送出的 attempts 比現有的「已記錄花費時間」筆數少而拒絕覆蓋
  // （attemptsRegressed），呼叫端可依此提示使用者，並讓本機資料跟伺服器實際存檔內容同步。
  async _saveRow(idx, overrides = null) {
    const row = this._state.rows[idx];
    if (!row || row.trackingId == null || !row.stage) return false;
    const attempts = await this._resolveAttempts(row);
    const payload = {
      trackingId: row.trackingId,
      stage: row.stage,
      experimentId: row.idRaw,
      date: row.date,
      matchedFilename: row.matchedFilename || row.selectedFilenames?.[0] || "",
      attempts,
      hasAssistData: !!row.assistDataRows?.length,
    };
    if (overrides) payload.overrides = overrides;

    try {
      const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.ANALYSIS.SAVE}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await parseJsonResponse(res);
      if (res.status === 409 && data.conflict) {
        row.saveConflict = data.conflicts.map(cf => ({ ...cf, choice: "incoming" }));
        this._render();
        return false;
      }
      if (!data.success) throw new Error(data.error || "儲存失敗");
      row.saveConflict = null;
      if (data.attemptsRegressed && data.record) {
        // 伺服器保留了原有的 attempts（沒有採用這次送出的版本），把本機這一列同步回伺服器
        // 實際存檔的內容，避免本機看到的資料跟伺服器真正存的東西不一致。
        // 只有伺服器判定那份資料是真的輔助標記人工資料時才寫回 assistDataRows，
        // 不然日誌翻譯出來的備援資料會被誤標成「輔助標記」。
        if (data.record.hasAssistData) row.assistDataRows = data.record.attempts || [];
        else row._logAttemptsCache = { filename: data.record.matchedFilename || "", attempts: data.record.attempts || [] };
      }
      row._savedSignature = this._rowSignature(row);
      this._saveDraft();
      this._render();
      return !!data.attemptsRegressed;
    } catch (err) {
      showToast(`儲存失敗：${err.message}`, "error");
      return false;
    }
  }

  // 上方「全部儲存」按鈕：逐列送出（伺服器一次只認一列），若某列有欄位衝突就停在該列的衝突面板等待選擇，
  // 其餘列繼續送出，最後統一回報結果。過程中顯示進度（第幾筆／共幾筆），並攔截關閉分頁／重新整理，
  // 避免使用者以為儲存中途離開會遺失資料——實際上每一筆都是伺服器確認成功才會前進，
  // 中途離開頂多是「還沒送到的那幾筆要重按一次」，不會讓已存成功的資料不見，但沒有提示的話很難放心等待。
  async _saveAllRows() {
    const rows = this._state.rows;
    const targets = [];
    let skippedNonRoster = 0, skippedUnchanged = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.trackingId == null || !row.stage) { skippedNonRoster++; continue; }
      const hasData = !!(row.matchedFilename || row.selectedFilenames?.length || row.assistDataRows?.length);
      // 完全沒有資料可存、或內容跟上次成功存檔時一模一樣的列，直接跳過，不用每次「全部儲存」
      // 都把每一列重新送一次伺服器。
      if (!hasData || row._savedSignature === this._rowSignature(row)) { skippedUnchanged++; continue; }
      targets.push(i);
    }
    let saved = 0, conflicts = 0, attemptsRegressed = 0;

    const beforeUnload = e => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    this._savingAll = { current: 0, total: targets.length, label: "" };
    this._render();
    try {
      for (let n = 0; n < targets.length; n++) {
        const i = targets[n];
        const row = rows[i];
        this._savingAll = {
          current: n + 1, total: targets.length,
          label: row.groupLabel || row.participantName || row.idRaw || "",
        };
        this._render();
        const regressed = await this._saveRow(i);
        if (regressed) attemptsRegressed++;
        if (this._state.rows[i]?.saveConflict) conflicts++;
        else saved++;
      }
    } finally {
      window.removeEventListener("beforeunload", beforeUnload);
      this._savingAll = null;
      this._render();
    }

    const skipNote = [
      skippedUnchanged ? `${skippedUnchanged} 筆未變更` : "",
      skippedNonRoster ? `${skippedNonRoster} 筆非名單匯入列` : "",
    ].filter(Boolean).join("、");
    // 伺服器判斷送出的花費時間比現有的少而拒絕覆蓋時，本機資料已在 _saveRow 內同步回伺服器實際內容，
    // 這裡只需要提醒使用者「有筆數被保護」，避免誤以為全部儲存＝全部套用了本機這份內容。
    const regressedNote = attemptsRegressed ? `${attemptsRegressed} 筆偵測到花費時間比伺服器現有的少，已保留伺服器原有資料` : "";
    if (conflicts) {
      showToast(`已儲存 ${saved} 筆，其中 ${conflicts} 筆有欄位衝突，請在下方列表中確認並儲存。`, "warning", 6000);
    } else if (regressedNote) {
      showToast(`已儲存 ${saved} 筆，其中 ${regressedNote}，未覆蓋。${skipNote ? `（另 ${skipNote}，已略過）` : ""}`, "warning", 7000);
    } else if (!targets.length) {
      showToast(`沒有需要儲存的變更${skipNote ? `（${skipNote}，已略過）` : ""}。`, "success");
    } else {
      showToast(`已全部儲存，共 ${saved} 筆${skipNote ? `（${skipNote}，已略過）` : ""}。`, "success");
    }
  }

  // 清除伺服器上這位受試者・這個階段已存的分析資料（比對／整合後發現資料有問題時用來重來一次），
  // 同時把這一列的本機狀態退回「待確認」，不影響其他列。
  async _clearSavedAnalysis(idx) {
    const row = this._state.rows[idx];
    if (!row || row.trackingId == null || !row.stage) return;
    const label = row.groupLabel || row.participantName || row.idRaw || `受試者 ${row.trackingId}`;
    if (!confirm(`確定要清除「${label}」已儲存的分析資料嗎？此動作無法復原。`)) return;
    try {
      const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.ANALYSIS.DELETE(row.trackingId, row.stage)}`, { method: "DELETE" });
      const data = await parseJsonResponse(res);
      if (!data.success) throw new Error(data.error || "刪除失敗");
      row.decision = "pending";
      row.matchedFilename = null;
      row.assistDataRows = null;
      row.saveConflict = null;
      row._savedSignature = null; // 伺服器紀錄已被刪除，強制視為未同步，之後重新比對存檔時一定會再送一次
      this._saveDraft();
      this._render();
    } catch (err) {
      showToast(`清除失敗：${err.message}`, "error");
    }
  }

  _setConflictChoice(idx, conflictIdx, choice) {
    const row = this._state.rows[idx];
    if (!row?.saveConflict?.[conflictIdx]) return;
    row.saveConflict[conflictIdx].choice = choice;
  }

  async _confirmConflictSave(idx) {
    const row = this._state.rows[idx];
    if (!row?.saveConflict) return;
    const overrides = {};
    for (const cf of row.saveConflict) {
      overrides[cf.field] = cf.choice === "existing" ? cf.existing : cf.incoming;
    }
    const label = row.groupLabel || row.participantName || row.idRaw || "";
    const regressed = await this._saveRow(idx, overrides);
    if (regressed) {
      showToast(`「${label}」比對到的花費時間筆數比伺服器現有的少，已保留伺服器原有計時資料，未覆蓋。`, "warning", 7000);
    }
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

    // 「已讀入」直接看 matchedFilename 有沒有值，不再另外存一個 decision 狀態去追蹤——
    // 兩個值分開存很容易像先前那樣忘記同步（重新整理名單後看起來像退回「待確認」）。
    row.matchedFilename = primary;
    this._saveDraft();
    this._render();
    // 存檔完成後再 render 一次：翻譯日誌拿到逐筆時間需要等 fetch，缺時間提示要等這時候才看得到。
    this._saveAnalysisFile(row).then(() => this._render());
  }

  // 點「已讀入 檔名」：跳到檢視分頁、直接以「重新標記」編輯模式開啟這個已確認的日誌檔，
  // 方便使用者確認內容有沒有異常。這裡只是打開來看／編輯，還沒有異動這一列的比對狀態——
  // 若看過沒問題，直接切走分頁即可，原始檔案不受影響；若真的編輯並「另存新檔」，
  // 要回來這裡按「重新讀入」才會把新存的檔案抓進候選清單。
  async _editMatchedFile(idx) {
    const row = this._state.rows[idx];
    if (!row?.matchedFilename) return;
    document.querySelector("[data-tab=\"viewer\"]")?.click();
    await manager._openServer(row.matchedFilename);
    if (manager._file) manager._file.viewMode = "remark";
    manager._renderAll?.();
  }

  // 「重新讀入」：在檢視分頁編輯並「另存新檔」後（原始檔不變、產生一個新檔名），
  // 回來這一列重新抓伺服器檔案清單，找到新存的編輯檔就直接採用（精確比對候選按修改時間
  // 排序，剛存好的編輯檔一定最新），不需要使用者再多按一次「直接讀入已選候選」確認——
  // 若選錯，仍可在展開的候選列表裡自行改選其他候選再手動讀入。
  // 找不到比目前 matchedFilename 更新的候選，就代表沒有新的編輯檔，原本讀入的那份沒有問題，
  // 維持原樣即可，不需要進入任何「待確認」的中繼狀態。
  async _reopenForRematch(idx) {
    const row = this._state.rows[idx];
    if (!row) return;
    this._expanded.add(idx);
    await this._loadServerFiles();
    const refreshed = this._state.rows[idx];
    if (!refreshed?.candidates?.length) return;
    const exactCandidates = refreshed.candidates.filter(c => c.exact);
    const latest = (exactCandidates.length ? exactCandidates : refreshed.candidates).slice(-1)[0];
    if (!latest || latest.filename === refreshed.matchedFilename) return;
    refreshed.selectedFilenames = [latest.filename];
    refreshed.matchedFilename = latest.filename;
    this._saveDraft();
    this._render();
    this._saveAnalysisFile(refreshed).then(() => this._render());
  }

  // 自動比對找不到某個人要的檔案時，讓使用者直接把還在自己電腦裡、還沒上傳的 .jsonl
  // 拖曳到那個人的列上：先依實驗ID命名（跟實驗機存檔同一套規則）上傳到伺服器，
  // 上傳成功後這個檔名前綴就會與 idRaw 完全相符，自動被精確比對邏輯認到並直接勾選起來，
  // 不需要另外處理選取狀態。
  async _dropFileOntoRow(idx, file) {
    const row = this._state.rows[idx];
    if (!row) return;
    if (!file.name.toLowerCase().endsWith(".jsonl")) {
      showToast(`不支援的檔案格式，請拖曳原始的實驗日誌 .jsonl 檔案。`, "error");
      return;
    }
    const safeId = String(row.idRaw || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeId) {
      showToast("這一列沒有可用的實驗ID，無法指定檔案。", "error");
      return;
    }
    const label = row.groupLabel || row.participantName || row.idRaw;
    try {
      const content = await file.text();
      const filename = `${safeId}_${Date.now()}.jsonl`;
      const res = await this._authedFetch(`${getApiUrl()}${API_ENDPOINTS.RECORD.SAVE}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, content }),
      });
      const data = await parseJsonResponse(res);
      if (!data.success) throw new Error(data.error || "上傳失敗");
      this._serverFiles.push({ filename: data.filename, size: data.size, modified: Date.now() });
      this._recomputeAllCandidates();
      row.selectedFilenames = [data.filename];
      this._expanded.add(idx);
      this._saveDraft();
      this._render();
      showToast(`已將「${file.name}」指定給「${label}」，請在展開的候選清單確認後按「直接讀入已選候選」。`, "success", 6000);
    } catch (err) {
      showToast(`指定檔案失敗：${err.message}`, "error");
    }
  }

  _markMatched(idx) {
    const row = this._state.rows[idx];
    if (!row || row.selectedFilenames.length !== 1) return;
    row.matchedFilename = row.selectedFilenames[0];
    this._saveDraft();
    this._render();
    // 存檔完成後再 render 一次：翻譯日誌拿到逐筆時間需要等 fetch，缺時間提示要等這時候才看得到。
    this._saveAnalysisFile(row).then(() => this._render());
  }

  _gotoQuickRemark(idx) {
    const row = this._state.rows[idx];
    if (!row) return;
    row.decision = "needs-remark";
    this._saveDraft();
    this._render();
    const hint = `${row.idRaw}${row.combo ? " · " + row.combo : ""}`;
    navigator.clipboard?.writeText(hint).catch(() => {});
    showToast(`已將「${hint}」標記為需重新標記，識別碼已複製到剪貼簿，可在「簡易標記」錄製時對照。`, "success", 6000);
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

  _resetAll() {
    this._state = createDefaultState();
    this._expanded.clear();
    this._previewOpen.clear();
    this._previewLoading.clear();
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* noop */ }
    this._scheduleServerSync(); // 把清空後的狀態同步上去，避免其他裝置／分頁之後又把舊草稿蓋回來
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
      <p>載入已建立的受試者名單，或上傳含受試者 ID 的 Excel / CSV／直接貼上表格內容，也可以把檔案拖曳到這裡，系統會嘗試比對伺服器上既有的日誌檔。</p>
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
          <div class="assist-mark-actions-group">
            ${renderActionsCollapseBtn("data-match-toggle-actions", this._actionsCollapsed)}
            <div class="assist-mark-actions${this._actionsCollapsed ? " is-collapsed" : ""}">
              <button class="archive-action-btn" data-match-action="load-roster">載入已存名單</button>
              <button class="archive-action-btn" data-match-action="import-assist" ${hasData ? "" : "disabled"}>從輔助標記匯入</button>
              <button class="archive-action-btn" data-match-action="export-assist" ${hasData ? "" : "disabled"} title="把目前已比對到的花費時間回填進「輔助標記」現有表格裡對得起來、還空白的那些列，不影響其他欄位">回填花費時間到輔助標記</button>
              <button class="archive-action-btn" data-match-action="paste">貼上內容</button>
              <button class="archive-action-btn" data-match-action="file">選擇檔案</button>
              <button class="archive-action-btn" data-match-action="refresh-server">重新載入伺服器清單</button>
              <button class="archive-action-btn" data-match-action="toggle-hide-completed" ${hasData ? "" : "disabled"} title="切換只顯示還沒讀入資料的列，方便專注在剩下待處理的部分">${this._hideCompleted ? "顯示全部" : "僅顯示待處理"}</button>
              <button class="archive-action-btn" data-match-action="save-all" ${hasData && !this._savingAll ? "" : "disabled"}>${this._savingAll ? "儲存中…" : "全部儲存"}</button>
              <button class="archive-action-btn archive-action-btn--danger" data-match-action="reset" ${hasData && !this._savingAll ? "" : "disabled"}>清空</button>
            </div>
          </div>
        </div>
        ${this._renderSavingBanner()}
        ${statsHtml}
        <textarea class="assist-mark-pastebox${(!this._pasteOpen || this._actionsCollapsed) ? " is-collapsed" : ""}" id="matchMarkPasteBox" placeholder="在這裡直接貼上 Excel 複製的名單內容，或先點選「貼上內容」再貼上，也可以直接把檔案拖曳到這個分頁的任何地方。"></textarea>
        <input type="file" id="matchMarkFileInput" accept=".xlsx,.xls,.csv,.txt" hidden>
        ${mappingHtml}
        <div class="match-mark-rows-wrap">${listHtml}</div>
      </div>`;

    this._bindEvents();
    const rowsWrap = this._container.querySelector(".match-mark-rows-wrap");
    if (rowsWrap) rowsWrap.scrollTop = scrollTop;
  }

  _renderSavingBanner() {
    if (!this._savingAll) return "";
    const { current, total, label } = this._savingAll;
    const pct = total ? Math.round((current / total) * 100) : 0;
    return `<div class="match-mark-saving-banner">
      <div class="match-mark-saving-text">儲存中…第 ${current}／${total} 筆${label ? "　目前：" + escapeHtml(label) : ""}　請勿關閉分頁或重新整理，已送出成功的筆數不會遺失，但還沒輪到的筆數會需要重新按一次「全部儲存」</div>
      <div class="match-mark-saving-bar"><div class="match-mark-saving-bar-fill" style="width:${pct}%"></div></div>
    </div>`;
  }

  // 每一列在跳轉選單裡顯示的名稱，跟列表頭上顯示的名稱同一套，方便對照
  _rowJumpLabel(row) {
    return row.groupLabel ? row.groupLabel
      : row.participantName ? `${row.participantName}（${row.idRaw || ""}）`
      : (row.idRaw || "（未填）");
  }

  _renderStats() {
    const rows = this._state.rows;
    if (!rows.length) return "";
    // 跟每一列的徽章（_renderRow 的 decisionLabel）用同一套優先順序：已讀入優先，
    // 不看 decision 欄位，其餘才照 decision 分類，這樣四個分類彼此互斥，加總才會等於總筆數，
    // 不會像之前那樣「已讀入」的列因為 decision 欄位還停在預設的 pending，同時被算進「待確認」。
    const allIdx = [];
    const pendingIdx = [];
    const completedIdx = [];
    const needsRemarkIdx = [];
    const skippedIdx = [];
    rows.forEach((r, idx) => {
      allIdx.push(idx);
      if (this._isRowCompleted(r)) { completedIdx.push(idx); return; }
      const effective = this._effectiveDecision(r);
      if (effective === "needs-remark") { needsRemarkIdx.push(idx); return; }
      if (effective === "skipped") { skippedIdx.push(idx); return; }
      pendingIdx.push(idx);
    });
    // 每個分類膠囊都做成下拉選單，選了哪一筆就直接捲到那一列，不用自己在長長的列表裡找。
    const chip = (label, idxList, extraClass = "") => {
      const options = idxList.map(idx => `<option value="${idx}">${escapeHtml(this._rowJumpLabel(rows[idx]))}</option>`).join("");
      return `<span class="match-mark-stat-chip match-mark-stat-chip--jump${extraClass ? " " + extraClass : ""}">
        <select data-match-jump-select ${idxList.length ? "" : "disabled"} title="跳到「${label}」裡的某一筆">
          <option value="" selected disabled>${label} ${idxList.length}</option>
          ${options}
        </select>
      </span>`;
    };
    return `<div class="match-mark-stats${this._actionsCollapsed ? " is-collapsed" : ""}">
      ${chip("共", allIdx)}
      ${chip("待確認", pendingIdx)}
      ${chip("已讀入", completedIdx, "match-mark-stat-chip--ok")}
      ${chip("建議重新標記", needsRemarkIdx, "match-mark-stat-chip--warn")}
      ${chip("已略過", skippedIdx)}
    </div>`;
  }

  // 分類膠囊下拉選了某一筆：跳到那一列並展開，若目前開著「僅顯示待處理」而目標剛好是
  // 已完成的列，先關掉篩選，不然這一列根本沒被畫出來，捲了也捲不到。
  _jumpToRow(idx) {
    const row = this._state.rows[idx];
    if (!row) return;
    if (this._hideCompleted && this._isRowCompleted(row)) {
      this._hideCompleted = false;
      saveCollapsedPref(HIDE_COMPLETED_KEY, false);
    }
    this._expanded.add(idx);
    this._render();
    requestAnimationFrame(() => {
      const el = this._container?.querySelector(`[data-row-idx="${idx}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("is-jump-highlight");
      setTimeout(() => el.classList.remove("is-jump-highlight"), 1500);
    });
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

  // 已知逐筆內容裡有幾筆缺花費時間；還沒解析過內容（knownAttempts 為 null）不當成「沒問題」，
  // 但也不當成「有問題」，單純回報 0——避免用還沒讀到的資料誤判。
  _missingDurationCount(row) {
    const knownAttempts = this._knownAttemptsFor(row);
    return knownAttempts ? knownAttempts.filter(a => !a.duration).length : 0;
  }

  // 「已完成」看這一列有沒有 matchedFilename（讀入日誌檔）或 assistDataRows（匯入輔助標記資料），
  // 不額外存一個狀態去追蹤——避免又發生像修這個 bug 之前那樣，兩個值分開存卻忘記同步的問題。
  // 兩者都是使用者主動觸發的讀入／匯入動作，等同已經確認過，不需要再另外標「待確認」。
  // 但如果已知內容裡有缺花費時間的筆數，代表資料還有問題要看，不能算完成——不然被「僅顯示
  // 待處理」篩掉之後，這種還沒修好的資料就整列消失、沒地方能再看到它。
  _isRowCompleted(row) {
    return (!!row.matchedFilename || !!row.assistDataRows?.length)
      && this._missingDurationCount(row) === 0;
  }

  // 「待確認／建議重新標記／已略過」的實際分類，統計列的下拉膠囊跟每一列自己的徽章要用同一套判斷，
  // 否則會出現「建議重新標記 4」但點進去卻只看到「待確認」徽章的不一致情形。
  // 沒有任何候選檔案、使用者也還沒手動處理過（decision 還是預設的 pending）的列，
  // 代表這個實驗編號在伺服器上根本找不到對應的日誌檔，等同需要回去重新標記，因此視同「建議重新標記」。
  _effectiveDecision(row) {
    if (row.decision === "needs-remark") return "needs-remark";
    if (row.decision === "skipped") return "skipped";
    if (row.candidates.length === 0 && row.decision === "pending" && row.stage !== "1") return "needs-remark";
    return "pending";
  }

  // 隱藏了幾筆「已完成」不用再另外寫一行提示——上面統計列的「已讀入」數字已經是同一個數字，
  // 兩個地方重複講同一件事沒有必要。
  _renderRows() {
    const st = this._state;
    if (!this._hideCompleted) {
      return st.rows.map((row, idx) => this._renderRow(row, idx)).join("");
    }
    return st.rows
      .map((row, idx) => this._isRowCompleted(row) ? "" : this._renderRow(row, idx))
      .join("");
  }

  _renderRow(row, idx) {
    const expanded = this._expanded.has(idx);
    const loading  = this._loadingCandidates.has(idx);
    // 「已讀入」跟 _isRowCompleted 用同一套判斷（matchedFilename 或 assistDataRows），不看 decision——
    // decision 只用來記另外幾種跟檔案無關的人工標註（待確認／建議重新標記／已略過）。
    const rowCompleted = this._isRowCompleted(row);
    const effectiveDecision = this._effectiveDecision(row);
    const decisionLabel = rowCompleted ? "已讀入"
      : ({ pending: "待確認", "needs-remark": "建議重新標記", skipped: "已略過" }[effectiveDecision] || effectiveDecision);
    const decisionClass = rowCompleted ? "is-ok"
      : ({ pending: "", "needs-remark": "is-warn", skipped: "is-muted" }[effectiveDecision] || "");

    const noCandidates = row.candidates.length === 0;
    // 只算目前候選名單裡真的還在的隱藏檔名，避免候選規則調整後殘留的隱藏紀錄
    // 讓「已隱藏」筆數比候選總數還多，顯示出負的「顯示中」筆數。
    const candidateFilenameSet = new Set(row.candidates.map(c => c.filename));
    const hiddenCount = (row.hiddenFilenames || []).filter(f => candidateFilenameSet.has(f)).length;
    const visibleCount = row.candidates.length - hiddenCount;
    const candCountLabel = noCandidates ? "無候選"
      : hiddenCount ? `${visibleCount} 個候選（${hiddenCount} 已隱藏）`
      : `${row.candidates.length} 個候選`;
    const candidatesHtml = expanded ? this._renderCandidates(row, idx, loading) : "";
    const assistRows = row.assistDataRows;
    // 「缺時間」直接標在有問題的那顆膠囊上（顏色＋文字），不再另外用一個彙總數字的徽章——
    // 彙總數字只能告訴你「有幾筆」，看不出是哪一筆，還要多一步展開才找得到。
    const assistHtml = assistRows?.length ? `<div class="match-mark-row-assist">
      <span class="match-mark-assist-count">輔助標記 ${assistRows.length} 筆</span>
      ${assistRows.map(a => {
        const missing = !a.duration;
        const timeText = missing ? "缺時間" : formatSecondsMs(parseClockMs(a.duration));
        return `<span class="match-mark-assist-item${missing ? " is-warn" : ""}"${missing ? ` title="這筆手勢紀錄沒有花費時間，可能是日誌缺少對應的開始事件（例如直接用日誌時間戳翻譯、但找不到 gesture_step_start），建議確認內容"` : ""}>${a.gestureCommand ? escapeHtml(a.gestureCommand) : ""}${a.type ? " " + escapeHtml(a.type) : ""}${a.typeRaw ? "（" + escapeHtml(a.typeRaw) + "）" : ""}${a.note ? " · " + escapeHtml(a.note) : ""} · <span class="match-mark-assist-time">${timeText}</span></span>`;
      }).join("")}
    </div>` : "";
    const saveHtml = row.saveConflict ? `<div class="match-mark-row-actions match-mark-row-actions--save">
      ${this._renderConflictPanel(row, idx)}
    </div>` : "";

    return `<div class="match-mark-row${expanded ? " is-expanded" : ""}" data-row-idx="${idx}" data-match-drop="${idx}" title="找不到自動比對出來的候選檔時，可以把電腦裡的 .jsonl 直接拖曳到這張卡片上指定給這個人">
      <div class="match-mark-row-head" data-match-toggle="${idx}">
        <span class="match-mark-row-id">${row.groupLabel ? escapeHtml(row.groupLabel) : row.participantName ? `${escapeHtml(row.participantName)}（${escapeHtml(row.idRaw || "")}）` : escapeHtml(row.idRaw || "（未填）")}</span>
        <span class="match-mark-row-meta">${row.date ? escapeHtml(row.date) : "—"}${row.groupLabel ? " · 代碼 " + escapeHtml(row.idRaw) : ""}${!row.groupLabel && row.participantName ? " · 受試者 " + escapeHtml(String(row.trackingId ?? "")) : ""}${row.combo ? " · " + escapeHtml(row.combo) : ""}${row.count != null ? ` · 預期 ${row.count} 次` : ""}${row.matchedFilename ? ` · 已讀入 <span class="match-mark-matched-link" data-match-edit-matched="${idx}" title="在檢視分頁開啟這個日誌檔的「重新標記」編輯模式，確認內容有沒有異常；沒異常就直接關掉分頁即可，原檔案不受影響">${escapeHtml(row.matchedFilename)}</span>` : ""}</span>
        <span class="match-mark-row-cand-count">${row.stage === "1" && noCandidates ? "階段一無日誌檔（正常）" : candCountLabel}</span>
        <span class="match-mark-decision-badge ${decisionClass}">${decisionLabel}</span>
        ${row.matchedFilename ? `<button class="archive-action-btn archive-action-btn--sm" data-match-reopen="${idx}" title="檢查是否有剛剛編輯後另存的異常修正檔，找到就直接採用最新的一份；沒有新檔案就維持原樣不變">重新讀入</button>` : ""}
        ${row.trackingId != null && row.stage ? `<button class="archive-action-btn archive-action-btn--sm archive-action-btn--danger" data-match-clear-saved="${idx}" title="刪除伺服器上這位受試者・這個階段已存的分析資料">清除已儲存資料</button>` : ""}
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

  // 候選檔案內容預覽：展開時直接讀日誌內嵌的姓名／實驗ID跟這一列預期值比對，
  // 並列出前幾筆手勢嘗試，讓使用者不用跳到「檢視」分頁也能確認是不是同一個人。
  _renderCandidatePreview(row, idx, filename) {
    const key = `${idx}::${filename}`;
    if (!this._previewOpen.has(key)) return "";
    if (this._previewLoading.has(key)) {
      return `<div class="match-mark-preview is-loading">載入中…</div>`;
    }
    const cached = this._candidateCache.get(filename);
    if (!cached) {
      return `<div class="match-mark-preview is-error">讀取失敗，請再點一次檔名重試。</div>`;
    }
    const { entries, summary } = cached;
    const expectedName = row.participantName || "";
    const actualName = summary.participant && summary.participant !== "—" ? summary.participant : "";
    const nameMatch = expectedName && actualName ? expectedName === actualName : null;
    const expectedId = String(row.idRaw || "").trim().toLowerCase();
    const actualId = String(summary.expId || "").trim().toLowerCase();
    const idMatch = expectedId && actualId && actualId !== "—" ? actualId === expectedId : null;

    const checkChip = (label, expected, actual, match) => {
      if (!expected && !actual) return "";
      const cls = match === true ? " is-match" : match === false ? " is-mismatch" : "";
      return `<span class="match-mark-preview-check${cls}">${label}：日誌內「${escapeHtml(actual || "—")}」／預期「${escapeHtml(expected || "—")}」</span>`;
    };

    const allAttempts = entries.filter(e => e.type === "gesture_attempt");
    const attempts = allAttempts.slice(0, 30);

    return `<div class="match-mark-preview">
      <div class="match-mark-preview-summary">
        ${checkChip("受試者姓名", expectedName, actualName, nameMatch)}
        ${checkChip("實驗ID", row.idRaw, summary.expId, idMatch)}
        <span class="match-mark-preview-meta">組合 ${escapeHtml(summary.comboName || "—")} · ${fmtDateTime(summary.startTime)} ～ ${fmtDateTime(summary.endTime)} · 共 ${summary.attemptCount} 次（成功 ${summary.successCount}）</span>
      </div>
      ${attempts.length ? `<div class="match-mark-preview-attempts">
        ${attempts.map(a => `<span class="match-mark-preview-attempt">${fmtDateTime(a.ts)} · ${escapeHtml(a.g_id || "")} · ${escapeHtml(G_TYPE_LABEL[a.g_type] || a.g_type || "")}</span>`).join("")}
        ${allAttempts.length > 30 ? `<span class="match-mark-preview-more">…僅顯示前 30 筆，共 ${allAttempts.length} 筆</span>` : ""}
      </div>` : `<p class="match-mark-empty-hint">此檔案沒有手勢嘗試紀錄。</p>`}
      <button class="archive-action-btn archive-action-btn--secondary archive-action-btn--sm" data-match-view-file="${escapeHtml(filename)}">在完整檢視分頁開啟 →</button>
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
          <button class="archive-action-btn archive-action-btn--secondary" data-match-skip="${idx}" title="標記為「這一列先不處理」，之後想再回來的話可從上方「已略過」下拉找回，不會刪除或動到任何已存的資料">略過此列</button>
        </div>
      </div>`;
    }

    const hiddenSet = new Set(row.hiddenFilenames || []);
    const showHidden = this._showHiddenRows.has(idx);
    const visible = row.candidates.filter(c => !hiddenSet.has(c.filename));
    const hidden = row.candidates.filter(c => hiddenSet.has(c.filename));

    const renderCand = (c, isHidden) => {
      const sel = row.selectedFilenames.includes(c.filename);
      const previewOpen = this._previewOpen.has(`${idx}::${c.filename}`);
      const riskBadge = loading
        ? "<span class=\"match-mark-risk is-loading\">評估中…</span>"
        : c.risk
          ? `<span class="match-mark-risk match-mark-risk--${c.risk}" title="${escapeHtml((c.riskReasons || []).join("；"))}">${{ low: "低風險", medium: "中風險", high: "高風險" }[c.risk]}</span>`
          : "";
      const mergeTag = c.mergeSuggestFilename
        ? `<span class="match-mark-merge-tag" data-match-merge-pair="${idx}" data-match-merge-file="${escapeHtml(c.filename)}" data-match-merge-with="${escapeHtml(c.mergeSuggestFilename)}" title="與「${escapeHtml(c.mergeSuggestFilename)}」時間相近，且前段疑似缺少結束事件，可能是同一次記錄被中斷後拆成兩個檔案。點擊可一併勾選兩者以合併">疑似續錄，建議合併</span>`
        : "";
      const hideBtn = isHidden
        ? `<button class="archive-action-btn archive-action-btn--secondary archive-action-btn--sm" data-match-unhide="${idx}" data-match-unhide-file="${escapeHtml(c.filename)}" title="取消隱藏，讓此檔案重新出現在候選清單">取消隱藏</button>`
        : `<button class="archive-action-btn archive-action-btn--secondary archive-action-btn--sm" data-match-hide="${idx}" data-match-hide-file="${escapeHtml(c.filename)}" title="標示為已確認不OK，從候選清單隱藏（可在下方「顯示已隱藏的檔案」找回）">隱藏</button>`;
      const nameSpan = isHidden
        ? `<span class="match-mark-cand-name">${escapeHtml(c.filename)}</span>`
        : `<span class="match-mark-cand-name" data-match-preview-toggle="${idx}" data-match-preview-file="${escapeHtml(c.filename)}" title="點擊展開／收合此檔案的內容預覽，確認是否為同一人">${previewOpen ? "▾" : "▸"} ${escapeHtml(c.filename)}</span>`;
      const label = `<label class="match-mark-candidate${sel ? " is-selected" : ""}${c.suggested ? " is-suggested" : ""}${isHidden ? " is-hidden" : ""}">
        <input type="checkbox" data-match-cand="${idx}" data-match-cand-file="${escapeHtml(c.filename)}" ${sel ? "checked" : ""} ${isHidden ? "disabled" : ""}>
        ${nameSpan}
        <span class="match-mark-cand-time">${fmtDateTime(c.modified)}</span>
        ${c.exact ? "<span class=\"match-mark-suggest-tag\">代碼精確比對</span>" : c.suggested ? "<span class=\"match-mark-suggest-tag\">建議</span>" : ""}
        ${mergeTag}
        ${riskBadge}
        ${hideBtn}
      </label>`;
      return isHidden ? label : label + this._renderCandidatePreview(row, idx, c.filename);
    };

    const items = visible.map(c => renderCand(c, false)).join("");
    const hiddenItems = showHidden ? hidden.map(c => renderCand(c, true)).join("") : "";
    const hiddenToggle = hidden.length
      ? `<button class="archive-action-btn archive-action-btn--secondary archive-action-btn--sm" data-match-toggle-hidden="${idx}">${showHidden ? "隱藏" : "顯示"}已隱藏的檔案（${hidden.length}）</button>`
      : "";
    const allHiddenHint = visible.length === 0 && hidden.length > 0
      ? `<p class="match-mark-empty-hint">此列候選皆已被隱藏。</p>`
      : "";

    const canOpen = row.selectedFilenames.length > 0;
    const canAccept = row.selectedFilenames.length === 1;
    return `<div class="match-mark-row-body">
      ${allHiddenHint}
      <div class="match-mark-candidate-list">${items}${hiddenItems}</div>
      <div class="match-mark-row-actions">
        <button class="archive-action-btn" data-match-accept="${idx}" ${canAccept ? "" : "disabled"} title="僅選取單一候選檔案時可用，直接採用該檔案作為比對結果，不進入重新標記工作區">直接讀入已選候選</button>
        <button class="archive-action-btn" data-match-open-remark="${idx}" ${canOpen ? "" : "disabled"}>在重新標記工作區開啟已選候選（合併）</button>
        <button class="archive-action-btn archive-action-btn--secondary" data-match-goto-remark="${idx}">標示需重新標記</button>
        <button class="archive-action-btn archive-action-btn--secondary" data-match-skip="${idx}" title="標記為「這一列先不處理」，之後想再回來的話可從上方「已略過」下拉找回，不會刪除或動到任何已存的資料">略過此列</button>
        ${hiddenToggle}
      </div>
    </div>`;
  }

  // 點「貼上內容」才展開貼上區：若操作區當時是收合的，先展開操作區（否則按鈕本身也看不到），
  // 一起 render 一次後再對焦，跟輔助標記頁的同名邏輯一致。
  _openPasteBox() {
    let changed = false;
    if (this._actionsCollapsed) { this._actionsCollapsed = false; saveCollapsedPref(ACTIONS_COLLAPSED_KEY, false); changed = true; }
    if (!this._pasteOpen) { this._pasteOpen = true; changed = true; }
    if (changed) this._render();
    this._container?.querySelector("#matchMarkPasteBox")?.focus();
  }

  _bindEvents() {
    const c = this._container;
    if (!c) return;
    const fileInput = c.querySelector("#matchMarkFileInput");
    const pasteBox  = c.querySelector("#matchMarkPasteBox");

    const toggleActionsBtn = c.querySelector("[data-match-toggle-actions]");
    if (toggleActionsBtn) toggleActionsBtn.addEventListener("click", () => {
      this._actionsCollapsed = !this._actionsCollapsed;
      saveCollapsedPref(ACTIONS_COLLAPSED_KEY, this._actionsCollapsed);
      // 收合操作時貼上區一併重置成未展開，下次展開操作要重新按「貼上內容」才會再展開，
      // 不會單靠展開操作就無緣無故冒出貼上區。
      if (this._actionsCollapsed) this._pasteOpen = false;
      this._render();
    });

    c.querySelectorAll("[data-match-action]").forEach(btn => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.matchAction;
        if (action === "load-roster") this._loadSavedRoster();
        if (action === "import-assist") this._importFromAssistMark();
        if (action === "export-assist") this._exportToAssistMark();
        if (action === "file") fileInput?.click();
        if (action === "paste") this._openPasteBox();
        if (action === "refresh-server") this._loadServerFiles();
        if (action === "toggle-hide-completed") {
          this._hideCompleted = !this._hideCompleted;
          saveCollapsedPref(HIDE_COMPLETED_KEY, this._hideCompleted);
          this._render();
        }
        if (action === "save-all") this._saveAllRows();
        if (action === "reset" && confirm("確定要清空目前的比對名單與草稿嗎？此動作無法復原（已存檔的比對結果不受影響）。")) this._resetAll();
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

    // 拖曳檔案匯入：整個分頁範圍都可以放，不用特地拖到某個小區塊裡
    const shell = c.querySelector(".match-mark-shell");
    shell?.addEventListener("dragover", e => { e.preventDefault(); shell.classList.add("is-drag-over"); });
    shell?.addEventListener("dragleave", () => shell.classList.remove("is-drag-over"));
    shell?.addEventListener("drop", e => {
      e.preventDefault();
      shell.classList.remove("is-drag-over");
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      if (!["xlsx", "xls", "csv", "txt"].includes(ext)) {
        showToast(`不支援的檔案格式「.${ext}」，請拖曳 Excel（.xlsx/.xls）或 CSV／TXT 檔案。`, "error");
        return;
      }
      this._importFile(file);
    });

    c.querySelector("#matchMarkIdRule")?.addEventListener("change", e => this._setIdSplitRule(e.target.value));
    c.querySelectorAll("[data-match-col]").forEach(sel =>
      sel.addEventListener("change", e => this._setColumnRole(Number(sel.dataset.matchCol), e.target.value)));

    c.querySelectorAll("[data-match-toggle]").forEach(head =>
      head.addEventListener("click", () => this._toggleExpand(Number(head.dataset.matchToggle))));

    c.querySelectorAll("[data-match-jump-select]").forEach(sel => {
      sel.addEventListener("change", () => {
        const idx = Number(sel.value);
        if (!Number.isNaN(idx)) this._jumpToRow(idx);
      });
    });

    // 找不到自動比對出來的候選檔時，直接把本機的 .jsonl 拖到這個人整張卡片上（不只是標題列，
    // 展開後的候選清單／輔助標記摘要區也算），指定給他。card 層級攔截並 stopPropagation，
    // 避免事件冒泡到整個分頁的拖曳匯入（那個是拿來匯入試算表名單的，跟這個用途不同）。
    c.querySelectorAll("[data-match-drop]").forEach(card => {
      const idx = Number(card.dataset.matchDrop);
      card.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); card.classList.add("is-drag-target"); });
      card.addEventListener("dragleave", () => card.classList.remove("is-drag-target"));
      card.addEventListener("drop", e => {
        e.preventDefault();
        e.stopPropagation();
        card.classList.remove("is-drag-target");
        const file = e.dataTransfer?.files?.[0];
        if (file) this._dropFileOntoRow(idx, file);
      });
    });

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
    c.querySelectorAll("[data-match-preview-toggle]").forEach(el =>
      el.addEventListener("click", e => {
        e.stopPropagation();
        e.preventDefault();
        this._togglePreview(Number(el.dataset.matchPreviewToggle), el.dataset.matchPreviewFile);
      }));
    c.querySelectorAll("[data-match-merge-pair]").forEach(el =>
      el.addEventListener("click", e => {
        e.stopPropagation();
        e.preventDefault();
        this._selectMergePair(Number(el.dataset.matchMergePair), el.dataset.matchMergeFile, el.dataset.matchMergeWith);
      }));
    c.querySelectorAll("[data-match-hide]").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        e.preventDefault();
        this._hideCandidate(Number(btn.dataset.matchHide), btn.dataset.matchHideFile);
      }));
    c.querySelectorAll("[data-match-unhide]").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        e.preventDefault();
        this._unhideCandidate(Number(btn.dataset.matchUnhide), btn.dataset.matchUnhideFile);
      }));
    c.querySelectorAll("[data-match-toggle-hidden]").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        e.preventDefault();
        this._toggleShowHidden(Number(btn.dataset.matchToggleHidden));
      }));

    c.querySelectorAll("[data-match-accept]").forEach(btn =>
      btn.addEventListener("click", e => { e.stopPropagation(); this._markMatched(Number(btn.dataset.matchAccept)); }));
    c.querySelectorAll("[data-match-open-remark]").forEach(btn =>
      btn.addEventListener("click", e => { e.stopPropagation(); this._openInRemark(Number(btn.dataset.matchOpenRemark)); }));
    c.querySelectorAll("[data-match-goto-remark]").forEach(btn =>
      btn.addEventListener("click", e => { e.stopPropagation(); this._gotoQuickRemark(Number(btn.dataset.matchGotoRemark)); }));
    c.querySelectorAll("[data-match-skip]").forEach(btn =>
      btn.addEventListener("click", e => { e.stopPropagation(); this._skipRow(Number(btn.dataset.matchSkip)); }));
    c.querySelectorAll("[data-match-clear-saved]").forEach(btn =>
      btn.addEventListener("click", e => { e.stopPropagation(); this._clearSavedAnalysis(Number(btn.dataset.matchClearSaved)); }));
    c.querySelectorAll("[data-match-edit-matched]").forEach(el =>
      el.addEventListener("click", e => { e.stopPropagation(); this._editMatchedFile(Number(el.dataset.matchEditMatched)); }));
    c.querySelectorAll("[data-match-reopen]").forEach(btn =>
      btn.addEventListener("click", e => { e.stopPropagation(); this._reopenForRematch(Number(btn.dataset.matchReopen)); }));

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
