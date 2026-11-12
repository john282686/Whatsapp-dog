const TelegramBot = require('node-telegram-bot-api');
const { makeWASocket, DisconnectReason, prepareWAMessageMedia, Browsers, makeCacheableSignalKeyStore } = require('stian-baileys');
const { useMongoAuthState } = require('baileys-mongodb');
const P = require('pino');
const QRCode = require('qrcode');
const https = require('https');
const { getLinkPreview } = require('link-preview-js');
const express = require('express');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const logger = P({ level: 'silent' });

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const activeSessions = new Map();
const userStates = new Map();

// --- Telegram Commands ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "👋 Welcome! Use `/link` to connect your WhatsApp account.\nUse `.grstatus <text>` to post a status.");
});

bot.onText(/\/link/, (msg) => {
    const chatId = msg.chat.id;
    if (activeSessions.has(chatId)) return bot.sendMessage(chatId, "⚠️ You already have an account linked.");
    userStates.set(chatId, { action: 'AWAITING_METHOD' });
    bot.sendMessage(chatId, "How would you like to link your WhatsApp?\n\n1️⃣ Reply with `1` for QR Code\n2️⃣ Reply with `2` for Pairing Code", { parse_mode: 'Markdown' });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim() : '';
    if (!text || text.startsWith('/')) return;

    const state = userStates.get(chatId);

    if (state && state.action === 'AWAITING_METHOD') {
        if (text === '1') {
            userStates.set(chatId, { action: 'CONNECTING_QR' });
            bot.sendMessage(chatId, "⏳ Generating QR Code... Please wait.");
            startWhatsAppSession(chatId, 'qr');
        } else if (text === '2') {
            userStates.set(chatId, { action: 'AWAITING_PHONE' });
            bot.sendMessage(chatId, "📱 Please send your WhatsApp phone number with the country code (e.g., `233201065918`). No `+` sign.");
        } else {
            bot.sendMessage(chatId, "❌ Invalid choice. Please reply with `1` or `2`.");
        }
        return;
    }

    if (state && state.action === 'AWAITING_PHONE') {
        const cleanNumber = text.replace(/\D/g, '');
        if (cleanNumber.length < 10) return bot.sendMessage(chatId, "❌ Invalid number. Please try again.");
        userStates.set(chatId, { action: 'CONNECTING_PAIR' });
        bot.sendMessage(chatId, "⏳ Requesting Pairing Code from WhatsApp...");
        startWhatsAppSession(chatId, 'pair', cleanNumber);
        return;
    }

    if (text.startsWith('.grstatus ')) {
        const sock = activeSessions.get(chatId);
        if (!sock) return bot.sendMessage(chatId, "❌ You need to link your WhatsApp first using `/link`.");
        bot.sendMessage(chatId, "🚀 Preparing status...");
        postStatusToGroups(sock, text.replace('.grstatus ', '').trim(), chatId);
    }
});

// --- WhatsApp Connection Logic ---
async function startWhatsAppSession(chatId, method, phoneNumber = null) {
    try {
        const sessionId = `session-${chatId}`;
        const { state, saveCreds } = await useMongoAuthState(MONGO_URI, sessionId);

        const sock = makeWASocket({
            version: [2, 3000, 1023223821],
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger: logger,
            browser: Browsers.macOS('Desktop'),
            markOnlineOnConnect: false,
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);
        let codeRequested = false;

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;

            // 🚨 FIX: Pairing Code must wait for 'connecting' state
            if (method === 'pair' && connection === 'connecting' && !sock.authState.creds.registered && !codeRequested) {
                codeRequested = true;
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    bot.sendMessage(chatId, `📱 YOUR PAIRING CODE: *${code}*\n\nGo to WhatsApp > Linked Devices > Link with phone number instead.`, { parse_mode: 'Markdown' });
                } catch (e) {
                    bot.sendMessage(chatId, `❌ Failed to get pairing code: ${e.message}. Please try the QR code method instead.`);
                    userStates.delete(chatId);
                }
            }

            // Handle QR Code
            if (method === 'qr' && qr) {
                try {
                    const qrImageBuffer = await QRCode.toBuffer(qr);
                    await bot.sendPhoto(chatId, qrImageBuffer, { caption: '📸 Scan this QR code with WhatsApp > Linked Devices.' });
                } catch (e) { console.log("Error sending QR image:", e); }
            }

            // Handle connection open
            if (connection === 'open') {
                activeSessions.set(chatId, sock);
                userStates.delete(chatId);
                bot.sendMessage(chatId, "✅ WhatsApp linked successfully!\nYou can now use `.grstatus <text>`");
            }

            // Handle connection close and reconnection
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    activeSessions.delete(chatId);
                    userStates.delete(chatId);
                    bot.sendMessage(chatId, "❌ WhatsApp logged out. Use `/link` to reconnect.");
                } else if (statusCode === DisconnectReason.restartRequired) {
                    // 🚨 FIX: This is the normal step after a QR scan. Reconnect to finalize.
                    console.log(`Session for ${chatId} needs a restart. Reconnecting...`);
                    startWhatsAppSession(chatId, method, phoneNumber);
                }
            }
        });
    } catch (err) {
        console.error("Error starting session:", err);
        bot.sendMessage(chatId, "❌ Internal error starting session. Check Render logs.");
    }
}

// --- Your posting logic (postStatusToGroups, fetchImageBuffer, Express server, etc.) remains the same ---
