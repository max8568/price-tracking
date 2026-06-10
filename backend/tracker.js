const http = require('http');
const cron = require('node-cron');
const config = require('../config');
const store = require('../shared/store');
const scraper = require('./scraper');
const telegram = require('./telegram');
const VERSION = require('./version');

// 抓單一商品現價，與「前一小時價格」(currentPrice)比較，有變動發 Telegram。
// opts.notifyNew=true：新增商品後的立即取價，成功/失敗都另發 Telegram 告知。
// 回傳 { changed, price } 或 null（取價失敗）
async function trackOne(product, opts = {}) {
  let scraped;
  try {
    scraped = await scraper.fetchProduct(product.url);
  } catch (err) {
    console.error(`[tracker] 取價失敗 ${product.url}：${err.message}`);
    store.update(product.id, (p) => {
      p.lastChecked = new Date().toISOString();
      p.lastError = err.message;
    });
    if (opts.notifyNew) {
      await telegram
        .notifyNewProductFailed({ url: product.url, error: err.message })
        .catch((e) => console.error('[tracker] 新增取價失敗通知發送失敗：', e.message));
    }
    return null;
  }

  const prev = product.currentPrice; // 前一小時的價格（null 表示首次）
  const now = scraped.price;
  const ts = new Date().toISOString();

  store.update(product.id, (p) => {
    if (scraped.name && (!p.name || p.name === p.url)) p.name = scraped.name;
    if (scraped.site) p.site = scraped.site;
    p.prevPrice = prev;
    p.currentPrice = now;
    p.lastChecked = ts;
    p.lastError = null;
    // history 只保留最近一次紀錄（前一次的價格已存在 prevPrice）
    p.history = [{ time: ts, price: now }];
  });

  let changed = false;
  if (prev != null && now !== prev) {
    changed = true;
    console.log(`[tracker]  ! ${product.name} 變價 ${prev} → ${now}，發送通知`);
    await telegram.notifyPriceChange({
      name: scraped.name || product.name,
      url: product.url,
      oldPrice: prev,
      newPrice: now,
    });
  } else if (prev == null) {
    console.log(`[tracker]  + ${scraped.name || product.url} 建立首次基準價 NT$${now}`);
  } else {
    console.log(`[tracker]  = ${product.name} 價格未變（NT$${now}）`);
  }

  if (opts.notifyNew) {
    console.log(`[tracker]  ✉ 發送新增商品通知：${scraped.name || product.url}（NT$${now}）`);
    await telegram
      .notifyNewProduct({ name: scraped.name || product.name, url: product.url, price: now })
      .catch((e) => console.error('[tracker] 新增商品通知發送失敗：', e.message));
  }
  return { changed, price: now };
}

// 每小時跑一次：逐一追蹤所有商品
let running = false;
async function trackAll() {
  if (running) {
    console.log('[tracker] 上一輪尚未結束，跳過本次');
    return;
  }
  running = true;
  try {
    const products = store.list();
    console.log(`[tracker] trackAll 開始，共 ${products.length} 個商品（${new Date().toLocaleString('zh-TW', { hour12: false })}）`);
    for (const product of products) {
      await trackOne(product);
    }
    console.log('[tracker] trackAll 完成');
  } finally {
    running = false;
  }
}

// 內部觸發伺服器：前端新增商品後 POST /track/:id，立即對該筆取價（僅綁 localhost）。
// 立即回 202 後才開始爬蟲，避免讓前端等待整段（可能數十秒）的取價流程。
function startTriggerServer() {
  const server = http.createServer((req, res) => {
    // 允許 file:// 開啟的 tracker.html 跨來源讀取（僅綁 localhost，風險低）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    // 版本查詢：供前端顯示後端版本號
    if (req.method === 'GET' && req.url === '/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ version: VERSION }));
    }
    const m = req.url && req.url.match(/^\/track\/([^/?#]+)$/);
    if (req.method !== 'POST' || !m) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    const id = decodeURIComponent(m[1]);
    const product = store.getById(id);
    if (!product) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '找不到商品' }));
    }
    console.log(`[tracker] 收到前端立即取價請求：${product.url}`);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));
    // 與每小時排程共用同一個 browser instance、各自開 context，併發執行安全。
    // notifyNew：取價完成後立即發 Telegram 告知（成功附價格，失敗附原因）。
    trackOne(product, { notifyNew: true }).catch((e) =>
      console.error('[tracker] 立即取價例外：', e)
    );
  });
  server.on('error', (e) => console.error(`[tracker] 觸發伺服器錯誤：${e.message}`));
  server.listen(config.trackerPort, config.host, () => {
    console.log(`[tracker] 立即取價觸發埠： http://${config.host}:${config.trackerPort}`);
  });
}

