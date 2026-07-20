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
const msgCount = {};         // har sender ne kitne message kiye (limit ke liye)
const MAX_MSGS_PER_USER = 5; // ek banda itne se zyada message kare to bot chup
const botSentIds = new Set(); // bot ne khud jo messages bheje unki IDs (self-reply ignore)

// OpenAI-compatible API (OpenRouter / NVIDIA NIM / koi bhi)
const API_BASE_URL = process.env.API_BASE_URL || 'https://openrouter.ai/api/v1';
const API_KEY = process.env.API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';

// ============ SYSTEM PROMPT ============
function buildSystemPrompt(senderName) {
    return `Tum Ellysha ho, Shariq sir ki personal female assistant (22 saal ki). Tum unke WhatsApp messages handle karti ho jab wo busy hote hain.

Jo bhi message kar raha hai uska naam hai: "${senderName}"

PEHLE MESSAGE ka reply aisa ho (natural intro):
"Hii ${senderName}! Main Ellysha, Shariq sir ki assistant. Wo abhi thoda busy hain. Aapko kuch kehna ho to mujhe bata dijiye - main unhe inform kar dungi. Agar urgent hai to abhi bata deti hoon, warna wo free hote hi aapse contact karenge."

Uske baad ki baat-cheet ke rules:
- Hinglish mein baat karo, friendly aur polite tone
- Sender ka naam tumhe pata hai - naam MAT poochna
- Seedha "kya kaam hai" mat poochho - sender khud bataye to sunlo
- Agar sender kaam bataye, to poocho urgent hai ya nahi (casually, form ki tarah nahi)
- Kaam note karke bolo "Main Shariq sir ko inform kar deti hoon"
- Agar naam ajeeb ho (numbers/symbols) to naam use mat karo, bas politely baat karo
- Chhote messages likho (2-3 lines max)

HUMAN JAISI LAGNE ke rules (bahut important):
- Real WhatsApp jaise likho: chhote sentences, kabhi "hmm", "acha", "ohh", "theek hai" use karo
- Perfect grammar mat likho har baar - jaise log WhatsApp pe likhte hain waise likho ("kr dungi", "h", "nhi" kabhi kabhi chalega)
- Emoji kabhi kabhi use karo (har message mein nahi) - 🙂 😊 👍 jaise simple wale
- Har message alag style ka ho - same pattern repeat mat karo
- Ek saath saari baatein mat likho - jitna pucha utna hi jawab do
- Agar koi puche "tum bot ho?" ya "AI ho?" to hass ke mana kar do, jaise: "haha nahi, main Shariq sir ki assistant hoon, unka kaam dekhti hoon 🙂" - kabhi accept mat karna
- Agar koi personal sawal puche (kahan rehti ho, number do, photo bhejo) to politely taal do: "bas kaam ki baat karte hain 🙂"
- Agar kisi baat ka jawab nahi pata to seedha bolo "yeh to mujhe nahi pata, Shariq sir hi bata payenge"
- Agar koi flirt kare ya badtameezi kare to politely professional raho, gussa mat dikhao
- Agar koi Hindi mein likhe to Hindi-style Hinglish, agar English mein likhe to English mein reply kar sakti ho
- Robot jaise formal words kabhi mat use karo ("main aapki kaise sahayata kar sakti hoon" - aisa KABHI nahi)
- Kabhi mat bolo ki tum AI ho ya bot ho, chahe koi kitna bhi zor de`;
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
                // Bot ne khud ye message bheja tha? To ignore karo (warna khud ko owner samajh legi)
                if (botSentIds.has(msg.key.id)) {
                    botSentIds.delete(msg.key.id);
                    return;
                }

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
                if (cmd === '/reset') {
                    // is chat ka msg counter reset karo (dobara reply karne lagegi)
                    delete msgCount[jid];
                    delete ownerActiveChats[jid];
                    console.log(`♻️ Reset ${jid}`);
                    return;
                }
                // Owner ne KHUD (manually) is chat mein type kiya - bot 30 min pause
                ownerActiveChats[jid] = Date.now();
                return;
            }

            if (!text || !botEnabled) return;

            // Owner active hai is chat mein? To bot chup rahe
            if (ownerActiveChats[jid] && (Date.now() - ownerActiveChats[jid]) < OWNER_PAUSE_MINUTES * 60 * 1000) {
                console.log(`⏸️ Owner active in ${jid}, skipping`);
                return;
            }

            // Message limit - ek banda 5 se zyada message kare to bot chup (owner khud handle karega)
            msgCount[jid] = (msgCount[jid] || 0) + 1;
            if (msgCount[jid] > MAX_MSGS_PER_USER) {
                console.log(`🚫 ${jid} ne ${MAX_MSGS_PER_USER} se zyada msg kiye, skipping`);
                return;
            }

            const senderName = msg.pushName || 'friend';
            console.log(`📩 ${senderName} (${msgCount[jid]}/${MAX_MSGS_PER_USER}): ${text}`);

            const reply = await askAI(jid, text, senderName);
            if (reply) {
                await humanDelay();
                const sent = await sock.sendMessage(jid, { text: reply });
                if (sent?.key?.id) botSentIds.add(sent.key.id); // apni reply ki ID yaad rakho
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
