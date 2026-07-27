# Kairo | 開流

用於機台 MR（混合實境）教學的多裝置同步互動系統，包含 Panel（受試者端）與 Board（管理端）。

## 功能特色

- **多裝置同步**：以工作階段為核心，同步實驗狀態與操作事件
- **雙模式運作**：支援本機模式與同步協作模式，自動切換
- **即時通訊**：`WebSocket` + `REST API`，支援重連與離線佇列
- **工作階段分享**：透過分享代碼快速加入協作
- **紀錄系統**：Record 模組 + IndexedDB 緩衝 + JSONL 伺服器備份
- **實驗日誌瀏覽器**：Archive 模組；時間軸 / 表格 / 原始視圖、時間戳編輯、重新標記工作區、另存新檔

## 技術堆疊

- **前端**：`Vanilla JavaScript` (`ES6+`)
- **即時通訊**：`WebSocket` + `REST API`
- **資料持久性**：`localStorage` + `sessionStorage` + `IndexedDB` + `SQLite`
- **樣式**：`CSS3` + 響應式設計（`Responsive Web Design`）
- **後端**：`Node.js` + `Express` + `SQLite`

## 文件

- [架構說明](docs/ARCHITECTURE.md) - 系統架構和設計文件
- [專案用語指南](docs/PROJECT_TERMINOLOGY_GUIDE.md) - 用語與翻譯規範

## 專案結構

```
kairo/
├── index.html              # 機台面板（受試者端）
├── board.html              # 實驗管理（研究者端）
├── archive.html            # 實驗日誌瀏覽器
├── js/                     # JavaScript 模組
│   ├── core/              # 核心功能（WebSocket、設定、校時、認證…）
│   ├── archive/           # 實驗日誌瀏覽與重標記
│   ├── board/             # 實驗管理頁面專用
│   ├── constants/         # 共用常數定義
│   ├── experiment/        # 實驗生命週期管理
│   ├── panel/             # 面板控制
│   ├── record/            # 日誌紀錄與檢視
│   ├── sync/              # 同步系統
│   └── ui/                # 通用 UI 元件
├── css/                   # 樣式表（含 archive/ 子目錄）
├── data/                  # 靜態設定資料
├── assets/                # 資源檔案
├── docs/                  # 文件資料夾
├── shared/                # 前後端共用常數（ws-protocol-constants.js）
├── runtime/               # 執行時資料（不上傳 GitHub）
│   ├── database/         # 資料庫檔案
│   ├── experiment-data/  # JSONL 實驗日誌
│   └── sessions/         # 工作階段檔案
└── server/                # Node.js 後端服務
```

## 開發者

謝祥紫 Xiang-zi Xie(@zisunny104)、GitHub Copilot、Claude Code

## 更新日誌

#### v2.9.604d66d - 新增最終分析與問卷分析、名單比對強化

- 新增「最終分析」分頁：卡片式統計模板、同意率分析、依名單比對彙整資料
- 新增「問卷分析」分頁：SSQ／NASA-TLX／SUS／UEQ 描述統計、圖表與異常檢查
- 名單比對強化：一鍵重新讀入、刪除鎖定防誤觸、存檔衝突改為讓使用者選擇、草稿同步伺服器
- 匯出功能擴充：xlsx 支援多分頁匯出、下載檔名統一加時間戳
- 修正多處樣式衝突與容器在大螢幕下的顯示問題，並強化整體安全性與效能

#### v2.7.cab1de5 - Archive 編輯器強化

- 拆分 `archive-page-manager.js` 為 7 個獨立模組（sidebar / viewer / editor / remark / init / constants）
- 新增重新標記工作區：多選平移、drag-to-mark、刪除事件（可撤回）
- 編輯記錄面板：單筆撤回 / 撤回到某筆，工具列「已編輯」指示可點擊
- 另存新檔：加 `_edited` 後綴，原始檔唯讀保護；`commitAsOriginal()` 重設基準線
- `ArchiveFileState` 引入 `_origIdx` 穩定對應，修正刪除後綠色標記誤判
- Record API 加入 Token 授權，Archive 頁面送出 admin token
- 修正草稿重載後 `_origIdx` 遺失導致綠色提示消失的問題

#### v2.6.c906572 - 新增 Archive 與安全性修復

- 響應式頁面切換 + 新增 archive 頁面
- 實驗結束後 UI 重置、日誌節流
- 修正記憶體洩漏、競爭條件、空值崩潰
- 計時器、格式化、WebSocket 效能改善
- 伺服器安全性強化

#### v2.6.35482eb - Panel 同步與實驗流程強化

