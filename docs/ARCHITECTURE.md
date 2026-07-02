# Node.js 伺服器重構版本 架構藍圖

## 專案概述

### 整體架構圖

```
┌─────────────────────────────────────────────────────────────┐
│                    前端系統 (Browser)                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  資料層 (Frontend Storage)                           │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐    │   │
│  │  │localStorage│  │ IndexedDB  │  │sessionStorage   │   │
│  │  │(實驗狀態)  │  │(實驗日誌)  │  │ (分頁狀態) │    │   │
│  │  └────────────┘  └────────────┘  └────────────┘    │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  業務層 (Business Logic)                             │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────┐   │   │
│  │  │PageManager  │  │SyncManager  │  │Experiment│   │   │
│  │  │  (初始化)   │  │(工作階段)   │  │  Manager │   │   │
│  │  │             │  │             │  │           │   │   │
│  │  └─────────────┘  └─────────────┘  └──────────┘   │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  通訊層 (Communication)                              │   │
│  │  ┌──────────────┐  ┌──────────────┐                │   │
│  │  │ WebSocket    │  │   REST API   │                │   │
│  │  │   Client     │  │(/api/health) │                │   │
│  │  └──────────────┘  └──────────────┘                │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────┬──────────────────────────────────────┘
                       │ WebSocket (ws://localhost:7645)
                       │ HTTP (http://localhost:7645)
┌──────────────────────┴──────────────────────────────────────┐
│            Node.js 伺服器 (Express + WebSocket)              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  HTTP 層                                             │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐         │   │
│  │  │  /health │  │ /static  │  │   CORS   │         │   │
│  │  └──────────┘  └──────────┘  └──────────┘         │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  WebSocket 層                                        │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌─────────┐  │   │
│  │  │ Connection   │  │   Session    │  │Broadcast│  │   │
│  │  │   Manager    │  │   Manager    │  │ Manager │  │   │
│  │  └──────────────┘  └──────────────┘  └─────────┘  │   │
│  │  - 連線管理         - 工作階段管理    - 狀態廣播    │   │
│  │  - 心跳機制         - 客戶端角色      - 實驗同步    │   │
│  │  - 重連機制         - 校時服務                      │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  資料層 (SQLite)                                     │   │
│  │  - sessions (工作階段)                               │   │
│  │  - share_codes (分享代碼)                            │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 啟動指南

### 前置需求

- **Node.js 22 以上**（伺服器使用 `node:sqlite` 內建模組，Node.js 22 才有）
- 不需要另外安裝資料庫軟體，SQLite 已內建於 Node.js

### 首次設定

> **重要**：以下所有指令都要在 `kairo/` **根目錄**下執行，不是在 `server/` 裡面。
> `package.json` 位於根目錄，`server/` 只放後端程式碼。

```powershell
# 步驟 1：安裝相依套件（只需執行一次）
npm install

# 步驟 2：建立環境變數設定檔
# 將範例檔複製一份，本機開發通常不需要修改裡面的值
cp server/.env.example server/.env
```

### 啟動伺服器

```powershell
# 啟動伺服器（開發與正式執行相同）
npm run dev
# 或
npm start
```

啟動成功後，終端機會顯示類似：
```
Server running on http://0.0.0.0:7645
```

> 伺服器同時負責兩件事：提供後端 API（WebSocket + REST）以及托管前端頁面（HTML/JS/CSS）。

### 確認是否正常運作

開啟瀏覽器，前往以下網址：

| 用途 | 網址 |
|---|---|
| 確認伺服器狀態 | `http://localhost:7645/api/health` |
| 機台操作面板（受試者端） | `http://localhost:7645/index.html` |
| 實驗管理頁面（研究者端） | `http://localhost:7645/board.html` |
| 實驗日誌瀏覽器 | `http://localhost:7645/archive.html` |

健康檢查成功應看到：
```json
{ "success": true, "message": "Server online", "timestamp": 1234567890 }
```

### 常用指令

```powershell
npm run dev             # 啟動伺服器
npm run version:update  # 更新版本號（建議每次 git commit 前執行）
npm run version:status  # 查看目前版本狀態
npm run lint            # 檢查並自動修正 JS 程式碼格式
```

---

## 核心概念與變數定義

### 1. 工作階段 (Session)

Session 是多裝置同步的基本單元，聚合多個 clients。

```javascript
interface Session {
  sessionId: string; // 6位大寫英數字
  createdAt: number; // Unix 時間戳
  updatedAt: number;
  lastActiveAt: number;
  isActive: boolean;

  createdBy: string | null;
  createCode: string;

  clients: Client[];
  maxClients: number; // 預設 6

  state: {
    experimentId?: string,
    experimentRunning?: boolean,
    customData?: any,
  };
}
```

### 2. 分享代碼 (ShareCode)

用於客戶端加入工作階段的代碼，格式：5 位基礎碼 + 1 位校驗碼。

```javascript
interface ShareCode {
  code: string; // 6位代碼 (123456)
  sessionId: string;

  createdAt: number;
  expiresAt: number;

  used: boolean;
  usedAt: number | null;
  usedBy: string | null;

  expired: boolean;
  checksumValid: boolean;
}
```

校驗碼演算法由後端 `server/utils/checksum.js` 維護，架構文件僅保留資料模型。

