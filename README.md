# 商品價格追蹤工具

追蹤購物網站（momo / PChome 24h / 蝦皮 Shopee）指定商品的價格變動：
**後端每小時自動比對「前一小時」的價格，有變動就透過 Telegram 通知。**
前端提供網頁介面新增、檢視、刪除追蹤商品。後端可註冊為 Windows 服務開機自動啟動。

## 架構（前後端分離，共用資料檔）

```
price-tracking/
├─ data/products.json     ← 共用資料檔（前端讀寫、後端讀寫）
├─ shared/                ← 前後端共用
│   ├─ store.js            讀寫 products.json
│   └─ util.js             站別判斷、價格清洗、名稱整理（無重依賴）
├─ backend/               ← 純背景，無網頁/無 API
│   ├─ tracker.js          每小時追蹤主程式（服務入口）
│   ├─ scraper.js          Playwright 取價
│   └─ telegram.js         變價通知（沿用 pttTelegramBot 的 bot）
├─ frontend/              ← 只負責顯示 / 輸入 / 刪除
│   ├─ server.js           Express，只讀寫 products.json（不爬蟲、不發 TG）
│   └─ public/             網頁 UI
├─ install-service.js     將 backend/tracker.js 註冊為開機自啟服務
└─ uninstall-service.js
```

- **後端 `backend/tracker.js`**：常駐、開機自啟。每小時（`0 * * * *`）讀 `products.json`，
  爬每個商品現價，與該商品上一輪（前一小時）的價格比較；不同則發 Telegram。
- **前端 `frontend/server.js`**：需要時才開。只做新增（存網址）、顯示、刪除，直接讀寫同一個 `products.json`。
- 兩者**不互相呼叫**，只透過共用的 `data/products.json` 溝通。
- 新增商品時前端只存網址；**名稱與價格由後端下一輪追蹤時補上**（後端啟動時也會先跑一次）。

## 功能對照（規格）

| 規格 | 實作 |
| --- | --- |
| 1. 每小時比對前一小時價格 | `backend/tracker.js`，node-cron `0 * * * *` |
| 2. 變價發 Telegram（沿用 pttTelegramBot） | `backend/telegram.js`，token/chat 於 `config.js` |
| 3. 輸入商品網址 | 前端輸入框 → `POST /api/products`（只存網址） |
| 4. 檢視追蹤商品頁面 | `http://127.0.0.1:3000` |
| 5. 刪除功能 | 每列「刪除」鈕 → `DELETE /api/products/:id` |
| 6. 開機自啟 | `install-service.js`（node-windows，註冊後端） |

## 安裝（詳細步驟）

以下為從零到「開機自動每小時追蹤 + Telegram 通知」的完整流程。Windows 11 + PowerShell 環境。

### 前置需求

| 項目 | 說明 / 確認方式 |
| --- | --- |
| Node.js 18 以上 | `node -v`（應顯示 v18 或更新）。沒有的話到 https://nodejs.org 安裝 LTS 版 |
| npm | 隨 Node.js 一起安裝，`npm -v` 可確認 |
| 作業系統 | Windows（開機自啟服務使用 node-windows，僅支援 Windows） |
| 系統管理員權限 | 「安裝為 Windows 服務」步驟需要（一般安裝/前景執行則不需要） |
| Telegram | 一個 bot token 與要接收通知的 chat id（預設沿用既有的，見下方步驟 4） |

### 步驟 1：進入專案目錄

```powershell
cd [your path]\price-tracking
```

### 步驟 2：安裝相依套件

```powershell
npm install
```

這會安裝 express、node-cron、node-telegram-bot-api、node-windows、playwright、uuid，並透過 `postinstall` 自動安裝 Playwright 的 chromium 瀏覽器。

接著從範本建立 `config.js`（此檔含 token，已列入 `.gitignore` 不會被提交）：

```powershell
Copy-Item config.example.js config.js
```

然後依步驟 4 填入你的 Telegram token 與 chat id。

### 步驟 3：確認 chromium 已安裝（前景執行用）

`npm install` 的 `postinstall` 通常已裝好。若當時失敗（例如網路中斷），手動補裝：

