/**
 * 伺服器設定
 */
import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import os from "os";
import crypto from "crypto";

// 載入環境變數（明確指定 server/.env 路徑，避免從根目錄啟動時找不到）
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, "../.env") });

// 管理員 Token：從環境變數讀取，否則每次啟動隨機產生
// 用於保護高危管理端點（清除、踢人、改角色）
export const ADMIN_TOKEN =
  process.env.ADMIN_TOKEN || crypto.randomBytes(16).toString("hex");

export const SERVER_CONFIG = {
  // 環境設定
  nodeEnv: process.env.NODE_ENV || "development",

  // 伺服器設定
  port: parseInt(process.env.PORT || "7645", 10),
  host: process.env.HOST || "0.0.0.0",
  displayHost: process.env.DISPLAY_HOST || os.hostname(),

  // CORS設定
  // credentials 僅在明確指定 origin 時才能開啟；wildcard 不允許帶憑證
  cors: (() => {
    const origin = process.env.CORS_ORIGIN || "*";
    return { origin, credentials: origin !== "*" };
  })(),

  // WebSocket設定
  websocket: {
    heartbeatInterval: parseInt(
      process.env.WS_HEARTBEAT_INTERVAL || "30000",
      10,
    ),
    // 90s：安卓瀏覽器背景時 setInterval 可能凍結 30s 以上，需要額外容錯空間
    heartbeatTimeout: parseInt(process.env.WS_HEARTBEAT_TIMEOUT || "90000", 10),
    // Rate limiting for incoming messages (tokens)
    // 說明：每個連線有獨立 token bucket，用以限制單一連線的速率
    // - capacity：突發可用 token 數
    // - refillPerSec：每秒補回的 token 數（長期平均速率）
    // - violationThreshold：違規次數達此值則會關閉該連線
    rateLimit: {
      // 預設值（已微調為較保守設定，適合 100~300 連線常態）：
      // - capacity: 突發容錯（短時間 burst 容許的最大 token），
      // - refillPerSec: 長期平均速率（每秒補回 token），
      // - violationThreshold: 違規次數達此值則關閉該連線
      capacity: parseInt(process.env.WS_RATE_LIMIT_CAPACITY || "20", 10),
      refillPerSec: parseInt(
        process.env.WS_RATE_LIMIT_REFILL_PER_SEC || "10",
        10,
      ),
      violationThreshold: parseInt(
        process.env.WS_RATE_LIMIT_VIOLATION_THRESHOLD || "5",
        10,
      ),
    },
    // Interval for low-frequency session validation (ms)
    // 說明：較高成本的 session 驗證（例如查 DB 是否仍有效）應以此排程處理，
    // 避免心跳時直接查 DB 導致高頻 I/O。
    sessionValidationInterval: parseInt(
      process.env.WS_SESSION_VALIDATION_INTERVAL || "300000",
      10,
    ),
  },

  // 工作階段設定
  session: {
    timeout: parseInt(process.env.SESSION_TIMEOUT || "1800", 10),
    inactiveTimeout: parseInt(process.env.INACTIVE_TIMEOUT || "600", 10),
    maxClients: parseInt(process.env.MAX_CLIENTS || "6", 10),
  },

  // 分享代碼設定
  shareCode: {
    timeout: parseInt(process.env.SHARE_CODE_TIMEOUT || "300", 10),
  },

  // 清理設定
  cleanup: {
    interval: parseInt(process.env.CLEANUP_INTERVAL || "120000", 10),
  },

  // 日誌設定
  log: {
    level: process.env.LOG_LEVEL || "info",
  },
};

/**
 * 從 config.json 讀取業務設定
 */
import { readFileSync } from "fs";

let businessConfig = null;

export function loadBusinessConfigSync() {
  if (businessConfig) return businessConfig;

  try {
    const configPath = resolve(__dirname, "../../data/config.json");
    const configData = readFileSync(configPath, "utf-8");
    businessConfig = JSON.parse(configData);
    return businessConfig;
  } catch (error) {
    // Logger 尚未完全初始化時此函式可能被呼叫，保留 console.error 作後備
    console.error("載入 config.json 失敗:", error.message);
    // 回傳預設設定（createCode 不可硬編碼，由 .env CREATE_CODE 控制）
    return {
      multiScreenSync: {
        maxClients: 6,
        enableSync: true,
      },
    };
  }
}

/**
 * 取得驗證碼 — 優先從環境變數讀取，其次從 config.json
 */
export function getValidCreateCode() {
  if (process.env.CREATE_CODE) {
    return process.env.CREATE_CODE;
  }
  const config = businessConfig || loadBusinessConfigSync();
  return config.multiScreenSync?.validCreateCode || "";
}

export function getSyncEnableFlag() {
  const config = businessConfig || loadBusinessConfigSync();
  return config.multiScreenSync?.enableSync !== false;
}

export function getSyncMaxClients() {
  const config = businessConfig || loadBusinessConfigSync();
  const configValue = Number(config.multiScreenSync?.maxClients);
  if (Number.isInteger(configValue) && configValue > 0) {
    return configValue;
  }
  return SERVER_CONFIG.session.maxClients;
}
