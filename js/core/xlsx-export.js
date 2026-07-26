/**
 * xlsx-export.js — 通用表格下載介面
 * 給任何頁面把二維陣列（表頭 + 資料列）下載成 Excel 或 CSV，不綁定特定分頁的狀態結構。
 */
import * as XLSX from "../vendor/xlsx.mjs";

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function nowStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// 統一在這裡加時間戳，呼叫端不用各自記得處理——同一個檔名重複下載（例如同一個表格連續匯出
// 兩次）不會彼此覆蓋或被瀏覽器自動改名成看不出差異的 (1)、(2)。
function withTimestamp(filename, ext) {
  const base = filename.endsWith(ext) ? filename.slice(0, -ext.length) : filename;
  return `${base}_${nowStamp()}${ext}`;
}

/** rows：二維陣列，第一列視為表頭。sheetName 僅用於 Excel。 */
export function downloadXlsx(rows, filename, sheetName = "Sheet1") {
  if (!rows.length) return;
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  const data = XLSX.write(book, { bookType: "xlsx", type: "array" });
  const blob = new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  downloadBlob(blob, withTimestamp(filename, ".xlsx"));
}

/** sheets：[{ name, rows }]，把多份表格匯出成同一個檔案裡的不同分頁（工作表）。 */
export function downloadXlsxMultiSheet(sheets, filename) {
  const valid = sheets.filter(s => s.rows && s.rows.length);
  if (!valid.length) return;
  const book = XLSX.utils.book_new();
  valid.forEach(({ name, rows }) => {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    // Excel 分頁名稱不能超過 31 字元、不能包含 \ / ? * [ ] :
    const safeName = String(name || "Sheet").replace(/[\\/?*[\]:]/g, "_").slice(0, 31);
    XLSX.utils.book_append_sheet(book, sheet, safeName);
  });
  const data = XLSX.write(book, { bookType: "xlsx", type: "array" });
  const blob = new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  downloadBlob(blob, withTimestamp(filename, ".xlsx"));
}

export function downloadCsv(rows, filename) {
  if (!rows.length) return;
  const escapeCsv = value => {
    const text = value == null ? "" : String(value);
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
    return text;
  };
  const text = rows.map(row => row.map(escapeCsv).join(",")).join("\n") + "\n";
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, withTimestamp(filename, ".csv"));
}
