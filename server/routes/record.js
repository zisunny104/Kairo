/**
 * 實驗日誌 API 路由
 * 處理實驗日誌的儲存、列出、讀取、刪除
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
    Logger.warn(`record 管理端點未授權存取 | ip=${req.ip} | path=${req.path}`);
    return res.status(403).json({ success: false, error: "授權失敗" });
  }
  next();
}

const SAFE_FILENAME_RE = /^[a-zA-Z0-9_\-\.]+\.jsonl$/;

function validateFilename(filename) {
  return typeof filename === "string" && SAFE_FILENAME_RE.test(path.basename(filename));
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 全域 express.json 限制為 1MB，record/save 需要更大的 body，單獨覆蓋
router.use(express.json({ limit: "11mb" }));

// 日誌檔案儲存路徑
const LOGS_DIR = path.join(__dirname, "../../runtime/experiment-data");
const MAX_CONTENT_BYTES = 10 * 1024 * 1024; // 10MB

// 確保目錄存在
async function ensureLogDir() {
  try {
    await fs.access(LOGS_DIR);
  } catch {
    await fs.mkdir(LOGS_DIR, { recursive: true });
  }
}

/**
 * GET /api/record/list
 * 列出所有日誌檔案
 */
router.get("/list", requireAdminToken, async (req, res) => {
  try {
    await ensureLogDir();

    const entries = await fs.readdir(LOGS_DIR);
    const files = [];

    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) {
        const filepath = path.join(LOGS_DIR, entry);
        const stats = await fs.stat(filepath);

        files.push({
          filename: entry,
          size: stats.size,
          modified: stats.mtimeMs,
          path: `runtime/experiment-data/${entry}`,
        });
      }
    }

    // 按修改時間降序排列
    files.sort((a, b) => b.modified - a.modified);

    res.json({
      success: true,
      files,
      count: files.length,
    });
  } catch (error) {
    Logger.error("[ExperimentLogs] List error:", error.message);
    res.status(500).json({
      success: false,
      error: "伺服器內部錯誤",
    });
  }
});

/**
 * POST /api/record/save
 * 儲存日誌檔案
 */
router.post("/save", async (req, res) => {
  try {
    const { filename, content } = req.body;

    if (!filename || !content) {
      return res.status(400).json({
        success: false,
        error: "Missing filename or content",
      });
    }

    await ensureLogDir();

    // 防止路徑遍歷，並驗證副檔名
    const safeFilename = path.basename(filename);
    if (!validateFilename(filename)) {
      return res.status(400).json({ success: false, error: "檔名格式無效（僅允許英數字、底線、連字號，副檔名須為 .jsonl）" });
    }

    // 限制內容大小
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > MAX_CONTENT_BYTES) {
      return res.status(400).json({ success: false, error: `內容超過大小限制 (${MAX_CONTENT_BYTES / 1024 / 1024}MB)` });
    }

    const filepath = path.join(LOGS_DIR, safeFilename);

    // 以獨佔模式寫入（flag: "wx"）：檔案已存在則拋出 EEXIST。
    // save 端點對外開放（實驗機需在未授權下寫入日誌），因此改由「絕不覆蓋既有檔」
    // 作為根本保護——實驗執行階段用時間戳命名不會撞名、編輯流程一律另存 _edited，
    // 皆不需覆蓋；如此可防止任意用戶清除或竄改既有實驗資料。
    try {
      await fs.writeFile(filepath, content, { encoding: "utf8", flag: "wx" });
    } catch (writeErr) {
      if (writeErr.code === "EEXIST") {
        return res.status(409).json({
          success: false,
          error: "檔案已存在，為保護既有資料不予覆蓋（請改用另存新檔或更換檔名）",
        });
      }
      throw writeErr;
    }

    const stats = await fs.stat(filepath);

    res.json({
      success: true,
      filename: safeFilename,
      size: stats.size,
      path: `runtime/experiment-data/${safeFilename}`,
    });
  } catch (error) {
    Logger.error("[ExperimentLogs] Save error:", error.message);
    res.status(500).json({
      success: false,
      error: "伺服器內部錯誤",
    });
  }
});

