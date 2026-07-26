/**
 * archive-roster.js — 受試者名單（participants.json）共用讀取
 * 姓名只存在名單這一份，其他地方一律用 trackingId 關聯查詢，不複製存放，
 * 避免「輔助標記／名單比對／最終分析」三個分頁各自重複打 API、各自維護一份姓名對照表。
 */
import { getApiUrl } from "../core/url-utils.js";
import { getAdminToken, clearAdminToken } from "../core/admin-auth.js";
import { API_ENDPOINTS } from "../constants/index.js";

let _participantsPromise = null;

async function authedFetch(url, opts = {}) {
  const first = await fetch(url, opts);
  if (first.status === 401) {
    const token = await getAdminToken();
    if (!token) return first;
    const headers = { ...(opts.headers || {}), "X-Admin-Token": token };
    return fetch(url, { ...opts, headers });
  }
  if (first.status === 403) clearAdminToken();
  return first;
}

// 頁面存活期間只抓一次名單並快取；比對/儲存後名單本身不會變，不需要每個分頁各自重抓
export function getParticipants() {
  if (!_participantsPromise) {
    _participantsPromise = authedFetch(`${getApiUrl()}${API_ENDPOINTS.ROSTER.PARTICIPANTS}`)
      .then(res => res.json())
      .then(data => (data.success ? data.participants || [] : []))
      .catch(() => []);
  }
  return _participantsPromise;
}

export async function getParticipantNameMap() {
  const participants = await getParticipants();
  return new Map(participants.map(p => [p.trackingId, p.name || ""]));
}

// 性別／國籍只給「最終分析」分頁用（篩選、匯出），姓名仍照舊各自用 getParticipantNameMap 查
export async function getParticipantInfoMap() {
  const participants = await getParticipants();
  return new Map(participants.map(p => [p.trackingId, { gender: p.gender || "", nationality: p.nationality || "" }]));
}