### 3. 客戶端 (Client)

Client 是分頁級實體，每個瀏覽器分頁擁有獨立的 clientId。

```javascript
interface Client {
  clientId: string; // D{timestamp}{random} (分頁唯一)
                    // 範例: "D1736405234567ABC"
  role: "viewer" | "operator";

  connectedAt: number;
  lastHeartbeat: number;
  connectionState: "connected" | "disconnected" | "reconnecting";

  wsConnectionId: string; // WebSocket 內部 ID
}
```

`clientId` 為分頁級唯一識別，實作細節以前端同步模組為準。

### 4. 實驗 ID

```javascript
interface ExperimentId {
  experimentId: string; // 6位隨機碼，例如: "JHWH4A", "K3LM9P"
  sessionId: string | null;
  createdAt: number;
  source: string; // "panel", "state_manager"
}
```

**格式**：`[A-Z0-9]{6}` - 6 位大寫英數字隨機碼

**特性**：相同 ID 搭配相同組合邏輯，可透過 seeded random 還原實驗序列排序

產生與同步細節以 `random-utils.js`、`sync-client.js`、`server/websocket/*` 為準。

---

### 5. **狀態更新 (State Update)**

**定義**: 即時同步的狀態變化事件。

**大小限制**: 單一狀態物件 JSON 序列化後不得超過 **512 KB**。超過時伺服器回傳 `STATE_TOO_LARGE` 錯誤，不寫入記憶體或資料庫。（上限由 `server/websocket/MessageHandler.js` `handleStateUpdate()` 強制執行）

**WebSocket 訊息封包**:

```javascript
interface WSMessage {
  type: string;      // 訊息類型
  timestamp: number; // 時間戳（毫秒）
  sessionId: string; // 工作階段 ID
  clientId: string;  // 發送者 clientId
  data: any;         // 業務 payload
}
```

訊息類型請以「WebSocket 訊息類型與同步事件參考」章節為準：
- WS 傳輸層：`shared/ws-protocol-constants.js`
- 業務廣播層：`js/constants/sync-events-constants.js`

---

## 目錄結構與檔案詳解

### server/ - Node.js 後端

```
server/
├── index.js                 # 主入口：Express + WebSocket 伺服器初始化
├── metrics.js               # 效能監控與度量統計
├── .env                     # 環境變數設定（執行時，不進版本控制）
├── .env.example             # 環境變數範例（版本控制）
├── config/
│   ├── server.js            # 伺服器設定（連接埠、CORS、WebSocket、工作階段、速率限制）
│   ├── database.js          # SQLite 連線設定與 PRAGMA 優化
│   └── constants.js         # 常數定義（超時、限制等）
├── database/
│   ├── connection.js        # node:sqlite DatabaseSync 實例
│   └── schema.js            # 資料庫表結構初始化
├── services/
│   ├── SessionService.js    # 工作階段管理（CRUD + 校時）
│   ├── ShareCodeService.js  # 分享代碼管理（產生、驗證、校驗碼）
│   ├── ExperimentService.js # 實驗 ID 管理
│   └── （日誌寫入由 routes/record.js 直接處理）
├── websocket/
│   ├── WSServer.js          # WebSocket 伺服器核心封裝
│   ├── ConnectionManager.js # 連線管理（clientId 對應、重連偵測）
│   ├── SessionManager.js    # 工作階段管理（房間管理）
│   ├── BroadcastManager.js  # 廣播管理（單播、房間廣播、全域廣播）
│   └── MessageHandler.js    # 訊息處理器（auth、heartbeat、state_update）
├── routes/
│   ├── sync.js              # 同步 API（工作階段、分享代碼、驗證）
│   ├── record.js            # 實驗日誌 API（record 使用；JSONL 檔案讀寫）
│   ├── experiment.js        # 實驗 API（ID 產生）
│   └── health.js            # 心跳檢測 API (`GET /api/health`)
├── middleware/
│   └── (目前為空，預留擴展)
└── utils/
    ├── logger.js            # 日誌工具（console 包裝）
    ├── idGenerator.js       # ID 產生工具
    ├── checksum.js          # 校驗碼計算
    ├── sync-role-guard.js   # operator 角色衝突檢查與 clientType 正規化
    └── time.js              # 時間工具
```

### runtime/ - 執行時資料（.gitignore 排除）

```
runtime/
├── database/
│   └── experiment.db        # SQLite 資料庫檔案
│       ├── sessions 表      # 工作階段資料
│       ├── share_codes 表   # 分享代碼資料
│       ├── experiment_ids 表 # 實驗 ID 紀錄
│       └── state_updates 表 # 狀態更新日誌
├── experiment-data/
│   ├── {experimentId}_{timestamp}.jsonl  # 實驗日誌（例：JHWH4A_1767975514075.jsonl）
│   └── ...
└── sessions/
    └── (工作階段還原資料)
```

### data/ - 靜態資料目錄

```
data/
├── scenarios.json  # 場景設定（實驗情境數據）
├── units.json      # 單元設定（包含組合定義和步驟）
├── section-a.json  # 章節 A 設定
├── buttons.json    # 按鈕設定（位置、標籤、動作）
├── gestures.json   # 手勢識別設定
├── config.json     # 前端業務設定（UI、功能開關、時區）
└── ref.txt         # 參考資訊
```