```powershell
npx playwright install chromium
```

> 注意：這一步裝到的是「使用者預設路徑」，供 `npm run backend` 前景執行使用。
> 若要裝成 **Windows 服務（開機自啟）**，瀏覽器必須改裝到專案內，請改看下方〈安裝為 Windows 服務〉的步驟，不要只靠這裡。

### 步驟 4：設定 Telegram

通知對象設定在 `config.js`（由步驟 2 從 `config.example.js` 複製而來）。填入你的 token 與 chat id，兩種方式擇一：

- **方式 A — 直接改 `config.js`**：修改 `TELEGRAM_TOKEN` 與 `TELEGRAM_CHAT_IDS`。
- **方式 B — 用環境變數（不動程式碼，建議）**：
  ```powershell
  $env:TG_TOKEN="你的bot token"
  $env:TG_CHAT_IDS="chatid1,chatid2"   # 多個用逗號分隔
  ```
  （環境變數只在當前 PowerShell 視窗有效；服務模式請寫進 `config.js` 或在 `install-service.js` 的 `env` 設定。）

設定值對照見下方〈設定（config.js）〉。

### 步驟 5：先用前景模式驗證能跑、能通知

正式裝成服務前，建議先跑一次確認爬蟲與 Telegram 都正常（詳見下方〈開發 / 前景執行〉與〈測試變價通知〉）：

```powershell
npm run backend
```

啟動後 Telegram 應收到「🟢 價格追蹤服務已啟動」訊息，console 也會印出排程與首跑結果。確認無誤即可 Ctrl+C 結束，接著裝成服務。

## 開發 / 前景執行

開兩個終端機（後端常駐、前端視需要）：

```powershell
# 終端機 1：後端追蹤（每小時跑，啟動時先跑一次）
npm run backend

# 終端機 2：前端管理介面（Express 版，可選）
npm run frontend
# 開啟 http://127.0.0.1:3000
```

## 前端：單檔 HTML（免 npm run frontend，推薦）

不想每次都跑 `npm run frontend`，可改用專案根目錄的 **`tracker.html`**：

1. **用 Chrome 或 Edge** 開啟（雙擊即可，或拖進瀏覽器）。
   - 此功能使用 File System Access API，**僅支援 Chrome / Edge**；Firefox/Safari 不支援。
2. 第一次點「**連線 products.json**」，選擇 `\data\products.json`。
3. 之後此瀏覽器會**記住該檔**，下次開啟自動重連（必要時瀏覽器會請你按一下「允許」，但不必再重選檔案）。

這個單檔直接讀寫後端在用的同一個 `data/products.json`，所以新增/刪除後，後端每小時追蹤照常運作。
> 註：基於瀏覽器安全限制，「第一次」一定要手動選一次檔案來授權；之後才能自動重連，無法完全零點擊。

## 安裝為 Windows 服務（後端開機自啟，規格 6）

服務以 LocalSystem 帳號執行，**讀不到使用者 AppData 下的 Playwright 瀏覽器**，
因此需把瀏覽器裝到專案內並透過環境變數指定路徑。請以**系統管理員 PowerShell**執行：

```powershell
cd price-tracking
# 1) 把 chromium 裝到專案內（與服務設定的路徑一致）
$env:PLAYWRIGHT_BROWSERS_PATH="[your path]\price-tracking\ms-playwright"
npx playwright install chromium
# 2) 安裝並啟動後端服務
node install-service.js
```

服務管理（系統管理員 PowerShell）：

```powershell
Get-Service "Price Tracking Bot"
Start-Service "Price Tracking Bot"
Stop-Service  "Price Tracking Bot"
Restart-Service "Price Tracking Bot"   # 改後端程式碼後需重啟
node uninstall-service.js              # 卸載
```

> 後端服務開機自啟後就會持續每小時追蹤。要管理清單時，再執行 `npm run frontend` 開網頁即可。

### 驗證安裝是否成功

