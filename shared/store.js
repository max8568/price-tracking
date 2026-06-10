const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const { detectSite } = require('./util');

const DATA_FILE = config.dataFile;

// 確保資料檔存在
function ensureFile() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ products: [] }, null, 2), 'utf8');
  }
}

// 產生 4 碼唯一亂數代碼（a-z0-9），供 Telegram /del 以短碼刪除
const CODE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
function genCode(taken) {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!taken.has(code)) return code;
  }
}

function readAll() {
  ensureFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw || '{}');
    if (!Array.isArray(data.products)) data.products = [];
    // 一次性遷移：替沒有 code 的舊資料補上
    const taken = new Set(data.products.map((p) => p.code).filter(Boolean));
    let migrated = false;
    for (const p of data.products) {
      if (!p.code) {
        p.code = genCode(taken);
        taken.add(p.code);
        migrated = true;
      }
    }
    if (migrated) writeAll(data);
    return data;
  } catch (err) {
    console.error('[store] 讀取資料檔失敗，回傳空清單：', err.message);
    return { products: [] };
  }
}

// 同步寫入（先寫暫存檔再 rename，降低前後端同時寫入造成損毀的風險）
function writeAll(data) {
  ensureFile();
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function list() {
  return readAll().products;
}

function getById(id) {
  return readAll().products.find((p) => p.id === id) || null;
}

function findByUrl(url) {
  return readAll().products.find((p) => p.url === url) || null;
}

function findByCode(code) {
  const c = String(code).toLowerCase();
  return readAll().products.find((p) => p.code === c) || null;
}

// 新增商品。前端只給 url；名稱/價格留待後端追蹤時補上
function add(product) {
  const data = readAll();
  const now = new Date().toISOString();
  const item = {
    id: uuidv4(),
    code: genCode(new Set(data.products.map((p) => p.code))), // 4 碼短代碼，供 /del 使用
    url: product.url,
    name: product.name || product.url, // 佔位，後端補上真實名稱
    site: product.site || detectSite(product.url),
    currentPrice: product.currentPrice ?? null, // 前一小時價格
    prevPrice: null, // 再前一次價格
    createdAt: now,
    lastChecked: null,
    lastError: null,
    history: [],
  };
  data.products.push(item);
  writeAll(data);
  return item;
}

function remove(id) {
  const data = readAll();
  const before = data.products.length;
  data.products = data.products.filter((p) => p.id !== id);
  const removed = data.products.length < before;
  if (removed) writeAll(data);
  return removed;
}

// 以函式更新單一商品；updater(product) 直接修改傳入物件即可
function update(id, updater) {
  const data = readAll();
  const item = data.products.find((p) => p.id === id);
  if (!item) return null;
  updater(item);
  writeAll(data);
  return item;
}

module.exports = { list, getById, findByUrl, findByCode, add, remove, update, readAll, writeAll };
