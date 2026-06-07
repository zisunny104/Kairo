/**
 * admin-auth - 管理員 Token 取得與快取
 *
 * 透過 CREATE_CODE 向伺服器換取一次性 admin token，
 * 並以 sessionStorage 暫存，避免重複輸入。
 */

import { getApiUrl } from "./url-utils.js";
import { API_ENDPOINTS } from "../constants/index.js";

const SESSION_KEY = "adminToken";

export async function getAdminToken() {
  const cached = sessionStorage.getItem(SESSION_KEY);
  if (cached) return cached;

  const createCode = prompt("請輸入建立代碼以取得管理員權限：");
  if (!createCode) return null;

  try {
    const res = await fetch(`${getApiUrl()}${API_ENDPOINTS.SYNC.ADMIN_TOKEN}`, {
      headers: { "X-Create-Code": createCode },
    });
    const data = await res.json();
    if (!data.token) {
      alert("建立代碼錯誤，無法取得管理員權限。");
      return null;
    }
    sessionStorage.setItem(SESSION_KEY, data.token);
    return data.token;
  } catch {
    alert("無法連接伺服器取得管理員權限。");
    return null;
  }
}

export function clearAdminToken() {
  sessionStorage.removeItem(SESSION_KEY);
}

export function makeAdminHeaders(token, extra = {}) {
  const headers = { "Content-Type": "application/json", ...extra };
  if (token) headers["X-Admin-Token"] = token;
  return headers;
}
