/**
 * archive-quick-remark.js — 簡易標記模式
 * POS 機風格：大按鈕、不滾動、鍵盤快捷鍵
 * 日誌格式與 board 日誌相容（g_type / exp_id 等欄位一致）
 */

import { getApiUrl } from '../core/url-utils.js';
import { API_ENDPOINTS } from '../constants/api-constants.js';

const CFG_KEY = 'qr_judgment_config';
const QR_DEBOUNCE_MS = 250;   // 同一顆按鈕在此毫秒內重複觸發視為誤按，忽略

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtTimer(ms) {
  ms = Math.max(0, ms);
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${p2(h)}:${p2(m)}:${p2(s)}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`;
}
function p2(n) { return String(n).padStart(2, '0'); }
function fmtTime(ts) {
  const d = new Date(ts);
  const base = d.toLocaleTimeString('zh-TW', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  return `${base}.${String(d.getMilliseconds()).padStart(3,'0')}`;
}

// ── 機台手勢 gesture_key → Numpad code（小鍵盤）────────────────────────────────
function gestureCode(gestureKey) {
  if (!gestureKey || gestureKey.includes('+')) return null;
  if (gestureKey.startsWith('Keypad')) return 'Numpad' + gestureKey.slice(6);
  if (gestureKey === 'Enter') return 'NumpadEnter';
  return gestureKey;
}
function kbLabel(gestureKey) {
  if (!gestureKey) return '';
  return gestureKey.replace(/Keypad(\d)/g,'Num$1').replace('Enter','↵').replace(/ \+ /g,'+');
}

// ── 機台手勢九宮格：左手 QWEASDZXC，排列同數字鍵盤空間方位 ─────────────────────
//   Q W E      對應數字鍵盤  7 8 9（上排）
//   A S D                   4 5 6（中排）
//   Z X C                   1 2 3（下排）
const GESTURE_STD_KEY = {
  'capture':  'KeyQ',   // Q 左上
  'zoom_in':  'KeyW',   // W 上（放大 = 上）
  'confirm':  'KeyE',   // E 右上
  'prev':     'KeyA',   // A 左（上一頁 = 左）
  'reload':   'KeyS',   // S 中心
  'next':     'KeyD',   // D 右（下一頁 = 右）
  'open':     'KeyZ',   // Z 左下
  'zoom_out': 'KeyX',   // X 下（縮小 = 下）
  'close':    'KeyC',   // C 右下
};
const STD_KEY_LABEL = {
  'KeyQ':'Q','KeyW':'W','KeyE':'E',
  'KeyA':'A','KeyS':'S','KeyD':'D',
  'KeyZ':'Z','KeyX':'X','KeyC':'C',
};
// 九宮格螢幕顯示順序（左→右、上→下，對應 QWEASDZXC）
const GESTURE_GRID_ORDER = ['capture','zoom_in','confirm','prev','reload','next','open','zoom_out','close'];

// ── 研究手勢：右手按鍵，左右畫面對應左右鍵盤 ──────────────────────────────────
// 修飾詞（右手食指區）：J = 手指，I = 手掌
// 動作鍵（右手其餘鍵）：R T Y U O P / F G H K L ; ' / V B N M
// QWEASDZXC 已被左邊九宮格佔用，不重複使用
// key:null = 純觸控，無鍵盤快捷鍵
const RESEARCH_GESTURES = [
  // ── 修飾詞（右手食指 / 食指上方）──────────────────────────────────────────
  { id:'mod_finger', name:'手指', short:'手指', type:'modifier', key:'KeyJ' },  // J
  { id:'mod_palm',   name:'手掌', short:'手掌', type:'modifier', key:'KeyI' },  // I

  // ── 動作（右手字母鍵，不與九宮格衝突）──────────────────────────────────────
  { id:'act_pinch',         name:'捏合',    short:'捏合',    type:'action', key:'KeyR' },
  { id:'act_up',            name:'向上',    short:'向上',    type:'action', key:'KeyU' },
  { id:'act_forward',       name:'向前',    short:'向前',    type:'action', key:'KeyY' },
  { id:'act_spread',        name:'展開',    short:'展開',    type:'action', key:'KeyT' },
  { id:'act_flip',          name:'翻面',    short:'翻面',    type:'action', key:'KeyO' },
  { id:'act_down_pinch',    name:'向下捏合',short:'向下捏合',type:'action', key:null   },
  { id:'act_spread_fwd',    name:'展開向前',short:'展開向前',type:'action', key:null   },
  { id:'act_wave_circle',   name:'揮動畫圈',short:'揮動畫圈',type:'action', key:null   },
  { id:'act_rotate_circle', name:'轉動畫圈',short:'轉動畫圈',type:'action', key:null   },
  { id:'act_left',          name:'向左',    short:'向左',    type:'action', key:'KeyF' },
  { id:'act_down',          name:'向下',    short:'向下',    type:'action', key:'KeyN' },
  { id:'act_tap',           name:'點按',    short:'點按',    type:'action', key:'KeyH' },
  { id:'act_right',         name:'向右',    short:'向右',    type:'action', key:'KeyK' },
  { id:'act_wave',          name:'揮動',    short:'揮動',    type:'action', key:'KeyG' },
  { id:'act_seven',         name:'比七',    short:'比七',    type:'action', key:'KeyL' },
  { id:'act_gather',        name:'聚合',    short:'聚合',    type:'action', key:'KeyP' },
  { id:'act_face_down',     name:'面下',    short:'面下',    type:'action', key:'KeyM' },
  { id:'act_cross',         name:'打叉',    short:'打叉',    type:'action', key:'KeyV' },
  { id:'act_multitap',      name:'連點',    short:'連點',    type:'action', key:'KeyB' },
  { id:'act_circle',        name:'畫圈',    short:'畫圈',    type:'action', key:'Semicolon' },
  { id:'act_write',         name:'寫字',    short:'寫字',    type:'action', key:'Quote' },

  // ── 獨立手勢（純觸控，無鍵盤快捷鍵）────────────────────────────────────────
  { id:'thumbs_up',   name:'比讚', short:'比讚', type:'standalone', key:null },
  { id:'thumbs_down', name:'倒讚', short:'倒讚', type:'standalone', key:null },
  { id:'ok',          name:'OK',   short:'OK',   type:'standalone', key:null },
  { id:'fist',        name:'握拳', short:'握拳', type:'standalone', key:null },
];

const _ZONE_MAP = new Map(RESEARCH_GESTURES.filter(g => g.key).map(g => [g.key, g]));

function zoneKeyLabel(code) {
  if (!code) return '';
  if (code.startsWith('Key'))   return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Semicolon')     return ';';
  if (code === 'Quote')         return "'";
  return code;
}

// ── 研究手勢示意圖：全部使用 emoji（跨裝置一致、好認、觸控友善）─────────────────────
//   已避開任何在某些文化帶冒犯／迷信意味的手勢（如 🖕🤙🤞🤌）
const GESTURE_EMOJI = {
  // 修飾詞
  mod_finger: '☝️', mod_palm: '🖐️',
  // 方向
  act_up: '⬆️', act_down: '⬇️', act_left: '⬅️', act_right: '➡️', act_forward: '⏩',
  // 手勢動作
  act_pinch: '🤏', act_spread: '🖐️', act_flip: '🔃',
  act_down_pinch: '🤏⬇️', act_spread_fwd: '🖐️⏩',
  act_tap: '👆', act_multitap: '👆👆',
  act_wave: '👋', act_wave_circle: '👋⭕', act_rotate_circle: '🔄⭕',
  act_seven: '✔️', act_gather: '🤌', act_face_down: '🫳',
  act_cross: '❌', act_circle: '⭕', act_write: '✍️',
  // 獨立手勢
  thumbs_up: '👍', thumbs_down: '👎', ok: '👌', fist: '✊',
};

function gestureIcon(id) {
  const emoji = GESTURE_EMOJI[id];
  return emoji ? `<span class="qr-zone-emoji">${emoji}</span>` : '';
}

// ── 判定按鈕色系（g_type: t/f/n） ──────────────────────────────────────────────
function gtypeClass(gt) {
  return { t:'qr-judge--t', f:'qr-judge--f', n:'qr-judge--n' }[gt] || 'qr-judge--custom';
}

// ── g_type 中文標籤 ────────────────────────────────────────────────────────────
const GTYPE_LBL = { t:'成功', f:'失敗', n:'未判斷' };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
class QuickRemarkManager {
  constructor() {
    this._container  = null;
    this._gestures   = [];
    this._loaded     = false;
    this._configuring = false;
    this._draftCfg   = null;

    // 判定設定：[{key, label, g_type}]
    this._cfg = this._loadCfg();

    // 實驗狀態
    this._st = {
      status:        'idle',   // idle | running | paused | done
      startRealTs:   null,
      pausedElapsed: 0,
      entries:       [],
      pending:       null,     // {g_id, name} 等待判定（機台手勢）
      _lastZone:     null,     // {gesture, ts} 供 A↔B 合併
      _stepIdx:      0,        // 步驟序號（每個機台手勢遞增），標記繼承此值供配對
      _lastPress:    null,     // {id, ts} 防抖追蹤
      participant:   '',
      expId:         null,
      _timerIv:      null,
      _keyHandler:   null,
    };
  }

  _loadCfg() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || 'null') || []; }
    catch { return []; }
  }
  _saveCfg(cfg) { this._cfg = cfg; localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

  // ── Init ──────────────────────────────────────────────────────────────────
  async init(container) {
    this._container = container;
    this._bindContainerOnce();
    if (!this._loaded) {
      this._loaded = true;
      await this._fetchGestures();
    }
    this._render();
    this._setupKeyHandler();
  }

  async _fetchGestures() {
    try {
      const data = await fetch('./data/scenarios.json').then(r => r.json());
      this._gestures = data.gesture_list || [];
    } catch { this._gestures = []; }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  _render() {
    if (!this._container) return;
    this._container.innerHTML = this._configuring
      ? this._buildConfigPage()
      : this._buildMainPage();
  }

  // ── Main Page ─────────────────────────────────────────────────────────────
  _buildMainPage() {
    return `<div class="qr-layout">
      ${this._buildTopBar()}
      <div class="qr-main">
        <div class="qr-left-col">
          ${this._buildGesturePanel()}
        </div>
        <div class="qr-right-col">
          ${this._buildZonePanels()}
        </div>
      </div>
      ${this._buildLogStrip()}
    </div>`;
  }

  _buildTopBar() {
    const { status, pausedElapsed, startRealTs, participant, entries } = this._st;
    const elapsed = status === 'running'
      ? pausedElapsed + Date.now() - startRealTs : pausedElapsed;
    const pInput = (status === 'idle' || status === 'done')
      ? `<input class="qr-participant" type="text" placeholder="受試者" value="${esc(participant)}" data-field="participant">`
      : participant ? `<span class="qr-info-chip">👤 ${esc(participant)}</span>` : '';
    const attempts = entries.filter(e => e.type === 'gesture_attempt').length;

    return `<div class="qr-top-bar">
      <span class="qr-timer" id="qr-timer">${fmtTimer(elapsed)}</span>
      ${pInput}
      <div class="qr-top-btns">
        ${status==='idle'||status==='done' ? `<button class="qr-top-btn qr-top-btn--start" data-action="start">${status==='done'?'重新開始':'開始實驗'}<span class="qr-btn-key">Space</span></button>` : ''}
        ${status==='running' ? `<button class="qr-top-btn qr-top-btn--pause" data-action="pause">暫停<span class="qr-btn-key">Space</span></button>` : ''}
        ${status==='paused'  ? `<button class="qr-top-btn qr-top-btn--pause" data-action="resume">繼續<span class="qr-btn-key">Space</span></button>` : ''}
        ${status==='running'||status==='paused' ? `<button class="qr-top-btn qr-top-btn--end" data-action="end">結束<span class="qr-btn-key">Esc</span></button>` : ''}
        ${status==='done' ? `<button class="qr-top-btn qr-top-btn--export" data-action="export">匯出 JSONL<span class="qr-btn-key">Enter</span></button>` : ''}
      </div>
      <span class="qr-status-chip qr-status--${status}">
        ${{idle:'待機', running:'● 進行中', paused:'⏸ 暫停', done:`✓ 結束 (${attempts} 筆)`}[status]}
      </span>
    </div>`;
  }

  // ── 研究手勢面板（大格子平鋪，觸控優先）──────────────────────────────────────
  _buildZonePanels() {
    const running = this._st.status === 'running';
    const lastId  = this._st._lastZone?.gesture.id ?? null;

    const btns = RESEARCH_GESTURES.map(g => {
      const isLast = g.id === lastId;
      return `<button class="qr-zone-btn qr-zone--${g.type}${isLast ? ' is-last' : ''}"
                      data-zone-id="${esc(g.id)}" ${!running ? 'disabled' : ''}>
        ${g.key ? `<span class="qr-zone-key">${esc(zoneKeyLabel(g.key))}</span>` : ''}
        ${gestureIcon(g.id)}
        <span class="qr-zone-name">${esc(g.short)}</span>
      </button>`;
    }).join('');

    return `<div class="qr-zone-wrap">${btns}</div>`;
  }

  _buildGesturePanel() {
    const running = this._st.status === 'running';
    const pending = this._st.pending;
    // 依九宮格空間順序排列（對應 QWEASDZXC 鍵位方位）
    const src = this._gestures.filter(g => g.gesture_id !== 'home');
    const ordered = GESTURE_GRID_ORDER.map(id => src.find(g => g.gesture_id === id)).filter(Boolean);
    const extra   = src.filter(g => !GESTURE_GRID_ORDER.includes(g.gesture_id));
    const btns = [...ordered, ...extra].map(g => {
        const isPending = pending?.g_id === g.gesture_id;
        const stdCode = GESTURE_STD_KEY[g.gesture_id];
        const hint    = stdCode ? (STD_KEY_LABEL[stdCode] ?? stdCode) : '';
        return `<button class="qr-gesture-btn${isPending?' is-pending':''}"
                        data-g-id="${esc(g.gesture_id)}" data-g-name="${esc(g.gesture_name)}"
                        ${!running?'disabled':''}>
          ${hint ? `<span class="qr-kb-hint">${esc(hint)}</span>` : ''}
          <span class="qr-gesture-name">${esc(g.gesture_name)}</span>
        </button>`;
      }).join('');

    return `<div class="qr-panel qr-panel--gestures">
      <div class="qr-panel-header">
        <span class="qr-panel-title">機台手勢</span>
        ${pending?`<span class="qr-pending-badge">⏳ ${esc(pending.name)}</span>`:''}
      </div>
      <div class="qr-gesture-grid">${btns||'<div class="qr-hint">無手勢資料</div>'}</div>
    </div>`;
  }

  _buildJudgePanel() {
    const cfg = this._cfg;
    if (cfg.length === 0) {
      return `<div class="qr-panel qr-panel--judge">
        <div class="qr-panel-header"><span class="qr-panel-title">標記判定</span></div>
        <div class="qr-judge-empty">
          <p>尚未設定判定按鍵</p>
          <button class="qr-setup-btn" data-action="open-cfg">⚙ 立即設定</button>
        </div>
      </div>`;
    }
    const active = this._st.status === 'running' && !!this._st.pending;
    const hint = active ? '可按鍵盤快捷鍵或點擊' : this._st.pending ? '' : '先點選機台手勢';

    const btns = cfg.map(c => `
      <button class="qr-judge-btn ${gtypeClass(c.g_type)}${active?'':' is-dim'}"
              data-action="judge" data-gtype="${esc(c.g_type)}" data-label="${esc(c.label)}"
              ${!active?'disabled':''} title="快捷鍵：${esc(c.key)}">
        <span class="qr-judge-key-badge">${esc(c.key.length<=4?c.key.toUpperCase():c.key)}</span>
        <span class="qr-judge-label">${esc(c.label)}</span>
      </button>`).join('');

    return `<div class="qr-panel qr-panel--judge">
      <div class="qr-panel-header">
        <span class="qr-panel-title">標記判定</span>
        <button class="qr-cfg-btn" data-action="open-cfg" title="設定按鍵">⚙</button>
      </div>
      <div class="qr-judge-list">${btns}</div>
      ${hint?`<div class="qr-judge-hint">${hint}</div>`:''}
    </div>`;
  }

  _buildLogStrip() {
    const entries = this._st.entries;
    if (!entries.length) return '';
    const TYPE_LBL = {
      exp_start:'實驗開始', exp_end:'結束', exp_pause:'暫停', exp_resume:'繼續',
      gesture_step_start:'↑指令', gesture_attempt:'●',
    };
    // 保留原始 index 供刪除；只顯示最近 8 筆、最新在前
    const rows = entries
      .map((e, i) => ({ e, i }))
      .slice(-8).reverse()
      .map(({ e, i }) => {
        let detail = '';
        if (e.type === 'gesture_attempt') {
          const performed = e.g_type || '';   // 比出的研究手勢（中文）
          detail = e.g_id ? `${e.g_id} → ${performed}` : performed;
        } else if (e.g_id) {
          detail = e.g_id;   // 步驟開始：機台手勢指令（中文）
        }
        const canDel = e.type === 'gesture_attempt' || e.type === 'gesture_step_start';
        const idxBadge = (e.g_idx != null) ? `<span class="qr-log-idx">#${e.g_idx}</span>` : '';
        return `<div class="qr-log-card qr-log-card--${esc(e.type)}">
          ${canDel ? `<button class="qr-log-del" data-del-idx="${i}" title="刪除這筆誤按" aria-label="刪除">×</button>` : ''}
          ${idxBadge}
          <span class="qr-log-t">${fmtTime(e.ts)}</span>
          <span class="qr-log-type">${esc(TYPE_LBL[e.type]||e.type)}</span>
          ${detail?`<span class="qr-log-detail">${esc(detail)}</span>`:''}
        </div>`;
      }).join('');
    return `<div class="qr-log-strip">${rows}</div>`;
  }

  // ── Config Page ────────────────────────────────────────────────────────────
  _buildConfigPage() {
    const defaults = [{key:'T',label:'成功',g_type:'t'},{key:'F',label:'失敗',g_type:'f'},{key:'N',label:'未判斷',g_type:'n'}];
    const cfg = this._draftCfg || (this._cfg.length ? JSON.parse(JSON.stringify(this._cfg)) : defaults);
    if (!this._draftCfg) this._draftCfg = cfg;

    const rows = cfg.map((c,i) => `
      <div class="qr-cfg-row">
        <input class="qr-cfg-inp qr-cfg-key" type="text" maxlength="4"
               value="${esc(c.key)}" placeholder="鍵" data-idx="${i}" data-f="key">
        <input class="qr-cfg-inp" type="text"
               value="${esc(c.label)}" placeholder="標籤" data-idx="${i}" data-f="label">
        <select class="qr-cfg-sel" data-idx="${i}" data-f="g_type">
          <option value="t"${c.g_type==='t'?' selected':''}>t — 成功</option>
          <option value="f"${c.g_type==='f'?' selected':''}>f — 失敗</option>
          <option value="n"${c.g_type==='n'?' selected':''}>n — 未判斷</option>
        </select>
        <button class="qr-cfg-del" data-action="del-cfg" data-idx="${i}">✕</button>
      </div>`).join('');

    return `<div class="qr-layout qr-cfg-page">
      <div class="qr-top-bar">
        <span class="qr-panel-title" style="font-size:15px">⚙ 設定判定按鍵</span>
        <div class="qr-top-btns">
          <button class="qr-top-btn qr-top-btn--pause" data-action="add-cfg">+ 新增</button>
          <button class="qr-top-btn qr-top-btn--start" data-action="save-cfg">儲存</button>
          <button class="qr-top-btn" data-action="cancel-cfg">取消</button>
        </div>
      </div>
      <div class="qr-cfg-body">
        <div class="qr-cfg-head">
          <span>快捷鍵</span><span>顯示標籤</span><span>結果（g_type）</span><span></span>
        </div>
        <div id="qr-cfg-rows">${rows}</div>
        <p class="qr-cfg-hint">快捷鍵支援單鍵（如 T、F、1、Enter、Space）<br>
          注意：A 區用到 T / F，B 區用到 N，請避免與判定鍵衝突（可改用 1、2、3）</p>
      </div>
    </div>`;
  }

  // ── Event Binding ─────────────────────────────────────────────────────────
  // 容器本身在整個生命週期不變（_render 只換 innerHTML），因此事件一律以委派方式
  // 綁在容器上「一次」。避免每次 render 重複 addEventListener 造成監聽器累積洩漏。
  _bindContainerOnce() {
    const c = this._container;
    if (!c || this._boundEl === c) return;
    this._boundEl = c;

    c.addEventListener('click', e => {
      // 刪除誤按的日誌卡片（優先處理，避免冒泡觸發其他按鈕）
      const delBtn = e.target.closest('[data-del-idx]');
      if (delBtn) { e.stopPropagation(); this._deleteEntry(parseInt(delBtn.dataset.delIdx, 10)); return; }

      const btn = e.target.closest('[data-action]');
      if (btn) { this._handleAction(btn); return; }

      // 機台手勢按鈕
      const gBtn = e.target.closest('[data-g-id]');
      if (gBtn && !gBtn.disabled) this._pressGesture(gBtn.dataset.gId, gBtn.dataset.gName);

      // A / B / C 區手勢按鈕（觸控優先）
      const zBtn = e.target.closest('[data-zone-id]');
      if (zBtn && !zBtn.disabled) {
        const g = RESEARCH_GESTURES.find(g => g.id === zBtn.dataset.zoneId);
        if (g) this._pressZoneKey(g);
      }
    });

    // 受試者輸入 + 判定設定欄位（皆位於每次 render 重建的 innerHTML 內，故用委派）
    const syncField = e => {
      const t = e.target;
      if (!t) return;
      if (t.matches('[data-field="participant"]')) {
        this._st.participant = t.value.trim();
      } else if (t.matches('[data-idx][data-f]')) {
        const i = parseInt(t.dataset.idx, 10), f = t.dataset.f;
        if (this._draftCfg?.[i] != null) this._draftCfg[i][f] = t.value;
      }
    };
    c.addEventListener('input', syncField);
    c.addEventListener('change', syncField);
  }

  _handleAction(btn) {
    switch (btn.dataset.action) {
      case 'start':      this._startExp();  break;
      case 'pause':      this._pauseExp();  break;
      case 'resume':     this._resumeExp(); break;
      case 'end':        this._endExp();    break;
      case 'export':     this._export();   break;
      case 'judge':      this._pressJudge(btn.dataset.gtype, btn.dataset.label); break;
      case 'open-cfg':
        this._draftCfg = this._cfg.length
          ? JSON.parse(JSON.stringify(this._cfg))
          : [{key:'T',label:'成功',g_type:'t'},{key:'F',label:'失敗',g_type:'f'},{key:'N',label:'未判斷',g_type:'n'}];
        this._configuring = true; this._render(); break;
      case 'cancel-cfg': this._draftCfg=null; this._configuring=false; this._render(); break;
      case 'save-cfg':   this._commitCfg(); break;
      case 'add-cfg':
        (this._draftCfg||=[]).push({key:'',label:'',g_type:'t'}); this._render(); break;
      case 'del-cfg':
        this._draftCfg?.splice(parseInt(btn.dataset.idx),1); this._render(); break;
    }
  }

  _commitCfg() {
    const valid = (this._draftCfg||[]).filter(c => c.key.trim() && c.label.trim());
    this._saveCfg(valid);
    this._draftCfg=null; this._configuring=false; this._render();
  }

  // ── Experiment Control ─────────────────────────────────────────────────────
  _startExp() {
    const pInp = this._container?.querySelector('[data-field="participant"]');
    if (pInp) this._st.participant = pInp.value.trim();

    const ts = Date.now();
    this._st.status        = 'running';
    this._st.startRealTs   = ts;
    this._st.pausedElapsed = 0;
    this._st.entries       = [];
    this._st.pending       = null;
    this._st._lastZone     = null;
    this._st._stepIdx      = 0;
    this._st._lastPress    = null;
    this._st.expId         = `remark-${ts}`;

    this._st.entries.push({
      ts, type: 'exp_start',
      exp_id: this._st.expId,
      participant: this._st.participant || '',
    });
    this._startTimer();
    this._render();
  }

  _pauseExp() {
    if (this._st.status !== 'running') return;
    const ts = Date.now();
    this._st.pausedElapsed += ts - this._st.startRealTs;
    clearInterval(this._st._timerIv);
    this._st.status    = 'paused';
    this._st._lastZone = null;
    this._st.entries.push({ ts, type: 'exp_pause', exp_id: this._st.expId });
    this._render();
  }

  _resumeExp() {
    if (this._st.status !== 'paused') return;
    const ts = Date.now();
    this._st.startRealTs = ts;
    this._st.status      = 'running';
    this._st._lastZone   = null;
    this._st.entries.push({ ts, type: 'exp_resume', exp_id: this._st.expId });
    this._startTimer();
    this._render();
  }

  _endExp() {
    if (this._st.status === 'running') {
      this._st.pausedElapsed += Date.now() - this._st.startRealTs;
    }
    clearInterval(this._st._timerIv);
    this._st.status    = 'done';
    this._st.pending   = null;
    this._st._lastZone = null;
    this._st.entries.push({ ts: Date.now(), type: 'exp_end', exp_id: this._st.expId });
    this._render();
  }

  _startTimer() {
    clearInterval(this._st._timerIv);
    this._st._timerIv = setInterval(() => {
      const el = document.getElementById('qr-timer');
      if (!el) return;
      el.textContent = fmtTimer(this._st.pausedElapsed + Date.now() - this._st.startRealTs);
    }, 50);
  }

  // 防抖：同一顆按鈕在 QR_DEBOUNCE_MS 內重複觸發視為誤按（含鍵盤連發殘留與觸控彈跳）
  _debounced(id) {
    const now  = Date.now();
    const last = this._st._lastPress;
    if (last && last.id === id && now - last.ts < QR_DEBOUNCE_MS) return true;
    this._st._lastPress = { id, ts: now };
    return false;
  }

  // 刪除一筆誤按的手勢記錄（只允許刪手勢類，不動實驗開始/結束等控制事件）
  _deleteEntry(idx) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= this._st.entries.length) return;
    const e = this._st.entries[idx];
    if (e.type !== 'gesture_attempt' && e.type !== 'gesture_step_start') return;
    this._st.entries.splice(idx, 1);
    this._st._lastZone = null;   // 刪除後清掉合併暫存，避免接著誤合併
    this._render();
  }

  // ── 機台手勢 & 判定 ─────────────────────────────────────────────────────────
  _pressGesture(g_id, name) {
    if (this._st.status !== 'running') return;
    if (this._debounced('g:' + g_id)) return;
    this._st.pending = { g_id, name };
    // 新指令開始：步驟序號 +1，並清掉上一步殘留的修飾詞，避免跨指令誤合併
    this._st._stepIdx += 1;
    this._st._lastZone = null;
    this._st.entries.push({ ts: Date.now(), type: 'gesture_step_start', exp_id: this._st.expId, g_idx: this._st._stepIdx, g_id });
    this._render();
  }

  _pressJudge(g_type, label) {
    if (this._st.status !== 'running' || !this._st.pending) return;
    const { g_id } = this._st.pending;
    this._st.entries.push({ ts: Date.now(), type: 'gesture_attempt', exp_id: this._st.expId, g_idx: this._st._stepIdx, g_id, g_type });
    this._st.pending = null;
    this._render();
  }

  // ── 研究手勢（修飾詞 + 動作雙向合併）────────────────────────────────────────
  _pressZoneKey(gesture) {
    if (this._st.status !== 'running') return;
    if (this._debounced('z:' + gesture.id)) return;
    const now  = Date.now();
    const prev = this._st._lastZone;
    const gIdx = this._st._stepIdx;
    const cmdId = this._st.pending?.g_id ?? null;   // 當下機台手勢指令（左邊，英文 id）

    // 修飾詞 ↔ 動作 雙向合併（任意順序，步驟結束前均可合併；衝突則各自記錄）
    const canMerge = prev &&
      gesture.type !== 'standalone' &&
      prev.gesture.type !== 'standalone' &&
      ((prev.gesture.type === 'modifier' && gesture.type === 'action') ||
       (prev.gesture.type === 'action'   && gesture.type === 'modifier'));

    if (canMerge) {
      this._st.entries.pop();
      const mod = prev.gesture.type === 'modifier' ? prev.gesture : gesture;
      const act = prev.gesture.type === 'action'   ? prev.gesture : gesture;
      this._st.entries.push({
        ts:     prev.ts,
        type:   'gesture_attempt',
        exp_id: this._st.expId,
        g_idx:  gIdx,
        g_id:   cmdId,
        g_type: `${mod.name}${act.name}`,
      });
      this._st._lastZone = null;
    } else {
      this._st.entries.push({
        ts:     now,
        type:   'gesture_attempt',
        exp_id: this._st.expId,
        g_idx:  gIdx,
        g_id:   cmdId,
        g_type: gesture.name,
      });
      this._st._lastZone = gesture.type === 'standalone' ? null : { gesture, ts: now };
    }
    this._render();
  }

  // ── Keyboard Handler ───────────────────────────────────────────────────────
  _setupKeyHandler() {
    if (this._st._keyHandler) document.removeEventListener('keydown', this._st._keyHandler);

    const handler = e => {
      const c = this._container;
      if (!c || c.classList.contains('is-hidden')) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.repeat) return;   // 忽略長按造成的自動連發

      const st = this._st.status;

      // ── 控制鍵（全狀態可用）──────────────────────────────────────────────────
      if (e.code === 'Space') {
        e.preventDefault();
        if (st === 'idle' || st === 'done') this._startExp();
        else if (st === 'running') this._pauseExp();
        else if (st === 'paused') this._resumeExp();
        return;
      }
      if (e.code === 'Escape' && (st === 'running' || st === 'paused')) {
        e.preventDefault(); this._endExp(); return;
      }
      if (e.code === 'Enter' && st === 'done') {
        e.preventDefault(); this._export(); return;
      }

      if (st === 'running') {
        // ① 機台手勢判定（有 pending 且按鍵在判定設定中，優先）
        if (this._st.pending) {
          const jm = this._cfg.find(c => c.key.toLowerCase() === e.key.toLowerCase());
          if (jm) { e.preventDefault(); this._pressJudge(jm.g_type, jm.label); return; }
        }
        // ② 研究手勢 A / B / C 區（QWERTY）
        const rzm = _ZONE_MAP.get(e.code);
        if (rzm) { e.preventDefault(); this._pressZoneKey(rzm); return; }
        // ③ 機台手勢：小鍵盤 OR 大鍵盤備用（GESTURE_STD_KEY）
        const gm = this._gestures.find(g => {
          const numCode = gestureCode(g.gesture_key);
          const stdCode = GESTURE_STD_KEY[g.gesture_id];
          return (numCode && e.code === numCode) || (stdCode && e.code === stdCode);
        });
        if (gm) { e.preventDefault(); this._pressGesture(gm.gesture_id, gm.gesture_name); }
      }
    };

    this._st._keyHandler = handler;
    document.addEventListener('keydown', handler);
  }

  // ── Export：存伺服器 + 下載本機備份 ─────────────────────────────────────────
  async _export() {
    if (!this._st.entries.length) return;
    const content  = this._st.entries.map(e => JSON.stringify(e)).join('\n');
    const filename = `${this._st.expId || 'quick_remark'}.jsonl`;
    const btn = this._container?.querySelector('[data-action="export"]');
    const restore = () => { if (btn?.isConnected) btn.innerHTML = '匯出 JSONL<span class="qr-btn-key">Enter</span>'; };

    // 1) 上傳到伺服器（與其他實驗記錄一起存於 runtime/experiment-data/）
    let serverOk = false;
    try {
      if (btn) { btn.disabled = true; btn.textContent = '上傳中…'; }
      const res  = await fetch(`${getApiUrl()}${API_ENDPOINTS.RECORD.SAVE}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content }),
      });
      const data = await res.json().catch(() => ({}));
      serverOk = res.ok && data.success;
      if (!serverOk) throw new Error(data.error || `HTTP ${res.status}`);
    } catch (err) {
      alert(`存到伺服器失敗：${err.message}\n仍會下載到本機作為備份。`);
    }

    // 2) 下載到本機作為備份
    const blob = new Blob([content], { type: 'application/x-ndjson' });
    const url  = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);

    if (btn) {
      btn.disabled = false;
      btn.textContent = serverOk ? '✓ 已存伺服器＋下載' : '⚠ 已下載（伺服器失敗）';
      setTimeout(restore, 2500);
    }
  }
}

const _manager = new QuickRemarkManager();

export function onQuickRemarkActivate() {
  const el = document.getElementById('archiveQuickRemark');
  if (!el) return;
  _manager.init(el);
}
