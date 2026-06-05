const path = require('path');
const express = require('express');
const config = require('../config');
const store = require('../shared/store');
const { detectSite } = require('../shared/util');

// 前端：只負責顯示、輸入、刪除，直接讀寫共用的 products.json。
// 不爬蟲、不發 Telegram —— 那些由後端 (backend/tracker.js) 負責。
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 顯示：取得追蹤清單
app.get('/api/products', (req, res) => {
  res.json({ products: store.list() });
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
