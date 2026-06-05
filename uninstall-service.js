const Service = require('node-windows').Service;
const path = require('path');

const svc = new Service({
  name: 'Price Tracking Bot',
  script: path.join(__dirname, 'backend', 'tracker.js'),
});

svc.on('uninstall', () => {
  console.log('服務已卸載。');
  console.log('exists: ', svc.exists);
});

svc.on('error', (err) => {
  console.error('卸載服務發生錯誤：', err);
});

console.log('正在卸載 Price Tracking Bot 服務（需系統管理員權限）…');
svc.uninstall();
