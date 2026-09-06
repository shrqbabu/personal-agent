# Ellysha - WhatsApp AI Assistant Bot 🤖

Ellysha ek WhatsApp personal assistant bot hai jo **Baileys** aur **OpenAI-compatible AI API** ke saath kaam karta hai.
Ye bot personal chats me auto-reply kar sakta hai, owner commands support karta hai, aur PM2 ke through server par 24/7 run ho sakta hai.

---

## Features

- WhatsApp AI personal assistant
- Baileys based WhatsApp Web connection
- OpenAI-compatible API support
- Owner commands:
  - `/on` - Bot ON karne ke liye
  - `/off` - Bot OFF karne ke liye
  - `/status` - Bot ka current status check karne ke liye
- Owner active ho to bot auto-pause ho jata hai
- Groups aur status messages ignore karta hai
- Old messages ko restart ke baad ignore karta hai
- PM2 se 24/7 background me run hota hai
- Connection loss hone par reconnect try karta hai
- QR scan se WhatsApp login hota hai

---

## Project Files

```bash
README.md
auth_info/
chat_logs.txt
index.js
node_modules/
package-lock.json
package.json
```

### Important Files

| File/Folder | Use |
|---|---|
| `index.js` | Main bot code |
| `auth_info/` | WhatsApp login/session data |
| `chat_logs.txt` | Chat logs |
| `package.json` | Node.js dependencies and scripts |
| `node_modules/` | Installed packages |

> **Important:** `auth_info/` folder ko delete karne par WhatsApp logout ho jayega aur QR dobara scan karna padega.

---

## Server Setup

### 1. Project folder me jao

```bash
cd ~/peronal-agent
```

### 2. Dependencies install karo

```bash
npm install
```

### 3. Bot direct start karna ho to

```bash
node index.js
```

Lekin production/server ke liye PM2 use karna recommended hai.

---

## PM2 Install

Agar PM2 installed nahi hai:

```bash
sudo npm install -g pm2
```

Check:

```bash
pm2 -v
```

---

## Server Start Kaise Hoga

### PM2 se bot start karo

```bash
cd ~/personal-agent
pm2 start index.js --name personal-agent --cwd ~/personal-agent
```

### Logs dekho

```bash
pm2 logs personal-agent
```

Agar pehli baar start kar rahe ho to logs me QR code aa sakta hai.

WhatsApp me jao:

```txt
WhatsApp → Linked Devices → Link a Device → QR Scan
```

QR scan ke baad bot connected ho jayega.

---

## Server Stop / Band Kaise Hoga

### Bot stop karna ho

```bash
pm2 stop 
```

Isse bot band ho jayega, lekin PM2 list me rahega.

### Bot completely remove karna ho

```bash
pm2 delete personal-agent
```

Isse PM2 se process remove ho jayega.

---

## Server Restart Kaise Hoga

Agar code update kiya hai ya connection issue hai:

```bash
pm2 restart personal-agent
```

Ya update env ke saath:

```bash
pm2 restart personal-agent --update-env
```

Logs check karo:

```bash
pm2 logs personal-agent --lines 100
```

---

## Server Status Check

```bash
pm2 status
```

Example output me ye cheezein dikhengi:

- Process name: `personal-agent`
- Status: `online`, `stopped`, `errored`
- CPU usage
- RAM usage
- PID

Agar status `online` hai to Node process chal raha hai.

---

## Reboot Ke Baad Auto Start

Server reboot hone ke baad bot auto-start ho, iske liye:

```bash
pm2 startup
```

Is command ke baad PM2 ek sudo command print karega. Us command ko copy karke run karo.

Phir:

```bash
pm2 save
```

Important:

```bash
pm2 save
```

Ye current PM2 process list save karta hai, taaki reboot ke baad bot wapas start ho sake.

---

## Common Commands

| Kaam | Command |
|---|---|
| Start | `pm2 start index.js --name personal-agent --cwd ~/personal-agent` |
| Stop | `pm2 stop personal-agent` |
| Restart | `pm2 restart personal-agent` |
| Status | `pm2 status` |
| Logs | `pm2 logs personal-agent` |
| Last 100 logs | `pm2 logs personal-agent --lines 100` |
| Delete from PM2 | `pm2 delete personal-agent` |
| Save PM2 | `pm2 save` |

---

## Bot ON/OFF Commands

Owner apne WhatsApp se ye commands bhej sakta hai:

### Bot ON

```txt
/on
```

### Bot OFF

```txt
/off
```

### Bot Status

```txt
/status
```

Logs me aisa dikh sakta hai:

```txt
🟢 Bot ON by owner
🔴 Bot OFF by owner
⏸️ Owner active in chat
```

---

## Owner Active In Chat Ka Meaning

Agar logs me ye aaye:

```txt
Owner active in chat
```

To iska matlab owner khud us chat me message kar raha hai.
Bot us chat me temporarily pause ho jata hai taaki owner aur bot dono ek saath reply na karein.

Ye normal behavior hai.

---

## Connection Loss Hone Par Kya Karein

Agar logs me ye error aaye:

```txt
Connection closed. Reconnecting: true
Connection Failure
not logged in, attempting registration
```

To pehle simple restart try karo:

```bash
cd ~/personal-agent
pm2 restart personal-agent
pm2 logs personal-agent --lines 100
```

Agar QR aa jaye to WhatsApp se scan karo.

---

## WhatsApp Session Reset Kaise Karein

