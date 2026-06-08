const TelegramBot = require('node-telegram-bot-api');
const dns = require('dns').promises;
const config = require('../config');

// 不開 polling，只用來送訊息（沿用 pttTelegramBot 的 bot token）
const bot = new TelegramBot(config.telegramToken, { polling: false });

const TELEGRAM_HOST = 'api.telegram.org';

// Markdown 特殊字元轉義
function escapeMd(text) {
  return String(text).replace(/([_*\[\]()`])/g, '\\$1');
}

// 判斷是否為「暫時性網路錯誤」——值得重試（開機網路未就緒、斷線、DNS 暫掛等）
function isRetryable(err) {
  const msg = String((err && err.message) || err);
  return /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EFATAL|ERR_NETWORK|socket hang up|network/i.test(
    msg
  );
}

// 等待網路就緒：開機自啟時網卡/DNS 可能尚未準備好，先確認能解析 api.telegram.org 再送。
// 回傳 true=就緒，false=逾時仍不可用。
async function waitForNetwork({ timeoutMs = 120000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let warned = false;
  for (;;) {
    try {
      await dns.lookup(TELEGRAM_HOST);
      if (warned) console.log(`[telegram] 網路已就緒（可解析 ${TELEGRAM_HOST}）`);
      return true;
    } catch (err) {
      if (Date.now() >= deadline) {
        console.error(
          `[telegram] 等待網路就緒逾時（${timeoutMs}ms），仍無法解析 ${TELEGRAM_HOST}：${err.message}`
        );
        return false;
      }
      if (!warned) {
        console.log(`[telegram] 網路尚未就緒（無法解析 ${TELEGRAM_HOST}），等待中…`);
        warned = true;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

// 發送單一訊息到單一 chat，遇暫時性網路錯誤時以指數退避重試
async function sendToChat(chatId, text, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      });
      return { chatId, ok: true, attempts: attempt + 1 };
    } catch (err) {
      if (attempt < retries && isRetryable(err)) {
        const delay = Math.min(30000, 1000 * 2 ** attempt); // 1s,2s,4s,8s,16s（上限 30s）
        console.error(
          `[telegram] 發送到 ${chatId} 失敗（第 ${attempt + 1} 次，${delay}ms 後重試）：${err.message}`
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      console.error(`[telegram] 發送到 ${chatId} 最終失敗：${err.message}`);
      return { chatId, ok: false, error: err.message, attempts: attempt + 1 };
    }
  }
}

// 發送純文字訊息到所有設定的 chat
async function sendMessage(text, opts) {
  const results = [];
  for (const chatId of config.telegramChatIds) {
    results.push(await sendToChat(chatId, text, opts));
    await new Promise((r) => setTimeout(r, 500)); // chat 之間節流
  }
  return results;
}

// 新增商品（立即取價成功）通知
async function notifyNewProduct({ name, url, price }) {
  const text =
    `🆕 *新增追蹤商品*\n` +
    `${escapeMd(name)}\n` +
    `目前價格：NT$${price.toLocaleString()}\n` +
    `${escapeMd(url)}`;
  return sendMessage(text);
}

// 新增商品取價失敗通知
async function notifyNewProductFailed({ url, error }) {
  const text =
    `⚠️ *新增追蹤商品取價失敗*\n` +
    `${escapeMd(url)}\n` +
    `原因：${escapeMd(error)}\n` +
    `將於下一輪排程自動重試。`;
  return sendMessage(text);
}

// 變價通知
async function notifyPriceChange({ name, url, oldPrice, newPrice }) {
  const diff = newPrice - oldPrice;
  const arrow = diff < 0 ? '🔽 降' : '🔼 漲';
  const diffText = `${arrow} ${Math.abs(diff).toLocaleString()}`;
  const text =
    `💰 *價格變動*\n` +
    `${escapeMd(name)}\n` +
    `NT$${oldPrice.toLocaleString()} → NT$${newPrice.toLocaleString()}（${diffText}）\n` +
    `${escapeMd(url)}`;
  return sendMessage(text);
}

module.exports = {
  sendMessage,
  notifyPriceChange,
  notifyNewProduct,
  notifyNewProductFailed,
  waitForNetwork,
};
