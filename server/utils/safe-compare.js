/**
 * safe-compare - 常數時間字串比對
 *
 * 用於比對機密值（admin token、建立代碼等），避免以 `===`/`!==` 逐字元比對
 * 而洩漏「前幾個字元是否正確」的時序側信道。
 */
import crypto from "crypto";

/**
 * 常數時間比對兩個字串是否相等。
 * 任一參數非字串、或長度不同時回傳 false（長度差異本身不敏感）。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