### js/ - 前端 JavaScript 模組

#### js/core/ - 核心模組

| 檔案 | class / 匯出 | 主要功能 |
|---|---|---|
| **config.js** | `ConfigManager` | 設定管理、版本資訊載入、使用者偏好儲存與重設 |
| **console-manager.js** | `Logger` | 統一日誌記錄（多級別），ES 模組匯出供各模組 import |
| **data-loader.js** | 匯出函數 | 載入 scenarios/units 資料、建立動作序列 |
| **websocket-client.js** | `WebSocketClient` | WebSocket 連線管理、事件訂閱、重連機制 |
| **time-sync-manager.js** | `TimeSyncManager` | WebSocket 校時（syncWithWebSocket）、提供 `getServerTime()` 與格式化工具 |
| **random-utils.js** | 匯出函數/物件 | 可重現隨機化（seeded random）、實驗 ID 產生 |
| **session-restore-events.js** | 匯出函數 | 工作階段快照轉譯並派發前端事件 |
| **url-utils.js** | 匯出函數 | API 基礎路徑解析（`getApiBasePath()`）|
| **event-emitter.js** | `EventEmitter` | 輕量事件訂閱基底類別，供各 Manager 繼承 |
| **app-bootstrap.js** | 匯出函數 | 版本快取破壞（`data-versioned` 資源加版本號）、舊版瀏覽器儲存清理 |
| **admin-auth.js** | 匯出函數 | 管理員 Token 取得與 sessionStorage 快取（供 Archive 頁面授權 record API）|

#### js/panel/ - 面板控制模組

| 檔案 | class / 匯出 | 主要功能 |
|---|---|---|
| **panel-page-manager.js** | `PanelPageManager` | 面板頁面初始化總協調（載入資料、建立管理器、綁定執行期依賴） |
| **panel-button-manager.js** | `ButtonManager` | 按鈕互動、實驗動作判定、動作序列導航（直接持有 ActionHandler 引用） |
| **panel-ui-manager.js** | `PanelUIManager` | UI 縮放、按鈕標籤/顏色可見性、觸控視覺設定 |
| **panel-power-control.js** | `PowerControl` | 電源狀態管理與 UI 同步 |
| **panel-media-manager.js** | `MediaManager` | 媒體預載入、快取、播放區域管理、首頁循環 |
| **panel-logger.js** | `PanelLogger` | 操作日誌記錄、顯示、匯出 |
| **panel-sync-manager.js** | `PanelSyncManager` | Panel 端同步事件監聽；`handleSyncExperimentStart/Stopped` 含 Panel 端狀態追蹤邏輯（_remoteExperimentActive、deferCompletion）；Paused/Resumed 直接委派 SystemManager |
| **panel-init.js** | 匯出函數 | 集中建立所有 Manager 並完成依賴注入（`initializePanelManagers(page)`） |

#### js/archive/ - 實驗日誌瀏覽與重標記模組

`ArchivePageManager` 透過 `Object.assign` 將下列四個 mixin 混入 prototype，共享 `this._file`（`ArchiveFileState`）與 `this._renderAll()`。

| 檔案 | 匯出 | 主要功能 |
|---|---|---|
| **archive-page-manager.js** | `ArchivePageManager` | 頁面入口；組合所有子模組方法，持有 `_file`、`_localFiles`、選取狀態 |
| **archive-constants.js** | `ArchiveFileState`、工具函式 | 檔案狀態（entries / history / dirty）、`applyEdit`、`undoAt`、`commitAsOriginal`、`toEditedJsonl`；共用常數與 HTML 工具函式 |
| **archive-sidebar.js** | `archiveSidebarMethods` | 伺服器 / 本機檔案清單；上傳、下載、刪除、另存新檔（`_saveWithSuffix`） |
| **archive-viewer.js** | `archiveViewerMethods` | 工具列（已編輯指示、另存按鈕）、摘要統計、計數列、時間軸 / 表格 / 原始視圖渲染 |
| **archive-editor.js** | `archiveEditorMethods` | 時間戳 / 類型 / 標記欄編輯彈出框；編輯記錄彈出框（撤回此步 / 還原至此） |
| **archive-remark.js** | `archiveRemarkMethods` | 重新標記工作區：標記點建立 / 拖拉分配、多選平移（delta-based）、事件刪除（可撤回）、另存 / 合併輸出 |
| **archive-init.js** | 入口腳本 | `bootstrapPage` + 載入 `ArchivePageManager`（`archive.html` 的 script 入口） |

**`ArchiveFileState` 重要方法**

| 方法 | 說明 |
|---|---|
| `applyEdit(index, field, value, label)` | 單筆欄位修改，記入 history，設 isDirty |
| `applyBatchEdit(changes, label)` | 批次修改，原子性 history 記錄 |
| `removeEntry(index)` | 刪除一筆 JSONL entry（可撤回） |
| `undoAt(historyIndex)` | 單獨撤回指定 history 操作（保留其他） |
| `undo()` | 撤回最後一步 |
| `revert()` | 回到原始檔案狀態，清空 history / draft |
| `commitAsOriginal()` | 儲存後推進基準線：`_original` ← 目前 entries，重設 `_origIdx`、清空 history / isDirty / draft |
| `toEditedJsonl()` | 輸出當前 entries 為 JSONL（自動剝除內部 `_origIdx` 欄位） |

