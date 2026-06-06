/**
 * 同步路由 - 處理工作階段和分享代碼相關的HTTP請求
 */
import express from "express";
import SessionService from "../services/SessionService.js";
import ShareCodeService from "../services/ShareCodeService.js";
import { generateClientId } from "../utils/idGenerator.js";
import { validateChecksum } from "../utils/checksum.js";
import {
  HTTP_STATUS,
  ERROR_CODES,
  SHARE_CODE_CONSTANTS,
  ROLE,
  CHANNEL_CONSTANTS,
} from "../config/constants.js";
import { WS_PROTOCOL } from "../../shared/ws-protocol-constants.js";
import Logger from "../utils/logger.js";
import { query, execute } from "../database/connection.js";
import {
  findOperatorConflict,
  normalizeClientType,
} from "../utils/sync-role-guard.js";
import {
  getValidCreateCode,
  getSyncEnableFlag,
  getSyncMaxClients,
  ADMIN_TOKEN,
} from "../config/server.js";

const { PREFIX: PUBLIC_CHANNEL_PREFIX, VALID_NAMES: VALID_CHANNELS } = CHANNEL_CONSTANTS;

const router = express.Router();

/**
 * 管理員 Token 驗證 middleware
 * 套用於高危端點：清除工作階段、踢出裝置、變更角色
 */
function requireAdminToken(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== ADMIN_TOKEN) {
    Logger.warn(`管理端點未授權存取 | ip=${req.ip} | path=${req.path}`);
    return res.status(HTTP_STATUS.FORBIDDEN).json({
      success: false,
      message: "需要管理員授權（缺少或無效的 X-Admin-Token）",
    });
  }
  next();
}

function closeSessionEverywhere(
  app,
  resolvedSessionId,
  { removeDatabaseSession = false } = {},
) {
  const connectionManager = app?.locals?.connectionManager;
  const sessionManager = app?.locals?.sessionManager;

  if (!connectionManager || !sessionManager) {
    throw new Error("WebSocket 系統尚未初始化");
  }

  const wsIds = connectionManager.getConnectionIdsBySessionId(resolvedSessionId);
  wsIds.forEach((id) => connectionManager.unregister(id));
  sessionManager.clearSession(resolvedSessionId);

  let dbDeleted = true;

  if (removeDatabaseSession) {
    execute(`DELETE FROM share_codes WHERE session_id = ?`, [resolvedSessionId]);
    const deleted = execute(`DELETE FROM sessions WHERE session_id = ?`, [resolvedSessionId]);
    dbDeleted = deleted.changes > 0;
  }

  return { closedCount: wsIds.length, dbDeleted };
}

/**
 * POST /api/sync/session
 * 建立新的工作階段（建立者直接加入，不自動產生分享代碼）
 *
 * Request body: { createCode } (建立代碼，用於驗證 - 可選)
 * Response: { sessionId, clientId, role, created_at }
 */
router.post("/session", (req, res) => {
  const { createCode } = req.body;

  if (!getSyncEnableFlag()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: "SYNC_DISABLED",
      message: "同步功能目前已停用",
    });
  }

  const validCreateCode = getValidCreateCode();
  if (!validCreateCode) {
    Logger.error("CREATE_CODE 未設定，拒絕建立工作階段");
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: ERROR_CODES.INVALID_CREATE_CODE,
      message: "伺服器尚未設定建立代碼，請在 server/.env 設定 CREATE_CODE",
    });
  }
  if (createCode !== validCreateCode) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: ERROR_CODES.INVALID_CREATE_CODE,
      message: "建立代碼無效",
    });
  }

  try {
    // 產生新的clientId（建立者的分頁ID）
    const clientId = generateClientId();

    // 建立工作階段（建立者自動成為 operator）
    const session = SessionService.createSession(clientId);

    // 回傳工作階段資訊（不包含分享代碼，需要時再呼叫 generate_share_code）
    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      data: {
        sessionId: session.sessionId,
        clientId: session.clientId,
        role: ROLE.OPERATOR,
        createdAt: session.created_at,
        maxClients: getSyncMaxClients(),
      },
    });
  } catch (error) {
    Logger.error("建立工作階段失敗:", error.message);
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: ERROR_CODES.DATABASE_ERROR,
      message: "建立工作階段失敗",
    });
  }
});

