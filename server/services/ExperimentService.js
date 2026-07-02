/**
 * ExperimentService.js
 * 實驗 ID 管理服務
 *
 * 功能：
 * 1. 建立實驗 ID（驗證 createCode）
 * 2. 查詢實驗 ID（基於 experimentId 或 sessionId）
 * 3. 刪除實驗 ID
 */

import { getDatabase } from "../database/connection.js";
import { getValidCreateCode } from "../config/server.js";
import { generateExperimentId } from "../utils/idGenerator.js";
import { Logger } from "../utils/logger.js";
import { safeEqual } from "../utils/safe-compare.js";

export class ExperimentService {
  /**
   * 建立實驗 ID
   * @param {string} createCode - 建立代碼（需驗證）
   * @param {string} sessionId - 工作階段 ID（可選）
   * @param {string} clientId - 客戶端 ID
   * @param {object} data - 實驗相關資料（JSON）
   * @returns {object} { success, experimentId, message }
   */
  static createExperimentId(createCode, sessionId = null, clientId, data = {}) {
    const db = getDatabase();

    // 1. 驗證 createCode
    const validCreateCode = getValidCreateCode();
    if (!validCreateCode || !safeEqual(createCode, validCreateCode)) {
      return {
        success: false,
        message: "建立代碼無效",
      };
    }

    // 2. 產生唯一的實驗 ID
    let experimentId;
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      experimentId = generateExperimentId();

      // 檢查是否已存在
      const existing = db
        .prepare("SELECT id FROM experiment_ids WHERE experiment_id = ?")
        .get(experimentId);

      if (!existing) break;
      attempts++;
    }

    if (attempts >= maxAttempts) {
      return {
        success: false,
        message: "無法產生唯一的實驗 ID，請重試",
      };
    }

