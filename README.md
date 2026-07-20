# Ellysha - WhatsApp AI Assistant Bot 🤖

WhatsApp personal assistant bot built with Baileys + OpenAI-compatible AI API.

## Features
- 🙋‍♀️ Ellysha persona - personal female assistant
- 👤 Greets senders by their WhatsApp profile name (never asks names)
- ⏸️ Auto-pauses in chats where owner is actively chatting (30 min)
- 🕐 Ignores old messages on restart (no spam)
- 🎮 Owner commands: `/on`, `/off`, `/status` (send in any chat from your own number)
- 🔌 OpenAI-compatible API - works with OpenRouter, NVIDIA NIM, etc. (switch via .env)
- ⏱️ Human-like reply delay (3-8 sec)

## Setup

```bash
# 1. Clone & install
git clone <repo-url>
cd whatsapp-bot
npm install

# 2. Create .env (copy from example)
cp .env.example .env
# Edit .env and add your API key

# 3. Run (scan QR code with WhatsApp > Linked Devices)
node index.js
```

## Run 24/7 with PM2

```bash
sudo npm install -g pm2
pm2 start index.js --name whatsapp-bot --cwd ~/whatsapp-bot
pm2 startup   # paste the sudo command it prints
pm2 save
```

## Notes
- `auth_info/` folder = WhatsApp session. Never commit or share it!
- Bot only replies in personal chats (groups & status ignored).
- One WhatsApp session = one server. Don't run on two servers at once.
