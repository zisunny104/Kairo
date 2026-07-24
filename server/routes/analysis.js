/**
 * 最終分析原始資料 API 路由
 * 寫入 runtime/analysis/ 底下、以「受試者+階段」為單位的分析用原始資料檔案。
 * 屬於衍生資料（非原始實驗日誌），允許覆寫更新，不採 wx 獨佔寫入。
 */
import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Logger } from "../utils/logger.js";
import { ADMIN_TOKEN, ARCHIVE_PROTECTED } from "../config/server.js";
import { safeEqual } from "../utils/safe-compare.js";

const router = express.Router();

function requireAdminToken(req, res, next) {
  if (!ARCHIVE_PROTECTED) return next();
  const token = req.headers["x-admin-token"];
  if (!token) return res.status(401).json({ success: false, error: "需要管理員授權" });
  if (!safeEqual(token, ADMIN_TOKEN)) {
    Logger.warn(`analysis 管理端點未授權存取 | ip=${req.ip} | path=${req.path}`);
    return res.status(403).json({ success: false, error: "授權失敗" });
  }
  next();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ANALYSIS_DIR = path.join(__dirname, "../../runtime/analysis");
const VALID_STAGES = new Set(["1", "2-1", "2-2"]);
const MERGE_FIELDS = ["experimentId", "date", "matchedFilename"];
// 受試者姓名只存在名單（participants.json），這裡不重複存放；輸出時一律用 trackingId 去名單查
const ATTEMPT_FIELDS = ["gestureCommand", "type", "typeRaw", "note", "duration"];
const MAX_ATTEMPTS = 500;

async function ensureDir() {
  try {
    await fs.access(ANALYSIS_DIR);
  } catch {
    await fs.mkdir(ANALYSIS_DIR, { recursive: true });
  }
}

/**
 * 將既有紀錄與新送來的內容合併：欄位只有一邊有值就直接採用，
 * 兩邊都有值但不同才算衝突（回傳 conflicts，呼叫端需決定要保留哪一邊，overrides 可強制指定結果）。
 */
function mergeRecord(existing, incoming, overrides = {}) {
  const merged = {};
  const conflicts = [];
  for (const field of MERGE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(overrides, field)) {
      merged[field] = overrides[field];
      continue;
    }
    const oldVal = existing ? existing[field] || "" : "";
    const newVal = incoming[field] || "";
    if (oldVal && newVal && oldVal !== newVal) {
      conflicts.push({ field, existing: oldVal, incoming: newVal });
      merged[field] = oldVal;
    } else {
      merged[field] = newVal || oldVal;
    }
  }
  return { merged, conflicts };
}

/**
 * GET /api/analysis/list
 * 列出 runtime/analysis/ 底下所有已存的分析用原始資料
 */
router.get("/list", requireAdminToken, async (req, res) => {
  try {
    await ensureDir();
    const entries = await fs.readdir(ANALYSIS_DIR);
    const records = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const content = await fs.readFile(path.join(ANALYSIS_DIR, entry), "utf8");
        records.push(JSON.parse(content));
      } catch {
        // 個別檔案損毀時略過，不中斷整體列表
      }
    }
    records.sort((a, b) => (a.trackingId - b.trackingId) || String(a.stage).localeCompare(String(b.stage)));
    res.json({ success: true, records, count: records.length });
  } catch (error) {
    Logger.error("[Analysis] List error:", error.message);
    res.status(500).json({ success: false, error: "伺服器內部錯誤" });
  }
});

/**
 * POST /api/analysis/save
 * 寫入單一受試者 × 單一階段的分析用原始資料（可覆寫，欄位可為空）
 */
router.post("/save", requireAdminToken, async (req, res) => {
  try {
    const { trackingId, stage, experimentId, date, matchedFilename, attempts, overrides } = req.body || {};

    const trackingIdNum = Number(trackingId);
    if (!Number.isInteger(trackingIdNum) || trackingIdNum < 0) {
      return res.status(400).json({ success: false, error: "trackingId 必須為整數" });
    }
    if (!VALID_STAGES.has(stage)) {
      return res.status(400).json({ success: false, error: "stage 必須為 1、2-1 或 2-2" });
    }

    const toSafeString = (v, max = 500) => (typeof v === "string" ? v.slice(0, max) : "");

    const incoming = {
      experimentId: toSafeString(experimentId, 100),
      date: toSafeString(date, 40),
      matchedFilename: toSafeString(matchedFilename, 200),
    };
    const safeOverrides = {};
    if (overrides && typeof overrides === "object") {
      for (const field of MERGE_FIELDS) {
        if (typeof overrides[field] === "string") {
          safeOverrides[field] = toSafeString(overrides[field], 500);
        }
      }
    }

    // attempts：每列一次手勢指令（來自輔助標記），整批覆寫，不做逐欄位衝突比對
    let safeAttempts = null;
    if (Array.isArray(attempts)) {
      safeAttempts = attempts.slice(0, MAX_ATTEMPTS).map(a => {
        const out = {};
        for (const field of ATTEMPT_FIELDS) {
          out[field] = toSafeString(a?.[field], field === "note" ? 2000 : 200);
        }
        return out;
      });
    }

    await ensureDir();
    const filename = `${trackingIdNum}_${stage}.json`;
    const filepath = path.join(ANALYSIS_DIR, filename);

    let existing = null;
    try {
      existing = JSON.parse(await fs.readFile(filepath, "utf8"));
    } catch { /* 尚無既有檔案，視為新建 */ }

    const { merged, conflicts } = mergeRecord(existing, incoming, safeOverrides);
    if (conflicts.length) {
      return res.status(409).json({ success: false, conflict: true, conflicts });
    }

    const record = {
      trackingId: trackingIdNum,
      stage,
      ...merged,
      attempts: safeAttempts && safeAttempts.length ? safeAttempts : (existing?.attempts || []),
      savedAt: new Date().toISOString(),
    };
    await fs.writeFile(filepath, JSON.stringify(record, null, 2), "utf8");

    res.json({ success: true, filename, record });
  } catch (error) {
    Logger.error("[Analysis] Save error:", error.message);
    res.status(500).json({ success: false, error: "伺服器內部錯誤" });
  }
});

/**
 * DELETE /api/analysis/:trackingId/:stage
 * 刪除單一受試者 × 單一階段已存的分析用原始資料（比對名單那邊發現資料有問題時用來重來一次）
 */
router.delete("/:trackingId/:stage", requireAdminToken, async (req, res) => {
  try {
    const trackingIdNum = Number(req.params.trackingId);
    const { stage } = req.params;
    if (!Number.isInteger(trackingIdNum) || trackingIdNum < 0) {
      return res.status(400).json({ success: false, error: "trackingId 必須為整數" });
    }
    if (!VALID_STAGES.has(stage)) {
      return res.status(400).json({ success: false, error: "stage 必須為 1、2-1 或 2-2" });
    }

    const filepath = path.join(ANALYSIS_DIR, `${trackingIdNum}_${stage}.json`);
    try {
      await fs.unlink(filepath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // 檔案本來就不存在視為已刪除，不算錯誤
    }
    res.json({ success: true });
  } catch (error) {
    Logger.error("[Analysis] Delete error:", error.message);
    res.status(500).json({ success: false, error: "伺服器內部錯誤" });
  }
});

export default router;
