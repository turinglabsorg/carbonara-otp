# Carbonara OTP

> Because reading OTP codes from your phone like a caveman is so 2019.

Your SMS messages were living their best life on Twilio, but they were lonely. They wanted to be seen. They wanted to be *appreciated*. So we built them a one-way ticket to your Telegram group.

**Carbonara OTP** polls Twilio for incoming SMS and yeets them straight into Telegram. That's it. That's the whole thing. No webhooks, no serverless, no 47-microservice architecture. Just a `while(true)` loop with dreams.

## How it works

```
SMS arrives on Twilio
        |
        v
  Carbonara polls every 10s
  (like checking the fridge at 2am)
        |
        v
  New message? Forward to Telegram.
  No new message? Go back to sleep.
        |
        v
  Repeat until heat death of the universe
  (or SIGTERM, whichever comes first)
```

## Setup

```bash
# Clone this bad boy
git clone https://github.com/turinglabsorg/carbonara-otp.git
cd carbonara-otp

# Install deps
pnpm install

# Copy the env template and fill in your secrets
cp .env.example .env
```

### Environment variables

| Variable | What it does |
|---|---|
| `TWILIO_ACCOUNT_SID` | Your Twilio account SID. Starts with `AC`. |
| `TWILIO_AUTH_TOKEN` | Your Twilio auth token. Guard it with your life. |
| `TWILIO_PHONE_NUMBER` | The Twilio number receiving SMS (e.g. `+19784945376`) |
| `TELEGRAM_BOT_TOKEN` | Create a bot via [@BotFather](https://t.me/BotFather), he'll give you a token |
| `TELEGRAM_CHAT_ID` | The group/chat ID where messages go (negative number for groups) |
| `POLL_INTERVAL` | Seconds between polls. Default: `10`. Lower = more impatient. |

### Getting your Telegram Chat ID

1. Add your bot to the group
2. Send a message in the group
3. Hit this URL:
```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
```
4. Look for `"chat": { "id": -100xxxxxxxxxx }` — that's your chat ID

## Run it

```bash
# Let's go
pnpm start
```

You should see:
```
Virtual OTP — SMS-to-Telegram Forwarder
Twilio phone : +19784945376
Twilio account: AC1d404032...
Telegram bot : @your_bot
Telegram chat: -4630812360
Loaded 19 existing message(s) — they will be skipped.
Polling every 10s — press Ctrl+C to stop.
```

Send an SMS to your Twilio number and watch it magically appear in Telegram within 10 seconds.

## Deploy on DigitalOcean

```bash
# SSH into your droplet
ssh root@your-droplet

# Clone & setup
git clone https://github.com/turinglabsorg/carbonara-otp.git
cd carbonara-otp
pnpm install
cp .env.example .env
nano .env  # fill in your secrets

# Run with pm2 so it survives your SSH session closing
pm2 start "pnpm start" --name carbonara-otp
pm2 save
pm2 startup
```

## Health check

Carbonara now comes with a built-in health check on **port 8080**, because DigitalOcean kept poking it and asking "are you still alive?" like an anxious parent.

Hit any route and it'll respond with a 200 and an existential crisis. It's the bare minimum to prove this thing hasn't died — kind of like replying "k" to a text.

```
$ curl http://localhost:8080
I'm alive, but at what cost? Forwarding OTPs for a living. Send help (or SMS).
```

## Tech stack

- **Twilio SDK** — fetches SMS like a golden retriever fetches balls
- **Telegram Bot API** — via raw `fetch()` because we don't need no SDK for 1 endpoint
- **TypeScript** — because we have standards (debatable)
- **A `setInterval`** — the backbone of this entire operation

## FAQ

**Q: Why "Carbonara"?**
A: Because like a good carbonara, this project is simple, has few ingredients, and gets the job done beautifully.

**Q: Is this production-ready?**
A: It's a `setInterval` that calls two APIs. It's been production-ready since the first commit. It's also been production-ready since before it was written.

**Q: What happens if Twilio or Telegram goes down?**
A: It logs the error and tries again in 10 seconds. Like a resilient little pasta.

**Q: Can I use this for 2FA?**
A: That's literally why it exists. OTP codes hit your Telegram faster than you can say "where's my phone".

## License

MIT — do whatever you want, just don't blame us when your OTP codes end up in the wrong group chat.