`_origIdx` 是建構時賦予每筆 entry 的穩定識別碼，讓 `removeEntry` 後的 index 偏移不影響「是否已修改」的比對邏輯。localStorage 草稿保留 `_origIdx`；JSONL 輸出不含此欄位。

#### js/sync/ - 同步模組

| 檔案 | class | 主要功能 |
|---|---|---|
| **sync-manager.js** | `SyncManager` | 同步管理主入口；持有 ROLE / STATUS / PAGE 常數；組合 Core + UI |
| **sync-manager-core.js** | `SyncManagerCore` | 工作階段建立/加入/還原、狀態廣播、離線佇列處理 |
| **sync-manager-ui.js** | `SyncManagerUI` | 膠囊指示器與控制面板渲染、UI 狀態更新 |
| **sync-sessions-modal.js** | `SyncSessionsModal` | 工作階段管理 Modal（列表、批次操作） |
| **sync-confirm-dialog.js** | `SyncConfirmDialogManager` | 加入工作階段確認對話 |
| **sync-client.js** | `SyncClient` | WebSocket + REST API 同步客戶端；工作階段建立/加入/還原、狀態廣播、心跳維持（由 WebSocketClient 底層處理） |
| **experiment-sync-core.js** | `ExperimentSyncCore` | 實驗同步核心廣播（safeBroadcast）；作為 ES module singleton 在 board/panel 共用 |
| **indicator-manager.js** | `IndicatorManager` | 同步狀態指示器顯示與動畫管理 |

#### js/experiment/ - 實驗管理模組

```
js/experiment/
├── experiment-system-manager.js      # ExperimentSystemManager
│                                     # 統一協調器（facade）；協調 UI/組合/流程/Hub 等子管理器
│                                     # 負責：實驗 ID 生命週期、受試者名稱、同步狀態委派
│                                     # 不直接持有動作序列邏輯（由 ActionHandler 負責）
│
├── experiment-flow-manager.js        # ExperimentFlowManager
│                                     # 實驗生命週期（開始/暫停/繼續/停止/完成）
│                                     # 單元/步驟進度管理；isRunning、isPaused 為流程狀態來源
│
├── experiment-action-handler.js      # ExperimentActionHandler
│                                     # 動作判定、手勢處理、步驟轉換、自動推進
│                                     # 持有並管理 currentActionSequence / currentActionIndex
│                                     # 提供動作序列導航：jumpToActionById, findActionIndexById 等
│
├── experiment-combination-manager.js # ExperimentCombinationManager
│                                     # 組合載入、隨機化（seeded）、快取還原、單元排序
│
├── experiment-hub-manager.js         # ExperimentHubManager
│                                     # 與中樞伺服器通訊；實驗 ID 註冊與同步模式切換（Local/Hub/Viewer）
│
├── experiment-state-manager.js       # ExperimentStateManager
│                                     # 本機實驗狀態持久化（experimentId、participantName、flowState）
│                                     # 多裝置快照還原的本機端狀態
│
├── experiment-ui-manager.js          # ExperimentUIManager（繼承鏈底端）
│                                     # 繼承鏈：ExperimentControlsDom → ExperimentUIRenderer → ExperimentUIManager
│                                     # 實驗 ID 輸入框綁定、計時器委派、視覺提示、控制面板狀態
│
├── experiment-ui-renderer.js         # ExperimentUIRenderer（中層）
│                                     # 通用 UI 工具：按鈕啟停/鎖定/高亮；組合/單元/控制面板 HTML 渲染
│
├── experiment-controls-dom.js        # ExperimentControlsDom（底層）
│                                     # 低層級 DOM 操作；實驗控制面板元素建立與綁定
│
├── experiment-timer.js               # ExperimentTimerManager - 實驗總計時與步驟計時
└── experiment-script-builder.js      # 建立 board 端手勢序列腳本（board 專用）
```

**模組間職責邊界**

| 元件 | 擁有的狀態 |
|---|---|
| ExperimentFlowManager | isRunning, isPaused, currentUnitIndex, 流程事件 |
| ExperimentActionHandler | currentActionSequence, currentActionIndex, completedActions |
| ExperimentCombinationManager | currentCombination, loadedUnits, 單元排序 |
| ExperimentStateManager | experimentId, participantName, flowState（持久化層） |
| ExperimentHubManager | 同步模式、連線狀態、中樞 experimentId |
| ExperimentSystemManager | 無自有狀態（純協調器，持有各子管理器引用） |

#### js/constants/ - 常數模組

```
js/constants/
├── index.js                    # 統一匯出入口（所有常數從此引用）
├── experiment-constants.js     # 實驗流程、動作、組合、Hub 事件常數
├── sync-events-constants.js    # SYNC_DATA_TYPES（業務廣播 type）、SYNC_EVENTS（前端 DOM 事件）
├── sync-constants.js           # SYNC_CLIENT_CONSTANTS、SYNC_ROLE_CONFIG、同步模式常數
├── action-constants.js         # ACTION_IDS（電源開關等特殊動作識別碼）
├── api-constants.js            # API 端點路徑常數
├── record-types-constants.js   # 日誌事件類型常數
├── record-source-constants.js  # RECORD_SOURCES（LOCAL_GENERATE / HUB_SYNC / SYNC_BROADCAST 等）
└── power-constants.js          # 電源狀態常數
```

