/**
 * archive-tabs.js — 頂層 Tab 切換（日誌檢視 / 簡易標記）
 */

import { onQuickRemarkActivate } from "./archive-quick-remark.js";
import { onAssistMarkActivate } from "./archive-assist-mark.js";
import { onMatchMarkActivate } from "./archive-match-mark.js";
import { onFinalAnalysisActivate } from "./archive-final-analysis.js";

(function () {
  var sidebarAutoCollapsed = false;
  var LAST_TAB_KEY = "archive_active_tab";
  var VALID_TABS = ["viewer", "quick-remark", "assist-mark", "match-mark", "final-analysis"];

  function getSidebar() { return document.getElementById("archiveLeftPanel"); }
  function getIcon()    { return document.getElementById("panelToggleIcon"); }

  function collapseSidebar() {
    var sb = getSidebar(), ic = getIcon();
    if (sb && !sb.classList.contains("collapsed")) {
      sb.classList.add("collapsed");
      if (ic) ic.textContent = "›";
      sidebarAutoCollapsed = true;
    }
  }

  function restoreSidebar() {
    var sb = getSidebar(), ic = getIcon();
    if (sidebarAutoCollapsed && sb && sb.classList.contains("collapsed")) {
      sb.classList.remove("collapsed");
      if (ic) ic.textContent = "‹";
    }
    sidebarAutoCollapsed = false;
  }

  function activateTab(target) {
    var prevEl = document.querySelector(".archive-panel-tab.is-active");
    var prev   = prevEl ? prevEl.dataset.tab : null;

    document.querySelectorAll(".archive-panel-tab").forEach(function (t) {
      t.classList.toggle("is-active", t.dataset.tab === target);
    });

    var viewerEl = document.getElementById("archiveViewer");
    var remarkEl = document.getElementById("archiveQuickRemark");
    var assistEl = document.getElementById("archiveAssistMark");
    var matchEl  = document.getElementById("archiveMatchMark");
    var finalEl  = document.getElementById("archiveFinalAnalysis");
    if (viewerEl) viewerEl.classList.toggle("is-hidden", target !== "viewer");
    if (remarkEl) remarkEl.classList.toggle("is-hidden", target !== "quick-remark");
    if (assistEl) assistEl.classList.toggle("is-hidden", target !== "assist-mark");
    if (matchEl)  matchEl.classList.toggle("is-hidden", target !== "match-mark");
    if (finalEl)  finalEl.classList.toggle("is-hidden", target !== "final-analysis");

    if (target === "quick-remark") {
      collapseSidebar();
      onQuickRemarkActivate();
    } else if (target === "assist-mark") {
      collapseSidebar();
      onAssistMarkActivate();
    } else if (target === "match-mark") {
      collapseSidebar();
      onMatchMarkActivate();
    } else if (target === "final-analysis") {
      collapseSidebar();
      onFinalAnalysisActivate();
    } else if (prev === "quick-remark" || prev === "assist-mark" || prev === "match-mark" || prev === "final-analysis") {
      restoreSidebar();
    }

    try { localStorage.setItem(LAST_TAB_KEY, target); } catch { /* 不可用時忽略，僅影響記憶功能 */ }
  }

  document.querySelectorAll(".archive-panel-tab").forEach(function (tab) {
    tab.addEventListener("click", function () { activateTab(this.dataset.tab); });
  });

  // 重新整理頁面時回到上次離開的分頁，而不是每次都跳回「日誌檢視」
  var lastTab = null;
  try { lastTab = localStorage.getItem(LAST_TAB_KEY); } catch { /* 不可用時忽略 */ }
  if (lastTab && lastTab !== "viewer" && VALID_TABS.indexOf(lastTab) !== -1) {
    activateTab(lastTab);
  }
})();
