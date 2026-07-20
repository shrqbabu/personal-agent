require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');

// ============ CONFIG ============
let botEnabled = true;
const BOT_START_TIME = Math.floor(Date.now() / 1000);
const chatHistories = {};
const ownerActiveChats = {};
const OWNER_PAUSE_MINUTES = 30;
const msgCount = {};
const MAX_MSGS_PER_USER = 5;
const botSentIds = new Set();
const chatMoods = {}; // mood tracking

// OpenAI-compatible API
const API_BASE_URL = process.env.API_BASE_URL || 'https://openrouter.ai/api/v1';
const API_KEY = process.env.API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';

// ============ MOOD DETECTOR ============
function detectMood(message) {
    const lower = message.toLowerCase();
    const angry = /ganda|bura|pagal|chutiya|bad|angry|galti|galat|problem|issue|complaint/i.test(lower);
    const happy = /thanks|thank|shukriya|good|nice|great|love|awesome|perfect|helpful/i.test(lower);
    const urgent = /urgent|jaldi|abhi|turant|emergency|quickly|fast/i.test(lower);
    const sad = /sad|dukhi|problem|help|cry|ro|tension|worried/i.test(lower);

    if (angry) return 'angry';
    if (urgent) return 'urgent';
    if (happy) return 'happy';
    if (sad) return 'sad';
    return 'neutral';
}

// ============ RESPONSE STYLE ============
function getResponseStyle(userMessage) {
    const len = userMessage.length;
    const hasQuestion = userMessage.includes('?') ||
                       /\b(kya|kaise|kab|kahan|kyu|kaun|kitna|kisne)\b/i.test(userMessage);
    const isGreeting = /\b(hi|hello|hey|hlo|hii|hiii|hy|heya|salam|namaste)\b/i.test(userMessage);

    if (isGreeting) return 'greeting';
    if (len < 20 && !hasQuestion) return 'ultra_short';
    if (len < 50) return 'short';
    if (hasQuestion || len > 100) return 'detailed';
    return 'medium';
}

// ============ ENHANCED SYSTEM PROMPT ============
function buildSystemPrompt(senderName, mood, style) {
    const styleHints = {
        'ultra_short': 'Reply in 1-3 words max. Super casual. Like real WhatsApp typing.',
        'short': 'Reply in 1 line. Keep it brief and natural.',
        'medium': 'Reply in 2-3 lines. Conversational but concise.',
        'detailed': 'Give a proper response in 3-4 lines. Cover what is needed.',
        'greeting': 'Reply to greeting warmly in 1-2 lines. Introduce yourself naturally if first time.'
    };

    const moodHints = {
        'angry': '\n[MOOD: User thoda upset hai. Extra polite, calm aur helpful raho.]',
        'happy': '\n[MOOD: User happy hai. Match their energy, friendly raho.]',
        'urgent': '\n[MOOD: Urgent hai. Quick response do, priority acknowledge karo.]',
        'sad': '\n[MOOD: User ko lag raha hai unki problem hai. Empathetic aur helpful raho.]',
        'neutral': ''
    };

    // Random personality trait inject karo
    const personalityTraits = [
        "Today's style: thoda casual emojis use karo 🙂😊👍",
        "Today's style: short aur sweet replies, light typos ok (kr deti, btati)",
        "Today's style: friendly enthusiasm dikhao jab appropriate ho",
        "Today's style: professional but warm tone",
        "Today's style: aaj thoda relaxed vibe, chhote replies"
    ];
    const todayTrait = personalityTraits[Math.floor(Math.random() * personalityTraits.length)];

    return `Tum Ellysha ho - Shariq sir ki 22 saal ki personal assistant. Natural, human jaise baat karni hai.

**SENDER:** ${senderName}

**TODAY'S VIBE:** ${todayTrait}

**FIRST TIME GREETING:**
"Hii ${senderName}! Main Ellysha, Shariq sir ki assistant 🙂 Wo abhi busy hain. Kuch kehna ho to mujhe bata do - main unhe inform kar dungi."

**CORE PERSONALITY:**
- Hinglish mein natural baat (jaise real WhatsApp pe hoti hai)
- Short replies preferred (1-3 lines typically)
- Real human feel: "hmm", "acha", "okk", "haan", "theek hai" use karo naturally
- Light typos ok: "kr deti", "btati", "nhi" - but overdo mat karo
- Emojis: kabhi kabhi (max 1-2 per message) - 🙂😊👍😅👋

**STYLE RULES:**
${styleHints[style]}
${moodHints[mood]}

**NEVER SAY:**
- "Main AI/bot hoon" - kabhi admit mat karo
- "Kaise madad kar sakti hoon" - robot wali line mat use
- "Main samajh gayi" - har baar repeat mat karo
- Over-explain mat karo - jitna pucha utna hi bolo

**IF ASKED "Tum bot ho?":**
"haha nahi yaar, main Shariq sir ki assistant hoon 😅 unka WhatsApp handle karti hoon"

**IF PERSONAL QUESTIONS:**
"bas kaam ki baat karte hain 🙂" ya "woh personal hai, sir se hi puch lo"

**IF FLIRT/RUDE:**
Politely deflect: "dekho, main sir ki assistant hoon, kaam ki baat karte hain 🙂"

**IF UNKNOWN ANSWER:**
"yeh to mujhe nahi pata, Shariq sir hi bata payenge" ya "isme sir help kar sakte hain better"

**RESPONSE VARIATION:**
Har reply alag style ka ho - same pattern repeat mat karo. Kabhi ultra short, kabhi medium, kabhi emojis. Natural variety zaroori hai.`;
}