/**
 * POST /api/sync/generate_share_code
 * 產生分享代碼
 *
 * Request body: { sessionId, clientId }
 * Response: { share_code, session_id, expires_at }
 */
router.post("/generate_share_code", (req, res) => {
  const { sessionId, clientId } = req.body;

  if (!sessionId || !clientId) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: ERROR_CODES.INVALID_SESSION_ID,
      message: "缺少sessionId或clientId",
    });
  }

  try {
    // 驗證工作階段存在
    const session = SessionService.getSession(sessionId);
    if (!session) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: ERROR_CODES.SESSION_NOT_FOUND,
        message: "工作階段不存在或已過期",
      });
    }

    // 驗證 clientId 必須為該 session 的建立者，防止任意人為已知 session 產生代碼
    if (session.created_by !== clientId) {
      Logger.warn(`generate_share_code 未授權 | sessionId=${sessionId} | clientId=${clientId}`);
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: "UNAUTHORIZED",
        message: "僅允許工作階段建立者產生分享代碼",
      });
    }

    const codeData = ShareCodeService.generateCode(sessionId, clientId);
    const shareUrl = `${req.baseUrl}/index.html?shareCode=${encodeURIComponent(codeData.share_code)}&role=${ROLE.VIEWER}`;

    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      data: {
        shareCode: codeData.share_code,
        sessionId: codeData.session_id,
        expiresAt: codeData.expires_at,
        shareUrl,
      },
    });
  } catch (error) {
    Logger.error("產生分享代碼失敗:", error.message);
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: ERROR_CODES.DATABASE_ERROR,
      message: "產生分享代碼失敗",
    });
  }
});

/**
 * POST /api/sync/join
 * 使用分享代碼加入工作階段
 *
 * Request body: { shareCode, role, clientId }
 * Response: { sessionId, clientId, role }
 */
router.post("/join", (req, res) => {
  const { shareCode, role, clientId, clientType } = req.body;

  if (!getSyncEnableFlag()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: "SYNC_DISABLED",
      message: "同步功能目前已停用",
    });
  }

  Logger.debug(`[Join] 加入請求 - 代碼: ${shareCode}, 角色: ${role}, 客戶端ID: ${clientId}`);

  if (!shareCode) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: ERROR_CODES.INVALID_SHARE_CODE,
      message: "缺少分享代碼",
    });
  }

  try {
    const validation = ShareCodeService.validateCode(shareCode);

    if (validation.error) {
      Logger.warn(`[Join] 分享代碼驗證失敗 - 代碼: ${shareCode}, 錯誤: ${validation.error}`);
      const statusMap = {
        [ERROR_CODES.INVALID_SHARE_CODE]: HTTP_STATUS.BAD_REQUEST,
        [ERROR_CODES.SHARE_CODE_NOT_FOUND]: HTTP_STATUS.NOT_FOUND,
        [ERROR_CODES.SHARE_CODE_EXPIRED]: HTTP_STATUS.NOT_FOUND,
      };

      return res
        .status(statusMap[validation.error] || HTTP_STATUS.BAD_REQUEST)
        .json({
          success: false,
          error: validation.error,
          message: "分享代碼無效、已過期或已使用",
        });
    }

    const resolvedRole = [ROLE.OPERATOR, ROLE.VIEWER].includes(role)
      ? role
      : ROLE.VIEWER;
    const normalizedClientType = normalizeClientType(clientType);

    if (resolvedRole === ROLE.OPERATOR && !normalizedClientType) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: "INVALID_CLIENT_TYPE",
        message: "操作者加入時必須指定 clientType 為 panel 或 board",
      });
    }

    // 使用提供的clientId或產生新的
    const finalClientId = clientId || generateClientId();

    const sessionManager = req.app?.locals?.sessionManager;
    const currentClientCount = sessionManager?.getClientCount?.(
      validation.session_id,
    ) || 0;
    const maxClients = getSyncMaxClients();

    if (currentClientCount >= maxClients) {
      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: "SESSION_CLIENT_LIMIT_REACHED",
        message: `工作階段已達人數上限 (${maxClients})`,
      });
    }

    if (resolvedRole === ROLE.OPERATOR) {
      const conflict = findOperatorConflict(
        sessionManager,
        validation.session_id,
        normalizedClientType,
        finalClientId,
      );

      if (conflict) {
        return res.status(HTTP_STATUS.CONFLICT).json({
          success: false,
          error: "OPERATOR_SLOT_OCCUPIED",
          message: `此工作階段的 ${normalizedClientType} 操作者已存在`,
        });
      }
    }

    // 標記分享代碼為已使用（通過角色檢查後才標記）
    ShareCodeService.markAsUsed(shareCode, finalClientId);

    // 更新工作階段最後活動時間
    SessionService.updateLastActive(validation.session_id);

    Logger.debug(`[Join] 加入成功 | session=${validation.session_id} role=${resolvedRole}`);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: {
        sessionId: validation.session_id,
        clientId: finalClientId,
        role: resolvedRole,
        clientType: normalizedClientType,
      },
    });
  } catch (error) {
    Logger.error("加入工作階段失敗:", error.message);
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: ERROR_CODES.DATABASE_ERROR,
      message: "加入工作階段失敗",
    });
  }
});

