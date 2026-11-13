const TelegramBot = require('node-telegram-bot-api');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, prepareWAMessageMedia, Browsers, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { useMongoAuthState } = require('baileys-mongodb');
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

// --- TELEGRAM COMMANDS ---
bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, "👋 Use `/link` to connect your WhatsApp via QR Code.\nUse `.grstatus <text>` to post."));

// 🚨 ROBUST RESET: Uses the official removeCreds() function from baileys-mongodb
bot.onText(/\/reset/, async (msg) => {
    const chatId = msg.chat.id;
    const sessionId = `session-${chatId}`;
    bot.sendMessage(chatId, "🧹 Clearing session...");
    try {
        const { removeCreds } = await useMongoAuthState(MONGO_URI, sessionId);
        await removeCreds();
        bot.sendMessage(chatId, "✅ Session cleared! Use `/link` to try again.");
    } catch (e) {
        bot.sendMessage(chatId, `❌ Failed to clear session: ${e.message}`);
    }
});

bot.onText(/\/link/, async (msg) => {
    const chatId = msg.chat.id;
    if (activeSessions.has(chatId)) return bot.sendMessage(chatId, "⚠️ Already linked.");
    
    // 🚨 Force a wipe before linking to ensure no stale session blocks the QR
    const sessionId = `session-${chatId}`;
    try {
        const { removeCreds } = await useMongoAuthState(MONGO_URI, sessionId);
        await removeCreds();
    } catch (e) { console.log("Pre-link clear warning:", e.message); }

    bot.sendMessage(chatId, "⏳ Generating QR Code... Please wait a moment.");
    startWhatsAppSession(chatId);
});

// --- WHATSAPP COMMAND LISTENER ---
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
            browser: Browsers.ubuntu('Chrome'), // 🚨 CHANGED: Ubuntu/Chrome works reliably on Render
            markOnlineOnConnect: false,
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);
        let qrTimeout;

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;
            
            // 🚨 DEBUG LOG: See exactly what state the connection is in
            if (connection) console.log(`Connection state: ${connection}`);

            if (qr) {
                clearTimeout(qrTimeout);
                try {
                    const qrImageBuffer = await QRCode.toBuffer(qr);
                    await bot.sendPhoto(chatId, qrImageBuffer, { caption: '📸 Scan this QR code with WhatsApp > Linked Devices.' });
                } catch (e) { console.log("QR error:", e); }
            }

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
                console.log(`Connection closed. Status: ${statusCode}`);
                
                if (statusCode === DisconnectReason.restartRequired) {
                    console.log('Restart required. Reconnecting...');
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

// --- STATUS POSTING LOGIC ---
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

// --- IMAGE FETCH HELPER ---
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
