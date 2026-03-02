import "dotenv/config";
import { createServer } from "http";

const twilio = require("twilio");

// ── Config ──────────────────────────────────────────────────────────

function getConfig() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const phoneNumber = process.env.TWILIO_PHONE_NUMBER?.replace(/^["']|["']$/g, "");
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  const pollInterval = parseInt(process.env.POLL_INTERVAL || "10", 10);

  if (!accountSid || !authToken || !phoneNumber) {
    console.error("Error: Twilio credentials not configured.");
    console.error("Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in .env");
    process.exit(1);
  }

  if (!telegramBotToken || !telegramChatId) {
    console.error("Error: Telegram config not set.");
    console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env");
    process.exit(1);
  }

  return { accountSid, authToken, phoneNumber, telegramBotToken, telegramChatId, pollInterval };
}

// ── Telegram helpers ────────────────────────────────────────────────

async function telegramRequest(botToken: string, method: string, body?: Record<string, unknown>) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as { ok: boolean; description?: string; result?: any };
  if (!data.ok) {
    throw new Error(`Telegram API error (${method}): ${data.description}`);
  }
  return data.result;
}

async function validateTelegramBot(botToken: string): Promise<string> {
  const me = await telegramRequest(botToken, "getMe");
  return me.username;
}

async function sendTelegramMessage(botToken: string, chatId: string, html: string) {
  return telegramRequest(botToken, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
  });
}

// ── Twilio helpers ──────────────────────────────────────────────────

async function fetchInboundMessages(client: any, phoneNumber: string, limit: number): Promise<any[]> {
  return client.messages.list({ to: phoneNumber, limit });
}

// ── Message formatting ──────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTelegramMessage(msg: any): string {
  const time = new Date(msg.dateCreated).toLocaleString();
  return [
    `📱 <b>New SMS Received</b>`,
    `<b>From:</b> ${escapeHtml(msg.from)}`,
    `<b>To:</b> ${escapeHtml(msg.to)}`,
    `<b>Time:</b> ${escapeHtml(time)}`,
    ``,
    escapeHtml(msg.body),
  ].join("\n");
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const config = getConfig();

  console.log("Virtual OTP — SMS-to-Telegram Forwarder");
  console.log(`Twilio phone : ${config.phoneNumber}`);
  console.log(`Twilio account: ${config.accountSid.substring(0, 10)}...`);

  // Validate Telegram bot
  const botUsername = await validateTelegramBot(config.telegramBotToken);
  console.log(`Telegram bot : @${botUsername}`);
  console.log(`Telegram chat: ${config.telegramChatId}`);

  // Create Twilio client
  const client = twilio(config.accountSid, config.authToken);

  // Seed seen SIDs with the last 100 messages
  const seenSids = new Set<string>();
  const initial = await fetchInboundMessages(client, config.phoneNumber, 100);
  for (const msg of initial) {
    seenSids.add(msg.sid);
  }
  console.log(`Loaded ${initial.length} existing message(s) — they will be skipped.`);
  console.log(`Polling every ${config.pollInterval}s — press Ctrl+C to stop.\n`);

  // Health-check HTTP server (DO needs this to know we're alive)
  const healthServer = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("I'm alive, but at what cost? Forwarding OTPs for a living. Send help (or SMS).");
  });
  healthServer.listen(8080, () => {
    console.log("Health check listening on :8080 — yes, I'm still here.");
  });

  // Poll loop
  const poll = async () => {
    try {
      const messages = await fetchInboundMessages(client, config.phoneNumber, 100);
      const newMessages = messages.filter((m: any) => !seenSids.has(m.sid));

      if (newMessages.length > 0) {
        // Process oldest first
        newMessages.reverse();
        for (const msg of newMessages) {
          seenSids.add(msg.sid);
          const html = formatTelegramMessage(msg);

          try {
            await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, html);
            console.log(`[${new Date().toLocaleTimeString()}] Forwarded SMS from ${msg.from} (${msg.sid})`);
          } catch (err: any) {
            console.error(`[${new Date().toLocaleTimeString()}] Failed to send to Telegram: ${err.message}`);
          }
        }
      }
    } catch (err: any) {
      console.error(`Poll error: ${err.message}`);
    }
  };

  const timer = setInterval(poll, config.pollInterval * 1000);

  // Graceful shutdown
  const shutdown = () => {
    clearInterval(timer);
    healthServer.close();
    console.log("\nShutting down. Goodbye!");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
