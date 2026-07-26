/**
 * Node.js + WebSocket 後端伺服器
 * Port: 7645
 * 功能: 實驗面板即時同步系統
 */
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { SERVER_CONFIG, ADMIN_TOKEN, getValidCreateCode } from "./config/server.js";
import { CHANNEL_CONSTANTS } from "./config/constants.js";
import { getDatabase, closeDatabase } from "./database/connection.js";
import { validateSchema } from "./database/schema.js";
import SessionService from "./services/SessionService.js";
import ShareCodeService from "./services/ShareCodeService.js";

// 匯入路由
import healthRouter from "./routes/health.js";
import syncRouter from "./routes/sync.js";
import recordRouter from "./routes/record.js";
import rosterRouter from "./routes/roster.js";
import analysisRouter from "./routes/analysis.js";
import assistMarkRouter from "./routes/assist-mark.js";
import matchMarkRouter from "./routes/match-mark.js";
import questionnaireRouter from "./routes/questionnaire.js";

// 匯入 WebSocket 系統
import { WSServer } from "./websocket/WSServer.js";
import { ConnectionManager } from "./websocket/ConnectionManager.js";
import { SessionManager } from "./websocket/SessionManager.js";
import { BroadcastManager } from "./websocket/BroadcastManager.js";
import { MessageHandler } from "./websocket/MessageHandler.js";

// 匯入日誌工具
import { Logger } from "./utils/logger.js";
import { metrics } from "./metrics.js";
import { safeEqual } from "./utils/safe-compare.js";

// ES module 中取得目前檔案路徑
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 建立Express應用
const app = express();

// 設定信任代理（僅信任最近一層代理，防止 X-Forwarded-For 偽造）
app.set("trust proxy", 1);

// 建立 HTTP 伺服器（用於 WebSocket 升級）
const httpServer = createServer(app);

// ===== 中間件設定 =====
app.use(cors(SERVER_CONFIG.cors));

// 安全 HTTP 標頭
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// 自動取得完整網址 middleware
app.use((req, res, next) => {
  // 利用 req.protocol 和 req.get('host') 自動組裝完整網址
  const protocol = req.protocol;
  const host = req.get("host");
  req.fullUrl = `${protocol}://${host}${req.originalUrl}`;
  req.baseUrl = `${protocol}://${host}`; // 基礎 URL（不含路徑）
  next();
});

// 請求日誌
app.use((req, res, next) => {
  // 過濾掉 HEAD 請求（心跳檢測），減少日誌雜訊
  if (req.method !== "HEAD") {
    Logger.http(req.method, req.path);
  }
  next();
});

// ===== 靜態檔案服務 (前端) =====
const publicPath = path.join(__dirname, "..");
Logger.info("初始化靜態檔案服務");
Logger.debug(`靜態檔案路徑: <cyan>${publicPath}</cyan>`);

// 封鎖伺服器端敏感路徑，防止透過靜態檔案服務直接存取
// runtime/ 含 SQLite DB 與 JSONL；server/ 含原始碼；scripts/、node_modules/、docs/ 不對外公開
const BLOCKED_STATIC = /^\/(?:runtime|server|scripts|node_modules|docs)(\/|$)/i;
app.use((req, res, next) => {
  if (BLOCKED_STATIC.test(req.path)) return res.status(404).end();
  next();
});

const REVALIDATE_EXTS = new Set([".html", ".htm", ".js", ".css"]);

app.use(
  express.static(publicPath, {
    index: "index.html",
    extensions: ["html", "htm"],
    setHeaders(res, filePath) {
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader(
        "Cache-Control",
        REVALIDATE_EXTS.has(ext) ? "no-cache" : "public, max-age=86400",
      );
    },
  }),
);

// ===== 路由註冊 =====
app.use("/api/health", healthRouter);
app.use("/api/sync", syncRouter);
app.use("/api/record", recordRouter);
app.use("/api/roster", rosterRouter);
app.use("/api/analysis", analysisRouter);
app.use("/api/assist-mark", assistMarkRouter);
app.use("/api/match-mark", matchMarkRouter);
app.use("/api/questionnaire", questionnaireRouter);

// 根路徑（僅回傳最低限度資訊，不公開 API 結構）
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

// ===== 資料庫初始化 =====
try {
  Logger.info("初始化資料庫連線");
  getDatabase();
  validateSchema();
} catch (error) {
  Logger.error("資料庫初始化失敗:", error.message);
  process.exit(1);
}

