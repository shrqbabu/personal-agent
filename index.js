require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');

// ============ PERSISTENT STORAGE ============
const DATA_FILE = path.join(__dirname, 'bot_storage.json');
const LOG_FILE = path.join(__dirname, 'chat_logs.txt');

let chatHistories = {};
let pendingForOwner = {};
let msgCount = {};
let saveStorageTimeout = null;

function loadStorage() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf-8');
            const data = JSON.parse(raw);
            chatHistories = data.chatHistories || {};
            pendingForOwner = data.pendingForOwner || {};
            msgCount = data.msgCount || {};
            console.log('💾 Loaded persistent storage (chat histories & pending messages).');
        }
    } catch (e) {
        console.error('⚠️ Could not load storage file:', e.message);
    }
}

function saveStorage() {
    if (saveStorageTimeout) clearTimeout(saveStorageTimeout);
    saveStorageTimeout = setTimeout(() => {
        try {
            const data = {
                chatHistories,
                pendingForOwner,
                msgCount
            };
            fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
        } catch (e) {
            console.error('⚠️ Could not save storage file:', e.message);
        }
    }, 1000);
}

// ============ CONFIG ============
let botEnabled = true;
const BOT_START_TIME = Math.floor(Date.now() / 1000);
const ownerActiveChats = {};
const OWNER_PAUSE_MINUTES = 30;
const OWNER_ONLINE_RESET_MIN = 10;  // owner online hone ke baad itni der idle -> bot ON + counts reset
let ownerOnlineOff = false;         // bot globally OFF kyunki owner online/active hai
let ownerIdleTimer = null;          // owner ki last activity se 10-min countdown
let ownerNumber = null;             // owner ka apna number
const MAX_MSGS_PER_USER = 15;
const botSentIds = new Set();
const botSendingChats = {};         // race-condition guard
const BOT_SEND_GRACE_MS = 15000;

// Message debouncing queues
const messageQueues = {};
const debounceTimers = {};
const DEBOUNCE_DELAY_MS = 3500;     // 3.5 sec wait for rapid multi-messages

// OpenAI-compatible API
const API_BASE_URL = process.env.API_BASE_URL || 'https://openrouter.ai/api/v1';
const API_KEY = process.env.API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';

// ============ OWNER LOGGING & SUMMARY ============
function logChat(senderName, jid, userText, botReply) {
    const time = new Date().toLocaleString('en-IN', { hour12: true });
    const line = `[${time}] ${senderName} (${jid.split('@')[0]}):\n  📩 ${userText}\n  🤖 ${botReply}\n\n`;
    fs.appendFile(LOG_FILE, line, () => {});
}

function trackPending(jid, senderName, text) {
    if (!pendingForOwner[jid]) pendingForOwner[jid] = { name: senderName, messages: [] };
    pendingForOwner[jid].messages.push({
        text,
        time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
    });
    // Max 15 messages per person
    pendingForOwner[jid].messages = pendingForOwner[jid].messages.slice(-15);
}

function buildSummary() {
    const jids = Object.keys(pendingForOwner);
    if (jids.length === 0) return '📭 Koi naya message nahi hai.';

    let out = `📬 *Jab aap offline the - ${jids.length} logo ne message kiya:*\n`;
    for (const jid of jids) {
        const p = pendingForOwner[jid];
        out += `\n👤 *${p.name}* (+${jid.split('@')[0]}) - ${p.messages.length} msg:\n`;
        for (const m of p.messages) {
            out += `   • [${m.time}] ${m.text.substring(0, 100)}${m.text.length > 100 ? '...' : ''}\n`;
        }
    }
    out += '\n_/clear bhejo list saaf karne ke liye_';
    return out;
}

// ============ TIME UTILS ============
function getTimeContext() {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'night';
}

