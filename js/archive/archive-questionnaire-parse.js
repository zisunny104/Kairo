/**
 * archive-questionnaire-parse.js — 問卷資料解析
 * 貼上文字／匯入 CSV／Excel → 表頭＋資料列，並自動偵測 Timestamp／Email／Participant ID
 * 與四種量表（SSQ／NASA-TLX／SUS／UEQ）欄位，最後驗證資料品質（缺漏、重複ID、非數值）。
 * 欄位對應永遠是「自動猜測 + 可手動調整」，不強制信任關鍵字命中結果。
 */
import * as XLSX from "../vendor/xlsx.mjs";
import { parseDelimitedText } from "./archive-assist-mark.js";

export const SCALE_ORDER = ["ssq", "nasa", "sus", "ueq"];
export const SCALE_DEFS = {
  ssq:  { label: "SSQ",      fullName: "模擬疾病量表（SSQ）",       count: 9 },
  nasa: { label: "NASA-TLX", fullName: "NASA 任務負荷指數（TLX）",  count: 6 },
  sus:  { label: "SUS",      fullName: "系統可用性量表（SUS）",     count: 10 },
  ueq:  { label: "UEQ",      fullName: "使用者經驗問卷（UEQ）",     count: 6 },
};

export function parsePastedText(text) {
  return parseDelimitedText(text);
}

export function readFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const result = e.target?.result;
      if (result == null) { reject(new Error("讀取失敗")); return; }
      if (ext === "xlsx" || ext === "xls") {
        try {
          const workbook = XLSX.read(result, { type: "array" });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
          resolve(rows.map(row => row.map(cell => (cell == null ? "" : String(cell)))));
        } catch (err) { reject(err); }
        return;
      }
      resolve(parseDelimitedText(result));
    };
    reader.onerror = () => reject(new Error("讀取失敗"));
    if (ext === "xlsx" || ext === "xls") reader.readAsArrayBuffer(file);
    else reader.readAsText(file, "utf-8");
  });
}

export function splitHeaderRows(rows) {
  if (!rows.length) return { headers: [], dataRows: [] };
  return { headers: rows[0].map(h => String(h ?? "").trim()), dataRows: rows.slice(1) };
}

const TIMESTAMP_RE = /(timestamp|時間戳記|時間戳|填答時間|提交時間)/i;
const EMAIL_RE = /(e-?mail|信箱|電子郵件)/i;
const PARTICIPANT_ID_RE = /(participant.?id|受試者.{0,4}(編號|id|代號)|受試者$|編號)/i;

const SCALE_KEYWORDS = {
  ssq:  /(ssq|暈|噁心|嘔吐|模糊不清|眼睛疲勞|定向感|平衡感|不適)/i,
  nasa: /(nasa|tlx|心智需求|生理需求|時間需求|表現|努力程度|挫折感|mental demand|physical demand|temporal demand|performance|effort|frustration)/i,
  sus:  /(sus|系統.{0,6}(易用|使用)|我認為|我覺得這個系統|我需要.{0,6}(學習|支援))/i,
  ueq:  /(ueq|吸引力|效率|可靠度|新穎性|刺激感|清晰度|易懂)/i,
};

function guessScaleForHeader(header) {
  for (const scale of SCALE_ORDER) {
    if (SCALE_KEYWORDS[scale].test(header)) return scale;
  }
  return null;
}

/**
 * 回傳 { timestampCol, emailCol, participantIdCol, ssq:[idx...], nasa:[...], sus:[...], ueq:[...] }
 * 皆為「初始猜測」，供 UI 顯示後讓使用者調整；找不到就給 -1 / 空陣列。
 */
export function detectColumns(headers) {
  const used = new Set();
  let timestampCol = -1, emailCol = -1, participantIdCol = -1;

  headers.forEach((h, i) => { if (timestampCol < 0 && TIMESTAMP_RE.test(h)) { timestampCol = i; used.add(i); } });
  headers.forEach((h, i) => { if (!used.has(i) && emailCol < 0 && EMAIL_RE.test(h)) { emailCol = i; used.add(i); } });
  headers.forEach((h, i) => { if (!used.has(i) && participantIdCol < 0 && PARTICIPANT_ID_RE.test(h)) { participantIdCol = i; used.add(i); } });

  const groups = { ssq: [], nasa: [], sus: [], ueq: [] };
  headers.forEach((h, i) => {
    if (used.has(i)) return;
    const scale = guessScaleForHeader(h);
    if (scale && groups[scale].length < SCALE_DEFS[scale].count) { groups[scale].push(i); used.add(i); }
  });

  // 關鍵字猜不到的量表：依欄位原始順序，從剩餘欄位依序補滿題數（保底猜測，仍可在 UI 手動調整）
  const remaining = headers.map((_, i) => i).filter(i => !used.has(i));
  for (const scale of SCALE_ORDER) {
    while (groups[scale].length < SCALE_DEFS[scale].count && remaining.length) {
      groups[scale].push(remaining.shift());
    }
  }

  return { timestampCol, emailCol, participantIdCol, ...groups };
}

/** 把 detectColumns() 的猜測結果攤平成「每欄一個角色」陣列，方便 UI 用單一下拉選單編輯 */
export function rolesFromDetected(headers, detected) {
  const roles = headers.map(() => "ignore");
  if (detected.timestampCol >= 0) roles[detected.timestampCol] = "timestamp";
  if (detected.emailCol >= 0) roles[detected.emailCol] = "email";
  if (detected.participantIdCol >= 0) roles[detected.participantIdCol] = "participantId";
  SCALE_ORDER.forEach(scale => { detected[scale].forEach(i => { roles[i] = scale; }); });
  return roles;
}

/** 角色陣列 → 分析用的 mapping（各量表欄位依原始欄位順序排列） */
export function mappingFromRoles(roles) {
  const mapping = { timestampCol: -1, emailCol: -1, participantIdCol: -1, ssq: [], nasa: [], sus: [], ueq: [] };
  roles.forEach((role, i) => {
    if (role === "timestamp") mapping.timestampCol = i;
    else if (role === "email") mapping.emailCol = i;
    else if (role === "participantId") mapping.participantIdCol = i;
    else if (SCALE_ORDER.includes(role)) mapping[role].push(i);
  });
  return mapping;
}

/** 驗證資料品質：缺漏 Participant ID、重複 ID、量表欄位缺值／非數值 */
export function validateData(headers, dataRows, mapping) {
  const idCol = mapping.participantIdCol;
  const idCounts = new Map();
  let missingIdCount = 0;

  dataRows.forEach(row => {
    const idVal = idCol >= 0 ? String(row[idCol] ?? "").trim() : "";
    if (!idVal) { missingIdCount++; return; }
    idCounts.set(idVal, (idCounts.get(idVal) || 0) + 1);
  });
  const duplicateIds = [...idCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id);

  const scaleCols = SCALE_ORDER.flatMap(scale => mapping[scale]);
  let missingValueCount = 0, invalidValueCount = 0;
  dataRows.forEach(row => {
    scaleCols.forEach(ci => {
      const raw = row[ci];
      if (raw === undefined || raw === null || String(raw).trim() === "") { missingValueCount++; return; }
      if (Number.isNaN(Number(raw))) invalidValueCount++;
    });
  });

  const scaleColumnCounts = {};
  SCALE_ORDER.forEach(scale => { scaleColumnCounts[scale] = mapping[scale].length; });

  return {
    rowCount: dataRows.length,
    missingIdCount,
    duplicateIds,
    missingValueCount,
    invalidValueCount,
    scaleColumnCounts,
    hasParticipantIdCol: idCol >= 0,
  };
}