// ===== 定期清理任務 =====
// 清理過期工作階段
// 清理過期分享代碼
const cleanupInterval = SERVER_CONFIG.cleanup.interval;

Logger.info("初始化清理任務");

setInterval(() => {
  try {
    SessionService.cleanupExpiredSessions();
    ShareCodeService.cleanupExpiredCodes();
  } catch (error) {
    Logger.error("清理任務失敗:", error.message);
  }
}, cleanupInterval);

Logger.success("清理任務已啟動");

// ===== WebSocket 系統初始化 =====
Logger.info("初始化 WebSocket 系統");

// 建立管理器
const connectionManager = new ConnectionManager();
const sessionManager = new SessionManager(connectionManager, SessionService);

// 將 in-memory SessionManager 指派給 ConnectionManager（避免 heartbeat 觸發 DB）
connectionManager.sessionManager = sessionManager;

const broadcastManager = new BroadcastManager(
  connectionManager,
  sessionManager,
);
const messageHandler = new MessageHandler(
  connectionManager,
  sessionManager,
  broadcastManager,
);

// 任何斷線（含 heartbeat timeout）從 SessionManager 移除後廣播 clientLeft
connectionManager.onClientLeft = (sessionId, clientId) => {
  broadcastManager.broadcastClientLeft(sessionId, clientId);
};

// 建立 WebSocket 伺服器
const wsServer = new WSServer(httpServer);
wsServer.initialize({
  connectionManager,
  messageHandler,
});

// 將 WebSocket 管理器掛載到 app.locals，供路由使用
app.locals.sessionManager = sessionManager;
app.locals.connectionManager = connectionManager;
app.locals.broadcastManager = broadcastManager;
app.locals.messageHandler = messageHandler;

Logger.success("WebSocket 系統已初始化");

// ===== Metrics endpoint (/metrics) 與週期性更新
// 說明：Prometheus 等監控系統會定期抓取本端點（scrape）以取得最新指標。
// 本端點回傳為 Prometheus text format，可直接被 Prometheus 抓取。
// Metrics endpoint（需要 admin token 避免伺服器統計外洩）
app.get("/metrics", (req, res, next) => {
  const token = req.headers["x-admin-token"];
  if (!token || !safeEqual(token, ADMIN_TOKEN)) return res.status(403).end();
  next();
}, async (req, res) => {
  try {
    Logger.debug(`[metrics] request from ${req.ip}`);
    res.set("Content-Type", metrics.register.contentType);
    const body = await metrics.register.metrics();
    Logger.debug(`[metrics] length=${body.length}`);
    res.send(body);
  } catch (e) {
    Logger.error(`[metrics] error: ${e.message}`);
    res.status(500).send("Metrics error");
  }
});

// Simple health check for metrics route debugging
app.get("/_metrics_test", (req, res) => {
  res.send("ok");
});

// 週期性更新 connection stats（每 5 秒）
// 說明：定期將 in-memory 統計資料寫入 metrics，以反映即時連線/工作階段狀態。
setInterval(() => {
  try {
    metrics.setConnectionStats(connectionManager.getStats());
  } catch (e) {
    // ignore metric update errors
  }
}, 5000);

// ===== 低頻 Session 驗證排程（每隔 sessionValidationInterval）
const sessionValidationInterval =
  SERVER_CONFIG.websocket.sessionValidationInterval || 300000; // ms
setInterval(() => {
  try {
    const sessions = sessionManager.getAllSessions();
    let removed = 0;
    for (const s of sessions) {
      const { sessionId } = s;
      // 公開頻道不存在 DB，跳過驗證以免誤斷線
      if (sessionId.startsWith(CHANNEL_CONSTANTS.PREFIX)) continue;
      const session = SessionService.getSession(sessionId);
      if (!session || !session.is_active) {
        Logger.warn(`發現失效 session，正在清理: ${sessionId}`);

        // 清理該 session 底下所有連線
        const wsIds = connectionManager.getConnectionIdsBySessionId(sessionId);
        for (const id of wsIds) {
          connectionManager.unregister(id);
        }

        // 同步移除 in-memory session
        sessionManager.clearSession(sessionId);
        removed++;
      }
    }

    if (removed > 0) {
      Logger.event("red", "-", `已清理 ${removed} 個失效 session`);
    }
  } catch (e) {
    Logger.error(`Session 驗證排程失敗: ${e.message}`);
  }
}, sessionValidationInterval);