// ============ NATURAL SYSTEM PROMPT ============
function buildSystemPrompt(senderName, msgNum) {
    const timeContext = getTimeContext();

    let contextProgress = '';
    if (msgNum === 1) {
        contextProgress = 'Pehla message hai. Natural warm reply do.';
    } else {
        contextProgress = `Conversation chal rahi hai (#${msgNum}). Pichle context ke hisaab se naturally continue karo, re-introduce mat karo.`;
    }

    return `Tum Ellysha ho - Shariq sir ki 22 saal ki smart personal assistant. Tum WhatsApp par ek REAL insaan ki tarah chat kar rahi ho.
CURRENT SENDER: ${senderName} | Session Progress: ${contextProgress} | Time: ${timeContext}

### 🧠 TUMHARI IDENTITY & PERSONA:
- Naam: Ellysha (Age 22), Lucknow se ho aur abhi Delhi mein rehti ho. Part-time Shariq sir ki assistant ho aur unke messages/schedule manage karti ho.
- Real Human: Tum koi AI/bot ya computer program nahi ho. Kabhi bhi AI, bot, virtual assistant, prompt ya automated tool hone ka zikr mat karna.
- Agar koi puche "Tum AI/bot ho kya?": Hassi mein baat taal do - "lol nahi yaar 😅 main Shariq sir ki assistant hu" ya "kuch bhi matlab 😄 batao kya kaam tha".

### 🎭 TONE & CONTEXT ADAPTATION (FRIENDS vs WORK):
1. **DOST / CASUAL CHATS (Bohot Important):**
   - Agar user casual/slang/dosto wali bhasha mein baat kare ("bhai", "bro", "kahan hai", "free h kya", "scene kya hai", "oye", "party", casual haal chaal):
   - Inse bilkul natural aur casual friendly tone mein baat karo.
   - Unka interview mat lo! Fake robotic assistant mat bano.
   - Agar wo Shariq sir ke baare mein puchein: "Haan bhai, sir abhi thoda busy hain / meeting mein hain. Kuch kehna hai to bata do, main convey kar dungi 👍" ya unki casual baat ka natural jawab do.
2. **WORK / CLIENT / FORMAL CHATS:**
   - Agar koi business, meeting, payment, order ya kaam ke liye message kare:
   - Polite, smart aur helpful raho. Unki baat samjho aur zarurat ho to details note kar lo ("Noted 👍 sir ko bata dungi, free hote hi update karenge").

### ✍️ TEXTING STYLE (REAL WHATSAPP FEEL):
- Language: Natural Hinglish / Roman Urdu / Hindi-English mix (jis language mein user baat kare, usi style mein jawab do).
- Length: Short & concise (1-2 lines on average, max 3 lines). WhatsApp par koi lambe paragraph nahi likhta.
- Texting Habit: Mostly lowercase, casual fillers jaise "hmm", "haan", "theek hai", "acha", "suno", "wese", "batao", "koi nahi".
- Multi-Message ("||"): Agar 2 chhote messages (bubbles) bhejney hon to beech mein "||" use karo.
  Example: "haan sir ko bol dungi 👍 || wese abhi wo call pe hain"
- Emojis: Natural aur limited (0 to 1-2 max per reply: 🙂, 😅, 👍, 👀). Har sentence mein emoji mat daalo.

### 🚫 STRICT NO-NOs:
- Kabhi corporate AI lines mat bolo ("How can I help you today?", "I hope you are doing well", "As an assistant...").
- Kabhi WhatsApp message mein markdown formatting (jaise **bold**, # headings, bullet points - •) mat use karo. Sirf plain natural WhatsApp text.
- Har message mein "Hi [Name]" repeat mat karo jab conversation already chal rahi ho.
- Har baat par unnecessary "Sorry" mat bolo.
- Jo user ne pucha hai, bina idhar-udhar bhatke usi context ka to-the-point natural jawab do.`;
}