/**
 * POST /api/sync/session/:sessionId/share-code
 * 為指定的工作階段產生分享代碼（RESTful 風格）
 *
 * Request body: { clientId }
 * Response: { shareCode, sessionId, expiresAt }
 */
router.post("/session/:sessionId/share-code", (req, res) => {
  const { sessionId } = req.params;
  const { clientId } = req.body;

  if (!clientId) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: ERROR_CODES.INVALID_REQUEST,
      message: "缺少clientId",
    });
  }

  try {
    // 驗證工作階段存在
    const session = SessionService.getSession(sessionId);
    if (!session) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: ERROR_CODES.SESSION_NOT_FOUND,
        message: "工作階段不存在或已過期",
      });
    }

    // 驗證 clientId 必須為該 session 的建立者
    if (session.created_by !== clientId) {
      Logger.warn(`session share-code 未授權 | sessionId=${sessionId} | clientId=${clientId}`);
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: "UNAUTHORIZED",
        message: "僅允許工作階段建立者產生分享代碼",
      });
    }

    // 產生分享代碼
    const codeData = ShareCodeService.generateCode(sessionId, clientId);

    // 回傳格式統一為 camelCase（前端預期格式）
    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      data: {
        shareCode: codeData.share_code,
        sessionId: codeData.session_id,
        expiresAt: codeData.expires_at,
      },
    });
  } catch (error) {
    Logger.error("產生分享代碼失敗:", error.message);
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: ERROR_CODES.DATABASE_ERROR,
      message: "產生分享代碼失敗",
    });
  }
});

/**
 * GET /api/sync/session/:sessionId/validate
 * 驗證工作階段是否有效（用於重新整理後恢復連線）
 *
 * Query params: clientId
 * Response: { valid: boolean }
 */
router.get("/session/:sessionId/validate", (req, res) => {
  const { sessionId } = req.params;
  const { clientId } = req.query;

  if (!clientId) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: ERROR_CODES.INVALID_REQUEST,
      message: "缺少clientId",
    });
  }

  try {
    const session = SessionService.getSession(sessionId);

    if (!session) {
      return res.status(HTTP_STATUS.OK).json({
        success: true,
        data: { valid: false },
      });
    }

    // 工作階段存在且有效
    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: { valid: true },
    });
  } catch (error) {
    Logger.error("驗證工作階段失敗:", error.message);
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: ERROR_CODES.DATABASE_ERROR,
      message: "驗證工作階段失敗",
    });
  }
});

/**
 * GET /api/sync/session/:sessionId/clients
 * 取得工作階段中的所有客戶端（即時連線狀態）
 *
 * Response: { clients: [{clientId, role, joinedAt}, ...], clientCount: number }
 */