#### js/record/ - 日誌模組

| 檔案 | 匯出 | 主要功能 |
|---|---|---|
| **index.js** | 統一入口 | 統一匯出所有子模組（RecordManager、recordView 等） |
| **record-manager.js** | `RecordManager` | 日誌管理主入口；協調寫入、緩衝與 API 上傳 |
| **record-store.js** | `recordStore` | IndexedDB 日誌持久化（緩衝區） |
| **record-runtime.js** | `recordRuntime` | 執行期記錄：事件入隊、去重、批次排程 |
| **record-view.js** | `recordView` | 日誌檢視主模組；協調列表、篩選、Modal、統計 |
| **record-view-list.js** | `recordViewList` | 日誌列表渲染 |
| **record-view-filter.js** | `recordViewFilter` | 篩選器（事件類型、時間範圍等） |
| **record-view-modal.js** | `recordViewModal` | 單筆日誌詳細檢視 Modal |
| **record-view-stats.js** | `recordViewStats` | 統計資訊顯示（計數、分布等） |

#### js/board/ - 實驗頁面專用模組

```
js/board/
├── board-page-manager.js         # BoardPageManager - 實驗頁面腳本載入與初始化協調
├── board-init.js                 # Board 初始化協調（initializeBoardManagers）
├── board-sync-io.js              # BoardSyncIO - 同步收發邏輯集中
├── board-experiment-sync.js      # ExperimentSyncAdapter - 同步狀態廣播轉接
├── board-ui-manager.js           # BoardUIManager - Board UI 與手勢卡片渲染
└── board-gesture-utils.js        # BoardGestureUtils - 手勢處理工具
```

#### 檔案層級依賴與初始化順序

**重要**: 檔案載入順序由各頁面的 PageManager 協調：

**Panel 頁面初始化順序** (`PanelPageManager`):

1. `PanelPageManager.initialize()`
2. `initializePanelManagers(this)`（位於 `js/panel/panel-init.js`）：集中建立並注入 Sync / Hub / Flow / UI / Logger / Media 等管理器
3. `_initializeExperimentUIAndData()`：載入 scenario/unit 資料並初始化實驗 UI
4. `_initializePanelRuntimeBindings()`：綁定按鈕、事件與執行期依賴

**Board 頁面載入順序** (`BoardPageManager`):

Board 由 `loadDependencies()` 使用 `Promise.all` **並行**載入核心依賴（基礎設施 → 實驗狀態 → 同步系統 → 實驗模組 → Board 專用模組），接著由 `initializeBoardManagers(this)`（`js/board/board-init.js`）集中完成管理器建立與依賴注入。

> 詳細模組清單與載入分組請參閱 `js/board/board-page-manager.js` 的 `loadDependencies()` 方法。

架構要點：

- 各頁面的 PageManager 負責頁面初始化協調。
- `panel-init.js` / `board-init.js` 負責管理器建立與依賴注入。
- `record/index.js` 統一匯出 `RecordManager` / `recordView` 與紀錄子模組。

**初始化依賴關係**:

```
PanelPageManager.initialize()
├─ initializeModules()
│  └─ initializePanelManagers(this)
├─ initializeRemainingComponents()
│  ├─ _initializeExperimentUIAndData()
│  └─ _initializePanelRuntimeBindings()
└─ 完成初始化
```

---

### css/ - 樣式表目錄

樣式依功能分層管理，入口為 `css/style.css`：

| 子目錄 | 說明 |
|---|---|
| `archive/` | Archive 頁面專用樣式（`archive.css`）|
| `base/` | 全域、佈局、捲軸等基礎樣式 |
| `components/` | 可複用元件（按鈕、表單、媒體區域等） |
| `features/experiment/` | 實驗功能專用樣式（卡片、組合、手勢、計時等） |
| `features/panels/` | 各控制面板樣式 |
| `pages/` | Board / Panel 頁面的頁面級專用樣式 |
| `shared/` | 跨頁面共用元件樣式（`file-list.css`、`filter-popover.css`）|
| `states/` | 實驗、互動、電源的狀態樣式 |
| `sync/` | 同步指示器、Modal、確認對話框樣式 |
| `utilities/` | 動畫、響應式設計工具 |

### assets/ - 資源檔案

```
assets/
├── audio/        # 音效檔案
├── ui/           # 介面圖標（按鈕、電源等）
└── units/        # 各實驗單元的媒體資源（依單元名稱分資料夾）
    └── SYSTEM/   # 系統媒體（首頁影片等）
```

### 根目錄檔案

