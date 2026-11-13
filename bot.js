const TelegramBot = require('node-telegram-bot-api');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, prepareWAMessageMedia, Browsers, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { useMongoAuthState } = require('baileys-mongodb');
const { MongoClient } = require('mongodb');
const P = require('pino');
const QRCode = require('qrcode');
const https = require('https');
const { getLinkPreview } = require('link-preview-js');
const express = require('express');

process.on('uncaughtException', (err) => console.error('🚨 Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('🚨 Unhandled Rejection:', reason));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const logger = P({ level: 'silent' });

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('Bot is running 24/7!'));
app.listen(process.env.PORT || 3000, () => console.log('✅ Express Server is listening.'));

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
if (RENDER_URL) {
    bot.setWebHook(`${RENDER_URL}/bot${TELEGRAM_TOKEN}`).catch(err => console.error('❌ Webhook error:', err.message));
}
app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });

const activeSessions = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Telegram Handlers ---
bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, "👋 Use `/link` to connect your WhatsApp via QR Code.\nUse `.grstatus <text>` to post."));

// 🚨 FORCE CLEAR SESSION: Wipes old data from MongoDB
bot.onText(/\/reset/, async (msg) => {
    const chatId = msg.chat.id;
    const sessionId = `session-${chatId}`;
    bot.sendMessage(chatId, "🧹 Clearing session...");
    let client;
    try {
        client = new MongoClient(MONGO_URI);
        await client.connect();
        const db = client.db();
        await db.collection('sessions').deleteOne({ _id: sessionId });
        await db.collection('baileys_auth').deleteOne({ _id: sessionId });
        bot.sendMessage(chatId, "✅ Session cleared! Use `/link` to try again.");
    } catch (e) {
        bot.sendMessage(chatId, `❌ Failed to clear session: ${e.message}`);
    } finally {
        if (client) await client.close();
    }
});

bot.onText(/\/link/, (msg) => {
    const chatId = msg.chat.id;
    if (activeSessions.has(chatId)) return bot.sendMessage(chatId, "⚠️ Already linked.");
    bot.sendMessage(chatId, "⏳ Generating QR Code... Please wait a moment.");
    startWhatsAppSession(chatId);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim() : '';
    if (!text || text.startsWith('/')) return;

    if (text.startsWith('.grstatus ')) {
        const sock = activeSessions.get(chatId);
        if (!sock) return bot.sendMessage(chatId, "❌ Use `/link` first.");
        bot.sendMessage(chatId, "🚀 Preparing status...");
        postStatusToGroups(sock, text.replace('.grstatus ', '').trim(), chatId);
    }
});

// --- WHATSAPP CONNECTION LOGIC (QR ONLY) ---
async function startWhatsAppSession(chatId) {
    try {
        const sessionId = `session-${chatId}`;
        const { state, saveCreds } = await useMongoAuthState(MONGO_URI, sessionId);

        const sock = makeWASocket({
            version: [2, 3000, 1023223821], // Stable version, avoids fetchLatestWaWebVersion issues
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            printQRInTerminal: false, // Deprecated, we handle 'qr' event manually
            logger: logger,
            browser: Browsers.macOS('Desktop'), // 🚨 SPOOFS MACOS TO BYPASS 405/428 ERRORS
            markOnlineOnConnect: false,
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);
        let qrTimeout;

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;

            // 🚨 FIX: Listen for the 'qr' event and render it as an image
            if (qr) {
                clearTimeout(qrTimeout);
                try {
                    const qrImageBuffer = await QRCode.toBuffer(qr);
                    await bot.sendPhoto(chatId, qrImageBuffer, { caption: '📸 Scan this QR code with WhatsApp > Linked Devices.' });
                } catch (e) { console.log("QR error:", e); }
            }

            // 🚨 FIX: Timeout to prevent infinite hang
            if (connection === 'connecting') {
                qrTimeout = setTimeout(() => {
                    bot.sendMessage(chatId, "❌ QR code generation timed out. Please use `/reset` and try again.");
                    sock.end(new Error('QR timeout'));
                }, 60000); // 60-second timeout
            }

            if (connection === 'open') {
                clearTimeout(qrTimeout);
                activeSessions.set(chatId, sock);
                bot.sendMessage(chatId, "✅ WhatsApp linked! Use `.grstatus <text>`");
            }

            if (connection === 'close') {
                clearTimeout(qrTimeout);
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                // 🚨 FIX: Handle restartRequired (515) by reconnecting immediately
                if (statusCode === DisconnectReason.restartRequired) {
                    startWhatsAppSession(chatId);
                } else if (statusCode === DisconnectReason.loggedOut) {
                    activeSessions.delete(chatId);
                    bot.sendMessage(chatId, "❌ Logged out. Use `/reset` then `/link` to try again.");
                } else {
                    setTimeout(() => startWhatsAppSession(chatId), 5000);
                }
            }
        });
    } catch (err) {
        console.error("Session error:", err);
        bot.sendMessage(chatId, "❌ Internal error. Check Render logs.");
    }
}

// --- Posting Logic and fetchImageBuffer (Same as before) ---
async function postStatusToGroups(sock, statusMessage, chatId) {
    // ... (Your existing postStatusToGroups function goes here) ...
}

const fetchImageBuffer = (url) => {
    // ... (Your existing fetchImageBuffer function goes here) ...
};