router.get("/session/:sessionId/clients", (req, res) => {
  const { sessionId } = req.params;

  try {
    // 先檢查工作階段是否存在於資料庫
    const session = SessionService.getSession(sessionId);
    if (!session) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: ERROR_CODES.SESSION_NOT_FOUND,
        message: "工作階段不存在或已過期",
      });
    }

    // 從 SessionManager 取得即時連線的客戶端
    const sessionManager = req.app.locals.sessionManager;
    if (!sessionManager) {
      // 如果 SessionManager 不可用，回傳空列表
      return res.status(HTTP_STATUS.OK).json({
        success: true,
        data: {
          clients: [],
          clientCount: 0,
        },
      });
    }

    const members = sessionManager.getClients(sessionId);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: {
        clients: members,
        clientCount: members.length,
      },
    });
  } catch (error) {
    Logger.error("取得客戶端列表失敗:", error.message);
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: ERROR_CODES.DATABASE_ERROR,
      message: "取得客戶端列表失敗",
    });
  }
});

/**
 * GET /api/sync/session/:sessionId
 * 取得工作階段資訊
 */
router.get("/session/:sessionId", (req, res) => {
  const { sessionId } = req.params;

  try {
    const session = SessionService.getSession(sessionId);

    if (!session) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: ERROR_CODES.SESSION_NOT_FOUND,
        message: "工作階段不存在或已過期",
      });
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: session,
    });
  } catch (error) {
    Logger.error("查詢工作階段失敗:", error.message);
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: ERROR_CODES.DATABASE_ERROR,
      message: "查詢工作階段失敗",
    });
  }
});

/**
 * GET /api/sync/sessions
 * 取得所有活動中的工作階段列表（含公開頻道）— 僅限管理員
 *
 * Response: { sessions: [...] }
 */
router.get("/sessions", requireAdminToken, (req, res) => {
  try {
    const sessions = SessionService.getActiveSessions();

    // 將公開頻道以相同結構附加到列表末尾
    const sessionManager = req.app?.locals?.sessionManager;
    const nowSec = Math.floor(Date.now() / 1000);
    const channelSessions = VALID_CHANNELS.map((name) => {
      const sessionId = `${PUBLIC_CHANNEL_PREFIX}${name}__`;
      const clients = sessionManager ? sessionManager.getClients(sessionId) : [];
      const info = sessionManager?.getSessionInfo?.(sessionId);
      return {
        id: sessionId,
        created: info ? Math.floor(info.createdAt / 1000) : nowSec,
        lastActivity: nowSec,
        maxClients: null,
        clients: clients.map((c) => ({
          id: c.clientId,
          role: c.role,
          clientType: c.clientType,
          joinedAt: Math.floor((c.joinedAt || Date.now()) / 1000),
          lastActivity: nowSec,
        })),
        shareCodes: [],
        state: null,
        isChannel: true,
        channelName: name,
      };
    });

    // 批次查詢所有 session 的 share_codes，避免 N+1 DB 查詢
    let allShareCodes = [];
    if (sessions.length > 0) {
      try {
        const sessionIds = sessions.map((s) => s.session_id);
        const placeholders = sessionIds.map(() => "?").join(",");
        allShareCodes = query(
          `SELECT code, session_id, expires_at, used FROM share_codes WHERE session_id IN (${placeholders})`,
          sessionIds,
        );
      } catch (e) {
        Logger.warn("批次查詢 share_codes 失敗，略過:", e.message);
      }
    }
    const shareCodesBySession = new Map();
    for (const c of allShareCodes) {
      if (!shareCodesBySession.has(c.session_id)) {
        shareCodesBySession.set(c.session_id, []);
      }
      shareCodesBySession.get(c.session_id).push({
        code: c.code,
        expiresAt: c.expires_at,
        used: c.used === 1,
      });
    }

    const normalizedSessions = sessions.map((s) => {
      const clients = sessionManager
        ? sessionManager.getClients(s.session_id).map((c) => ({
            id: c.clientId,
            role: c.role,
            clientType: c.clientType,
            joinedAt: Math.floor((c.joinedAt || Date.now()) / 1000),
          }))
        : [];
      const shareCodes = shareCodesBySession.get(s.session_id) || [];
      let state = null;
      try { state = s.data ? JSON.parse(s.data) : null; } catch (e) {
        Logger.debug(`session ${s.session_id} data JSON 解析失敗:`, e.message);
      }
      return {
        id: s.session_id,
        created: s.created_at,
        lastActivity: s.last_active_at,
        maxClients: getSyncMaxClients(),
        clients,
        shareCodes,
        state,
        isChannel: false,
        channelName: null,
      };
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: [...channelSessions, ...normalizedSessions],
    });
  } catch (error) {
    Logger.error("查詢工作階段列表失敗:", error.message);
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: ERROR_CODES.DATABASE_ERROR,
      message: "查詢工作階段列表失敗",
    });
  }
});