```
kairo/
├── index.html             # 機台面板（受試者端，實驗操作）
├── board.html             # 實驗管理（研究者端，實驗分析）
├── archive.html           # 實驗日誌瀏覽器
├── package.json           # Node.js 依賴管理（從這裡執行 npm 指令）
├── package-lock.json      # 依賴鎖定檔案
├── README.md              # 專案說明
├── eslint.config.js       # ESLint 設定
├── kairo.code-workspace   # VS Code 工作區設定
└── favicon.ico            # 網站圖標

scripts/
├── find_duplicate_logs.js              # 重複日誌檢測工具
├── update-version.js                   # 版本更新腳本
├── verify_experiment_resilience.js     # 實驗韌性驗證腳本
└── verify_experiment_contracts.js      # 實驗契約驗證腳本
```

### docs/ - 文件目錄

```
docs/
├── ARCHITECTURE.md              # 架構文件（本文件）
├── PROJECT_TERMINOLOGY_GUIDE.md # 專案術語指南
└── scenarios_structure.md       # Scenarios 架構說明
```

---

## 資料流說明

### 本機模式（無同步）

```
使用者操作
  -> PanelPageManager / ExperimentStateManager
  -> localStorage（狀態持久化）
  -> PanelLogger（可匯出本機 JSON）
  -> RecordManager -> IndexedDB（實驗事件緩衝區）
```

### 同步模式（多裝置）

```
裝置 A 狀態事件
  -> sync-client.js / websocket-client.js
  -> WebSocket Server
  -> 廣播到同工作階段裝置 B/C/...
  -> 各端 ExperimentStateManager 更新
  -> UI 即時同步
```

### 日誌寫入伺服器（JSONL）

```
RecordManager（記憶體/IndexedDB）
  -> POST /api/record/save
  -> runtime/experiment-data/*.jsonl
```

### 校時機制（一次性）

```
auth_success（含 serverTime）
  -> timeSyncManager.syncWithWebSocket(serverTime)
  -> 更新 timeOffset
  -> 後續以 TimeSyncManager.getServerTime() 取時
```

---

## 運作模式與實驗中樞註冊 (Operating Modes)

### 設計原則

系統依是否具備有效 `sessionId + clientId` 切換模式：

- 獨立運作模式（本機）：
  - 不建立同步連線。
  - 實驗 ID 與狀態僅保留本機。
- 同步運作模式（協作）：
  - 建立 WebSocket 連線並加入工作階段。
  - 實驗 ID 變更需註冊至實驗中樞。

### 架構規則

- `ExperimentHubManager.isInSyncMode()` 作為註冊中樞與同步廣播的主要判斷入口。
- 所有實驗 ID 產生/更新流程均遵循：
  - 同步模式：註冊中樞並廣播（only in sync mode）。
  - 本機模式：只更新本機狀態，不對外同步。

---

## 重新連線與離線機制 (Reconnect & Offline System)

### 前端重點

| 面向 | 設計重點 | 前端行為 |
| ---- | -------- | -------- |
| 連線身分還原 | 分頁重新整理後維持 `clientId/sessionId/role` | 優先從 `sessionStorage` 還原識別並重送 `auth` |
| 多分頁與跨工作階段 | 分頁隔離 + 跨分頁共用 | `sessionStorage` 保存分頁識別；`localStorage` 保存跨分頁資訊（如 `sync_session_id`） |
| 日誌持久化 | 本機快取與伺服器備份分離 | `IndexedDB` 緩衝/持久化；完成時可經 `/api/record/*` 寫入 JSONL |
| 離線容錯 | 斷線期間不中斷操作 | `offlineQueue` 暫存、排序去重，重連後依序重送 |

### 儲存層策略

| 儲存方式 | 主要用途 | 重新整理 | 多分頁 | 關閉瀏覽器 |
| -------- | -------- | -------- | ------ | ---------- |
| `sessionStorage` | 分頁級重連（推薦） | 保留 | 隔離 | 消失 |
| `localStorage` | 跨工作階段還原 | 保留 | 共用 | 保留 |
| `IndexedDB` | 實驗日誌快取 | 保留 | 共用 | 保留 |
| `memory` | 離線佇列暫存 | 消失 | 隔離 | 消失 |

### 重新連線摘要流程

```
connect -> auth(clientId, sessionId, role) -> auth_success(isReconnect, serverTime)
     -> session_state -> client_reconnected(others)
     -> processOfflineQueue() (if any)
```

---

## API 端點

### HTTP REST API

#### 1. 健康檢查

- **端點**: `GET /api/health`
- **回應**: `{ success: true, message: "Server online", timestamp: 1234567890 }`

#### 2. 同步 API

> **🔒 標記說明**：標有 🔒 的端點需在 HTTP Header 帶入 `X-Admin-Token`（從 `/api/sync/admin-token` 取得）。

