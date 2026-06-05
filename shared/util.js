// 前後端共用的輕量工具（無重依賴，前端也可安全 require）

// 由 hostname 判斷站別
function detectSite(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (_) {
    return 'unknown';
  }
  if (host.includes('momoshop')) return 'momo';
  if (host.includes('pchome')) return 'pchome';
  if (host.includes('shopee')) return 'shopee';
  return 'unknown';
}

// 把 "NT$1,234"、"$ 1,234 元" 之類清成數字
function parsePrice(text) {
  if (text == null) return null;
  const str = String(text).replace(/[^\d.]/g, '');
  if (!str) return null;
  const num = Number(str);
  return Number.isFinite(num) && num > 0 ? num : null;
}

// 清掉商品名常見的站名後綴
function cleanName(name) {
  if (!name) return name;
  return String(name)
    .replace(/\s*[-|–]\s*(PChome.*|momo購物網.*|蝦皮購物.*|Shopee.*)$/i, '')
    .trim();
}

module.exports = { detectSite, parsePrice, cleanName };