/**
 * DELETE /api/sync/session/:sessionId
 * 刪除指定的工作階段
 *
 * Response: { success: true }
 */
router.delete("/session/:sessionId", requireAdminToken, (req, res) => {
  const { sessionId } = req.params;

  try {
    const result = closeSessionEverywhere(req.app, sessionId, {
      removeDatabaseSession: true,
    });

    if (!result.dbDeleted) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: ERROR_CODES.SESSION_NOT_FOUND,
        message: "工作階段不存在",
      });
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: {
        sessionId,
        closedCount: result.closedCount,
      },
      message: "工作階段已刪除",
    });
  } catch (error) {
    Logger.error("刪除工作階段失敗:", error.message);
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: ERROR_CODES.DATABASE_ERROR,
      message: "刪除工作階段失敗",
    });
  }
});

/**
 * POST /api/sync/sessions/clear
 * 清除所有工作階段
 *
 * Response: { success: true, deletedCount: number }
 */
router.post("/sessions/clear", requireAdminToken, (req, res) => {
  try {
    // 取得所有工作階段
    const sessions = query(`SELECT session_id FROM sessions`);
    const sessionIds = sessions.map((s) => s.session_id);

    if (sessionIds.length === 0) {
      return res.status(HTTP_STATUS.OK).json({
        success: true,
        data: { deletedCount: 0 },
      });
    }

    // 刪除所有分享代碼
    execute(`DELETE FROM share_codes`);

    // 刪除所有工作階段
    const result = execute(`DELETE FROM sessions`);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: { deletedCount: result.changes },
    });
  } catch (error) {
    Logger.error("清除所有工作階段失敗:", error.message);
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: ERROR_CODES.DATABASE_ERROR,
      message: "清除所有工作階段失敗",
    });
  }
});

/**
 * GET /api/sync/share-code/:code
 * 取得分享代碼資訊（用於檢查狀態，不會標記為已使用）
 *
 * 驗證順序（與加入時保持一致）：
 * 1. 長度驗證：必須為 SHARE_CODE_CONSTANTS.LENGTH 位
 * 2. 校驗碼驗證：使用 validateChecksum() 驗證
 * 3. 資料庫查詢：檢查代碼是否存在
 * 4. 狀態檢查：檢查是否過期或已使用
 *
 * Response: { sessionId, expired, used, expiresAt, createdAt }
 */