1. **服務狀態**：`Get-Service "Price Tracking Bot"` 顯示 `Running`。
2. **啟動通知**：Telegram 收到「🟢 價格追蹤服務已啟動」訊息。
3. **執行紀錄**：查看 daemon log（會看到排程啟動、trackAll 結果）：
   ```powershell
   Get-Content backend\daemon\pricetrackingbot.out.log -Tail 20
   Get-Content backend\daemon\pricetrackingbot.err.log -Tail 20   # 錯誤紀錄
   ```
4. **開機自啟**：重開機後，不必手動操作，服務會自啟並再次發送啟動通知。

### 疑難排解

| 症狀 | 原因 / 處理 |
| --- | --- |
| 服務 Running，但**開機後沒收到啟動通知** | 開機瞬間網卡/DNS 尚未就緒，發送失敗。本專案已加入「等網路就緒再發 + 失敗指數退避重試」（`backend/telegram.js` 的 `waitForNetwork`、`sendToChat`），改完程式後**務必重啟服務**才生效：`Restart-Service "Price Tracking Bot"`。仍無改善可在 err.log 確認是否為 `ENOTFOUND api.telegram.org`。 |
| err.log 出現 `ENOTFOUND api.telegram.org` | DNS 暫時解析不到，多為開機/斷網瞬間。可手動測：`Resolve-DnsName api.telegram.org`、`Test-NetConnection api.telegram.org -Port 443`。企業網路若封鎖 Telegram，需改走可連線的網路或設定 proxy。 |
| 服務取價一直失敗（err.log 有 Playwright 錯誤） | 多半是服務帳號找不到 chromium。請確認有照〈安裝為 Windows 服務〉把瀏覽器裝到專案內的 `ms-playwright`，且 `install-service.js` 的 `PLAYWRIGHT_BROWSERS_PATH` 指向同一路徑；改路徑後需重裝服務。 |
| `node install-service.js` 失敗 / 無法停止服務（存取被拒） | 未以系統管理員身分執行。請用「以系統管理員身分執行」的 PowerShell。 |
| 改了後端程式碼但沒效果 | 服務跑的是舊程式，需 `Restart-Service "Price Tracking Bot"`。 |
| 前景 `npm run backend` 可以、服務模式不行 | 通常是「服務帳號環境」差異（Playwright 路徑、網路/proxy），對照上面兩列檢查。 |

## 設定（config.js）

| 項目 | 預設 | 環境變數 |
| --- | --- | --- |
| 前端監聽埠 | 3000 | `PORT` |
| Telegram token | （於 config.js 填入） | `TG_TOKEN` |
| Telegram chat ids | （於 config.js 填入） | `TG_CHAT_IDS`（逗號分隔） |
| 追蹤排程 | `0 * * * *`（每小時） | `TRACK_CRON` |
| 啟動時先跑一次 | 是 | `RUN_ON_START=0` 可關閉 |

## 排程語意

每小時整點，後端對每個商品：抓現價 → 與上一輪（前一小時）記錄的價格比較 →
**不同**則發 Telegram，並把現價存為新的「前一次」價格。第一次追蹤只建立基準、不通知。

## 測試變價通知（不必等整點）

1. 先 `npm run backend` 跑一次，讓商品有了基準價（`currentPrice`）。
2. 手動把 `data/products.json` 裡某商品的 `currentPrice` 改成不同的數字（模擬「前一小時」價格）。
3. 再跑一次 `npm run backend`（或等下一個整點）→ 偵測到與前值不同 → 發 Telegram。

## 已知限制

- **蝦皮 Shopee** 反爬較嚴，無頭瀏覽器可能被擋或跳驗證，取價穩定度較低；取價失敗時商品仍會保留在清單，並於該列顯示警告。
- 各站改版可能使 CSS 選擇器失效；本工具以 **JSON-LD 結構化資料優先**、CSS 選擇器為輔。選擇器位於 `backend/scraper.js` 的 `SITE_SELECTORS`，可自行調整。
- 前端與後端同時寫入同一檔案時，採「寫暫存檔再 rename」降低損毀風險；但極高頻並發下仍建議錯開操作。
- Telegram bot token 直接寫在 `config.js`（沿用既有專案），請勿外流。
