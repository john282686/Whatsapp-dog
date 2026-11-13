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
const userStates = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Telegram Handlers ---
bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, "👋 Use `/link` to connect your WhatsApp.\nUse `.grstatus <text>` to post."));

bot.onText(/\/reset/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "🧹 Clearing session...");
    const sessionId = `session-${chatId}`;
    try {
        const authState = await useMongoAuthState(MONGO_URI, sessionId);
        if (typeof authState.removeCreds === 'function') {
            await authState.removeCreds();
        } else {
            const client = new MongoClient(MONGO_URI);
            await client.connect();
            const db = client.db();
            await db.collection('sessions').deleteOne({ _id: sessionId });
            await db.collection('baileys_auth').deleteOne({ _id: sessionId });
            await client.close();
        }
        bot.sendMessage(chatId, "✅ Session cleared! Use `/link` to try again.");
    } catch (e) {
        bot.sendMessage(chatId, `❌ Failed to clear session: ${e.message}`);
    }
});

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
            bot.sendMessage(chatId, "⏳ Generating QR Code... Please wait a moment.");
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

async function startWhatsAppSession(chatId, method, phoneNumber = null) {
    try {
        const sessionId = `session-${chatId}`;
        const { state, saveCreds } = await useMongoAuthState(MONGO_URI, sessionId);

        // 🚨 FIX: Use a stable, hardcoded version to prevent 405 errors
        const sock = makeWASocket({
            version: [2, 3000, 1023223821], 
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            printQRInTerminal: false, // Deprecated
            logger: logger,
            browser: Browsers.macOS('Desktop'),
            markOnlineOnConnect: false,
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);
        let codeRequested = false;
        let qrTimeout;

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;

            // 🚨 FIX: Listen for the 'qr' event and render it manually
            if (qr) {
                if (method === 'qr') {
                    clearTimeout(qrTimeout);
                    try {
                        const qrImageBuffer = await QRCode.toBuffer(qr);
                        await bot.sendPhoto(chatId, qrImageBuffer, { caption: '📸 Scan this QR code with WhatsApp > Linked Devices.' });
                    } catch (e) { console.log("QR error:", e); }
                } 
                // 🚨 FIX: Request pairing code ONLY when the QR event fires (WebSocket is ready)
                else if (method === 'pair' && !sock.authState.creds.registered && !codeRequested) {
                    codeRequested = true;
                    try {
                        const code = await sock.requestPairingCode(phoneNumber);
                        bot.sendMessage(chatId, `📱 YOUR PAIRING CODE: *${code}*\n\nGo to WhatsApp > Linked Devices > Link with phone number instead.`, { parse_mode: 'Markdown' });
                    } catch (e) { 
                        bot.sendMessage(chatId, `❌ Pairing failed: ${e.message}`); 
                        userStates.delete(chatId); 
                    }
                }
            }

            // 🚨 FIX: Timeout to prevent infinite hang
            if (method === 'qr' && connection === 'connecting') {
                qrTimeout = setTimeout(() => {
                    bot.sendMessage(chatId, "❌ QR code generation timed out. Please use `/reset` and try again.");
                    userStates.delete(chatId);
                    sock.end(new Error('QR timeout')); 
                }, 60000); // 60-second timeout
            }

            if (connection === 'open') {
                clearTimeout(qrTimeout);
                activeSessions.set(chatId, sock);
                userStates.delete(chatId);
                bot.sendMessage(chatId, "✅ WhatsApp linked! Use `.grstatus <text>`");
            }

            if (connection === 'close') {
                clearTimeout(qrTimeout);
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                if (statusCode === DisconnectReason.restartRequired) {
                    console.log('Restart required. Reconnecting...');
                    startWhatsAppSession(chatId, method, phoneNumber);
                } else if (statusCode === DisconnectReason.loggedOut) {
                    activeSessions.delete(chatId);
                    userStates.delete(chatId);
                    bot.sendMessage(chatId, "❌ Logged out. Use `/reset` then `/link` to try again.");
                } else {
                    setTimeout(() => startWhatsAppSession(chatId, method, phoneNumber), 5000);
                }
            }
        });
    } catch (err) {
        console.error("Session error:", err);
        bot.sendMessage(chatId, "❌ Internal error. Check Render logs.");
    }
}