    // 3. 準備資料
    const id = `EXP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const createdAt = Math.floor(Date.now() / 1000);

    const experimentData = {
      clientId,
      createdAt,
      ...data,
    };

    // 4. 儲存至資料庫
    try {
      db.prepare(
        `
        INSERT INTO experiment_ids (id, experiment_id, session_id, created_at, data)
        VALUES (?, ?, ?, ?, ?)
      `,
      ).run(
        id,
        experimentId,
        sessionId,
        createdAt,
        JSON.stringify(experimentData),
      );

      return {
        success: true,
        experimentId,
        id,
        createdAt,
        message: "實驗 ID 建立成功",
      };
    } catch (error) {
      Logger.error("[ExperimentService] 建立實驗 ID 失敗:", error.message);
      return {
        success: false,
        message: "資料庫錯誤：" + error.message,
      };
    }
  }

  /**
   * 查詢實驗 ID（基於 experimentId）
   * @param {string} experimentId - 實驗 ID
   * @returns {object|null} 實驗記錄或 null
   */
  static getExperimentById(experimentId) {
    const db = getDatabase();

    try {
      const row = db
        .prepare(
          `
        SELECT id, experiment_id, session_id, created_at, data
        FROM experiment_ids
        WHERE experiment_id = ?
      `,
        )
        .get(experimentId);

      if (!row) return null;

      return {
        id: row.id,
        experimentId: row.experiment_id,
        sessionId: row.session_id,
        createdAt: row.created_at,
        data: JSON.parse(row.data),
      };
    } catch (error) {
      Logger.error("[ExperimentService] 查詢實驗 ID 失敗:", error.message);
      return null;
    }
  }

  /**
   * 查詢工作階段的所有實驗
   * @param {string} sessionId - 工作階段 ID
   * @returns {Array} 實驗列表
   */
  static getExperimentsBySession(sessionId) {
    const db = getDatabase();

    try {
      const rows = db
        .prepare(
          `
        SELECT id, experiment_id, session_id, created_at, data
        FROM experiment_ids
        WHERE session_id = ?
        ORDER BY created_at DESC
      `,
        )
        .all(sessionId);

      return rows.map((row) => ({
        id: row.id,
        experimentId: row.experiment_id,
        sessionId: row.session_id,
        createdAt: row.created_at,
        data: JSON.parse(row.data),
      }));
    } catch (error) {
      Logger.error("[ExperimentService] 查詢工作階段實驗失敗:", error.message);
      return [];
    }
  }

  /**
   * 刪除實驗 ID
   * @param {string} experimentId - 實驗 ID
   * @returns {object} { success, message }
   */
  static deleteExperimentId(experimentId) {
    const db = getDatabase();

    try {
      const result = db
        .prepare("DELETE FROM experiment_ids WHERE experiment_id = ?")
        .run(experimentId);

      if (result.changes === 0) {
        return {
          success: false,
          message: "實驗 ID 不存在",
        };
      }

      return {
        success: true,
        message: "實驗 ID 已刪除",
      };
    } catch (error) {
      Logger.error("[ExperimentService] 刪除實驗 ID 失敗:", error.message);
      return {
        success: false,
        message: "資料庫錯誤：" + error.message,
      };
    }
  }

  /**
   * 驗證實驗 ID 是否存在
   * @param {string} experimentId - 實驗 ID
   * @returns {boolean}
   */
  static validateExperimentId(experimentId) {
    const db = getDatabase();

    try {
      const row = db
        .prepare("SELECT id FROM experiment_ids WHERE experiment_id = ?")
        .get(experimentId);

      return row !== undefined;
    } catch (error) {
      Logger.error("[ExperimentService] 驗證實驗 ID 失敗:", error.message);
      return false;
    }
  }

  /**
   * 更新實驗資料
   * @param {string} experimentId - 實驗 ID
   * @param {object} newData - 新的實驗資料（會合併到現有資料）
   * @returns {object} { success, message }
   */
  static updateExperimentData(experimentId, newData) {
    const db = getDatabase();

    try {
      // 1. 取得現有資料
      const existing = this.getExperimentById(experimentId);
      if (!existing) {
        return {
          success: false,
          message: "實驗 ID 不存在",
        };
      }

      // 2. 合併資料
      const updatedData = {
        ...existing.data,
        ...newData,
        updatedAt: Math.floor(Date.now() / 1000),
      };

      // 3. 更新資料庫
      db.prepare(
        `
        UPDATE experiment_ids
        SET data = ?
        WHERE experiment_id = ?
      `,
      ).run(JSON.stringify(updatedData), experimentId);

      return {
        success: true,
        message: "實驗資料已更新",
        data: updatedData,
      };
    } catch (error) {
      Logger.error("[ExperimentService] 更新實驗資料失敗:", error.message);
      return {
        success: false,
        message: "資料庫錯誤：" + error.message,
      };
    }
  }

  /**
   * 列出所有實驗（支援分頁）
   * @param {number} page - 頁碼（從 1 開始）
   * @param {number} pageSize - 每頁數量
   * @returns {object} { experiments, total, page, pageSize, totalPages }
   */
  static listExperiments(page = 1, pageSize = 20) {
    const db = getDatabase();

    try {
      // 1. 計算總數
      const { total } = db
        .prepare("SELECT COUNT(*) as total FROM experiment_ids")
        .get();

      // 2. 查詢分頁資料
      const offset = (page - 1) * pageSize;
      const rows = db
        .prepare(
          `
        SELECT id, experiment_id, session_id, created_at, data
        FROM experiment_ids
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `,
        )
        .all(pageSize, offset);

      const experiments = rows.map((row) => ({
        id: row.id,
        experimentId: row.experiment_id,
        sessionId: row.session_id,
        createdAt: row.created_at,
        data: JSON.parse(row.data),
      }));

      return {
        experiments,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
    } catch (error) {
      Logger.error("[ExperimentService] 列出實驗失敗:", error.message);
      return {
        experiments: [],
        total: 0,
        page,
        pageSize,
        totalPages: 0,
      };
    }
  }
}