async function start() {
  console.log(`[tracker] 後端追蹤啟動 v${VERSION}，排程='${config.trackCron}'（每小時比對前一小時價格）`);

  // 內部觸發埠先開，讓前端新增商品後可立即通知取價
  startTriggerServer();

  // 排程先掛上，不受網路就緒影響（cron 觸發時網路通常已就緒，且發送本身會重試）
  cron.schedule(config.trackCron, () => {
    trackAll().catch((e) => console.error('[tracker] trackAll 例外：', e));
  });

  // 開機自啟時網卡/DNS 可能尚未準備好，先等網路就緒再發啟動通知，避免通知遺失。
  await telegram.waitForNetwork({ timeoutMs: 120000 });

  // Telegram 指令監聽：/add [商品連結] 加入追蹤並立即取價、/del [商品連結] 移除追蹤
  // （/add 的驗證/去重邏輯與前端 POST /api/products 一致）
  telegram.startCommandListener({
    onAddItem: async (url) => {
      if (!/^https?:\/\//i.test(url)) return '⚠️ 請提供有效的商品網址（http/https）';
      if (store.findByUrl(url)) return '⚠️ 此商品網址已在追蹤清單中';
      const item = store.add({ url }); // store.add 內建 detectSite，會寫入 products.json
      trackOne(item, { notifyNew: true }).catch((e) =>
        console.error('[tracker] /add 立即取價例外：', e)
      );
      return `✅ 已加入追蹤（代碼：${item.code}），正在取得價格…`;
    },
    // 接受 4 碼代碼或商品連結
    onDeleteItem: async (input) => {
      const item = store.findByUrl(input) || store.findByCode(input);
      if (!item) return '⚠️ 追蹤清單中找不到此商品（請輸入 4 碼代碼或商品連結）';
      store.remove(item.id);
      console.log(`[tracker] /del 移除追蹤：[${item.code}] ${item.name}`);
      return `🗑 已移除追蹤：${telegram.escapeMd(item.name)}`;
    },
    onListItems: async () => {
      const products = store.list();
      if (!products.length) return '📋 追蹤清單是空的，用 /add [商品連結] 新增。';
      const lines = [`📋 *追蹤清單*（共 ${products.length} 項）`];
      products.forEach((p, i) => {
        const price =
          p.currentPrice == null ? '尚未取得' : `NT$${p.currentPrice.toLocaleString()}`;
        let priceLine = `　　💰 現價　${price}`;
        if (p.prevPrice != null && p.prevPrice !== p.currentPrice) {
          priceLine += p.currentPrice > p.prevPrice ? ' 🔼' : ' 🔽';
        }
        const prev = p.prevPrice == null ? '—' : `NT$${p.prevPrice.toLocaleString()}`;
        const checked = p.lastChecked
          ? new Date(p.lastChecked).toLocaleString('zh-TW', { hour12: false })
          : '尚未檢查';
        lines.push('');
        lines.push(`${i + 1}. [${telegram.escapeMd(p.name)}](${p.url})`);
        lines.push(`　　🏷 代碼　\`${p.code}\``);
        lines.push(`　　🏪 站別　${p.site}`);
        lines.push(priceLine);
        lines.push(`　　💸 前次　${prev}`);
        lines.push(`　　🕐 檢查　${checked}`);
        if (p.lastError) lines.push(`　　⚠️ ${telegram.escapeMd(p.lastError)}`);
      });
      return lines.join('\n');
    },
  });

  // 服務啟動通知（開機自啟、手動重啟、崩潰自動重啟都會發）
  const startedAt = new Date().toLocaleString('zh-TW', { hour12: false });
  const count = store.list().length;
  telegram
    .sendMessage(`🟢 *價格追蹤服務已啟動* v${VERSION}\n時間：${startedAt}\n追蹤商品：${count} 項`)
    .catch((e) => console.error('[tracker] 啟動通知發送失敗：', e.message));

  if (config.runOnStart) {
    // 啟動時先跑一次：替新加入(只有網址)的商品補上名稱與基準價
    trackAll().catch((e) => console.error('[tracker] 啟動首跑例外：', e));
  }
}

async function shutdown() {
  console.log('[tracker] 關閉中…');
  await scraper.closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 直接執行 (node backend/tracker.js) 即啟動；被 require 時僅匯出
if (require.main === module) {
  start().catch((e) => console.error('[tracker] 啟動例外：', e));
}

module.exports = { start, trackAll, trackOne };