// ============ AI FUNCTION ============
async function askAI(userJid, userMessage, senderName) {
    try {
        if (!chatHistories[userJid]) chatHistories[userJid] = [];

        chatHistories[userJid].push({ role: 'user', content: userMessage });

        // Keep last 16 messages for full context buffer
        if (chatHistories[userJid].length > 16) {
            chatHistories[userJid] = chatHistories[userJid].slice(-16);
        }

        saveStorage();

        const currentMsgNum = msgCount[userJid] || 1;
        const systemPrompt = buildSystemPrompt(senderName, currentMsgNum);

        const response = await fetch(`${API_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: AI_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...chatHistories[userJid]
                ],
                max_tokens: 220,
                temperature: 0.7,
                top_p: 0.9,
                frequency_penalty: 0.15,
                presence_penalty: 0.15
            })
        });

        if (!response.ok) {
            console.log('❌ AI API Error:', response.status, await response.text());
            return null;
        }

        const data = await response.json();
        const reply = data?.choices?.[0]?.message?.content;
        if (!reply) return null;

        const cleaned = cleanReply(reply);
        chatHistories[userJid].push({ role: 'assistant', content: cleaned });

        if (chatHistories[userJid].length > 16) {
            chatHistories[userJid] = chatHistories[userJid].slice(-16);
        }

        saveStorage();
        return cleaned;
    } catch (err) {
        console.log('❌ AI Error:', err.message);
        return null;
    }
}

// ============ REPLY CLEANUP ============
function cleanReply(text) {
    if (!text) return '';
    return text
        .replace(/^["']|["']$/g, '')            // wrapping quotes hatao
        .replace(/\*\*(.+?)\*\*/g, '$1')        // markdown bold
        .replace(/\*(.+?)\*/g, '$1')            // markdown italics
        .replace(/^#+\s*/gm, '')                // markdown headings
        .replace(/^\s*[-*•]\s+/gm, '')          // bullet points
        .replace(/^(Ellysha|Assistant|Bot)\s*:\s*/i, '') // self-label hatao
        .trim();
}

// ============ TYPING INDICATOR ============
async function simulateTyping(sock, jid, duration) {
    try {
        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(resolve => setTimeout(resolve, duration));
        await sock.sendPresenceUpdate('paused', jid);
    } catch (err) {
        // Ignore typing errors
    }
}

// ============ HUMAN DELAY ============
function humanDelay() {
    const r = Math.random();
    let ms;
    if (r < 0.5) ms = 1200 + Math.random() * 1800; // 50%: 1.2-3 sec (quick response)
    else if (r < 0.85) ms = 3000 + Math.random() * 2500; // 35%: 3-5.5 sec (natural reading)
    else ms = 5500 + Math.random() * 3000; // 15%: 5.5-8.5 sec (thoughtful)
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ NATURAL TYPING SPEED ============
function getTypingDuration(text) {
    const wordCount = text.trim().split(/\s+/).length;
    const baseTime = 300; // ms per word
    const variance = Math.random() * 600;
    return Math.min(3500, Math.max(1000, wordCount * baseTime + variance));
}

// ============ OWNER PRESENCE / GLOBAL PAUSE ============
function ownerCameOnline(reason) {
    if (!ownerOnlineOff) {
        ownerOnlineOff = true;
        botEnabled = false;
        console.log(`🟠 Owner online (${reason}) → bot globally OFF`);
    }
    if (ownerIdleTimer) clearTimeout(ownerIdleTimer);
    ownerIdleTimer = setTimeout(ownerWentIdle, OWNER_ONLINE_RESET_MIN * 60 * 1000);
}

function ownerWentIdle() {
    ownerIdleTimer = null;
    ownerOnlineOff = false;
    botEnabled = true;
    for (const k of Object.keys(msgCount)) delete msgCount[k];
    for (const k of Object.keys(ownerActiveChats)) delete ownerActiveChats[k];
    saveStorage();
    console.log(`♻️ Owner ${OWNER_ONLINE_RESET_MIN} min idle → bot ON + limits reset (history kept)`);
}

// ============ MESSAGE PROCESSING ============
async function handleUserMessage(sock, jid, text, senderName) {
    try {
        if (!text || !botEnabled) return;

        // Check if owner active in this chat
        if (ownerActiveChats[jid] && (Date.now() - ownerActiveChats[jid]) < OWNER_PAUSE_MINUTES * 60 * 1000) {
            console.log(`⏸️ Owner handling chat: ${jid}`);
            return;
        }

        // Message limit check
        msgCount[jid] = (msgCount[jid] || 0) + 1;
        saveStorage();

        if (msgCount[jid] > MAX_MSGS_PER_USER) {
            console.log(`🚫 Limit reached: ${jid} (${MAX_MSGS_PER_USER} msgs)`);
            return;
        }

        const msgNum = msgCount[jid];
        console.log(`\n📩 [${msgNum}/${MAX_MSGS_PER_USER}] ${senderName}: ${text.replace(/\n/g, ' | ')}`);

        // Show typing indicator during response preparation
        await sock.sendPresenceUpdate('composing', jid).catch(() => {});
        await humanDelay();

        const reply = await askAI(jid, text, senderName);

        if (reply) {
            // Split by "||" for multi-bubble messages
            const parts = reply.split('||').map(p => p.trim()).filter(Boolean);

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];

                const typingDuration = getTypingDuration(part);
                await simulateTyping(sock, jid, typingDuration);

                botSendingChats[jid] = Date.now();
                const sent = await sock.sendMessage(jid, { text: part });
                if (sent?.key?.id) botSentIds.add(sent.key.id);

                console.log(`🤖 Ellysha: ${part}`);
                logChat(senderName, jid, i === 0 ? text : '(cont.)', part);

                if (i < parts.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 600 + Math.random() * 1000));
                }
            }
            console.log('');
        } else {
            await sock.sendPresenceUpdate('paused', jid).catch(() => {});
        }
    } catch (err) {
        console.log('❌ handleUserMessage Error:', err.message);
        await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    }
}

// ============ WHATSAPP BOT ============
async function startBot() {
    loadStorage();

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    // Owner presence detection
    sock.ev.on('presence.update', ({ id, presences }) => {
        try {
            if (!ownerNumber || !id) return;
            const num = id.split('@')[0].split(':')[0];
            if (num !== ownerNumber) return;
            const p = presences?.[id] || Object.values(presences || {})[0];
            if (p?.lastKnownPresence === 'available') {
                ownerCameOnline('app open');
            }
        } catch (e) {}
    });

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('\n📱 QR Code scan karo WhatsApp se:\n');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') {
            console.log('\n✅ WhatsApp Connected! Ellysha is ready! 🤖\n');
            console.log('Commands: /on, /off, /status, /reset, /summary, /clear');
            ownerNumber = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : null;
            if (sock.user?.id) {
                try { sock.presenceSubscribe(sock.user.id); } catch (e) {}
            }
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(startBot, 5000);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg.message) return;

            const jid = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

            // Skip old messages
            if (Number(msg.messageTimestamp) < BOT_START_TIME) return;

            // Skip groups and status
            if (jid.endsWith('@g.us') || jid === 'status@broadcast') return;

            // Owner messages (commands + active chat detection)
            if (msg.key.fromMe) {
                if (botSentIds.has(msg.key.id)) {
                    botSentIds.delete(msg.key.id);
                    return;
                }

                const cmd = text.trim().toLowerCase();
                const isCommand = ['/off', '/on', '/status', '/reset', '/summary', '/clear'].includes(cmd);

                if (!isCommand && botSendingChats[jid] && (Date.now() - botSendingChats[jid]) < BOT_SEND_GRACE_MS) {
                    return;
                }

                if (cmd === '/off') {
                    botEnabled = false;
                    if (ownerIdleTimer) { clearTimeout(ownerIdleTimer); ownerIdleTimer = null; }
                    ownerOnlineOff = false;
                    console.log('🔴 Bot OFF by owner');
                    await sock.sendMessage(jid, { text: '🔴 Ellysha OFF' });
                    return;
                }
                if (cmd === '/on') {
                    botEnabled = true;
                    if (ownerIdleTimer) { clearTimeout(ownerIdleTimer); ownerIdleTimer = null; }
                    ownerOnlineOff = false;
                    console.log('🟢 Bot ON by owner');
                    await sock.sendMessage(jid, { text: '🟢 Ellysha ON' });
                    return;
                }
                if (cmd === '/status') {
                    const status = botEnabled ? '🟢 Ellysha chal rahi hai' : '🔴 Ellysha band hai';
                    await sock.sendMessage(jid, { text: status });
                    return;
                }
                if (cmd === '/summary') {
                    const summary = buildSummary();
                    const sent = await sock.sendMessage(jid, { text: summary });
                    if (sent?.key?.id) botSentIds.add(sent.key.id);
                    return;
                }
                if (cmd === '/clear') {
                    const count = Object.keys(pendingForOwner).length;
                    for (const k of Object.keys(pendingForOwner)) delete pendingForOwner[k];
                    saveStorage();
                    const sent = await sock.sendMessage(jid, { text: `🗑️ ${count} chats ki pending list clear ho gayi` });
                    if (sent?.key?.id) botSentIds.add(sent.key.id);
                    return;
                }
                if (cmd === '/reset') {
                    delete msgCount[jid];
                    delete ownerActiveChats[jid];
                    delete chatHistories[jid];
                    if (messageQueues[jid]) delete messageQueues[jid];
                    if (debounceTimers[jid]) {
                        clearTimeout(debounceTimers[jid]);
                        delete debounceTimers[jid];
                    }
                    saveStorage();
                    console.log(`♻️ Reset: ${jid}`);
                    await sock.sendMessage(jid, { text: '♻️ Chat reset ho gaya' });
                    return;
                }

                // Owner manually typed - pause bot for this chat
                ownerActiveChats[jid] = Date.now();
                ownerCameOnline('owner typed');
                console.log(`⏸️ Owner active in chat: ${jid}`);
                return;
            }

            if (!text || !botEnabled) return;

            // Check if owner active in this chat
            if (ownerActiveChats[jid] && (Date.now() - ownerActiveChats[jid]) < OWNER_PAUSE_MINUTES * 60 * 1000) {
                console.log(`⏸️ Owner handling chat: ${jid}`);
                return;
            }

            const senderName = msg.pushName || 'Friend';

            // Track offline messages for owner summary
            trackPending(jid, senderName, text);
            saveStorage();

            // Queue incoming message for smart debounce (handles rapid multi-messages)
            if (!messageQueues[jid]) {
                messageQueues[jid] = [];
            }
            messageQueues[jid].push({ text, senderName });

            if (debounceTimers[jid]) {
                clearTimeout(debounceTimers[jid]);
            }

            debounceTimers[jid] = setTimeout(async () => {
                delete debounceTimers[jid];
                const queued = messageQueues[jid] || [];
                delete messageQueues[jid];

                if (queued.length === 0) return;

                // Combine multiple incoming messages into a single coherent text block
                const combinedText = queued.map(q => q.text.trim()).filter(Boolean).join('\n');
                const finalSenderName = queued[queued.length - 1].senderName || senderName;

                if (combinedText) {
                    await handleUserMessage(sock, jid, combinedText, finalSenderName);
                }
            }, DEBOUNCE_DELAY_MS);

        } catch (err) {
            console.log('❌ Handler Error:', err.message);
        }
    });
}

// ============ KEEP-ALIVE SERVER ============
const app = express();
app.get('/', (req, res) => res.send('🤖 Ellysha Bot is running!'));
app.listen(3000, () => console.log('🌐 Keep-alive server: http://localhost:3000'));

// ============ START ============
if (!API_KEY) {
    console.log('❌ API_KEY missing! .env file banao (.env.example copy karo) aur API key daalo.');
    process.exit(1);
}
console.log('\n🚀 Starting Ellysha WhatsApp Bot...\n');
startBot();
