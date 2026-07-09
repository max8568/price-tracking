const { chromium } = require('playwright');
const config = require('../config');
const { detectSite, parsePrice, cleanName } = require('../shared/util');

let browserPromise = null;

// 共用單一 browser instance（懶啟動）
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      await b.close();
    } catch (_) {
      /* ignore */
    }
    browserPromise = null;
  }
}

// 各站退回用 CSS 選擇器（依實際頁面結構，列多個候選）
const SITE_SELECTORS = {
  momo: {
    name: ['#osmGoodsName', '.prdnoteArea h1', 'meta[property="og:title"]'],
    // meta product:price:amount 是實際售價（促銷價）；.seoPrice 為市售價(較高)，置後備援
    price: [
      'meta[property="product:price:amount"]',
      '#price',
      '.priceArea .price',
      'li.special_price',
      '.seoPrice',
    ],
  },
  pchome: {
    name: ['h1', 'meta[property="og:title"]'],
    // PChome 24h(SPA)：主商品售價為第一個 c-prodInfoV2__priceValue--m；--xs 多為原價(較高)
    price: ['.c-prodInfoV2__priceValue--m', '#PriceTotal', '.price .value', 'span.value'],
  },
  shopee: {
    name: ['div[class*="product-briefing"] span', 'h1', 'meta[property="og:title"]'],
    price: [
      'meta[property="product:price:amount"]',
      'div[class*="product-price"]',
      'div[class*="pqTWkA"]',
    ],
  },
  unknown: {
    name: ['meta[property="og:title"]', 'h1', 'title'],
    price: ['meta[property="product:price:amount"]', '[itemprop="price"]'],
  },
};

// 解析頁面內所有 JSON-LD，找 schema.org Product 的 offers.price 與 name
async function extractFromJsonLd(page) {
  const blocks = await page
    .$$eval('script[type="application/ld+json"]', (nodes) => nodes.map((n) => n.textContent))
    .catch(() => []);

  for (const block of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(block);
    } catch (_) {
      continue;
    }
    const candidates = [];
    const pushAll = (v) => {
      if (Array.isArray(v)) v.forEach(pushAll);
      else if (v && typeof v === 'object') {
        candidates.push(v);
        if (v['@graph']) pushAll(v['@graph']);
      }
    };
    pushAll(parsed);

    for (const node of candidates) {
      const type = node['@type'];
      const hasType = (t) => type === t || (Array.isArray(type) && type.includes(t));
      if (!hasType('Product') && !hasType('ProductGroup')) continue;

      // ProductGroup（momo 2026 新版商品頁）：offers 藏在 hasVariant[n] 內，
      // 商品名稱取群組層 name（variant 的 name 只是規格，如「單一規格」）
      const offerSources = hasType('ProductGroup')
        ? [].concat(node.hasVariant || []).map((v) => v && v.offers)
        : [node.offers];
      for (let offers of offerSources) {
        if (Array.isArray(offers)) offers = offers[0];
        const priceRaw = offers && (offers.price ?? offers.lowPrice ?? offers.highPrice);
        const price = parsePrice(priceRaw);
        if (price != null) {
          return { name: node.name ? String(node.name).trim() : null, price };
        }
      }
    }
  }
  return null;
}

// 用 CSS 選擇器逐一嘗試取文字
async function extractBySelectors(page, selectors, isPrice) {
  for (const sel of selectors) {
    try {
      const isMeta = sel.startsWith('meta');
      let value;
      if (isMeta) {
        value = await page.getAttribute(sel, 'content').catch(() => null);
      } else {
        const el = await page.$(sel);
        if (!el) continue;
        value = (await el.textContent())?.trim();
      }
      if (!value) continue;
      if (isPrice) {
        const p = parsePrice(value);
        if (p != null) return p;
      } else {
        return value.trim();
      }
    } catch (_) {
      /* try next selector */
    }
  }
  return null;
}

// 抓取單一商品的 { name, price, site }；失敗丟出錯誤
async function fetchProduct(url) {
  const site = detectSite(url);
  const { timeoutMs, retries, userAgent } = config.scrape;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const browser = await getBrowser();
    const context = await browser.newContext({
      userAgent,
      locale: 'zh-TW',
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.waitForTimeout(2500); // 給動態渲染一點時間

      // 1) JSON-LD 優先
      let result = await extractFromJsonLd(page);

      // 2) 退回各站 CSS 選擇器
      const selectors = SITE_SELECTORS[site] || SITE_SELECTORS.unknown;
      if (!result || result.price == null) {
        const price = await extractBySelectors(page, selectors.price, true);
        const nameFromLd = result && result.name;
        result = { name: nameFromLd, price };
      }
      if (!result.name) {
        result.name = await extractBySelectors(page, selectors.name, false);
      }
      if (!result.name) {
        result.name =
          (await page.getAttribute('meta[property="og:title"]', 'content').catch(() => null)) ||
          (await page.title().catch(() => null));
      }

      await context.close();

      if (result.price == null) {
        throw new Error('無法從頁面取得價格（可能為反爬、需登入或選擇器已失效）');
      }
      return { site, name: cleanName(result.name) || url, price: result.price };
    } catch (err) {
      lastErr = err;
      await context.close().catch(() => {});
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 5000));
      }
    }
  }
  throw new Error(`取價失敗（${site}）：${lastErr ? lastErr.message : 'unknown'}`);
}

module.exports = { fetchProduct, closeBrowser };
