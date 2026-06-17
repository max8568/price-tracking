const TelegramBot = require('node-telegram-bot-api');
const dns = require('dns').promises;
const config = require('../config');

// 建構時不開 polling；後端 tracker 呼叫 startCommandListener() 後才開始收訊息
//（沿用 pttTelegramBot 的 bot token，該 bot 已不再 polling，無 409 衝突疑慮）
// request.timeout：library 的 polling 迴圈要等當前 getUpdates settle 才會排下一輪，
// 網路中斷時懸掛的請求會讓 polling 永久卡死；client 端 20s 超時讓它 reject 後自我恢復
//（須大於長輪詢 server 端持有的 10s，避免誤殺正常請求）
const bot = new TelegramBot(config.telegramToken, {
  polling: false,
  request: { timeout: 20000 },
});

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
async function sendToChat(chatId, text, { retries = 4, disablePreview = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: disablePreview,
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

// 啟動指令監聽（polling）。handler(arg) 回傳要回覆給使用者的文字。
// onAddItem：/add [商品連結]，onDeleteItem：/del [代碼或連結]，onListItems：/list（無參數）
function startCommandListener({ onAddItem, onDeleteItem, onListItems }) {
  const commands = [
    { name: 'add', usage: '用法：/add [商品連結]', handler: onAddItem },
    { name: 'del', usage: '用法：/del [4碼代碼或商品連結]', handler: onDeleteItem },
    // usage 為空＝不需參數；noPreview＝回覆關閉連結預覽（清單含多個連結）
    { name: 'list', handler: onListItems, noPreview: true },
  ];
  for (const cmd of commands) {
    // (?!\S) 確保指令後是空白或結尾，避免 /addxxx 之類誤觸發
    const re = new RegExp(`^\\/${cmd.name}(?:@\\S+)?(?!\\S)\\s*(\\S+)?`);
    bot.onText(re, async (msg, match) => {
      const chatId = String(msg.chat.id);
      // 授權檢查：只處理設定內的 chat，其他來源靜默忽略
      if (!config.telegramChatIds.includes(chatId)) {
        console.warn(`[telegram] 忽略未授權 chat ${chatId} 的 /${cmd.name} 指令`);
        return;
      }
      const arg = match && match[1];
      let reply;
      if (!arg && cmd.usage) {
        reply = cmd.usage;
      } else {
        try {
          reply = await cmd.handler(arg);
        } catch (err) {
          console.error(`[telegram] /${cmd.name} 處理失敗：${err.message}`);
          reply = `⚠️ 處理失敗：${escapeMd(err.message)}`;
        }
      }
      await sendToChat(chatId, reply, { disablePreview: !!cmd.noPreview });
    });
  }
  // 409 只告警一次，避免重複發訊息
  let conflictHandled = false;
  bot.on('polling_error', (err) => {
    const msg = String((err && err.message) || err);
    // 409 Conflict：同一 token 有另一個程式也在 polling getUpdates。
    // 繼續輪詢只會互相搶 update（指令收不到）並把 log 洗爆，所以停掉本機 polling
    // 並告警一次，交由人工排除重複實例（正常情況一個 token 只該有一個 poller）。
    if (/409/.test(msg) && /conflict/i.test(msg)) {
      if (conflictHandled) return;
      conflictHandled = true;
      console.error(`[telegram] 偵測到 409 衝突，已停止本機 polling（另一程式正用同一 token）：${msg}`);
      bot.stopPolling().catch(() => {});
      sendMessage(
        `⚠️ *Telegram 指令監聽已停止*\n` +
          `偵測到 409 衝突：有另一個程式正用同一個 bot token 在 polling。\n` +
          `指令（/add /del /list）暫時無法使用，請確認只有一個服務在收訊息。`
      ).catch((e) => console.error('[telegram] 409 告警發送失敗：', e.message));
      return;
    }
    console.error(`[telegram] polling 錯誤：${msg}`);
  });
  bot.startPolling();
  console.log('[telegram] 指令監聽已啟動（polling），支援 /add、/del、/list');
}

module.exports = {
  sendMessage,
  notifyPriceChange,
  notifyNewProduct,
  notifyNewProductFailed,
  waitForNetwork,
  startCommandListener,
  escapeMd,
};
