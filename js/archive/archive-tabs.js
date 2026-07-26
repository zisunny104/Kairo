/**
 * archive-tabs.js — 頂層 Tab 切換（日誌檢視 / 簡易標記）
 */

import { onQuickRemarkActivate } from "./archive-quick-remark.js";
import { onAssistMarkActivate } from "./archive-assist-mark.js";
import { onMatchMarkActivate } from "./archive-match-mark.js";
import { onFinalAnalysisActivate } from "./archive-final-analysis.js";
import { onQuestionnaireActivate } from "./archive-questionnaire.js";

(function () {
  var sidebarAutoCollapsed = false;
  var LAST_TAB_KEY = "archive_active_tab";
  var VALID_TABS = ["viewer", "quick-remark", "assist-mark", "match-mark", "final-analysis", "questionnaire"];
  // 日誌檢視／輔助標記暫時隱藏（同簡易標記），還原後把對應 tab 從這裡移除即可
  var HIDDEN_TABS = ["viewer", "quick-remark", "assist-mark"];
  var DEFAULT_TAB = "match-mark";

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

  function activateTab(target, opts) {
    opts = opts || {};
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
    var qnrEl    = document.getElementById("archiveQuestionnaire");
    if (viewerEl) viewerEl.classList.toggle("is-hidden", target !== "viewer");
    if (remarkEl) remarkEl.classList.toggle("is-hidden", target !== "quick-remark");
    if (assistEl) assistEl.classList.toggle("is-hidden", target !== "assist-mark");
    if (matchEl)  matchEl.classList.toggle("is-hidden", target !== "match-mark");
    if (finalEl)  finalEl.classList.toggle("is-hidden", target !== "final-analysis");
    if (qnrEl)    qnrEl.classList.toggle("is-hidden", target !== "questionnaire");

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
    } else if (target === "questionnaire") {
      collapseSidebar();
      onQuestionnaireActivate();
    } else if (prev === "quick-remark" || prev === "assist-mark" || prev === "match-mark" || prev === "final-analysis" || prev === "questionnaire") {
      restoreSidebar();
    }

    try { localStorage.setItem(LAST_TAB_KEY, target); } catch { /* 不可用時忽略，僅影響記憶功能 */ }

    // 使用者主動點分頁才寫入瀏覽器歷史紀錄；popstate 觸發的還原（opts.silent）不能再往上疊，
    // 否則會產生無限增生的歷史紀錄，「上一頁」永遠回不到分頁清單之外的前一個頁面。
    if (!opts.silent && prev !== target) {
      try { history.pushState({ archiveTab: target }, "", location.href); } catch { /* 不可用時忽略，僅影響上一頁記憶功能 */ }
    }
  }

  document.querySelectorAll(".archive-panel-tab").forEach(function (tab) {
    tab.addEventListener("click", function () { activateTab(this.dataset.tab); });
  });

  // 重新整理頁面時回到上次離開的分頁，而不是每次都跳回「日誌檢視」
  var lastTab = null;
  try { lastTab = localStorage.getItem(LAST_TAB_KEY); } catch { /* 不可用時忽略 */ }
  if (!lastTab || HIDDEN_TABS.indexOf(lastTab) !== -1 || VALID_TABS.indexOf(lastTab) === -1) {
    lastTab = DEFAULT_TAB;
  }
  activateTab(lastTab, { silent: true });
  // 把目前這筆歷史紀錄標記上目前分頁，讓「上一頁」先在分頁之間走，走完才離開這個頁面
  try { history.replaceState({ archiveTab: lastTab }, "", location.href); } catch { /* 不可用時忽略 */ }

  window.addEventListener("popstate", function (e) {
    var tab = e.state && e.state.archiveTab;
    if (tab && HIDDEN_TABS.indexOf(tab) === -1 && VALID_TABS.indexOf(tab) !== -1) {
      activateTab(tab, { silent: true });
    }
  });
})();