// 提供管理員 Token 給前端管理介面（區網環境）
// 安全說明：需提供正確的 CREATE_CODE 才能取得 admin token，
// 防止學員/參與者在不知道建立代碼的情況下取得管理員權限。
app.get("/api/sync/admin-token", (req, res) => {
  const provided = req.headers["x-create-code"] || req.query.createCode;
  const valid = getValidCreateCode();
  if (!valid || !provided || !safeEqual(provided, valid)) {
    Logger.warn(`admin-token 端點未授權存取 | ip=${req.ip}`);
    return res.status(403).json({ success: false, message: "需要有效的建立代碼" });
  }
  res.json({ token: ADMIN_TOKEN });
});

// 404處理（在所有路由與 middleware 註冊後）
// 只回傳狀態碼，由 Nginx error_page 處理頁面跳轉
app.use((req, res) => {
  res.status(404).end();
});

// 錯誤處理（放在所有路由與 404 之後）
// 只回傳狀態碼，由 Nginx error_page 處理頁面跳轉
app.use((err, req, res, next) => {
  Logger.error("伺服器錯誤:", err.message || err);
  res.status(500).end();
});

// ===== 啟動伺服器 =====
const server = httpServer.listen(SERVER_CONFIG.port, () => {
  Logger.success("Panel Backend Server 已啟動");

  // 伺服器綁定在 0.0.0.0，客戶端可通過多種方式存取
  // 前端使用 window.location 自動決定實際網址，所以這裡只作為參考顯示
  Logger.info(
    `<yellow>|</yellow> 綁定網址: <dim>0.0.0.0:${SERVER_CONFIG.port}</dim>`,
  );
  Logger.info(`  HTTP      <yellow>|</yellow> <cyan>/api/*</cyan>`);
  Logger.info(
    `  WebSocket <yellow>|</yellow> <cyan>/ws</cyan> <dim>(ws://host:port/ws)</dim>`,
  );
  Logger.info(`  心跳檢測  <yellow>|</yellow> <cyan>/api/health</cyan>`);
  Logger.info(
    `工作階段超時: <cyan>${SERVER_CONFIG.session.timeout}</cyan> 秒 <yellow>|</yellow> 分享代碼超時: <cyan>${SERVER_CONFIG.shareCode.timeout}</cyan> 秒`,
  );
  Logger.info(
    `心跳檢測間隔: <cyan>${SERVER_CONFIG.websocket.heartbeatInterval / 1000}</cyan> 秒 <yellow>|</yellow> 心跳檢測超時: <cyan>${SERVER_CONFIG.websocket.heartbeatTimeout / 1000}</cyan> 秒`,
  );
  Logger.info(
    `清理任務間隔: <cyan>${SERVER_CONFIG.cleanup.interval / 1000}</cyan> 秒`,
  );
  const tokenPreview = ADMIN_TOKEN.slice(0, 8) + "...";
  Logger.warn(
    `管理員 Token: <yellow>${tokenPreview}</yellow>  <dim>(完整 Token 請查看 /api/sync/admin-token 或設定環境變數 ADMIN_TOKEN)</dim>`,
  );
  const createCode = getValidCreateCode();
  if (!createCode) {
    Logger.error(
      `⚠️  CREATE_CODE 未設定！無法建立工作階段。請在 server/.env 加入：<yellow>CREATE_CODE=your_code_here</yellow>`,
    );
  } else {
    const codePreview = createCode.slice(0, 2) + "*".repeat(Math.max(0, createCode.length - 2));
    Logger.info(`建立代碼已設定: <cyan>${codePreview}</cyan> <dim>(${createCode.length} 位)</dim>`);
  }
  Logger.info("");
});

// ===== 優雅關閉 =====
process.on("SIGINT", () => {
  Logger.warn("收到SIGINT資訊，正在關閉伺服器...");

  // 關閉 WebSocket 系統
  wsServer.close();
  connectionManager.closeAll();

  // 關閉 HTTP 伺服器
  server.close(() => {
    Logger.info("HTTP伺服器已關閉");
    closeDatabase();
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  Logger.warn("收到SIGTERM資訊，正在關閉伺服器...");

  // 關閉 WebSocket 系統
  wsServer.close();
  connectionManager.closeAll();

  // 關閉 HTTP 伺服器
  server.close(() => {
    Logger.info("HTTP伺服器已關閉");
    closeDatabase();
    process.exit(0);
  });
});