| 方法   | 端點                                          | 說明                               |
| ------ | --------------------------------------------- | ---------------------------------- |
| POST   | `/api/sync/session`                           | 建立新的工作階段                   |
| POST   | `/api/sync/create_session`                    | 建立工作階段（僅建立）             |
| POST   | `/api/sync/generate_share_code`               | 產生分享代碼                       |
| POST   | `/api/sync/join`                              | 使用分享代碼加入工作階段           |
| POST   | `/api/sync/session/:sessionId/share-code`     | 為指定工作階段產生分享代碼         |
| GET    | `/api/sync/session/:sessionId/validate`       | 驗證工作階段是否有效               |
| GET    | `/api/sync/session/:sessionId/clients`        | 取得工作階段中的所有客戶端         |
| GET    | `/api/sync/session/:sessionId`                | 取得工作階段資訊                   |
| GET    | `/api/sync/sessions` 🔒                       | 取得所有活動中的工作階段列表       |
| DELETE | `/api/sync/session/:sessionId` 🔒             | 刪除指定的工作階段                 |
| POST   | `/api/sync/sessions/clear` 🔒                 | 清除所有工作階段                   |
| POST   | `/api/sync/heartbeat`                         | 更新工作階段活動時間               |
| GET    | `/api/sync/share-code/:code`                  | 取得分享代碼資訊                   |
| POST   | `/api/sync/channel`                           | 建立公開頻道工作階段               |
| GET    | `/api/sync/channels`                          | 取得所有公開頻道                   |
| POST   | `/api/sync/channel/close` 🔒                  | 關閉指定頻道                       |
| POST   | `/api/sync/client/:clientId/kick` 🔒          | 強制踢出指定客戶端                 |
| POST   | `/api/sync/client/:clientId/role` 🔒          | 調整指定客戶端角色                 |
| POST   | `/api/sync/client/:clientId/request-state` 🔒 | 向指定客戶端請求當前狀態           |
| POST   | `/api/sync/client/:clientId/refresh` 🔒       | 推送最新同步狀態給指定客戶端       |
| GET    | `/api/sync/admin-token`                       | 取得管理員 Token（區網無需認證）   |

#### 3. 實驗 API

| 方法 | 端點                 | 說明        |
| ---- | -------------------- | ----------- |
| POST | `/api/experiment/id` | 建立實驗 ID |

#### 4. 日誌 API

| 方法   | 端點                           | 說明             |
| ------ | ------------------------------ | ---------------- |
| GET    | `/api/record/list`             | 列出所有日誌檔案 |
| POST   | `/api/record/save`             | 儲存日誌檔案     |
| GET    | `/api/record/read/:filename`   | 讀取日誌檔案內容 |
| DELETE | `/api/record/delete/:filename` | 刪除日誌檔案     |

---

## WebSocket 訊息類型與同步事件參考

### 1. WS_PROTOCOL — WebSocket 傳輸層訊息類型

定義檔：`shared/ws-protocol-constants.js`

#### C2S（客戶端 → 伺服器）

| `type` 值                | 說明                                       | 伺服器處理器                 |
| ------------------------ | ------------------------------------------ | ---------------------------- |
| `auth`                   | 認證連線，建立工作階段綁定                 | `handleAuth`                 |
| `heartbeat`              | 心跳，維持連線活動中                       | `handleHeartbeat`            |
| `state_update`           | 狀態廣播（承載所有業務事件的主通道）       | `handleStateUpdate`          |
| `get_session_state`      | 取得目前工作階段完整狀態快照               | `handleGetSessionState`      |
| `ping`                   | Ping                                       | `handlePing`                 |
| `experiment_id_register` | 任一端重新產生實驗 ID 後廣播給同頻道所有人 | `handleExperimentIdRegister` |

#### S2C（伺服器 → 客戶端）

| `type` 值               | 說明                         | 主要 payload 欄位                     |
| ----------------------- | ---------------------------- | ------------------------------------- |
| `connected`             | 連線成功                     | `wsConnectionId`, `serverTime`        |
| `auth_success`          | 認證成功                     | `sessionId`, `clientId`, `role`       |
| `clear_sync_data`       | 要求客戶端清除本機同步狀態   | —                                     |
| `heartbeat_ack`         | 心跳確認                     | `timestamp`                           |
| `pong`                  | Ping 回應                    | `timestamp`                           |
| `session_state`         | 完整工作階段狀態快照         | `sessionId`, `state`, `clients`       |
| `session_state_update`  | 工作階段狀態增量更新         | `sessionId`, `state`                  |
| `state_update_ack`      | 狀態更新確認                 | `timestamp`                           |
| `client_joined`         | 有客戶端加入工作階段         | `clientId`, `role`                    |
| `client_left`           | 有客戶端離開工作階段         | `clientId`                            |
| `client_reconnected`    | 客戶端重新連線               | `clientId`                            |
| `experiment_started`    | 實驗開始                     | `experimentId`, `source`, `timestamp` |
| `experiment_paused`     | 實驗暫停                     | `experimentId`, `source`              |
| `experiment_resumed`    | 實驗繼續                     | `experimentId`, `source`              |
| `experiment_stopped`    | 實驗停止                     | `experimentId`, `source`              |
| `experiment_id_changed` | 實驗 ID 已變更（伺服器推播） | `experimentId`, `timestamp`           |
| `error`                 | 錯誤訊息                     | `code`, `message`                     |

---

### 1.5. 廣播事件 Schema 層級化統一標準

#### 層 1：傳輸層 - 固定格式

所有客户端發出的業務廣播均遵循統一的傳輸層 schema：

```javascript
{
  type: string,              // 必須：SYNC_DATA_TYPES 常數值
  clientId: string,          // 必須：發送者識別碼
  timestamp: number,         // 必須：毫秒級時間戳 (Date.now())
  ...businessFields          // 業務特定欄位
}
```

