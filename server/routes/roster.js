/**
 * 受試者名單 API 路由
 * 唯讀公開 runtime/roster/ 底下整理好的基礎名單資料，供前端「最終分析」分頁引入。
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
    Logger.warn(`roster 管理端點未授權存取 | ip=${req.ip} | path=${req.path}`);
    return res.status(403).json({ success: false, error: "授權失敗" });
  }
  next();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROSTER_DIR = path.join(__dirname, "../../runtime/roster");

/**
 * GET /api/roster/participants
 * 讀取受試者基礎名單（runtime/roster/participants.json）
 */
router.get("/participants", requireAdminToken, async (req, res) => {
  try {
    const filepath = path.join(ROSTER_DIR, "participants.json");
    let content;
    try {
      content = await fs.readFile(filepath, "utf8");
    } catch {
      return res.status(404).json({ success: false, error: "尚未建立受試者名單資料" });
    }

    let data;
    try {
      data = JSON.parse(content);
    } catch {
      return res.status(500).json({ success: false, error: "名單資料格式錯誤" });
    }

    res.json({ success: true, ...data });
  } catch (error) {
    Logger.error("[Roster] Read error:", error.message);
    res.status(500).json({ success: false, error: "伺服器內部錯誤" });
  }
});

export default router;
