const path = require('path');
const http = require('http');
const express = require('express');
const config = require('../config');
const store = require('../shared/store');
const { detectSite } = require('../shared/util');
const FRONTEND_VERSION = require('./version');

// 向後端觸發埠查詢後端版本號；後端未啟動或逾時則回 null
function fetchBackendVersion() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: config.host, port: config.trackerPort, path: '/version', timeout: 2000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).version ?? null);
          } catch (_) {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

// 通知後端對某商品立即取價（fire-and-forget）。後端沒開時不影響新增，
// 僅記一筆警告，價格仍會在下一輪每小時排程補上。
function triggerImmediateFetch(id) {
  const req = http.request(
    {
      host: config.host,
      port: config.trackerPort,
      path: '/track/' + encodeURIComponent(id),
      method: 'POST',
      timeout: 3000,
    },
    (res) => res.resume() // 丟棄回應內容
  );
  req.on('error', (e) =>
    console.warn(`[frontend] 通知後端立即取價失敗（將等下一輪排程）：${e.message}`)
  );
  req.on('timeout', () => req.destroy());
  req.end();
}

// 前端：只負責顯示、輸入、刪除，直接讀寫共用的 products.json。
// 不爬蟲、不發 Telegram —— 那些由後端 (backend/tracker.js) 負責。
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 顯示：取得追蹤清單
app.get('/api/products', (req, res) => {
  res.json({ products: store.list() });
});

// 版本號：前端版本 + 後端版本（後端離線時 backend 為 null）
app.get('/api/version', async (req, res) => {
  const backend = await fetchBackendVersion();
  res.json({ frontend: FRONTEND_VERSION, backend });
});

// 輸入：新增商品（只存網址；名稱與價格由後端下一輪追蹤時補上）
app.post('/api/products', (req, res) => {
  const url = (req.body && req.body.url ? String(req.body.url) : '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: '請提供有效的商品網址（http/https）' });
  }
  if (store.findByUrl(url)) {
    return res.status(409).json({ error: '此商品網址已在追蹤清單中' });
  }
  const item = store.add({ url, site: detectSite(url) });
  triggerImmediateFetch(item.id); // 通知後端立即取價，不阻塞回應
  res.status(201).json({ product: item });
});

// 刪除
app.delete('/api/products/:id', (req, res) => {
  const ok = store.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: '找不到商品' });
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(config.port, config.host, () => {
  console.log(`[frontend] 管理介面已啟動： http://${config.host}:${config.port}`);
  console.log('[frontend] 注意：價格追蹤與 Telegram 通知由後端服務 (backend/tracker.js) 負責。');
});
