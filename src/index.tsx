// Load env file from --env flag (e.g. --env .env.guest → label "GUEST")
import dotenv from "dotenv";
const envArg = process.argv.find((_, i, arr) => arr[i - 1] === "--env") || ".env";
const envLabel = envArg.replace(/^\.env\.?/, "").toUpperCase() || "DEFAULT";
dotenv.config({ path: envArg });

import { createServer } from "net";
import { createServer as createHttpServer } from "http";
import React, { useState, useEffect, useCallback } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";

import twilio from "twilio";

// ── Types ────────────────────────────────────────────────────────────

interface SmsMessage {
  sid: string;
  from: string;
  to: string;
  body: string;
  direction: "inbound" | "outbound";
  dateCreated: Date;
}

interface Config {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  label: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramEnabled: boolean;
  pollInterval: number;
}

// ── Config ──────────────────────────────────────────────────────────

function getConfig(): Config {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const phoneNumber = process.env.TWILIO_PHONE_NUMBER?.replace(/^["']|["']$/g, "");
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || undefined;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID || undefined;
  const pollInterval = parseInt(process.env.POLL_INTERVAL || "10", 10);

  if (!accountSid || !authToken || !phoneNumber) {
    console.error("Error: Twilio credentials not configured.");
    console.error("Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in .env");
    process.exit(1);
  }

  const telegramEnabled = !!(telegramBotToken && telegramChatId);

  return { accountSid, authToken, phoneNumber, label: envLabel, telegramBotToken, telegramChatId, telegramEnabled, pollInterval };
}

// ── Port finder ─────────────────────────────────────────────────────

async function findAvailablePort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close();
        resolve(true);
      });
      server.listen(port);
    });
    if (available) return port;
  }
  throw new Error(`No available port in range ${start}-${end}`);
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
  if (!data.ok) throw new Error(`Telegram API error (${method}): ${data.description}`);
  return data.result;
}