- 重構 panel 同步與 UI 樣式，提升實驗狀態同步穩定性
- 修正 board / panel 配置與元資料更新，減少同步異常
- 改善實驗控制與面板佈局，修復面板關閉與互動問題
- 強化後端服務安全與流程一致性

#### v2.6.fd602b4 - 系統穩定性修正與架構收斂

- 修復實驗控制按鈕顯示與 panel UI 行為
- 修正 POWER 廣播、stale session、ConfigManager 初始化
- 同步面板 modal 新增版本號顯示

#### v2.5.f184499 - 調整部分系統流程與修正錯誤
- 新增/修正日誌與錯誤處理
- 同步機制與 UI 初始化流程調整
- 核心設定、WebSocket、時間同步相關修正
- 實驗流程與面板互動邏輯更新

#### v2.5.9421b7e - 同步系統與實驗流程修正
- 修正 WebSocket 同步序號問題
- 讓 board 同步完成標記更準確
- 加強 remote pause/resume 穩定性

#### v2.5.0c67292 - 特殊動作與冷卻修補

- 修正特殊狀態動作流程
- 收斂冷卻補丁行為

#### v2.5.917995b - 同步常數對齊與語法清理

- 舊版同步 key 完整移除
- 協議常數對齊 WS_PROTOCOL
- Board 骨架載入動畫
- CSS 語法修正
- 其他小清理

#### v2.5.2ec0f36 - 架構整理與流程修正

- 統一事件系統與 Logger 導入
- 改善手勢與實驗流程同步

#### v2.5.56abddf - 紀錄與同步流程整理

- `record` 命名已全面對齊前端、後端、樣式與文件，移除舊版相容層與過時模組名
- Panel / Board 初始化流程收斂為單一路徑，減少重複綁定與補做式渲染
- 啟動時自動清除舊版瀏覽器儲存資料，避免舊 IndexedDB 與 localStorage 一直殘留
- 架構藍圖與版本資訊同步更新，維持文件與現況一致

#### v2.4.d3fdddb - 同步與流程收斂

- 統一 bootstrap 載入與版本化資源處理，入口頁改由共同初始化流程管理
- 動作完成 / 進入事件分離，board 與 panel 的同步責任更清楚，起始步驟可正確進入
- 關閉目前工作階段與 panel 本機關機分流，避免自動結束實驗帶到 board 端
- 日誌載入改為延後更新與分批讀取，並補強複製即時日誌與完成樣式

#### v2.3.f366c7b - 同步與模組化更新

- **ES 模組化**：面板與同步模組全面轉為 ES module，明確注入依賴並收斂全域狀態
- **初始化流程**：集中 PanelPageManager 初始化與依賴串接，統一 UI、同步與實驗管理入口
- **同步事件整理**：統一事件常數與廣播流程，跨裝置狀態更新更一致
- **日誌 UI 拆分**：日誌列表、篩選、統計與彈窗獨立模組，提升維護性
- **電源與流程細化**：電源動作完成同步與冷卻流程計算邏輯明確化

#### v2.2.bc0460d - 模組重構與清理

- **移除過時的模組文件**：刪除舊版 panel 實驗模組與重複工具文件
- **重構實驗管理架構**：從 board.html 獨立管理 experiment 模組，新增系統協調器
- **重構UI與樣式系統**：合併控制項模組，重構CSS結構
- **清理測試與文檔**：移除舊版測試規格，更新架構文檔

#### v2.1.5d6c7ea - 同步系統與後端強化

- **同步系統改進**：統一事件常數（SyncEvents）、新增 LOCAL 角色與斷線/還原流程
- **QR Code 系統改善**：相機排序/過濾、掃描器重試與偵錯資訊、QR Code 產生 target 支援
- **後端強化**：新增 /metrics、rate limiting、低頻 Session 驗證與心跳穩定性修正

#### v2.6.379fa9d - 同步系統架構完善

- **扁平化伺服端工作階段架構**：簡化資料結構與存取邏輯
- **後端服務調整**：WebSocket 心跳機制與 HTTP 心跳檢測協同運作機制
-**前端同步整合**：心跳檢測定時器與 WebSocket 狀態監視整合
- **日誌規範化**：統一日誌訊息格式與內容
- **專案用語規範化**：統一用語以提升可讀性與維護性日誌系統規範化

#### v2.0 - 後端架構重構

- 建立多裝置同步與實驗管理平台
- 支援 JSONL 日誌、QR Code 分享與 SQLite 後端

#### v1.5.gv0tm - 階段性成果上傳

- 多裝置同步系統基礎實現
- 實驗日誌記錄和管理
- SSE 即時通訊機制
- QR Code 工作階段分享
- 版本管理系統
