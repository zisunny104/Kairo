// ========== 角色類 ==========
// 同步角色識別值（邏輯判斷用）
export const SYNC_ROLE_CONFIG = {
  VIEWER: "viewer",
  OPERATOR: "operator",
  LOCAL: "local",
};

// 角色顯示文字
export const SYNC_ROLE_TEXTS = {
  viewer: "檢視者",
  operator: "操作者",
  local: "本機",
};

// 模式顯示文字（依角色顯示）— 用於加入工作階段確認對話框
export const SYNC_MODE_TEXTS = {
  viewer: SYNC_ROLE_TEXTS.viewer,
  operator: SYNC_ROLE_TEXTS.operator,
};

// 讀取：角色顯示文字
export function getSyncRoleText(role) {
  return SYNC_ROLE_TEXTS[role] || role;
}

// 擴充：新增角色文字（key 已存在時回傳 false）
export function addSyncRoleText(key, text) {
  if (Object.prototype.hasOwnProperty.call(SYNC_ROLE_TEXTS, key)) {
    return false;
  }
  SYNC_ROLE_TEXTS[key] = text;
  return true;
}

// ========== 狀態類 ==========
// 同步狀態識別值（邏輯判斷用）
export const SYNC_STATUS_CONFIG = {
  IDLE: "idle",
  OFFLINE: "offline",
  VIEWER: "viewer",
  OPERATOR: "operator",
};

// 狀態顯示文字
export const SYNC_STATUS_TEXTS = {
  idle: "未同步",
  viewer: "檢視中",
  operator: "同步中",
  offline: "已離線",
};

// 讀取：狀態顯示文字
export function getSyncStatusText(status) {
  return SYNC_STATUS_TEXTS[status] || status;
}

// 擴充：新增狀態文字（key 已存在時回傳 false）
export function addSyncStatusText(key, text) {
  if (Object.prototype.hasOwnProperty.call(SYNC_STATUS_TEXTS, key)) {
    return false;
  }
  SYNC_STATUS_TEXTS[key] = text;
  return true;
}

// ========== 頁面類 ==========
// 頁面識別值（路由/切頁判斷用）
export const SYNC_PAGE_CONFIG = {
  PANEL: "panel",
  BOARD: "board",
  ARCHIVE: "archive",
};

// 頁面顯示資訊（名稱 + 路徑）
export const SYNC_PAGE_LIST = {
  panel: {
    name: "機台面板",
    path: "index.html",
  },
  board: {
    name: "實驗管理",
    path: "board.html",
  },
  archive: {
    name: "檔案管理",
    path: "archive.html",
  },
};

// 讀取：頁面名稱
export function getSyncPageName(pageKey) {
  return SYNC_PAGE_LIST[pageKey]?.name || pageKey;
}

// 讀取：頁面路徑
export function getSyncPagePath(pageKey) {
  return SYNC_PAGE_LIST[pageKey]?.path || pageKey;
}

// 擴充：新增頁面資訊（key 已存在時回傳 false）
export function addSyncPage(key, name, path) {
  if (Object.prototype.hasOwnProperty.call(SYNC_PAGE_LIST, key)) {
    return false;
  }
  SYNC_PAGE_LIST[key] = { name, path };
  return true;
}

// 同步模組聚合常數
export const SYNC_MANAGER_CONSTANTS = {
  PUBLIC_CHANNEL_PREFIX: "__CH_",
  DEFAULT_ROLE_CONFIG: SYNC_ROLE_CONFIG,
  DEFAULT_PAGE_CONFIG: SYNC_PAGE_CONFIG,
  DEFAULT_STATUS_CONFIG: SYNC_STATUS_CONFIG,
};

// 同步工作階段儲存鍵
export const SYNC_SESSION_STORAGE_KEYS = {
  SESSION_ID: "sync_sessionId",
  CLIENT_ID: "sync_clientId",
  ROLE: "sync_role",
};

// 同步客戶端常數
export const SYNC_CLIENT_CONSTANTS = {
  STORAGE_PREFIX: "panel_sync_",
  DEFAULT_HEALTH_CHECK_INTERVAL_MS: 30000,
  DEFAULT_HEALTH_CHECK_CACHE_TTL_MS: 3000,
  DEFAULT_SERVER_HEALTH_TIMEOUT_MS: 2000,
  SESSION_NOT_FOUND_REASON: "session_not_found",
  JOIN_RESPONSE_SOURCE: "join_response",
  EVENT_NAMES: {
    AUTHENTICATED: "authenticated",
    RECONNECTED: "reconnected",
    DISCONNECTED: "disconnected",
    SERVER_ERROR: "server_error",
  },
};
