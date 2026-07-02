/**
 * archive-editor.js — 時間戳、類型、標記欄編輯彈出框
 */

import { ICON, ATTEMPT_ICON, ATTEMPT_COLOR, TYPE_COLORS, escapeHtml } from "./archive-constants.js";
import { RECORD_TYPE_LABELS, GESTURE_ATTEMPT_TYPE_LABELS } from "../constants/index.js";

export const archiveEditorMethods = {

  // ── 事件綁定 ──────────────────────────────────────────────────────────────

  _bindViewerEvents(viewer) {
    viewer.querySelectorAll("[data-mode]").forEach(btn =>
      btn.addEventListener("click", () => this._setViewMode(btn.dataset.mode))
    );
    viewer.querySelectorAll("[data-action='show-history']").forEach(el =>
      el.addEventListener("click", e => { e.stopPropagation(); this._showHistoryPopup(e.currentTarget); })
    );
    viewer.addEventListener("click", e => {
      if (!e.target.closest("#history-popup") && !e.target.closest("[data-action='show-history']"))
        document.getElementById("history-popup")?.remove();
    });
    // 篩選列的還原/重設/展開按鈕
    viewer.querySelectorAll("[data-action='undo']").forEach(el =>
      el.addEventListener("click", () => this._handleUndo()));
    viewer.querySelectorAll("[data-action='revert']").forEach(el =>
      el.addEventListener("click", () => this._handleRevert()));
    viewer.querySelector("[data-action='upload']")?.addEventListener("click", () => this._uploadToServer(this._file));
    viewer.querySelector("[data-action='save-file']")?.addEventListener("click", () => this._saveWithSuffix(this._file));
    viewer.querySelectorAll("[data-action='toggle-expand']").forEach(el => el.addEventListener("click", () => {
      const allKeys = [...viewer.querySelectorAll(".archive-step-card[data-step-key]")].map(c => c.dataset.stepKey);
      const allOpen = allKeys.every(k => this._expandedSteps.has(k));
      this._expandAll(viewer, !allOpen);
      const btn = viewer.querySelector("[data-action='toggle-expand']");
      if (btn) btn.innerHTML = allOpen
        ? `${ICON.chevronDown} 展開全部`
        : `${ICON.chevronRight} 收折全部`;
    }));

    // 類型篩選
    viewer.querySelector("#entryTypeFilter")?.addEventListener("change", e => {
      this._entryFilter = e.target.value;
      this._renderAll();
    });

    // 摘要互動
    this._bindSummaryEvents(viewer, this._file);

    // 步驟收折
    viewer.querySelectorAll(".archive-step-header[data-step-key]").forEach(hdr =>
      hdr.addEventListener("click", e => {
        this._toggleStep(hdr.dataset.stepKey);
      })
    );

    // 時間戳彈出框
    viewer.addEventListener("click", e => {
      const el = e.target.closest(".ts-editable");
      if (el) {
        e.stopPropagation();
        el.classList.contains("ts-editing") ? this._closeTsPopup() : this._handleTsEdit(el);
        return;
      }
      if (!e.target.closest("#ts-popup")) this._closeTsPopup();
    });

    // 類型 badge 彈出框
    viewer.addEventListener("click", e => {
      const el = e.target.closest("[data-type-edit]");
      if (el) { e.stopPropagation(); this._handleTypeEdit(el); return; }
      if (!e.target.closest("#type-popup")) this._closeTypePopup();
    });

    // 標記欄彈出框（三選一）
    viewer.addEventListener("click", e => {
      const el = e.target.closest("[data-mark-edit]");
      if (el) { e.stopPropagation(); this._handleMarkEdit(el); return; }
      if (!e.target.closest("#mark-popup")) this._closeMarkPopup();
    });
  },

  // ── 摘要互動 ──────────────────────────────────────────────────────────────

  _bindSummaryEvents(viewer, fileState) {
    viewer.querySelectorAll(".archive-stat--copyable").forEach(el => {
      const btn = el.querySelector(".archive-icon-action");
      btn?.addEventListener("click", e => {
        e.stopPropagation();
        navigator.clipboard?.writeText(el.dataset.copy).then(() => {
          btn.style.color = "#27ae60";
          setTimeout(() => (btn.style.color = ""), 1500);
        });
      });
    });

    viewer.querySelectorAll(".archive-stat--editable").forEach(el => {
      const editBtn = el.querySelector(".archive-icon-action");
      const valSpan = el.querySelector(".archive-stat-value");
      if (!editBtn) return;

      editBtn.addEventListener("click", e => {
        e.stopPropagation();
        const idx   = parseInt(el.dataset.editIndex, 10);
        const field = el.dataset.editField;
        const relevantIndices = fileState.entries.reduce((acc, entry, i) => {
          if ((entry.type === "exp_start" || entry.type === "exp_end") && i >= idx) acc.push(i);
          return acc;
        }, []);
        const currentVal = fileState.entries[idx]?.[field] || "";
        const input = document.createElement("input");
        input.className = "archive-stat-input";
        input.value = currentVal;
        valSpan.innerHTML = "";
        valSpan.appendChild(input);
        input.focus(); input.select();

        let committed = false;
        const commit = () => {
          if (committed) return;
          committed = true;
          const newVal = input.value.trim();
          if (newVal !== currentVal) {
            fileState.applyBatchEdit(
              relevantIndices.map(i => ({ index: i, field, value: newVal })),
              `修改${field}: ${currentVal} → ${newVal}`
            );
          }
          this._renderAll();
        };

        input.addEventListener("blur", commit);
        input.addEventListener("keydown", e => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          if (e.key === "Escape") { committed = true; this._renderAll(); }
        });
      });
    });
  },

  _handleUndo() {
    if (!this._file?.undo()) return;
    this._renderAll();
  },

  _handleRevert() {
    if (!this._file) return;
    if (!confirm("確定要還原至原始狀態嗎？所有編輯將遺失。")) return;
    this._file.revert();
    this._renderAll();
  },

  // ── 時間戳彈出框 ──────────────────────────────────────────────────────────

  _handleTsEdit(el) {
    this._closeTsPopup();
    const idx       = parseInt(el.dataset.tsEdit);
    const currentTs = parseInt(el.dataset.ts);
    if (isNaN(idx) || isNaN(currentTs) || !this._file) return;

    const originalTs = this._file._original[idx]?.ts ?? currentTs;
    const expStart   = this._file.entries.find(e => e.type === "exp_start");
    const expStartTs = expStart?.ts ?? null;
    const fmtRel = ts => (!ts || !expStartTs) ? "T+??" : `T+${this._tsm.formatStopwatch(ts - expStartTs)}`;

    el.classList.add("ts-editing");

    const popup = document.createElement("div");
    popup.id        = "ts-popup";
    popup.className = "archive-ts-popup";
    popup.innerHTML = `
      <div class="ts-popup-head">
        調整時間戳 <span class="ts-popup-key">ts</span>
      </div>
      <div class="ts-popup-adj-row">
        <button class="ts-adj-btn" data-delta="-1000">−1 秒</button>
        <button class="ts-adj-btn" data-delta="-100">−0.1 秒</button>
        <button class="ts-adj-btn" data-delta="100">+0.1 秒</button>
        <button class="ts-adj-btn" data-delta="1000">+1 秒</button>
      </div>
      <div class="ts-popup-input-row">
        <label class="ts-input-label">毫秒值</label>
        <input type="number" class="ts-ms-input" value="${currentTs}" step="100">
      </div>
      <div class="ts-popup-preview">相對時間：<span class="ts-rel-preview">${fmtRel(currentTs)}</span></div>
      <div class="ts-popup-actions">
        <button class="ts-action-btn ts-revert-btn">還原</button>
        <button class="ts-action-btn ts-cancel-btn">取消</button>
        <button class="ts-action-btn ts-save-btn">儲存</button>
      </div>`;

    const rect = el.getBoundingClientRect();
    popup.style.top  = `${rect.bottom + 6}px`;
    popup.style.left = `${rect.left}px`;
    document.body.appendChild(popup);

    const input   = popup.querySelector(".ts-ms-input");
    const preview = popup.querySelector(".ts-rel-preview");

    const updatePreview = () => {
      const v = parseInt(input.value);
      preview.textContent = isNaN(v) ? "T+??" : fmtRel(v);
    };

    input.addEventListener("input", updatePreview);
    input.focus(); input.select();

    popup.querySelectorAll(".ts-adj-btn").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        input.value = (parseInt(input.value) || currentTs) + parseInt(btn.dataset.delta);
        updatePreview();
      })
    );

    popup.querySelector(".ts-revert-btn").addEventListener("click", e => {
      e.stopPropagation();
      input.value = originalTs;
      updatePreview();
    });

    popup.querySelector(".ts-cancel-btn").addEventListener("click", e => {
      e.stopPropagation();
      this._closeTsPopup();
    });

    popup.querySelector(".ts-save-btn").addEventListener("click", e => {
      e.stopPropagation();
      const newTs = parseInt(input.value);
      if (!isNaN(newTs) && newTs !== currentTs)
        this._file.applyEdit(idx, "ts", newTs, `時間調整: ${currentTs}→${newTs}`);
      this._closeTsPopup();
      this._renderAll();
    });

    document.addEventListener("keydown", this._tsPopupKeyHandler = ev => {
      if (ev.key === "Escape") this._closeTsPopup();
    }, { once: true });
  },

  _closeTsPopup() {
    document.getElementById("ts-popup")?.remove();
    document.querySelectorAll(".ts-editing").forEach(el => el.classList.remove("ts-editing"));
    if (this._tsPopupKeyHandler) {
      document.removeEventListener("keydown", this._tsPopupKeyHandler);
      this._tsPopupKeyHandler = null;
    }
  },

  // ── 類型 badge 彈出框 ─────────────────────────────────────────────────────

  _handleTypeEdit(el) {
    this._closeTypePopup();
    const idx = parseInt(el.dataset.typeEdit);
    if (isNaN(idx) || !this._file) return;

    const entry      = this._file.entries[idx];
    const currentType = entry?.type || "";

    const options = Object.entries(RECORD_TYPE_LABELS)
      .map(([v, l]) => `<option value="${v}"${v === currentType ? " selected" : ""}>${l}</option>`)
      .join("");

    const popup = document.createElement("div");
    popup.id        = "type-popup";
    popup.className = "archive-ts-popup";
    popup.innerHTML = `
      <div class="ts-popup-head">修改類型 <span class="ts-popup-key">type</span></div>
      <div class="ts-popup-input-row">
        <select class="ts-ms-input" id="type-select" style="padding:6px 10px">${options}</select>
      </div>
      <div class="ts-popup-actions">
        <button class="ts-action-btn type-delete-btn" style="background:#f44336;color:white">刪除此記錄</button>
        <button class="ts-action-btn ts-cancel-btn">取消</button>
        <button class="ts-action-btn ts-save-btn">儲存</button>
      </div>`;

    const rect = el.getBoundingClientRect();
    popup.style.top  = `${rect.bottom + 6}px`;
    popup.style.left = `${rect.left}px`;
    document.body.appendChild(popup);

    popup.querySelector(".type-delete-btn").addEventListener("click", e => {
      e.stopPropagation();
      if (!confirm("確定刪除此記錄？")) return;
      this._file.removeEntry(idx);
      this._closeTypePopup();
      this._renderAll();
    });
    popup.querySelector(".ts-cancel-btn").addEventListener("click", e => {
      e.stopPropagation(); this._closeTypePopup();
    });
    popup.querySelector(".ts-save-btn").addEventListener("click", e => {
      e.stopPropagation();
      const newType = popup.querySelector("#type-select").value;
      if (newType !== currentType)
        this._file.applyEdit(idx, "type", newType, `類型: ${currentType}→${newType}`);
      this._closeTypePopup();
      this._renderAll();
    });

    document.addEventListener("keydown", this._typePopupKeyHandler = ev => {
      if (ev.key === "Escape") this._closeTypePopup();
    }, { once: true });
  },

  _closeTypePopup() {
    document.getElementById("type-popup")?.remove();
    if (this._typePopupKeyHandler) {
      document.removeEventListener("keydown", this._typePopupKeyHandler);
      this._typePopupKeyHandler = null;
    }
  },

  // ── 標記欄彈出框（三選一）────────────────────────────────────────────────

  _handleMarkEdit(el) {
    this._closeMarkPopup();
    const idx      = parseInt(el.dataset.markEdit);
    const currentG = el.dataset.markVal || "";
    if (isNaN(idx) || !this._file) return;

    const popup = document.createElement("div");
    popup.id        = "mark-popup";
    popup.className = "archive-mark-popup";

    const MARKS = [
      { g: "t", label: "成功" },
      { g: "n", label: "未判斷" },
      { g: "f", label: "失敗" },
    ];
    popup.innerHTML = MARKS.map(m =>
      `<button class="mark-choice-btn${m.g === currentG ? " is-current" : ""}"
         style="background:${ATTEMPT_COLOR[m.g]}"
         data-g="${m.g}" title="${m.label}">
        ${ATTEMPT_ICON[m.g]}
      </button>`
    ).join("");

    const rect = el.getBoundingClientRect();
    popup.style.top  = `${rect.bottom + 6}px`;
    popup.style.left = `${rect.left}px`;
    document.body.appendChild(popup);

    popup.querySelectorAll(".mark-choice-btn").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const newG = btn.dataset.g;
        if (newG !== currentG)
          this._file.applyEdit(idx, "g_type", newG, `標記: ${currentG}→${newG}`);
        this._closeMarkPopup();
        this._renderAll();
      })
    );

    document.addEventListener("keydown", ev => {
      if (ev.key === "Escape") this._closeMarkPopup();
    }, { once: true });
  },

  _closeMarkPopup() { document.getElementById("mark-popup")?.remove(); },

  // ── 編輯記錄彈出框 ────────────────────────────────────────────────────────

  _showHistoryPopup(anchor) {
    document.getElementById("history-popup")?.remove();
    if (!this._file) return;

    const history = this._file.history;
    if (history.length === 0) return;

    const fmtTime = ts => {
      const d = new Date(ts);
      return `${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}:${d.getSeconds().toString().padStart(2,"0")}`;
    };

    const rows = [...history].reverse().map((op, ri) => {
      const histIdx = history.length - 1 - ri;
      const i       = history.length - ri;
      const lbl     = op.label || (op.op === "remove" ? `刪除: ${op.removed?.type}` : `編輯 #${op.index}`);
      const time    = fmtTime(op.ts);
      const isCurrent = ri === 0;
      return `<div class="history-item">
        <span class="history-item-num">${i}</span>
        <span class="history-item-label">${escapeHtml(lbl)}</span>
        <span class="history-item-time">${time}</span>
        <span class="history-item-actions">
          <button class="history-revoke-btn" data-hist-idx="${histIdx}" title="只撤銷這一筆，保留其他">撤銷此步</button>
          ${!isCurrent ? `<button class="history-undo-btn" data-undo-steps="${ri}" title="撤銷此步之後所有操作">還原至此</button>` : ""}
        </span>
      </div>`;
    }).join("");

    const popup = document.createElement("div");
    popup.id        = "history-popup";
    popup.className = "archive-history-popup";
    popup.innerHTML = `
      <div class="ts-popup-head">
        編輯記錄 <span class="ts-popup-key">${history.length} 筆</span>
      </div>
      <div class="history-list">${rows}</div>
      <div class="ts-popup-actions">
        <button class="ts-action-btn ts-cancel-btn" id="history-close-btn">關閉</button>
      </div>`;

    const rect = anchor.getBoundingClientRect();
    popup.style.top  = `${rect.bottom + 6}px`;
    popup.style.left = `${Math.max(0, rect.left)}px`;
    document.body.appendChild(popup);

    // 撤銷此步（單獨撤銷，保留其他）
    popup.querySelectorAll(".history-revoke-btn").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        this._file.undoAt(parseInt(btn.dataset.histIdx));
        popup.remove();
        this._renderAll();
      })
    );
    // 還原至此（撤銷此步之後所有操作）
    popup.querySelectorAll(".history-undo-btn").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const steps = parseInt(btn.dataset.undoSteps);
        for (let i = 0; i < steps; i++) this._file.undo();
        popup.remove();
        this._renderAll();
      })
    );
    popup.querySelector("#history-close-btn").addEventListener("click", e => {
      e.stopPropagation();
      popup.remove();
    });

    document.addEventListener("keydown", ev => {
      if (ev.key === "Escape") document.getElementById("history-popup")?.remove();
    }, { once: true });
  },

};
