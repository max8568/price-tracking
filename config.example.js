const path = require('path');

// --- 設定範本 ---
// 複製本檔為 config.js 後填入自己的值：
//   PowerShell:  Copy-Item config.example.js config.js
// config.js 已列入 .gitignore，不會被提交（避免 token 外洩）。
// 也可改用環境變數覆寫（部署/測試時較方便）。

// --- Telegram 設定 ---
const TELEGRAM_TOKEN = process.env.TG_TOKEN || '請填入你的 Telegram bot token';
const TELEGRAM_CHAT_IDS = (process.env.TG_CHAT_IDS
  ? process.env.TG_CHAT_IDS.split(',')
  : ['請填入 chat id 1', '請填入 chat id 2']
).map((s) => s.trim()).filter(Boolean);

module.exports = {
  // 前端網頁 UI 監聽埠（僅綁 localhost）
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '127.0.0.1',

  // Telegram
  telegramToken: TELEGRAM_TOKEN,
  telegramChatIds: TELEGRAM_CHAT_IDS,

  // 後端排程：每小時比對前一小時價格，有變動發 Telegram
  trackCron: process.env.TRACK_CRON || '0 * * * *', // 每小時整點
  // 後端啟動時是否先跑一次（補上新加入商品的名稱/價格基準）
  runOnStart: process.env.RUN_ON_START !== '0',

  // 共用資料檔（前端讀寫、後端讀寫）
  dataFile: path.join(__dirname, 'data', 'products.json'),

  // Playwright 取價設定（僅後端使用）
  scrape: {
    timeoutMs: Number(process.env.SCRAPE_TIMEOUT) || 45000,
    retries: Number(process.env.SCRAPE_RETRIES) || 2,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
};
