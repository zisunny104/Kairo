/**
 * 名單比對草稿 API 路由
 * 把「名單比對」分頁的工作進度存成伺服器上單一份共用草稿（runtime/match-mark/draft.json），
 * 讓不同客戶端開啟時看到一致的資料，而不是各自存在自己瀏覽器的 localStorage。
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
    Logger.warn(`match-mark 管理端點未授權存取 | ip=${req.ip} | path=${req.path}`);
    return res.status(403).json({ success: false, error: "授權失敗" });
  }
  next();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MATCH_MARK_DIR = path.join(__dirname, "../../runtime/match-mark");
const DRAFT_PATH = path.join(MATCH_MARK_DIR, "draft.json");

async function ensureDir() {
  try {
    await fs.access(MATCH_MARK_DIR);
  } catch {
    await fs.mkdir(MATCH_MARK_DIR, { recursive: true });
  }
}

/**
 * GET /api/match-mark/draft
 * 讀取伺服器上共用的名單比對草稿；尚未存過時回傳 draft: null
 */
router.get("/draft", requireAdminToken, async (req, res) => {
  try {
    let content;
    try {
      content = await fs.readFile(DRAFT_PATH, "utf8");
    } catch {
      return res.json({ success: true, draft: null });
    }
    let draft;
    try {
      draft = JSON.parse(content);
    } catch {
      return res.status(500).json({ success: false, error: "草稿資料格式錯誤" });
    }
    res.json({ success: true, draft });
  } catch (error) {
    Logger.error("[MatchMark] Read error:", error.message);
    res.status(500).json({ success: false, error: "伺服器內部錯誤" });
  }
});

/**
 * PUT /api/match-mark/draft
 * 整份覆寫伺服器上共用的名單比對草稿
 */
router.put("/draft", requireAdminToken, async (req, res) => {
  try {
    const draft = req.body;
    if (!draft || typeof draft !== "object") {
      return res.status(400).json({ success: false, error: "草稿資料格式錯誤" });
    }
    await ensureDir();
    await fs.writeFile(DRAFT_PATH, JSON.stringify(draft), "utf8");
    res.json({ success: true });
  } catch (error) {
    Logger.error("[MatchMark] Save error:", error.message);
    res.status(500).json({ success: false, error: "伺服器內部錯誤" });
  }
});

export default router;