Agar connection bar-bar fail ho raha hai ya login corrupt ho gaya hai, to `auth_info` reset karo.

```bash
cd ~/personal-agent
pm2 stop personal-agent
mv auth_info auth_info_backup_$(date +%F_%H-%M-%S)
pm2 restart personal-agent
pm2 logs personal-agent --lines 100
```

Agar restart work na kare:

```bash
pm2 start index.js --name personal-agent --cwd ~/personal-agent
pm2 logs personal-agent --lines 100
```

Ab QR scan karna padega.

---

## Full Clean Restart

Agar kuch bhi work nahi kar raha:

```bash
cd ~/personal-agent

pm2 stop personal-agent
pm2 delete personal-agent

rm -rf auth_info

pm2 start index.js --name personal-agent --cwd ~/personal-agent
pm2 logs personal-agent --lines 150
```

Phir WhatsApp me QR scan karo:

```txt
WhatsApp → Linked Devices → Link a Device
```

---

## Baileys Update

Agar WhatsApp connection fail ho raha hai aur QR scan ke baad bhi issue hai, Baileys update karo:

```bash
cd ~/personal-agent

pm2 stop personal-agent

npm install @whiskeysockets/baileys@latest

rm -rf auth_info

pm2 start index.js --name personal-agent --cwd ~/personal-agent --update-env
pm2 logs personal-agent --lines 150
```

Phir QR scan karo.

---

## Server Time Check

WhatsApp/Baileys me kabhi-kabhi server time galat hone se issue aa sakta hai.

Check:

```bash
timedatectl
```

NTP enable karo:

```bash
sudo timedatectl set-ntp true
```

Phir restart:

```bash
pm2 restart personal-agent
```

---

## Logs Me Common Messages

### 1. Connection closed

```txt
Connection closed. Reconnecting: true
```

Meaning: WhatsApp connection drop hua, bot reconnect try kar raha hai.

Fix:

```bash
pm2 restart personal-agent
```

Agar repeat ho to `auth_info` reset karo.

---

### 2. Not logged in

```txt
not logged in, attempting registration
```

Meaning: WhatsApp session valid nahi hai.

Fix:

```bash
rm -rf auth_info
pm2 restart personal-agent
```

Phir QR scan.

---

### 3. Closing open session

```txt
Closing open session in favor of incoming prekey bundle
```

Meaning: WhatsApp encryption/session sync ho raha hai.

Usually ye normal hai. Agar bot reply kar raha hai to ignore kar sakte ho.

---

### 4. Bot OFF by owner

```txt
Bot OFF by owner
```

Meaning: Owner ne `/off` command bheja hai.

Fix:

```txt
/on
```

---

### 5. Owner active in chat

```txt
Owner active in chat
```

Meaning: Owner khud chat me active hai, bot auto-pause mode me hai.

---

## Port 3000 Live Hai Lekin Bot Reply Nahi Kar Raha

Port 3000 live hone ka matlab Node/server process chal raha hai.
Lekin WhatsApp connection alag hota hai.

Agar port live hai but bot reply nahi kar raha:

```bash
pm2 logs personal-agent --lines 100
```

Check karo:

- Bot OFF to nahi hai
- WhatsApp logout to nahi hua
- QR required to nahi hai
- Owner active pause to nahi hai
- Connection failure to nahi aa raha

---

## Manual Kill Avoid Karo

Manual process kill avoid karo:

```bash
kill -9 <pid>
```

PM2 process ko khud manage karta hai.
Agar process kill karoge to PM2 naya PID bana sakta hai.

Use PM2 commands:

```bash
pm2 restart personal-agent
pm2 stop personal-agent
pm2 delete personal-agent
```

---

## Current PID Check

```bash
pm2 status
```

Ya:

```bash
ps aux | grep node
```

Agar duplicate Node processes chal rahe hain:

```bash
pm2 delete personal-agent
pm2 start index.js --name personal-agent --cwd ~/personal-agent
pm2 save
```

---

## Safe Daily Commands

### Bot check karna

```bash
pm2 status
```

### Logs check karna

```bash
pm2 logs personal-agent --lines 50
```

### Restart karna

```bash
pm2 restart personal-agent
```

### Save karna

```bash
pm2 save
```

---

## Important Notes

- `auth_info/` folder ko share mat karo.
- `auth_info/` GitHub par commit mat karo.
- Ek WhatsApp account ek hi active server/session par use karo.
- Agar WhatsApp Linked Device remove kar diya to bot logout ho jayega.
- Agar QR scan ke baad bot working hai, to `pm2 save` zaroor karo.
- Server reboot ke baad auto-start ke liye `pm2 startup` aur `pm2 save` required hai.

---

## Quick Recovery

Agar bot suddenly reply nahi kar raha:

```bash
cd ~/personal-agent
pm2 restart personal-agent
pm2 logs personal-agent --lines 100
```

Agar QR/login issue:

```bash
cd ~/personal-agent
pm2 stop personal-agent
rm -rf auth_info
pm2 restart personal-agent
pm2 logs personal-agent --lines 100
```

QR scan karo and done.

---

## Final Production Checklist

- [ ] `npm install` done
- [ ] Bot PM2 se start hai
- [ ] QR scan complete hai
- [ ] Bot test message ka reply de raha hai
- [ ] `/on`, `/off`, `/status` working hai
- [ ] `pm2 save` run kiya hai
- [ ] `pm2 startup` configured hai
- [ ] `auth_info/` safe hai