// --- Posting Logic (Same as before) ---
async function postStatusToGroups(sock, statusMessage, chatId) {
    try {
        const groups = await sock.groupFetchAllParticipating();
        let validGroups = Object.values(groups).filter(g => !g.announce);
        validGroups = validGroups.sort(() => Math.random() - 0.5);
        
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = statusMessage.match(urlRegex);
        
        let imgBuffer = null;
        let channelName = "Join the Channel";
        let channelDesc = "Click the link to view";

        if (urls && urls.length > 0) {
            const targetUrl = urls[0];
            if (targetUrl.includes('whatsapp.com/channel/')) {
                const channelId = targetUrl.split('/channel/')[1]?.split('?')[0];
                if (channelId) {
                    try {
                        const metadata = await sock.newsletterMetadata("invite", channelId);
                        if (metadata) {
                            channelName = metadata.name || channelName;
                            channelDesc = metadata.description || channelDesc;
                            if (metadata.preview) imgBuffer = await fetchImageBuffer(metadata.preview);
                        }
                    } catch (e) { }
                }
            } else if (targetUrl.includes('chat.whatsapp.com/')) {
                const inviteCode = targetUrl.split('/').pop();
                try {
                    const groupInfo = await sock.groupGetInviteInfo(inviteCode);
                    if (groupInfo) {
                        channelName = groupInfo.subject || channelName;
                        channelDesc = groupInfo.desc || channelDesc;
                    }
                } catch (e) { }
            } else {
                try {
                    const preview = await getLinkPreview(targetUrl, { headers: { 'user-agent': 'Mozilla/5.0' } });
                    if (preview.title) channelName = preview.title;
                    if (preview.description) channelDesc = preview.description;
                    if (preview.images && preview.images.length > 0) {
                        imgBuffer = await fetchImageBuffer(preview.images[0]);
                    }
                } catch (e) { }
            }
        }

        if (!imgBuffer) {
            try { imgBuffer = await fetchImageBuffer('https://picsum.photos/500/500.jpg'); } catch (e) { }
        }

        let content = { text: statusMessage };
        if (imgBuffer) {
            const { imageMessage } = await prepareWAMessageMedia(
                { image: imgBuffer },
                { upload: sock.waUploadToServer, mediaTypeOverride: 'thumbnail-link' }
            );
            imageMessage.height = 720;
            imageMessage.width = 480;

            content = {
                text: statusMessage,
                linkPreview: {
                    'matched-text': urls ? urls[0] : '',
                    'canonical-url': urls ? urls[0] : '',
                    title: channelName,
                    description: channelDesc,
                    previewType: 0,
                    jpegThumbnail: imgBuffer,
                    highQualityThumbnail: imageMessage,
                    linkPreviewMetadata: { socialMediaPostType: 4, linkMediaDuration: 0 }
                }
            };
        }

        let count = 1;
        let successCount = 0;
        let batchCount = 0;

        for (const group of validGroups) {
            try {
                await sock.stianStatus.sendGroupStatus(group.id, content);
                successCount++;
                batchCount++;
            } catch (err) { }
            
            count++;
            if (count <= validGroups.length) {
                const humanJitter = Math.floor(Math.random() * 400) + 100;
                await sleep(1000 + humanJitter);
                if (batchCount === 20) {
                    await sleep(10000);
                    batchCount = 0;
                }
            }
        }
        
        bot.sendMessage(chatId, `🎉 Finished! Successfully posted to ${successCount}/${validGroups.length} groups.`);
    } catch (error) {
        bot.sendMessage(chatId, `❌ Error during posting: ${error.message}`);
    }
}

const fetchImageBuffer = (url) => {
    return new Promise((resolve, reject) => {
        const options = { headers: { 'User-Agent': 'Mozilla/5.0' } };
        https.get(url, options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchImageBuffer(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) return reject(new Error("Status " + res.statusCode));
            const data = [];
            res.on('data', (chunk) => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data)));
        }).on('error', reject);
    });
};