router.get("/share-code/:code", (req, res) => {
  const { code } = req.params;

  try {
    // 步驟 1: 長度驗證
    if (code.length !== SHARE_CODE_CONSTANTS.LENGTH) {
      Logger.warn(`[ShareCode] 長度驗證失敗 - 期望: ${SHARE_CODE_CONSTANTS.LENGTH}, 實際: ${code.length}`);
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: ERROR_CODES.INVALID_SHARE_CODE,
        message: "分享代碼格式錯誤（應為6位數字）",
      });
    }

    // 步驟 2: 校驗碼驗證
    if (!validateChecksum(code)) {
      Logger.warn(`[ShareCode] 校驗碼驗證失敗 - 代碼: ${code}`);
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: ERROR_CODES.INVALID_SHARE_CODE,
        message: "分享代碼校驗失敗",
      });
    }

    // 步驟 3 & 4: 取得代碼資訊（資料庫查詢 + 狀態檢查）
    const codeInfo = ShareCodeService.getCodeInfo(code);

    if (codeInfo.error) {
      Logger.warn(
        `[ShareCode] 代碼資訊查詢失敗 - 代碼: ${code}, 錯誤: ${codeInfo.error}`,
      );
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: codeInfo.error,
        message: "分享代碼無效",
      });
    }

    // 回傳格式統一為 camelCase
    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: {
        sessionId: codeInfo.session_id,
        expired: codeInfo.expired,
        used: codeInfo.used,
        expiresAt: codeInfo.expires_at,
        createdAt: codeInfo.created_at,
      },
    });
  } catch (error) {
    Logger.error("取得分享代碼資訊失敗:", error.message);
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: ERROR_CODES.DATABASE_ERROR,
      message: "取得分享代碼資訊失敗",
    });
  }
});

/**
 * POST /api/sync/channel
 * 快速加入公開頻道（無需分享代碼，直接以頻道名稱連線）
 *
 * Request body: { channelName: "A"|"B"|"C", role?, clientId? }
 * Response: { sessionId, clientId, role, channelName }
 */
router.post("/channel", (req, res) => {
  const {
    channelName,
    role = ROLE.OPERATOR,
    clientId: existingClientId,
    clientType,
  } = req.body;

  if (!channelName || !VALID_CHANNELS.includes(channelName.toUpperCase())) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: "INVALID_CHANNEL",
      message: `頻道名稱無效，可用頻道: ${VALID_CHANNELS.join(", ")}`,
    });
  }

  const validRole = [ROLE.OPERATOR, ROLE.VIEWER].includes(role)
    ? role
    : ROLE.OPERATOR;
  const normalizedClientType = normalizeClientType(clientType);

  if (validRole === ROLE.OPERATOR && !normalizedClientType) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: "INVALID_CLIENT_TYPE",
      message: "操作者加入公開頻道時必須指定 clientType 為 panel 或 board",
    });
  }

  // 公開頻道的 sessionId 使用固定前綴，不存入 DB（純記憶體工作階段）
  const sessionId = `${PUBLIC_CHANNEL_PREFIX}${channelName.toUpperCase()}__`;
  const clientId = existingClientId || generateClientId();

  if (validRole === ROLE.OPERATOR) {
    const sessionManager = req.app?.locals?.sessionManager;
    const conflict = findOperatorConflict(
      sessionManager,
      sessionId,
      normalizedClientType,
      clientId,
    );

    if (conflict) {
      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: "OPERATOR_SLOT_OCCUPIED",
        message: `此公開頻道的 ${normalizedClientType} 操作者已存在`,
      });
    }
  }

  Logger.event(
    "cyan",
    "~",
    `公開頻道 | 頻道 ${channelName.toUpperCase()} | ${clientId} | ${validRole}`,
  );

  res.status(HTTP_STATUS.OK).json({
    success: true,
    data: {
      sessionId,
      clientId,
      role: validRole,
      clientType: normalizedClientType,
      channelName: channelName.toUpperCase(),
    },
  });
});

/**
 * GET /api/sync/channels
 * 取得所有公開頻道的即時狀態（記憶體中）
 *
 * Response: { channels: [{ channelName, sessionId, clientCount, clients, active }] }
 */
router.get("/channels", (req, res) => {
  const sessionManager = req.app?.locals?.sessionManager;

  const channels = VALID_CHANNELS.map((name) => {
    const sessionId = `${PUBLIC_CHANNEL_PREFIX}${name}__`;
    const clients = sessionManager ? sessionManager.getClients(sessionId) : [];
    return {
      channelName: name,
      sessionId,
      clientCount: clients.length,
      clients,
      active: clients.length > 0,
    };
  });

  res.status(HTTP_STATUS.OK).json({
    success: true,
    data: channels,
  });
});

