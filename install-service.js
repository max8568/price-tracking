const Service = require('node-windows').Service;
const path = require('path');

// 將 Playwright 瀏覽器安裝在專案內，並讓服務（LocalSystem 帳號）以同一路徑尋找
// 安裝前請先以同一環境變數安裝瀏覽器：
//   $env:PLAYWRIGHT_BROWSERS_PATH="F:\CodingTest\price-tracking\ms-playwright"; npx playwright install chromium
const BROWSERS_PATH = path.join(__dirname, 'ms-playwright');

// 自啟的是「後端追蹤程序」(backend/tracker.js)：每小時比價並發 Telegram。
// 前端管理介面 (frontend/server.js) 由使用者需要時自行開啟，不必常駐。
const svc = new Service({
  name: 'Price Tracking Bot',
  description: '購物網站商品價格追蹤後端：每小時比對前一小時價格並透過 Telegram 通知',
  script: path.join(__dirname, 'backend', 'tracker.js'),
  nodeOptions: ['--max_old_space_size=4096'],
  // 讓服務帳號找得到 Playwright 瀏覽器
  env: [
    { name: 'PLAYWRIGHT_BROWSERS_PATH', value: BROWSERS_PATH },
  ],
});

svc.on('install', () => {
  console.log('服務安裝成功！正在啟動…');
  svc.start();
});

svc.on('start', () => {
  console.log('Price Tracking Bot 後端服務已啟動，並會於開機時自動啟動。');
  console.log('開啟管理介面請另外執行： npm run frontend  → http://127.0.0.1:3000');
  console.log('查看服務： Get-Service "Price Tracking Bot"');
  console.log('卸載服務： node uninstall-service.js');
});

svc.on('alreadyinstalled', () => {
  console.log('服務已安裝。若要重裝，請先執行： node uninstall-service.js');
});

svc.on('error', (err) => {
  console.error('安裝服務發生錯誤：', err);
});

console.log('正在將 Price Tracking Bot 安裝為 Windows 服務（需系統管理員權限）…');
console.log('Playwright 瀏覽器路徑：', BROWSERS_PATH);
svc.install();
