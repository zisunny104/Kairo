/**
 * recordViewList - 實驗日誌列表渲染 mixin
 *
 * 負責列表顯示、選取狀態與批次按鈕控制。
 * 作為 mixin 混入 RecordView。
 */

export const recordViewList = {
  /**
   * 顯示實驗記錄列表
   * @param {Array} experiments
   */
  displayRecordList(records) {
    this.currentRecords = records;
    this._allRecords = records;
    this.selectedRecords.clear();

    this._ensureRecordFilterBindings();
    this._updateRecordFilterBounds(records);

    const container = document.getElementById("recordEntriesContainer");
    if (!container) return;

    if (records.length === 0) {
      container.innerHTML = `
        <div class="no-records">
          <div class="no-records-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
              <polyline points="14,2 14,8 20,8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
              <polyline points="10,9 9,9 8,9"></polyline>
            </svg>
          </div>
          <div class="no-records-text">目前沒有任何實驗日誌</div>
          <div class="no-records-hint">請確保已啟動伺服器並有進行過實驗</div>
        </div>`;
      return;
    }

    const filteredRecords = this._applyRecordFilters(records);

    if (filteredRecords.length === 0) {
      container.innerHTML = `
        <div class="record-filter-summary">
          <span>沒有符合篩選條件的日誌</span>
          <button class="btn-secondary" data-action="reset-filter">清除篩選</button>
        </div>`;
      return;
    }

    const filterSummary = this._isRecordFilterActive()
      ? `<div class="record-filter-summary">
           <span>${this._buildRecordFilterSummaryText(filteredRecords.length, records.length)}</span>
           <div class="record-filter-summary-actions">
             <button class="btn-secondary" data-action="select-filtered">全選篩選內容</button>
             <button class="btn-secondary" data-action="reset-filter">清除篩選</button>
           </div>
         </div>`
      : "";

    container.innerHTML = filterSummary + `
      <div class="records-list" role="list">
        ${filteredRecords.map((record) => this._renderRecordItem(record)).join("")}
      </div>`;

    this.updateBatchActionButtons();
  },

  /**
   * 產生單一實驗記錄項目的 HTML
   * @param {Object} exp - 實驗物件（含 filename、experimentId、logCount 等）
   * @returns {string} HTML 字串
   */
  _renderRecordItem(record) {
    const filename = record.filename ||
      `${record.experimentId}_${record.participantName}_experiment_record.jsonl`;
    const recordDate = record.startTime ? this.timeSyncManager?.formatDate(record.startTime) : "";
    const safeFilename = this.escapeHtml(filename);
    const safeRecordFile = this.escapeHtml(record.filename || "");
    const safeExpId = this.escapeHtml(record.actualExperimentId || record.experimentId || "");

    return `
      <div class="record-item" data-record-id="${safeExpId}">
        <div class="record-checkbox">
          <input type="checkbox" id="record-${safeRecordFile}" data-record-id="${safeRecordFile}">
          <label for="record-${safeRecordFile}"></label>
        </div>
        <div class="record-details" data-action="view-record" data-record-id="${safeRecordFile}">
          <div class="record-filename">${safeFilename}</div>
          <div class="record-meta">
            <span class="record-size">${record.logCount} 條記錄</span>
            ${recordDate ? `<span class="record-date">${recordDate}</span>` : ""}
          </div>
        </div>
        <div class="file-card-actions">
          <button class="file-card-btn" data-action="download-record" data-record-id="${safeRecordFile}" title="下載">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2"></path>
              <polyline points="8 12 12 16 16 12"></polyline>
              <line x1="12" y1="3" x2="12" y2="16"></line>
            </svg>
          </button>
          <button class="file-card-btn file-card-btn--danger" data-action="delete-record" data-record-id="${safeRecordFile}" title="刪除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
              <path d="M10 11v6M14 11v6"></path>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
            </svg>
          </button>
        </div>
      </div>`;
  },

  /**
   * 切換指定記錄的選取狀態
   * @param {string} recordId - 記錄 filename
   */
  toggleRecordSelection(recordId) {
    if (this.selectedRecords.has(recordId)) this.selectedRecords.delete(recordId);
    else this.selectedRecords.add(recordId);
    this.updateBatchActionButtons();
  },

  /** 根據目前選取數量更新批次刪除與下載按鈕的顯示狀態 */
  updateBatchActionButtons() {
    const count = this.selectedRecords.size;
    const deleteBtn = document.getElementById("deleteSelectedRecordsBtn");
    const downloadBtn = document.getElementById("downloadSelectedRecordsBtn");
    const batchCount = document.getElementById("recordsBatchCount");
    if (deleteBtn) {
      deleteBtn.classList.toggle("is-hidden", count === 0);
      deleteBtn.title = count > 0 ? `刪除選取項目 (${count})` : "刪除選取項目";
      deleteBtn.setAttribute("aria-label", deleteBtn.title);
    }
    if (downloadBtn) downloadBtn.classList.toggle("is-hidden", count === 0);
    if (batchCount) {
      batchCount.classList.toggle("is-hidden", count === 0);
      batchCount.textContent = `${count} 項已選`;
    }
  },
};
