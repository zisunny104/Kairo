/**
 * API Endpoint Constants
 *
 * 將常用 REST API 路徑集中管理，避免多處硬編與路徑不一致。
 */
export const API_ENDPOINTS = {
  SYNC: {
    SESSION: "/sync/session",
    JOIN: "/sync/join",
    GENERATE_SHARE_CODE: "/sync/generate_share_code",
    CHANNEL: "/sync/channel",
    CHANNEL_CLOSE: "/sync/channel/close",
    SESSIONS: "/sync/sessions",
    SESSIONS_CLEAR: "/sync/sessions/clear",
    SHARE_CODE: (shareCode) => `/sync/share-code/${encodeURIComponent(shareCode)}`,
    SESSION_TARGET: (sessionId) => `/sync/session/${encodeURIComponent(sessionId)}`,
    SESSION_VALIDATE: (sessionId, clientId) =>
      `/sync/session/${encodeURIComponent(sessionId)}/validate?clientId=${encodeURIComponent(clientId)}`,
    SESSION_SHARE_CODE: (sessionId) =>
      `/sync/session/${encodeURIComponent(sessionId)}/share-code`,
    SESSION_CLIENTS: (sessionId) =>
      `/sync/session/${encodeURIComponent(sessionId)}/clients`,
    CLIENT_KICK: (clientId) =>
      `/sync/client/${encodeURIComponent(clientId)}/kick`,
    CLIENT_ROLE: (clientId) =>
      `/sync/client/${encodeURIComponent(clientId)}/role`,
    CLIENT_REFRESH: (clientId) =>
      `/sync/client/${encodeURIComponent(clientId)}/refresh`,
    CLIENT_REQUEST_STATE: (clientId) =>
      `/sync/client/${encodeURIComponent(clientId)}/request-state`,
    ADMIN_TOKEN: "/sync/admin-token",
    HEALTH: "/health",
  },
  RECORD: {
    SAVE: "/record/save",
    LIST: "/record/list",
    READ: (filename) => `/record/read/${encodeURIComponent(filename)}`,
    DELETE: (filename) => `/record/delete/${encodeURIComponent(filename)}`,
    UPDATE_PARTICIPANT: (filename) =>
      `/record/update-participant/${encodeURIComponent(filename)}`,
  },
  ROSTER: {
    PARTICIPANTS: "/roster/participants",
  },
  ANALYSIS: {
    SAVE: "/analysis/save",
    LIST: "/analysis/list",
    DELETE: (trackingId, stage) =>
      `/analysis/${encodeURIComponent(trackingId)}/${encodeURIComponent(stage)}`,
  },
  ASSIST_MARK: {
    DRAFT: "/assist-mark/draft",
  },
  MATCH_MARK: {
    DRAFT: "/match-mark/draft",
  },
  QUESTIONNAIRE: {
    DRAFT: "/questionnaire/draft",
  },
};