/**
 * GET /api/record/read/:filename
 * 讀取日誌檔案
 */
router.get("/read/:filename", requireAdminToken, async (req, res) => {
  try {
    const { filename } = req.params;

    if (!filename) {
      return res.status(400).json({
        success: false,
        error: "Missing filename",
      });
    }

    // 防止路徑遍歷，並驗證副檔名
    const safeFilename = path.basename(filename);
    if (!validateFilename(filename)) {
      return res.status(400).json({ success: false, error: "檔名格式無效（僅允許英數字、底線、連字號，副檔名須為 .jsonl）" });
    }
    const filepath = path.join(LOGS_DIR, safeFilename);

    // 檢查檔案是否存在
    try {
      await fs.access(filepath);
    } catch {
      return res.status(404).json({
        success: false,
        error: `File not found: ${safeFilename}`,
      });
    }

    const content = await fs.readFile(filepath, "utf8");
    const stats = await fs.stat(filepath);

    res.json({
      success: true,
      filename: safeFilename,
      content,
      size: stats.size,
    });
  } catch (error) {
    Logger.error("[ExperimentLogs] Read error:", error.message);
    res.status(500).json({
      success: false,
      error: "伺服器內部錯誤",
    });
  }
});

/**
 * PATCH /api/record/update-participant/:filename
 * 更新日誌檔案中所有 exp_start / exp_end 的 participant 欄位
 */
router.patch("/update-participant/:filename", requireAdminToken, async (req, res) => {
  try {
    const { filename } = req.params;
    const { participant } = req.body;

    if (!filename || !participant) {
      return res.status(400).json({
        success: false,
        error: "Missing filename or participant",
      });
    }

    if (typeof participant !== "string" || participant.length > 200) {
      return res.status(400).json({ success: false, error: "participant 值無效（最多 200 字元）" });
    }

    const safeFilename = path.basename(filename);
    if (!validateFilename(filename)) {
      return res.status(400).json({ success: false, error: "檔名格式無效（僅允許英數字、底線、連字號，副檔名須為 .jsonl）" });
    }
    const filepath = path.join(LOGS_DIR, safeFilename);

    try {
      await fs.access(filepath);
    } catch {
      return res.status(404).json({
        success: false,
        error: `File not found: ${safeFilename}`,
      });
    }

    const content = await fs.readFile(filepath, "utf8");
    const updatedLines = content
      .trim()
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "exp_start" || entry.type === "exp_end") {
            entry.participant = participant;
          }
          return JSON.stringify(entry);
        } catch {
          return line;
        }
      });

    await fs.writeFile(filepath, updatedLines.join("\n") + "\n", "utf8");

    res.json({ success: true, filename: safeFilename, participant });
  } catch (error) {
    Logger.error("[ExperimentLogs] UpdateParticipant error:", error.message);
    res.status(500).json({ success: false, error: "伺服器內部錯誤" });
  }
});

/**
 * DELETE /api/record/delete/:filename
 * 刪除日誌檔案
 */
router.delete("/delete/:filename", requireAdminToken, async (req, res) => {
  try {
    const { filename } = req.params;

    if (!filename) {
      return res.status(400).json({
        success: false,
        error: "Missing filename",
      });
    }

    // 防止路徑遍歷，並驗證副檔名
    const safeFilename = path.basename(filename);
    if (!validateFilename(filename)) {
      return res.status(400).json({ success: false, error: "檔名格式無效（僅允許英數字、底線、連字號，副檔名須為 .jsonl）" });
    }
    const filepath = path.join(LOGS_DIR, safeFilename);

    // 檢查檔案是否存在
    try {
      await fs.access(filepath);
    } catch {
      return res.status(404).json({
        success: false,
        error: `File not found: ${safeFilename}`,
      });
    }

    await fs.unlink(filepath);

    res.json({
      success: true,
      filename: safeFilename,
      message: "File deleted successfully",
    });
  } catch (error) {
    Logger.error("[ExperimentLogs] Delete error:", error.message);
    res.status(500).json({
      success: false,
      error: "伺服器內部錯誤",
    });
  }
});

export default router;