async function sendTelegramMessage(botToken: string, chatId: string, html: string) {
  return telegramRequest(botToken, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Create a fingerprint for a message: direction + body + minute-level timestamp */
function msgFingerprint(msg: { body: string; direction: string; dateCreated: Date }): string {
  // Round to the minute so messages within the same minute are considered dupes
  const minuteTs = Math.floor(msg.dateCreated.getTime() / 60000);
  return `${msg.direction}|${msg.body}|${minuteTs}`;
}

function isAutoReply(body: string): boolean {
  return (
    !body ||
    body.includes("Configure your number's SMS URL") ||
    body.includes("Reply HELP for help") ||
    body === "Your message has been delivered." ||
    body.startsWith("We couldn't match your number") ||
    body.startsWith("You have multiple active conversations") ||
    body.startsWith("Something went wrong")
  );
}

function formatTelegramMessage(msg: SmsMessage): string {
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

// ── Twilio helpers ──────────────────────────────────────────────────

async function sendSmsViaTwilio(client: any, from: string, to: string, body: string): Promise<SmsMessage> {
  const result = await client.messages.create({ body, from, to });
  return {
    sid: result.sid,
    from: result.from,
    to: result.to,
    body,
    direction: "outbound",
    dateCreated: new Date(),
  };
}

// ── TUI Components ──────────────────────────────────────────────────

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(date: Date): string {
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return formatTime(date);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${formatTime(date)}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${formatTime(date)}`;
}

interface AppProps {
  config: Config;
  client: any;
  initialMessages: SmsMessage[];
}

function App({ config, client, initialMessages }: AppProps) {
  const { exit } = useApp();

  // Track seen fingerprints to prevent duplicate messages
  const [seenFingerprints] = useState(() => new Set<string>());

  // Conversation state: map of phone number → messages (deduplicated by fingerprint)
  const [conversations, setConversations] = useState<Map<string, SmsMessage[]>>(() => {
    const map = new Map<string, SmsMessage[]>();
    for (const msg of initialMessages) {
      const key = msg.direction === "inbound" ? msg.from : msg.to;
      const fp = msgFingerprint(msg);
      if (seenFingerprints.has(fp)) continue;
      seenFingerprints.add(fp);
      const existing = map.get(key) || [];
      existing.push(msg);
      map.set(key, existing);
    }
    for (const [key, msgs] of map) {
      map.set(key, msgs.sort((a, b) => a.dateCreated.getTime() - b.dateCreated.getTime()));
    }
    return map;
  });

  const [contactList, setContactList] = useState<string[]>(() =>
    Array.from(new Map<string, SmsMessage[]>((() => {
      const map = new Map<string, SmsMessage[]>();
      for (const msg of initialMessages) {
        const key = msg.direction === "inbound" ? msg.from : msg.to;
        const existing = map.get(key) || [];
        existing.push(msg);
        map.set(key, existing);
      }
      return map;
    })()).keys())
  );

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeContact, setActiveContact] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [sending, setSending] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [seenSids] = useState(() => {
    const set = new Set<string>();
    for (const msg of initialMessages) set.add(msg.sid);
    return set;
  });

  // Update contact list when conversations change
  useEffect(() => {
    const sorted = Array.from(conversations.entries())
      .sort((a, b) => {
        const lastA = a[1][a[1].length - 1]?.dateCreated.getTime() || 0;
        const lastB = b[1][b[1].length - 1]?.dateCreated.getTime() || 0;
        return lastB - lastA;
      })
      .map(([key]) => key);
    setContactList(sorted);
  }, [conversations]);

  // Poll for new messages
  useEffect(() => {
    const poll = async () => {
      try {
        // Fetch all messages involving our number
        const inbound: any[] = await client.messages.list({ to: config.phoneNumber, limit: 100 });
        const outbound: any[] = await client.messages.list({ from: config.phoneNumber, limit: 100 });

        // Deduplicate by SID (a message can appear in both queries)
        const byId = new Map<string, any>();
        for (const m of inbound) {
          byId.set(m.sid, { ...m, direction: "inbound" as const });
        }
        for (const m of outbound) {
          if (!byId.has(m.sid)) {
            byId.set(m.sid, { ...m, direction: "outbound" as const });
          }
        }

        const allMessages = Array.from(byId.values()).filter(
          (m) => !(m.direction === "outbound" && isAutoReply(m.body))
        );

        const newMessages = allMessages.filter((m) => !seenSids.has(m.sid));
        if (newMessages.length > 0) {
          for (const msg of newMessages) {
            seenSids.add(msg.sid);
          }

          setConversations((prev) => {
            const next = new Map(prev);
            for (const msg of newMessages) {
              const key = msg.direction === "inbound" ? msg.from : msg.to;
              const parsed: SmsMessage = {
                sid: msg.sid,
                from: msg.from,
                to: msg.to,
                body: msg.body,
                direction: msg.direction,
                dateCreated: new Date(msg.dateCreated),
              };
              const fp = msgFingerprint(parsed);
              if (seenFingerprints.has(fp)) continue;
              seenFingerprints.add(fp);
              const existing = next.get(key) || [];
              existing.push(parsed);
              existing.sort((a, b) => a.dateCreated.getTime() - b.dateCreated.getTime());
              next.set(key, existing);
            }
            return next;
          });

          // Forward inbound to Telegram
          if (config.telegramEnabled) {
            for (const msg of newMessages.filter((m) => m.direction === "inbound")) {
              try {
                const html = formatTelegramMessage(msg as SmsMessage);
                await sendTelegramMessage(config.telegramBotToken!, config.telegramChatId!, html);
              } catch {}
            }
          }
        }
      } catch {}
    };

    const timer = setInterval(poll, config.pollInterval * 1000);
    return () => clearInterval(timer);
  }, []);

  const handleSend = useCallback(async () => {
    if (!activeContact || !inputValue.trim() || sending) return;
    setSending(true);
    setStatusMsg("Sending...");
    try {
      const sent = await sendSmsViaTwilio(client, config.phoneNumber, activeContact, inputValue.trim());
      seenSids.add(sent.sid);
      const fp = msgFingerprint(sent);
      seenFingerprints.add(fp);
      setConversations((prev) => {
        const next = new Map(prev);
        const existing = next.get(activeContact) || [];
        existing.push(sent);
        next.set(activeContact, existing);
        return next;
      });
      setInputValue("");
      setStatusMsg("Sent!");
      setTimeout(() => setStatusMsg(""), 2000);
    } catch (err: any) {
      setStatusMsg(`Failed: ${err.message}`);
      setTimeout(() => setStatusMsg(""), 3000);
    }
    setSending(false);
  }, [activeContact, inputValue, sending]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      process.exit(0);
    }

    if (!activeContact) {
      // Contact list navigation
      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setSelectedIndex((i) => Math.min(contactList.length - 1, i + 1));
      } else if (key.return) {
        if (contactList[selectedIndex]) {
          setActiveContact(contactList[selectedIndex]);
        }
      }
    } else {
      // Conversation view
      if (key.escape) {
        setActiveContact(null);
        setInputValue("");
      } else if (key.return && inputValue.trim()) {
        handleSend();
      }
    }
  });

  const termHeight = process.stdout.rows || 24;

  // ── Contact list view ──
  if (!activeContact) {
    return (
      <Box flexDirection="column" height={termHeight}>
        <Box borderStyle="single" borderColor="cyan" paddingX={1}>
          <Text bold color="cyan">Virtual OTP</Text>
          <Text> — </Text>
          <Text bold color="yellow">{config.label}</Text>
          <Text> — </Text>
          <Text>{config.phoneNumber}</Text>
          <Text> — </Text>
          <Text dimColor>{contactList.length} conversations</Text>
        </Box>

        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          {contactList.length === 0 ? (
            <Text dimColor>No messages yet. Waiting for SMS...</Text>
          ) : (
            contactList.slice(0, termHeight - 5).map((phone, i) => {
              const msgs = conversations.get(phone) || [];
              const lastMsg = msgs[msgs.length - 1];
              const unread = msgs.filter((m) => m.direction === "inbound").length;
              const isSelected = i === selectedIndex;
              const preview = lastMsg ? lastMsg.body.substring(0, 50) : "";
              const time = lastMsg ? formatDate(lastMsg.dateCreated) : "";

              return (
                <Box key={phone}>
                  <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                    {isSelected ? ">" : " "} {phone}
                  </Text>
                  <Text dimColor> ({msgs.length} msgs) </Text>
                  <Text dimColor>{time}</Text>
                  <Text> </Text>
                  <Text dimColor wrap="truncate">{preview}</Text>
                </Box>
              );
            })
          )}
        </Box>

        <Box borderStyle="single" borderColor="gray" paddingX={1}>
          <Text dimColor>↑↓ navigate  Enter open  Ctrl+C quit</Text>
        </Box>
      </Box>
    );
  }

  // ── Conversation view ──
  const messages = conversations.get(activeContact) || [];
  const termWidth = process.stdout.columns || 80;
  // Estimate lines each message takes (wrapping at terminal width, minus padding)
  const usableWidth = termWidth - 4; // 2 padding each side
  let lineBudget = termHeight - 8; // header(3) + input(3) + footer(1) + buffer(1)
  const visibleMessages: SmsMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && lineBudget > 0; i--) {
    const msg = messages[i];
    const lineLen = msg.body.length + 16; // prefix + timestamp
    const linesNeeded = Math.max(1, Math.ceil(lineLen / usableWidth));
    lineBudget -= linesNeeded;
    if (lineBudget >= 0) visibleMessages.unshift(msg);
  }

  return (
    <Box flexDirection="column" height={termHeight}>
      <Box borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">{activeContact}</Text>
        <Text> — </Text>
        <Text bold color="yellow">{config.label}</Text>
        <Text> — </Text>
        <Text>{config.phoneNumber}</Text>
        <Text> — </Text>
        <Text dimColor>{messages.length} messages</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {visibleMessages.map((msg, i) => {
          const isOutbound = msg.direction === "outbound";
          return (
            <Box key={msg.sid || i} justifyContent={isOutbound ? "flex-end" : "flex-start"}>
              <Text
                color={isOutbound ? "green" : "white"}
                dimColor={isOutbound}
              >
                {isOutbound ? "→ " : "← "}
                <Text dimColor>[{formatTime(msg.dateCreated)}]</Text>
                {" "}
                {msg.body}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box borderStyle="single" borderColor={sending ? "yellow" : "green"} paddingX={1}>
        <Text color="green">Reply: </Text>
        <TextInput
          value={inputValue}
          onChange={setInputValue}
          placeholder="Type a message and press Enter..."
        />
      </Box>

      <Box paddingX={1}>
        <Text dimColor>Esc back  Enter send  Ctrl+C quit</Text>
        {statusMsg ? <Text color="yellow"> {statusMsg}</Text> : null}
      </Box>
    </Box>
  );
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const config = getConfig();

  // Find available port in 6000-7000 range
  const port = await findAvailablePort(6000, 7000);

  // Validate Telegram (if configured)
  if (config.telegramEnabled) {
    const me = await telegramRequest(config.telegramBotToken!, "getMe");
    process.stderr.write(`Telegram bot: @${me.username}\n`);
  }

  // Create Twilio client
  const client = twilio(config.accountSid, config.authToken);

  // Load recent messages (inbound + outbound) to seed conversations
  const [inbound, outbound] = await Promise.all([
    client.messages.list({ to: config.phoneNumber, limit: 100 }),
    client.messages.list({ from: config.phoneNumber, limit: 100 }),
  ]);

  // Deduplicate by SID and filter auto-replies
  const byId = new Map<string, SmsMessage>();
  for (const m of inbound) {
    byId.set(m.sid, {
      sid: m.sid, from: m.from, to: m.to, body: m.body,
      direction: "inbound", dateCreated: new Date(m.dateCreated),
    });
  }
  for (const m of outbound) {
    if (!byId.has(m.sid)) {
      byId.set(m.sid, {
        sid: m.sid, from: m.from, to: m.to, body: m.body,
        direction: "outbound", dateCreated: new Date(m.dateCreated),
      });
    }
  }

  const initialMessages: SmsMessage[] = Array.from(byId.values())
    .filter((m) => !(m.direction === "outbound" && isAutoReply(m.body)))
    .sort((a, b) => a.dateCreated.getTime() - b.dateCreated.getTime());

  // Health-check HTTP server
  const healthServer = createHttpServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Virtual OTP running");
  });
  healthServer.listen(port, () => {
    process.stderr.write(`Health check on :${port}\n`);
  });

  // Render TUI
  const { waitUntilExit } = render(
    <App config={config} client={client} initialMessages={initialMessages} />
  );

  await waitUntilExit();
  healthServer.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