/**
 * POST /api/sync/channel/close
 * 關閉公開頻道所有連線
 *
 * Request body: { channelName?: "A"|"B"|"C", sessionId?: string }
 * Response: { sessionId, closedCount }
 */
router.post("/channel/close", requireAdminToken, (req, res) => {
  const { channelName, sessionId } = req.body || {};

  let resolvedSessionId = sessionId;
  if (!resolvedSessionId && channelName) {
    const upper = String(channelName).toUpperCase();
    if (!VALID_CHANNELS.includes(upper)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: "INVALID_CHANNEL",
        message: `頻道名稱無效，可用頻道: ${VALID_CHANNELS.join(", ")}`,
      });
    }
    resolvedSessionId = `${PUBLIC_CHANNEL_PREFIX}${upper}__`;
  }

  if (!resolvedSessionId || !resolvedSessionId.startsWith(PUBLIC_CHANNEL_PREFIX)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: "INVALID_CHANNEL",
      message: "缺少有效的公開頻道 sessionId",
    });
  }

  const connectionManager = req.app.locals.connectionManager;
  const sessionManager = req.app.locals.sessionManager;

  if (!connectionManager || !sessionManager) {
    return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: "SERVER_NOT_READY",
      message: "WebSocket 系統尚未初始化",
    });
  }

  try {
    const result = closeSessionEverywhere(req.app, resolvedSessionId);

    Logger.event(
      "red",
      "!",
      `公開頻道已關閉 | session=${resolvedSessionId} | 斷線 ${result.closedCount} 筆`,
    );

    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: {
        sessionId: resolvedSessionId,
        closedCount: result.closedCount,
      },
    });
  } catch (error) {
    Logger.error("關閉公開頻道失敗:", error.message);
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: "CHANNEL_CLOSE_FAILED",
      message: "關閉公開頻道失敗",
    });
  }
});

/**
 * POST /api/sync/client/:clientId/kick
 * 強制退出指定客戶端
 */
router.post("/client/:clientId/kick", requireAdminToken, (req, res) => {
  const { clientId } = req.params;
  const connectionManager = req.app?.locals?.connectionManager;
  const sessionManager = req.app?.locals?.sessionManager;
  const broadcastManager = req.app?.locals?.broadcastManager;

  if (!connectionManager || !sessionManager) {
    return res.status(HTTP_STATUS.INTERNAL_ERROR).json({ success: false, message: "WebSocket 系統尚未初始化" });
  }

  const wsConnectionId = connectionManager.clientIdMap.get(clientId);
  if (!wsConnectionId) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, message: "找不到該裝置的連線" });
  }

  try {
    if (broadcastManager) {
      broadcastManager.sendToClient(clientId, { type: WS_PROTOCOL.S2C.KICKED, reason: "admin_kick" });
    }

    const removedSessionId = sessionManager?.removeClientById?.(clientId);
    if (removedSessionId && broadcastManager?.broadcastClientLeft) {
      broadcastManager.broadcastClientLeft(removedSessionId, clientId);
    }

    connectionManager.unregister(wsConnectionId);
    Logger.event("red", "!", `管理員強制退出 | clientId=${clientId}`);
    res.json({ success: true, data: { clientId } });
  } catch (error) {
    Logger.error("強制退出失敗:", error.message);
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({ success: false, message: "強制退出失敗" });
  }
});

/**
 * POST /api/sync/client/:clientId/role
 * 調整指定客戶端的角色
 * Body: { role: "operator" | "viewer" }
 */
