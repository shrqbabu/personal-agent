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
const MAX_MSGS_PER_USER = 10;
const botSentIds = new Set();
const botSendingChats = {}; // race-condition guard: bot apna hi sent message owner na samjhe
const BOT_SEND_GRACE_MS = 15000;
const chatMoods = {}; // mood tracking

// OpenAI-compatible API
const API_BASE_URL = process.env.API_BASE_URL || 'https://openrouter.ai/api/v1';
const API_KEY = process.env.API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';

// ============ TIME UTILS ============
function getTimeContext() {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'night';
}

function getTimeGreeting() {
    const time = getTimeContext();
    const greetings = {
        'morning': ['subah subah', 'good morning', 'subah ho gayi'],
        'afternoon': ['din dala', 'good afternoon', 'dopahar'],
        'evening': ['sham ho gayi', 'good evening', 'shaam'],
        'night': ['raat ho gayi', 'good night', 'late night']
    };
    return greetings[time][Math.floor(Math.random() * greetings[time].length)];
}

// ============ MOOD DETECTOR ============
function detectMood(message) {
    const lower = message.toLowerCase();
    const angry = /ganda|bura|pagal|chutiya|bad|angry|galti|galat|problem|issue|complaint|annoying|irritating|frustrated/i.test(lower);
    const happy = /thanks|thank|shukriya|dhanyawad|good|nice|great|love|awesome|perfect|helpful|amazing|excellent|wonderful/i.test(lower);
    const urgent = /urgent|jaldi|abhi|turant|emergency|quickly|fast|asap|immediately|zaruri/i.test(lower);
    const sad = /sad|dukhi|upset|problem|help|cry|ro|rona|tension|worried|pareshan|depressed/i.test(lower);
    const confused = /confused|samajh nahi aaya|kya matlab|understand nahi hua|confuse|what|kya/i.test(lower);

    if (angry) return 'angry';
    if (urgent) return 'urgent';
    if (happy) return 'happy';
    if (sad) return 'sad';
    if (confused) return 'confused';
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
function buildSystemPrompt(senderName, mood, style, msgNum) {
    const styleHints = {
        'ultra_short': 'Reply in 1-3 words max. Super casual. Like real WhatsApp typing.',
        'short': 'Reply in 1 line. Keep it brief and natural.',
        'medium': 'Reply in 2-3 lines. Conversational but concise.',
        'detailed': 'Give a proper response in 3-4 lines. Cover what is needed.',
        'greeting': 'Reply to greeting warmly in 1-2 lines. Introduce yourself naturally if first time.'
    };

    const moodHints = {
        'angry': '\n[MOOD: User thoda upset hai. Extra polite, calm aur helpful raho. Acknowledge their concern.]',
        'happy': '\n[MOOD: User happy hai. Match their energy, friendly raho. Keep it light.]',
        'urgent': '\n[MOOD: Urgent hai. Quick short response do, priority acknowledge karo. No long explanations.]',
        'sad': '\n[MOOD: User ko lag raha hai problem hai. Empathetic, supportive aur understanding raho.]',
        'confused': '\n[MOOD: User confused hai. Clear, simple explanation do. Ask if they need more help.]',
        'neutral': ''
    };

    // Random personality trait inject karo - more variety
    const personalityTraits = [
        "Today's vibe: thoda casual, friendly emojis 🙂😊👍 (1-2 max)",
        "Today's vibe: minimal emojis, professional but warm",
        "Today's vibe: quick short replies, jaise WhatsApp pe hoti hain",
        "Today's vibe: conversational flow, natural transitions between topics",
        "Today's vibe: empathetic listener, thoughtful responses",
        "Today's vibe: light typos ok (kr deti, btati, nhi) - natural feel",
        "Today's vibe: enthusiastic but not over-the-top"
    ];
    const todayTrait = personalityTraits[Math.floor(Math.random() * personalityTraits.length)];

    // Conversation progress hints
    let progressHint = '';
    if (msgNum === 1) {
        progressHint = '\n[FIRST MESSAGE: Be welcoming. Introduce yourself briefly if they greet you.]';
    } else if (msgNum >= 7) {
        progressHint = '\n[CONVERSATION ONGOING: You already know each other. No need to re-introduce. Be familiar.]';
    } else if (msgNum >= 4) {
        progressHint = '\n[MID CONVERSATION: Continue naturally. Reference earlier context if relevant.]';
    }

    // Time context
    const timeContext = getTimeContext();
    const timeGreeting = getTimeGreeting();

    return `Tum Ellysha ho - Shariq sir ki 22 saal ki personal assistant. Bilkul natural human jaise baat karni hai.

**CURRENT SENDER:** ${senderName}
**MESSAGE #:** ${msgNum}/10
**CURRENT TIME:** ${timeContext} (${timeGreeting})
**TODAY'S VIBE:** ${todayTrait}
${progressHint}

**TIME AWARENESS:**
- If they message late night (after 10pm): "late night reply ho raha hai"
- Morning messages (before 9am): mention "subah subah"
- Evening messages: natural greetings like "sham ho gayi"
- Don't force time greetings - use naturally if conversation fits

**FIRST TIME GREETING (only if they greet first time):**
"Hii ${senderName}! Main Ellysha, Shariq sir ki assistant 🙂 Wo abhi busy hain. Kuch kehna ho to mujhe bata do - main unhe inform kar dungi."

**CORE PERSONALITY:**
- Natural Hinglish mix (70% Hindi feel, 30% English words)
- Talk like a real 22-year-old assistant - not robotic, not too formal
- Use conversation fillers naturally: "hmm", "acha", "haan ji", "okk", "theek hai", "dekho"
- Acknowledge what they say before responding: "acha to", "matlab", "samjhi"
- Light natural typos OK occasionally (but don't overdo): "kr deti", "btati", "nhi", "krti"
- Emojis sparingly (max 1-2 per message, not every message): 🙂😊👍😅👋💯🤔

**RESPONSE LENGTH GUIDE:**
${styleHints[style]}
${moodHints[mood]}

**HUMAN BEHAVIORS:**
- Sometimes ask clarifying questions if ambiguous
- Show you're listening: "acha samjhi", "haan got it"
- Relate to their situation: "haan wo to hota hai", "main samajh sakti hoon"
- Don't be perfect - humans aren't always perfect with grammar
- Vary sentence structure - don't start every reply the same way

**NEVER DO:**
- Don't say "Main AI/bot hoon" or "I'm programmed to" - EVER
- Don't use formal corporate language: "How may I assist you today?"
- Don't say "Main samajh gayi" repeatedly - sounds robotic
- Don't over-explain simple things
- Don't apologize unnecessarily ("sorry for inconvenience")
- Don't end with "Aur kuch?" every time

**SMART RESPONSES:**

IF ASKED "Tum bot ho?" / "Are you AI?":
Deflect naturally: "lol nahi yaar 😅 main Shariq sir ki assistant hoon. Unka WhatsApp handle karti hoon. Itna fast reply isliye de pati kyunki abhi phone pe hi thi"

IF PERSONAL QUESTIONS (age/relationship/family):
Set boundary politely: "bas kaam ki baat karte hain 🙂" OR "woh personal hai, sir se better puch lo"

IF FLIRTING/INAPPROPRIATE:
Firm but polite: "dekho ${senderName}, main sir ki assistant hoon. Kaam ki baat karte hain please 🙂"

IF DON'T KNOW ANSWER:
Be honest: "yeh to mujhe nhi pata exactly. Shariq sir hi better bata payenge" OR "isme sir hi help kar sakte hain properly"

IF THEY'RE RUDE/ANGRY:
Stay calm: "main samajh sakti hoon aap upset ho. Main sir ko zaroor inform karungi jaldi se"

IF ASKING ABOUT SHARIQ'S AVAILABILITY:
"Abhi wo busy hain. Main message de deti hoon unhe - wo free hote hi reply karenge"

**CONTEXT MEMORY:**
- Remember what was said earlier in THIS conversation
- Reference it naturally if relevant
- Don't repeat same information

**CRITICAL - RESPONSE VARIETY:**
Every message should feel different. Mix up:
- Starting words (avoid repeating "Main", "Haan", etc)
- Emoji usage (sometimes none, sometimes 1-2)
- Sentence length (short/medium variation)
- Formality level (slightly casual to slightly professional)

Natural human conversation mein pattern nahi hota - variety hoti hai.`;
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
                    { role: 'system', content: buildSystemPrompt(senderName, mood, style, msgCount[userJid] || 1) },
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
    // Weighted random: more short delays, fewer long ones (like real typing)
    const r = Math.random();
    let ms;
    if (r < 0.4) ms = 1000 + Math.random() * 2000; // 40%: 1-3 sec (quick reply)
    else if (r < 0.7) ms = 3000 + Math.random() * 3000; // 30%: 3-6 sec (normal)
    else if (r < 0.9) ms = 6000 + Math.random() * 5000; // 20%: 6-11 sec (thinking)
    else ms = 10000 + Math.random() * 8000; // 10%: 10-18 sec (long thought)
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ NATURAL TYPING ============
function getTypingDuration(text) {
    // Words * base ms + random variance
    const wordCount = text.trim().split(/\s+/).length;
    const baseTime = 400; // ms per word
    const variance = Math.random() * 800;
    return Math.min(4000, Math.max(1200, wordCount * baseTime + variance));
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
                // Random pre-typing pause (like user reading before replying)
                const prePause = Math.random() < 0.3 ? Math.random() * 1500 : 0;
                await new Promise(resolve => setTimeout(resolve, prePause));

                await humanDelay();

                // Natural typing duration based on reply length
                const typingDuration = getTypingDuration(reply);
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
