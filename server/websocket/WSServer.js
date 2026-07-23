/**
 * WebSocket 伺服器封裝
 *
 * 功能:
 * - 初始化 WebSocketServer
 * - 處理連線升級
 * - 管理 WebSocket 生命週期
 * - 錯誤處理與日誌
 */

import { WebSocketServer } from "ws";
import { SERVER_CONFIG } from "../config/server.js";
import { Logger } from "../utils/logger.js";
import { metrics } from "../metrics.js";
import { WS_PROTOCOL } from "../../shared/ws-protocol-constants.js";

export class WSServer {
  constructor(httpServer) {
    this.httpServer = httpServer;
    this.wss = null;
    this.connectionManager = null;
    this.messageHandler = null;
  }

  /**
   * 初始化 WebSocket 伺服器
   * @param {Object} options - 配置選項
   * @param {ConnectionManager} options.connectionManager - 連線管理器
   * @param {MessageHandler} options.messageHandler - 訊息處理器
   */
  initialize({ connectionManager, messageHandler }) {
    this.connectionManager = connectionManager;
    this.messageHandler = messageHandler;

    // 建立 WebSocketServer (noServer: true 允許手動處理升級)
    this.wss = new WebSocketServer({
      noServer: true,
      // 最大負載大小 (10MB)
      maxPayload: 10 * 1024 * 1024,
    });

    // 設定 HTTP 升級處理
    this.setupUpgradeHandler();

    // 設定 WebSocket 連線處理
    this.setupConnectionHandler();

    Logger.success("WebSocket 伺服器已初始化");
  }

  /**
   * 設定 HTTP 升級處理器
   * 將 HTTP 請求升級為 WebSocket 連線
   */
  setupUpgradeHandler() {
    this.httpServer.on("upgrade", (request, socket, head) => {
      try {
        // 解析 URL 路徑
        const pathname = new URL(request.url, `http://${request.headers.host}`)
          .pathname;

        // 只在 /ws 路徑上升級為 WebSocket
        if (pathname === "/ws") {
          this.wss.handleUpgrade(request, socket, head, (ws) => {
            this.wss.emit("connection", ws, request);
          });
        } else {
          // 非 /ws 路徑，拒絕升級
          socket.destroy();
        }
      } catch (error) {
        Logger.error("WebSocket 升級錯誤:", error.message);
        socket.destroy();
      }
    });
  }

  /**
   * 設定 WebSocket 連線處理器
   */
  setupConnectionHandler() {
    this.wss.on("connection", (ws, request) => {
      try {
        // 提取客戶端資訊
        const clientInfo = this.extractClientInfo(request);

        Logger.event("green", ">", `新連線 | IP: ${clientInfo.ipAddress}`);

        // 註冊連線到 ConnectionManager
        const wsConnectionId = this.connectionManager.register(ws, clientInfo);

        // 設定訊息處理（含速率限制檢查，避免大量訊息造成 CPU 峰值）
        //
        // 行為說明：
        // - 在解析訊息前先呼叫 ConnectionManager.allowMessage() 檢查 token
        //   bucket。若不允許，會回傳速率限制錯誤供客戶端處理。
        // - 若連續違規達到閾值，伺服器會移除該連線（移除連線與清理資源）。
        // 這樣可阻止單一使用者或惡意代理將 CPU 時間佔滿。
        ws.on("message", (data) => {
          try {
            // AUTH 訊息豁免 rate limit：新裝置/重連時第一個訊息必定是 auth，
            // 若也被 token bucket 擋住，裝置將永遠無法加入。
            let messageType = null;
            try {
              messageType = JSON.parse(data.toString())?.type;
            } catch (_) {}
            const isAuthMessage = messageType === WS_PROTOCOL.C2S.AUTH;

            const res = isAuthMessage
              ? { allowed: true }
              : this.connectionManager.allowMessage(wsConnectionId);
            if (!res.allowed) {
              // 回傳速率限制錯誤
              this.sendError(ws, "RATE_LIMIT_EXCEEDED", "Too many messages");

              // 增加 metrics 紀錄
              try {
                metrics.incrementRateLimitViolations();
              } catch (e) {
                // ignore
              }

              // 超過閾值則關閉連線並清理
              if (
                res.violations >=
                (res.threshold ||
                  SERVER_CONFIG.websocket.rateLimit.violationThreshold)
              ) {
                Logger.warn(`關閉連線: ${wsConnectionId} 因為超出速率限制`);
                try {
                  ws.close(1008, "Rate limit exceeded");
                } catch (e) {
                  // ignore
                }
                this.connectionManager.unregister(wsConnectionId);
              }

              return;
            }
          } catch (e) {
            Logger.warn(`速率檢查失敗: ${e.message}`);
          }

          this.handleMessage(ws, wsConnectionId, data);
        });

        // 設定關閉處理
        ws.on("close", (code, reason) => {
          this.handleClose(wsConnectionId, code, reason);
        });

        // 設定錯誤處理
        ws.on("error", (error) => {
          this.handleError(wsConnectionId, error);
        });

        // 設定 Pong 處理（心跳響應）
        ws.on("pong", () => {
          this.connectionManager.updateHeartbeat(wsConnectionId);
        });

        // 發送連線成功訊息
        this.sendConnectionSuccess(ws, wsConnectionId);
      } catch (error) {
        Logger.error("處理 WebSocket 連線失敗:", error.message);
        ws.close(1011, "Internal server error");
      }
    });
  }