router.post("/client/:clientId/role", requireAdminToken, (req, res) => {
  const { clientId } = req.params;
  const { role } = req.body;
  const sessionManager = req.app?.locals?.sessionManager;
  const broadcastManager = req.app?.locals?.broadcastManager;

  if (!sessionManager) {
    return res.status(HTTP_STATUS.INTERNAL_ERROR).json({ success: false, message: "WebSocket 系統尚未初始化" });
  }

  if (![ROLE.OPERATOR, ROLE.VIEWER].includes(role)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, message: "角色無效，必須為 operator 或 viewer" });
  }

  const sessionId = sessionManager.getSessionByClientId(clientId);
  if (!sessionId) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, message: "找不到該裝置所在的工作階段" });
  }

  try {
    // 更新 SessionManager 記憶體中的角色
    const session = sessionManager.activeSessions.get(sessionId);
    if (session?.clients.has(clientId)) {
      const meta = session.clients.get(clientId);
      session.clients.set(clientId, { ...meta, role });
    }

    // 通知該裝置角色已變更
    if (broadcastManager) {
      broadcastManager.sendToClient(clientId, { type: "role_changed", role, sessionId });
      // 廣播給工作階段內其他人知道成員角色變更
      broadcastManager.broadcastToRoom(sessionId, { type: "member_role_changed", clientId, role }, { excludeClientId: clientId });
    }

    Logger.event("blue", "~", `管理員調整角色 | clientId=${clientId} | role=${role}`);
    res.json({ success: true, data: { clientId, sessionId, role } });
  } catch (error) {
    Logger.error("調整角色失敗:", error.message);
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({ success: false, message: "調整角色失敗" });
  }
});


/**
 * POST /api/sync/client/:clientId/request-state
 * 向指定客戶端請求當前狀態並等待回覆
 */
router.post("/client/:clientId/request-state", requireAdminToken, async (req, res) => {
  const { clientId } = req.params;
  const messageHandler = req.app?.locals?.messageHandler;
  const sessionManager = req.app?.locals?.sessionManager;

  if (!messageHandler || !sessionManager) {
    return res.status(HTTP_STATUS.INTERNAL_ERROR).json({ success: false, message: "WebSocket 系統尚未初始化" });
  }

  const sessionId = sessionManager.getSessionByClientId(clientId);
  if (!sessionId) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, message: "找不到該裝置所在的工作階段" });
  }

  try {
    let state = await messageHandler.requestClientState(clientId, 7000);

    if (
      !state ||
      (typeof state === "object" && Object.keys(state).length === 0)
    ) {
      const session = SessionService.getSession(sessionId);
      if (session?.data) {
        try {
          const sessionData = typeof session.data === "string"
            ? JSON.parse(session.data)
            : session.data || {};
          state = {
            ...(typeof sessionData.state === "object" && sessionData.state ? sessionData.state : {}),
            ...(typeof sessionData.experimentState === "object" && sessionData.experimentState ? sessionData.experimentState : {}),
            ...(typeof sessionData.lastState === "object" && sessionData.lastState ? sessionData.lastState : {}),
          };
        } catch (parseError) {
          Logger.warn("無法解析工作階段快取資料，將保留空回應", parseError.message);
        }
      }
    }

    Logger.event("cyan", "~", `管理員請求客戶端狀態 | clientId=${clientId}`);
    res.json({ success: true, data: { clientId, sessionId, state } });
  } catch (error) {
    Logger.error("請求客戶端狀態失敗:", error.message);
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/sync/client/:clientId/refresh
 * 推送最新同步狀態給指定客戶端
 */
router.post("/client/:clientId/refresh", requireAdminToken, (req, res) => {
  const { clientId } = req.params;
  const sessionManager = req.app?.locals?.sessionManager;
  const broadcastManager = req.app?.locals?.broadcastManager;

  if (!sessionManager || !broadcastManager) {
    return res.status(HTTP_STATUS.INTERNAL_ERROR).json({ success: false, message: "WebSocket 系統尚未初始化" });
  }

  const sessionId = sessionManager.getSessionByClientId(clientId);
  if (!sessionId) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, message: "找不到該裝置所在的工作階段" });
  }

  try {
    const state = sessionManager.getExperimentState(sessionId);
    const sent = broadcastManager.sendToClient(clientId, {
      type: "sync_state",
      sessionId,
      state: state || {},
    });

    Logger.event("cyan", "~", `管理員推送狀態 | clientId=${clientId}`);
    res.json({ success: true, data: { clientId, sent } });
  } catch (error) {
    Logger.error("推送狀態失敗:", error.message);
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({ success: false, message: "推送狀態失敗" });
  }
});

export default router;
