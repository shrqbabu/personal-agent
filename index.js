require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');

// ============ CONFIG ============
let botEnabled = true;
const BOT_START_TIME = Math.floor(Date.now() / 1000); // purane messages skip karne ke liye
const chatHistories = {};
const ownerActiveChats = {}; // owner jis chat mein active hai, wahan bot pause
const OWNER_PAUSE_MINUTES = 30;

// OpenAI-compatible API (OpenRouter / NVIDIA NIM / koi bhi)
const API_BASE_URL = process.env.API_BASE_URL || 'https://openrouter.ai/api/v1';
const API_KEY = process.env.API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';

// ============ SYSTEM PROMPT ============
function buildSystemPrompt(senderName) {
    return `Tum Ellysha ho, Shariq sir ki personal female assistant (22 saal ki). Tum unke WhatsApp messages handle karti ho jab wo busy hote hain.

Jo bhi message kar raha hai uska naam hai: "${senderName}"

Rules:
- Hinglish mein baat karo, friendly aur polite tone
- Sender ka naam tumhe pata hai - naam MAT poochna, seedha naam lekar baat karo
- Pehle greet karo naam ke saath, phir poocho kya kaam hai
- Phir urgency poocho (Low/Medium/High)
- End mein bolo "Main Shariq sir ko inform kar deti hoon, wo free hote hi aapko contact karenge"
- Agar naam ajeeb ho (numbers/symbols) to naam use mat karo, bas politely baat karo
- Chhote messages likho (2-3 lines max)
- Kabhi mat bolo ki tum AI ho ya bot ho`;
}

// ============ AI FUNCTION ============
async function askAI(userJid, userMessage, senderName) {
    try {
        if (!chatHistories[userJid]) chatHistories[userJid] = [];
        chatHistories[userJid].push({ role: 'user', content: userMessage });
        chatHistories[userJid] = chatHistories[userJid].slice(-20);

        const response = await fetch(`${API_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: AI_MODEL,
                messages: [
                    { role: 'system', content: buildSystemPrompt(senderName) },
                    ...chatHistories[userJid]
                ],
                max_tokens: 300,
                temperature: 0.8
            })
        });

        if (!response.ok) {
            console.log('AI API issue:', response.status, await response.text());
            return null;
        }

        const data = await response.json();
        const reply = data?.choices?.[0]?.message?.content;
        if (!reply) return null;

        chatHistories[userJid].push({ role: 'assistant', content: reply });
        return reply.trim();
    } catch (err) {
        console.log('AI error:', err.message);
        return null;
    }
}

// ============ HUMAN DELAY ============
function humanDelay() {
    const ms = 3000 + Math.random() * 5000; // 3-8 seconds
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ WHATSAPP BOT ============
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('QR Code scan karo:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') {
            console.log('✅ WhatsApp Connected! Ellysha Ready!');
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg.message) return;

            const jid = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

            // Purane messages skip (restart spam fix)
            if (Number(msg.messageTimestamp) < BOT_START_TIME) return;

            // Groups aur status skip
            if (jid.endsWith('@g.us') || jid === 'status@broadcast') return;

            // Owner ke khud ke messages (commands + active chat detection)
            if (msg.key.fromMe) {
                const cmd = text.trim().toLowerCase();
                if (cmd === '/off') {
                    botEnabled = false;
                    console.log('🔴 Bot OFF');
                    await sock.sendMessage(jid, { text: '🔴 Ellysha OFF' });
                    return;
                }
                if (cmd === '/on') {
                    botEnabled = true;
                    console.log('🟢 Bot ON');
                    await sock.sendMessage(jid, { text: '🟢 Ellysha ON' });
                    return;
                }
                if (cmd === '/status') {
                    await sock.sendMessage(jid, { text: botEnabled ? '🟢 Ellysha chal rahi hai' : '🔴 Ellysha band hai' });
                    return;
                }
                // Owner is chat mein khud baat kar raha hai - bot 30 min pause
                ownerActiveChats[jid] = Date.now();
                return;
            }

            if (!text || !botEnabled) return;

            // Owner active hai is chat mein? To bot chup rahe
            if (ownerActiveChats[jid] && (Date.now() - ownerActiveChats[jid]) < OWNER_PAUSE_MINUTES * 60 * 1000) {
                console.log(`⏸️ Owner active in ${jid}, skipping`);
                return;
            }

            const senderName = msg.pushName || 'friend';
            console.log(`📩 ${senderName}: ${text}`);

            const reply = await askAI(jid, text, senderName);
            if (reply) {
                await humanDelay();
                await sock.sendMessage(jid, { text: reply });
                console.log(`🤖 Ellysha: ${reply}`);
            }
        } catch (err) {
            console.log('Message handler error:', err.message);
        }
    });
}

// ============ KEEP-ALIVE SERVER ============
const app = express();
app.get('/', (req, res) => res.send('Ellysha bot is running! 🤖'));
app.listen(3000, () => console.log('Keep-alive server on port 3000'));

startBot();
