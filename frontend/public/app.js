const $ = (id) => document.getElementById(id);
const msg = $('msg');

const SITE_LABEL = { momo: 'momo', pchome: 'PChome', shopee: '蝦皮', unknown: '其他' };

function showMsg(text, cls) {
  msg.textContent = text || '';
  msg.className = cls || '';
}

function fmtPrice(p) {
  return p == null ? '—' : Number(p).toLocaleString();
}

function fmtTime(t) {
  return t ? new Date(t).toLocaleString('zh-TW', { hour12: false }) : '尚未檢查';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function load() {
  const res = await fetch('/api/products');
  const data = await res.json();
  const rows = $('rows');
  rows.innerHTML = '';
  const products = data.products || [];
  $('empty').style.display = products.length ? 'none' : 'block';

  for (const p of products) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.className = 'name';
    tdName.innerHTML =
      `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>` +
      (p.lastError ? `<div class="muted err">取價警告：${escapeHtml(p.lastError)}</div>` : '') +
      (p.currentPrice == null && !p.lastError ? `<div class="muted">等待後端首次取價…</div>` : '');

    // 4 碼短代碼（Telegram /del 可用）
    const tdCode = document.createElement('td');
    tdCode.innerHTML = `<span class="pill">${escapeHtml(p.code || '—')}</span>`;

    const tdSite = document.createElement('td');
    tdSite.innerHTML = `<span class="pill">${SITE_LABEL[p.site] || p.site}</span>`;

    const tdPrice = document.createElement('td');
    tdPrice.className = 'price';
    // 與前一次比較上色
    let cls = '';
    if (p.currentPrice != null && p.prevPrice != null) {
      if (p.currentPrice > p.prevPrice) cls = 'up';
      else if (p.currentPrice < p.prevPrice) cls = 'down';
    }
    tdPrice.innerHTML = `<span class="${cls}">${fmtPrice(p.currentPrice)}</span>`;

    const tdPrev = document.createElement('td');
    tdPrev.className = 'muted';
    tdPrev.textContent = fmtPrice(p.prevPrice);

    const tdTime = document.createElement('td');
    tdTime.className = 'muted';
    tdTime.textContent = fmtTime(p.lastChecked);

    const tdAct = document.createElement('td');
    tdAct.innerHTML = `<button class="btn-del" data-del="${p.id}">刪除</button>`;

    tr.append(tdName, tdCode, tdSite, tdPrice, tdPrev, tdTime, tdAct);
    rows.appendChild(tr);
  }
  return products;
}

// 新增後輪詢，等後端立即取價完成就更新畫面（最多約 60 秒，逾時則交給排程/手動重新整理）
async function pollForPrice(id, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const products = await load();
    const p = products.find((x) => x.id === id);
    if (!p) return; // 已被刪除
    if (p.currentPrice != null) {
      showMsg(`已取得「${p.name}」價格：NT$${fmtPrice(p.currentPrice)}`, 'ok');
      return;
    }
    if (p.lastError) {
      showMsg('取價失敗，請見清單中的警告訊息。', 'err');
      return; // 列內已顯示警告
    }
  }
  showMsg('取價需要較久，稍後請按「重新整理」查看。', '');
}

async function addProduct() {
  const url = $('url').value.trim();
  if (!url) return showMsg('請先輸入商品網址', 'err');
  $('addBtn').disabled = true;
  showMsg('新增中…');
  try {
    const res = await fetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) {
      showMsg(data.error || '新增失敗', 'err');
    } else {
      $('url').value = '';
      showMsg('已加入追蹤，正在請後端立即取價…', 'ok');
      await load();
      pollForPrice(data.product.id); // 背景輪詢，不阻塞按鈕
    }
  } catch (e) {
    showMsg('新增失敗：' + e.message, 'err');
  } finally {
    $('addBtn').disabled = false;
  }
}

document.addEventListener('click', async (e) => {
  const delId = e.target.getAttribute && e.target.getAttribute('data-del');
  if (delId) {
    if (!confirm('確定刪除此追蹤商品？')) return;
    await fetch('/api/products/' + delId, { method: 'DELETE' });
    await load();
  }
});

// 頁尾顯示前後端版本號（後端離線時顯示「離線」）
async function loadVersion() {
  try {
    const res = await fetch('/api/version');
    const v = await res.json();
    const backend = v.backend == null ? '離線' : 'v' + v.backend;
    $('ver').textContent = `前端 v${v.frontend}　/　後端 ${backend}`;
  } catch (e) {
    $('ver').textContent = '版本資訊載入失敗';
  }
}

$('addBtn').addEventListener('click', addProduct);
$('refreshBtn').addEventListener('click', () => { load(); loadVersion(); });
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') addProduct(); });

load();
loadVersion();