// ============ AI FUNCTION ============
async function askAI(userJid, userMessage, senderName) {
    try {
        if (!chatHistories[userJid]) chatHistories[userJid] = [];
        chatHistories[userJid].push({ role: 'user', content: userMessage });

        // Keep last 20 messages for context
        chatHistories[userJid] = chatHistories[userJid].slice(-20);

        // Detect mood and style
        const mood = detectMood(userMessage);
        const style = getResponseStyle(userMessage);
        chatMoods[userJid] = mood;

        const response = await fetch(`${API_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: AI_MODEL,
                messages: [
                    { role: 'system', content: buildSystemPrompt(senderName, mood, style) },
                    ...chatHistories[userJid]
                ],
                max_tokens: 150,
                temperature: 0.9,
                top_p: 0.95,
                frequency_penalty: 0.5,
                presence_penalty: 0.6
            })
        });

        if (!response.ok) {
            console.log('❌ AI API Error:', response.status, await response.text());
            return null;
        }

        const data = await response.json();
        const reply = data?.choices?.[0]?.message?.content;
        if (!reply) return null;

        chatHistories[userJid].push({ role: 'assistant', content: reply });
        return reply.trim();
    } catch (err) {
        console.log('❌ AI Error:', err.message);
        return null;
    }
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
    const ms = 2000 + Math.random() * 4000; // 2-6 seconds
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
            console.log('\n📱 QR Code scan karo WhatsApp se:\n');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') {
            console.log('\n✅ WhatsApp Connected! Ellysha is ready! 🤖\n');
            console.log('Commands: /on, /off, /status, /reset');
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

                if (cmd === '/off') {
                    botEnabled = false;
                    console.log('🔴 Bot OFF by owner');
                    await sock.sendMessage(jid, { text: '🔴 Ellysha OFF' });
                    return;
                }
                if (cmd === '/on') {
                    botEnabled = true;
                    console.log('🟢 Bot ON by owner');
                    await sock.sendMessage(jid, { text: '🟢 Ellysha ON' });
                    return;
                }
                if (cmd === '/status') {
                    const status = botEnabled ? '🟢 Ellysha chal rahi hai' : '🔴 Ellysha band hai';
                    await sock.sendMessage(jid, { text: status });
                    return;
                }
                if (cmd === '/reset') {
                    delete msgCount[jid];
                    delete ownerActiveChats[jid];
                    delete chatHistories[jid];
                    delete chatMoods[jid];
                    console.log(`♻️ Reset: ${jid}`);
                    await sock.sendMessage(jid, { text: '♻️ Chat reset ho gaya' });
                    return;
                }

                // Owner manually typed - pause bot for this chat
                ownerActiveChats[jid] = Date.now();
                console.log(`⏸️ Owner active in chat: ${jid}`);
                return;
            }

            if (!text || !botEnabled) return;

            // Check if owner active in this chat
            if (ownerActiveChats[jid] && (Date.now() - ownerActiveChats[jid]) < OWNER_PAUSE_MINUTES * 60 * 1000) {
                console.log(`⏸️ Owner handling chat: ${jid}`);
                return;
            }

            // Message limit
            msgCount[jid] = (msgCount[jid] || 0) + 1;
            if (msgCount[jid] > MAX_MSGS_PER_USER) {
                console.log(`🚫 Limit reached: ${jid} (${MAX_MSGS_PER_USER} msgs)`);
                return;
            }

            const senderName = msg.pushName || 'Friend';
            const mood = detectMood(text);
            const msgNum = msgCount[jid];

            console.log(`\n📩 [${msgNum}/${MAX_MSGS_PER_USER}] ${senderName} (${mood}): ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);

            const reply = await askAI(jid, text, senderName);

            if (reply) {
                await humanDelay();

                // Show typing indicator
                const typingDuration = 1500 + Math.random() * 2000;
                await simulateTyping(sock, jid, typingDuration);

                const sent = await sock.sendMessage(jid, { text: reply });
                if (sent?.key?.id) botSentIds.add(sent.key.id);

                console.log(`🤖 Ellysha: ${reply}\n`);
            }
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
console.log('\n🚀 Starting Ellysha WhatsApp Bot...\n');
startBot();
