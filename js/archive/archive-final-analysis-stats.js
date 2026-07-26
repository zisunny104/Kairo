/**
 * archive-final-analysis-stats.js — 最終分析卡片共用的純統計函式（不碰 DOM）。
 * 敘述統計 + Wobbrock 同意率 + 四種檢定（卡方、Fisher exact、配對 t、Wilcoxon）+ 單因子重複量數 ANOVA。
 * p 值計算所需的常態/卡方/t/F 分布數值工具是標準 Numerical Recipes 演算法，不是新統計方法，
 * 只是算前述檢定 p 值所需的數學機器。
 */

// ── 敘述統計 ──────────────────────────────────────────────────────────────
export function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

export function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function stddev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (arr.length - 1));
}

// type-7 分位數（線性內插），供箱型圖使用
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

export function boxPlotStats(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return { min: s[0], q1: quantile(s, 0.25), median: quantile(s, 0.5), q3: quantile(s, 0.75), max: s[s.length - 1], mean: mean(s), n: s.length };
}

export function descriptiveStats(values) {
  if (!values.length) return { n: 0, mean: null, median: null, sd: null, min: null, max: null };
  return {
    n: values.length,
    mean: mean(values),
    median: median(values),
    sd: stddev(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

// ── 數值分布工具（Numerical Recipes 標準演算法）──────────────────────────
function gammln(xx) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = xx, y = xx;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y += 1; ser += cof[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function gammpSeries(a, x) {
  const ITMAX = 100, EPS = 3e-7;
  if (x <= 0) return 0;
  const gln = gammln(a);
  let ap = a, sum = 1 / a, del = sum;
  for (let n = 1; n <= ITMAX; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - gln);
}

function gammcfCont(a, x) {
  const ITMAX = 100, EPS = 3e-7, FPMIN = 1e-30;
  const gln = gammln(a);
  let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

// 正規化下不完全 gamma 函數 P(a,x)
function gammp(a, x) {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 0;
  return x < a + 1 ? gammpSeries(a, x) : 1 - gammcfCont(a, x);
}

function betacf(a, b, x) {
  const MAXIT = 100, EPS = 3e-7, FPMIN = 1e-30;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

// 正規化不完全 beta 函數 I_x(a,b)
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammln(a + b) - gammln(a) - gammln(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normalCDF(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

// 卡方分布上尾 p 值：P(X > x; df)
function chiSquareUpperP(x, df) { return 1 - gammp(df / 2, x / 2); }

// 雙尾 t 分布 p 值
function tDistTwoTailedP(t, df) { return betai(df / 2, 0.5, df / (df + t * t)); }

// F 分布上尾 p 值：P(F > f; df1, df2)
function fDistUpperP(f, df1, df2) {
  if (f <= 0) return 1;
  return betai(df2 / 2, df1 / 2, df2 / (df2 + df1 * f));
}

// ── Wobbrock et al. (2005) 同意率 A_r = Σ_i (n_i/N)² ──────────────────────
// attempts：扁平化的嘗試陣列（非 records），與最終分析新架構的 filterAttempts() 輸出對齊
export function discoverAgreementKeys(attempts) {
  const keys = new Set();
  for (const a of attempts) {
    for (const k of Object.keys(a)) {
      if (k !== "gestureCommand") keys.add(k);
    }
  }
  return Array.from(keys).sort();
}

export function computeAgreement(attempts, keyField) {
  const byReferent = new Map();
  for (const a of attempts) {
    const command = a.gestureCommand || "（未知指令）";
    const raw = a[keyField];
    const val = raw == null ? "" : String(raw).trim();
    if (!val) continue;
    if (!byReferent.has(command)) byReferent.set(command, []);
    byReferent.get(command).push(a);
  }
  const rows = [];
  for (const [command, entries] of byReferent) {
    const n = entries.length;
    const counts = new Map();
    entries.forEach(a => {
      const val = String(a[keyField]).trim();
      counts.set(val, (counts.get(val) || 0) + 1);
    });
    let ar = 0;
    const groups = [];
    for (const [value, count] of counts) {
      ar += (count / n) ** 2;
      groups.push({ value, count, pct: count / n });
    }
    groups.sort((a, b) => b.count - a.count);
    // 追查來源用：這個指令分組裡實際涉及哪些受試者（trackingId），主要給「（未知指令）」這種
    // 需要回頭檢查原始資料的分組使用，其餘正常分組通常涉及的受試者太多，UI 不一定會顯示。
    const sources = Array.from(new Map(entries.map(a => [String(a.trackingId), a.participantName || ""])).entries())
      .map(([trackingId, participantName]) => ({ trackingId, participantName }))
      .sort((x, y) => x.trackingId.localeCompare(y.trackingId, "zh-Hant", { numeric: true }));
    rows.push({ command, ar, n, groups, sources });
  }
  rows.sort((a, b) => a.command.localeCompare(b.command, "zh-Hant"));
  return rows;
}

// ── 錯誤率（g_type: t=成功；其餘（f=失敗、n=未判斷…）一律算不正確）────────
export function errorRateCounts(attempts) {
  const total = attempts.length;
  const correct = attempts.reduce((n, a) => n + (a.typeRaw === "t" ? 1 : 0), 0);
  const wrong = total - correct;
  return { correct, wrong, total, errorRate: total ? wrong / total : null };
}

// ── 卡方檢定：R×C 列聯表 ──────────────────────────────────────────────────
export function chiSquareTest(table) {
  const R = table.length, C = table[0]?.length || 0;
  const rowSums = table.map(row => row.reduce((a, b) => a + b, 0));
  const colSums = Array.from({ length: C }, (_, j) => table.reduce((s, row) => s + row[j], 0));
  const total = rowSums.reduce((a, b) => a + b, 0);
  if (!total || R < 2 || C < 2) return { chi2: null, df: 0, p: null, minExpected: 0, suitable: false, reason: "資料不足，無法計算" };
  let chi2 = 0, minExpected = Infinity;
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < C; j++) {
      const expected = (rowSums[i] * colSums[j]) / total;
      minExpected = Math.min(minExpected, expected);
      if (expected > 0) chi2 += (table[i][j] - expected) ** 2 / expected;
    }
  }
  const df = (R - 1) * (C - 1);
  const p = chiSquareUpperP(chi2, df);
  const suitable = minExpected >= 5;
  return { chi2, df, p, minExpected, suitable, reason: suitable ? "" : "部分期望次數 < 5，卡方檢定近似可能不準確" };
}

// ── Fisher exact test（僅支援 2×2）───────────────────────────────────────
function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return gammln(n + 1) - gammln(k + 1) - gammln(n - k + 1);
}

export function fisherExactTest2x2(a, b, c, d) {
  const R1 = a + b, R2 = c + d, C1 = a + c, C2 = b + d, N = R1 + R2;
  if (!R1 || !R2 || !C1 || !C2) return { p: null, suitable: false, reason: "某列或欄總和為 0，無法計算" };
  const aMin = Math.max(0, C1 - R2), aMax = Math.min(R1, C1);
  const logP = k => logChoose(R1, k) + logChoose(R2, C1 - k) - logChoose(N, C1);
  const observedLogP = logP(a);
  const EPS = 1e-7;
  let p = 0;
  for (let k = aMin; k <= aMax; k++) {
    const lp = logP(k);
    if (lp <= observedLogP + EPS) p += Math.exp(lp);
  }
  return { p: Math.min(1, p), suitable: true, reason: "" };
}

export function fisherExactSuitability(groupCount) {
  return groupCount === 2
    ? { suitable: true, reason: "" }
    : { suitable: false, reason: `僅支援 2×2 比較，目前已選 ${groupCount} 個資料集` };
}

// ── 配對 t 檢定（配對值＝每位受試者一組差值）──────────────────────────────
export function pairedTTest(diffs) {
  const n = diffs.length;
  if (n < 2) return { t: null, df: 0, p: null, mean: null, sd: null, n, reason: "配對樣本數不足（至少需要 2 對）" };
  const m = mean(diffs);
  const sd = stddev(diffs);
  if (!sd) return { t: null, df: n - 1, p: m === 0 ? 1 : 0, mean: m, sd: 0, n, reason: m === 0 ? "所有配對差值皆為 0" : "所有配對差值相同（變異數為 0）" };
  const t = m / (sd / Math.sqrt(n));
  const df = n - 1;
  return { t, df, p: tDistTwoTailedP(t, df), mean: m, sd, n };
}

// ── Wilcoxon 符號等級檢定（常態近似，含連續性校正 + 同分等級校正）────────
export function wilcoxonSignedRank(diffs) {
  const nonZero = diffs.filter(d => d !== 0);
  const n = nonZero.length;
  if (n < 1) return { W: null, z: null, p: null, n: 0, reason: "沒有非零差值可供檢定" };
  const abs = nonZero.map(Math.abs);
  const order = abs.map((_, i) => i).sort((i, j) => abs[i] - abs[j]);
  const ranks = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && abs[order[j + 1]] === abs[order[i]]) j++;
    const avgRank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) ranks[order[k]] = avgRank;
    i = j + 1;
  }
  let wPlus = 0;
  for (let k = 0; k < n; k++) if (nonZero[k] > 0) wPlus += ranks[k];
  const meanW = n * (n + 1) / 4;
  const tieGroups = new Map();
  ranks.forEach(r => tieGroups.set(r, (tieGroups.get(r) || 0) + 1));
  let tieCorrection = 0;
  for (const t of tieGroups.values()) tieCorrection += (t ** 3 - t);
  const varW = n * (n + 1) * (2 * n + 1) / 24 - tieCorrection / 48;
  if (varW <= 0) return { W: wPlus, z: null, p: null, n, reason: "變異數為 0，無法計算 z 值" };
  const sigma = Math.sqrt(varW);
  const z = (Math.abs(wPlus - meanW) - 0.5) / sigma;
  const p = Math.min(1, Math.max(0, 2 * (1 - normalCDF(z))));
  return { W: wPlus, z, p, n, note: n < 10 ? "樣本數較小，常態近似準確度較低" : "" };
}

// ── 單因子重複量數 ANOVA（Subject × Condition，SS 拆解法）────────────────
// matrix：受試者 × 條件 的二維陣列，需先由呼叫端做 listwise（每位受試者每個條件都要有值）
export function oneWayRepeatedMeasuresAnova(matrix) {
  const n = matrix.length;
  const k = matrix[0]?.length || 0;
  if (n < 2 || k < 2) return { F: null, df1: 0, df2: 0, p: null, n, k, reason: "樣本數或條件數不足（至少需要 2 位受試者、2 個條件）" };
  const all = matrix.flat();
  const grand = mean(all);
  const subjectMeans = matrix.map(row => mean(row));
  const conditionMeans = Array.from({ length: k }, (_, j) => mean(matrix.map(row => row[j])));
  let ssTotal = 0, ssSubjects = 0, ssConditions = 0;
  for (const row of matrix) for (const v of row) ssTotal += (v - grand) ** 2;
  for (const sm of subjectMeans) ssSubjects += k * (sm - grand) ** 2;
  for (const cm of conditionMeans) ssConditions += n * (cm - grand) ** 2;
  const ssError = Math.max(0, ssTotal - ssSubjects - ssConditions);
  const dfConditions = k - 1, dfError = (k - 1) * (n - 1);
  const msConditions = ssConditions / dfConditions;
  const msError = ssError / dfError;
  if (!msError) return { F: msConditions > 0 ? Infinity : 0, df1: dfConditions, df2: dfError, p: msConditions > 0 ? 0 : 1, n, k };
  const F = msConditions / msError;
  return { F, df1: dfConditions, df2: dfError, p: fDistUpperP(F, dfConditions, dfError), n, k };
}
