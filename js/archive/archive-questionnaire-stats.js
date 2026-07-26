/**
 * archive-questionnaire-stats.js — 問卷量表計分與描述統計
 * 只有 SUS 的反向計分／0–100 換算與等級對照是有公開依據的標準做法（Brooke, 1996；
 * 等級對照參考 Sauro, 2011 的曲線化等級表），其餘量表一律只算描述性統計（平均數/標準差），
 * 不套用未經確認的加權公式或切點，避免產生沒有依據的分數或結論。
 */
import { mean, stddev } from "./archive-final-analysis-stats.js";

export function numericColumn(dataRows, colIndex) {
  return dataRows.map(row => Number(row[colIndex])).filter(v => Number.isFinite(v));
}

/** 各題描述統計：[{ colIndex, label, mean, sd, n }] */
export function itemStats(headers, dataRows, cols) {
  return cols.map(ci => {
    const values = numericColumn(dataRows, ci);
    return {
      colIndex: ci,
      label: headers[ci] || `第${ci + 1}欄`,
      mean: values.length ? mean(values) : null,
      sd: values.length > 1 ? stddev(values) : null,
      n: values.length,
    };
  });
}

export function overallMean(stats) {
  const valid = stats.filter(s => s.mean != null);
  return valid.length ? mean(valid.map(s => s.mean)) : null;
}

/**
 * 標準 SUS 反向計分（Brooke, 1996）：
 * 奇數題（第1,3,5,7,9題，正向敘述）分數 = 原始分 - 1
 * 偶數題（第2,4,6,8,10題，反向敘述）分數 = 5 - 原始分
 * 加總後 × 2.5 → 0–100 分。缺值的受試者不列入計算。
 */
export function computeSusScores(dataRows, susCols) {
  const scores = [];
  dataRows.forEach(row => {
    let sum = 0, validCount = 0;
    susCols.forEach((ci, idx) => {
      const raw = Number(row[ci]);
      if (!Number.isFinite(raw)) return;
      sum += idx % 2 === 0 ? (raw - 1) : (5 - raw);
      validCount++;
    });
    if (validCount === susCols.length && susCols.length > 0) scores.push(sum * 2.5);
  });
  return scores;
}

/** 參考 Sauro (2011) SUS 曲線化等級對照表（公開發表版本，僅供參考） */
export function susRating(score) {
  if (score == null || Number.isNaN(score)) return null;
  if (score >= 84.1) return { grade: "A+", adjective: "優異 Excellent" };
  if (score >= 80.8) return { grade: "A", adjective: "優異 Excellent" };
  if (score >= 78.9) return { grade: "A-", adjective: "優異 Excellent" };
  if (score >= 77.2) return { grade: "B+", adjective: "良好 Good" };
  if (score >= 74.1) return { grade: "B", adjective: "良好 Good" };
  if (score >= 72.6) return { grade: "B-", adjective: "良好 Good" };
  if (score >= 71.1) return { grade: "C+", adjective: "普通 OK" };
  if (score >= 65.0) return { grade: "C", adjective: "普通 OK" };
  if (score >= 62.7) return { grade: "C-", adjective: "普通 OK" };
  if (score >= 51.7) return { grade: "D", adjective: "尚可 Poor" };
  return { grade: "F", adjective: "不佳 Awful" };
}
