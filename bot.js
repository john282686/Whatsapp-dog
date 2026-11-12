const TelegramBot = require('node-telegram-bot-api');
const { makeWASocket, DisconnectReason, prepareWAMessageMedia, Browsers, makeCacheableSignalKeyStore, fetchLatestWaWebVersion } = require('stian-baileys');
const { useMongoAuthState } = require('baileys-mongodb');
const P = require('pino');
const QRCode = require('qrcode');
const https = require('https');
const { getLinkPreview } = require('link-preview-js');
const express = require('express');

// 1. Catch unhandled errors
process.on('uncaughtException', (err) => console.error('🚨 Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('🚨 Unhandled Rejection:', reason));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const logger = P({ level: 'silent' });

// 2. Express Server (starts immediately)
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('Bot is running 24/7!'));
app.listen(process.env.PORT || 3000, () => console.log('✅ Express Server is listening.'));

// 3. Telegram Webhook
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
if (RENDER_URL) {
    bot.setWebHook(`${RENDER_URL}/bot${TELEGRAM_TOKEN}`).catch(err => console.error('❌ Webhook error:', err.message));
}
app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });

// State
const activeSessions = new Map();
const userStates = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Telegram Handlers ---
bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, "👋 Use `/link` to connect your WhatsApp.\nUse `.grstatus <text>` to post."));

bot.onText(/\/link/, (msg) => {
    const chatId = msg.chat.id;
    if (activeSessions.has(chatId)) return bot.sendMessage(chatId, "⚠️ Already linked.");
    userStates.set(chatId, { action: 'AWAITING_METHOD' });
    bot.sendMessage(chatId, "Link via:\n\n1️⃣ Reply `1` for QR Code\n2️⃣ Reply `2` for Pairing Code", { parse_mode: 'Markdown' });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim() : '';
    if (!text || text.startsWith('/')) return;
    const state = userStates.get(chatId);

    if (state && state.action === 'AWAITING_METHOD') {
        if (text === '1') {
            userStates.set(chatId, { action: 'CONNECTING_QR' });
            bot.sendMessage(chatId, "⏳ Generating QR Code...");
            startWhatsAppSession(chatId, 'qr');
        } else if (text === '2') {
            userStates.set(chatId, { action: 'AWAITING_PHONE' });
            bot.sendMessage(chatId, "📱 Send your WhatsApp number with country code (e.g., `233201065918`).");
        }
        return;
    }

    if (state && state.action === 'AWAITING_PHONE') {
        const cleanNumber = text.replace(/\D/g, '');
        if (cleanNumber.length < 10) return bot.sendMessage(chatId, "❌ Invalid number.");
        userStates.set(chatId, { action: 'CONNECTING_PAIR' });
        bot.sendMessage(chatId, "⏳ Requesting Pairing Code...");
        startWhatsAppSession(chatId, 'pair', cleanNumber);
        return;
    }

    if (text.startsWith('.grstatus ')) {
        const sock = activeSessions.get(chatId);
        if (!sock) return bot.sendMessage(chatId, "❌ Use `/link` first.");
        bot.sendMessage(chatId, "🚀 Preparing status...");
        postStatusToGroups(sock, text.replace('.grstatus ', '').trim(), chatId);
    }
});

// --- WhatsApp Connection Logic ---
async function startWhatsAppSession(chatId, method, phoneNumber = null) {
    try {
        const sessionId = `session-${chatId}`;
        const { state, saveCreds } = await useMongoAuthState(MONGO_URI, sessionId);
        
        // CRITICAL: Fetch the latest web version dynamically
        const { version } = await fetchLatestWaWebVersion({}); 

        const sock = makeWASocket({
            version: version,
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            printQRInTerminal: false,
            logger: logger,
            browser: Browsers.macOS('Desktop'), // Spoofs a desktop device
            markOnlineOnConnect: false,
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);
        let codeRequested = false;

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;

            if (method === 'pair' && (connection === 'connecting' || qr) && !sock.authState.creds.registered && !codeRequested) {
                codeRequested = true;
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    bot.sendMessage(chatId, `📱 YOUR PAIRING CODE: *${code}*\n\nGo to WhatsApp > Linked Devices > Link with phone number instead.`, { parse_mode: 'Markdown' });
                } catch (e) { bot.sendMessage(chatId, `❌ Pairing failed: ${e.message}`); userStates.delete(chatId); }
            }

            if (method === 'qr' && qr) {
                try {
                    const qrImageBuffer = await QRCode.toBuffer(qr);
                    await bot.sendPhoto(chatId, qrImageBuffer, { caption: '📸 Scan this QR code with WhatsApp.' });
                } catch (e) { console.log("QR error:", e); }
            }

            if (connection === 'open') {
                activeSessions.set(chatId, sock);
                userStates.delete(chatId);
                bot.sendMessage(chatId, "✅ WhatsApp linked! Use `.grstatus <text>`");
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    activeSessions.delete(chatId);
                    userStates.delete(chatId);
                    bot.sendMessage(chatId, "❌ Logged out. Use `/link` to reconnect with a fresh session.");
                } else if (statusCode === DisconnectReason.restartRequired) {
                    startWhatsAppSession(chatId, method, phoneNumber); // Safe to reconnect
                }
            }
        });
    } catch (err) {
        console.error("Session error:", err);
        bot.sendMessage(chatId, "❌ Internal error. Check Render logs.");
    }
}

// --- Posting Logic (same as before, kept for completeness) ---
async function postStatusToGroups(sock, statusMessage, chatId) {
    // ... (Your existing postStatusToGroups function from the previous code goes here) ...
}

const fetchImageBuffer = (url) => { /* ... */ };

console.log("Telegram Manager Bot is running...");