  /**
   * 提取客戶端資訊
   * @param {Object} request - HTTP 請求對象
   * @returns {Object} 客戶端資訊
   */
  extractClientInfo(request) {
    return {
      ipAddress: request.socket.remoteAddress || "unknown",
      userAgent: request.headers["user-agent"] || "unknown",
      origin: request.headers["origin"] || "unknown",
    };
  }

  /**
   * 處理收到的訊息
   * @param {WebSocket} ws - WebSocket 連線
   * @param {string} wsConnectionId - 連線 ID
   * @param {Buffer} data - 訊息資料
   */
  handleMessage(ws, wsConnectionId, data) {
    try {
      // 解析 JSON 訊息
      const message = JSON.parse(data.toString());

      // 委託給 MessageHandler 處理
      this.messageHandler.handle(wsConnectionId, message, ws);
    } catch (error) {
      Logger.error(`解析訊息失敗 [${wsConnectionId}]:`, error.message);

      // 發送錯誤回應
      this.sendError(ws, "INVALID_MESSAGE", "訊息格式錯誤");
    }
  }

  /**
   * 處理連線關閉
   * Session 成員清理與 clientLeft 廣播由 ConnectionManager.unregister() 統一處理，
   * 無論來源為 close 事件或 heartbeat timeout 皆一致。
   * @param {string} wsConnectionId - 連線 ID
   * @param {number} code - 關閉代碼
   * @param {string} reason - 關閉原因
   */
  handleClose(wsConnectionId, code, reason) {
    Logger.debug(`連線關閉 [${wsConnectionId}]: ${code} - ${reason}`);
    this.connectionManager.unregister(wsConnectionId);
  }

  /**
   * 處理連線錯誤
   * @param {string} wsConnectionId - 連線 ID
   * @param {Error} error - 錯誤對象
   */
  handleError(wsConnectionId, error) {
    Logger.error(`WebSocket 錯誤 [${wsConnectionId}]:`, error.message);
  }

  /**
   * 發送連線成功訊息
   * @param {WebSocket} ws - WebSocket 連線
   * @param {string} wsConnectionId - 連線 ID
   */
  sendConnectionSuccess(ws, wsConnectionId) {
    const message = {
      type: WS_PROTOCOL.S2C.CONNECTED,
      data: {
        wsConnectionId,
        serverTime: Math.floor(Date.now() / 1000),
        heartbeatInterval: SERVER_CONFIG.websocket.heartbeatInterval,
      },
      timestamp: Date.now(),
    };

    this.sendMessage(ws, message);
  }

  /**
   * 發送錯誤訊息
   * @param {WebSocket} ws - WebSocket 連線
   * @param {string} code - 錯誤代碼
   * @param {string} message - 錯誤訊息
   */
  sendError(ws, code, message) {
    const errorMessage = {
      type: WS_PROTOCOL.S2C.ERROR,
      data: {
        code,
        message,
      },
      timestamp: Date.now(),
    };

    this.sendMessage(ws, errorMessage);
  }

  /**
   * 發送訊息到客戶端
   * @param {WebSocket} ws - WebSocket 連線
   * @param {Object} message - 訊息對象
   */
  sendMessage(ws, message) {
    if (ws.readyState === 1) {
      // OPEN
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * 關閉伺服器
   */
  close() {
    if (this.wss) {
      Logger.debug("正在關閉 WebSocket 伺服器...");

      // 關閉所有連線
      this.wss.clients.forEach((ws) => {
        ws.close(1001, "Server shutting down");
      });

      // 關閉伺服器
      this.wss.close(() => {
        Logger.info("WebSocket 伺服器已關閉");
      });
    }
  }
}