**欄位約束：**
- `type`：直接使用 SYNC_DATA_TYPES 中的值，不混合結構（例如不使用 `type: "state_change" + event: "paused"` 的矛盾設計）
- `clientId`：由發送方決定（透過 SyncClient 實例的 clientId 屬性取得，如 `syncClient.clientId` 或 `syncManager.clientId`）
- `timestamp`：統一為毫秒級整數（Date.now()），便於邏輯比較和去重
- 欄位順序：type → clientId → timestamp → 業務欄位

#### 層 2：業務層 - 各事件定義

根據 type 值，各廣播方法定義特定的業務欄位。詳見下節 「SYNC_DATA_TYPES」表格。

### 2. SYNC_DATA_TYPES — `state_update` 內部 `type` 欄位

所有透過 `state_update` C2S 訊息傳送的業務廣播，payload 中的 `type` 欄位均遵循層 1 固定格式。  
定義檔：`js/constants/sync-events-constants.js`（`SYNC_DATA_TYPES`）

業務廣播分為三類：
- **實驗生命週期**：`experiment_initialize` / `experiment_started` / `experiment_paused` / `experiment_resumed` / `experiment_stopped`（由 board 端發送）
- **實驗資訊更新**：`experiment_id_update` / `participant_name_update` / `combination_selected`
- **動作與手勢**：`action_completed` / `action_cancelled` / `gesture_marked` / `gesture_step_completed`（action 狀態以面板為主控，Board 端僅反映 UI）

完整 payload 欄位定義請參閱 `js/constants/sync-events-constants.js`。

---

### 3. SYNC_EVENTS — 前端 DOM / Window 事件

這些事件透過 `document.dispatchEvent()` 或 `window.dispatchEvent()` 在**同一頁面內**傳遞，不經過 WebSocket。  
定義檔：`js/constants/sync-events-constants.js`（`SYNC_EVENTS`）

事件分為五類：
- **工作階段事件**（`SyncManager` 派發）：建立、加入、離開、還原工作階段，分享代碼產生
- **WebSocket 連線事件**：連線成功、中斷、伺服器上下線、客戶端初始化
- **狀態同步事件**：`sync_state_update`（承載所有遠端更新）、`experiment:sync:remote_state`（board 端中繼）
- **實驗生命週期事件**（前端本機派發）：started / paused / resumed / stopped / id_changed / combination_selected
- **其他 UI 事件**：電源狀態、設定重設、同步面板開關等本機事件

完整事件名稱與常數對照請參閱 `js/constants/sync-events-constants.js`。

---

## 環境變數設定 (.env)

### 設定範例

```env
NODE_ENV=production
PORT=7645
HOST=0.0.0.0
CORS_ORIGIN=http://localhost:7645
DB_PATH=../runtime/database/experiment.db
```

完整參數清單與預設值請參閱 `server/.env.example`，主要參數包含：連接埠（`PORT`）、資料庫路徑（`DB_PATH`）、工作階段逾時（`SESSION_TIMEOUT`）、WebSocket 心跳間隔（`WS_HEARTBEAT_INTERVAL`）等。

### 設定優先級

系統設定的優先級（高到低）：

1. **環境變數** (`server/.env`) - 最高優先級
2. **server/config/\*.js** - 預設值定義
3. **硬編碼常數** - 最低優先級

若需要改變執行行為，優先修改 `server/.env`，避免修改源代碼。

---

## 命名規範

| 使用情境 | 命名風格 | 範例 |
|---|---|---|
| JS 變數與函數 | `camelCase` | `sessionId`, `generateShareCode()`, `updateLastActive()` |
| 資料庫欄位 | `snake_case`（SQLite 慣例） | `session_id`, `created_at`, `share_code` |
| 環境變數與常數 | `UPPER_SNAKE_CASE` | `SESSION_TIMEOUT`, `WS_HEARTBEAT_INTERVAL` |
| 設定物件屬性 | `camelCase` | `SERVER_CONFIG.session.timeout` |
| 類別與服務 | `PascalCase` | `SessionService`, `WebSocketManager` |

---

## 版本管理系統

專案使用 git commit hash 作為版本識別碼，提供更好的版本追蹤。

### 自動化版本更新

```bash
# 更新所有版本資訊（推薦）
npm run version:update

# 僅更新 git commit hash
npm run version:hash

# 查看目前版本狀態
npm run version:status
```

### Git Commit Hash 說明

- **完整 hash**: 40 位字符 (如: `09f31f10f01bbc67831146436a49f6de71c02b46`)
- **短 hash**: 預設 7 位 (如: `09f31f1`)
- **專案使用**: 7 位短 hash (如: `09f31f1`)

版本號格式: `major.minor.gitHash` (如: `2.5.da4fff5`)

---

## 實驗日誌運作方式

### 架構摘要

- 本機模式：面板端可在實驗結束後輸出 JSONL 供本機儲存。
- 同步模式：事件透過 WebSocket 廣播，管理端與面板端維持進度一致。
- 管理端日誌採用記憶體緩衝區 + IndexedDB，並可透過 API 寫入伺服器檔案備份。

### 儲存與存取邊界

- 伺服器端儲存路徑：`runtime/experiment-data/`
- 前端僅透過 API 存取日誌：`/api/record/*`
- 日誌目錄可由 `config.json` 的 `experiment.logsDirectory` 配置
