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

bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, "👋 Use `/link` to connect your WhatsApp.\nUse `.grstatus <text>` to post."));

bot.onText(/\/link/, async (msg) => {
    const chatId = msg.chat.id;
    if (activeSessions.has(chatId)) return bot.sendMessage(chatId, "⚠️ Already linked.");

    const sessionId = `session-${chatId}`;
    bot.sendMessage(chatId, "🧹 Clearing old session from database...");
    
    // 🚨 FORCE CLEAR THE SESSION USING NATIVE MONGODB DRIVER
    let client;
    try {
        client = new MongoClient(MONGO_URI);
        await client.connect();
        const db = client.db(); // Uses the database name in the connection string
        // Baileys-mongodb usually stores sessions in a collection called 'sessions' or similar
        // We will try to delete the specific document for this user
        const collection = db.collection('sessions');
        await collection.deleteOne({ _id: sessionId }); 
        // Also try deleting from 'baileys_auth' if that exists
        try {
            await db.collection('baileys_auth').deleteOne({ _id: sessionId });
        } catch (e) {} 
        console.log(`Session ${sessionId} cleared from database.`);
        bot.sendMessage(chatId, "✅ Session cleared! Generating fresh QR Code...");
    } catch (e) {
        console.error("DB clear error:", e);
        bot.sendMessage(chatId, `⚠️ Could not clear DB, but trying to generate QR anyway...`);
    } finally {
        if (client) await client.close();
    }

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
            version: [2, 3000, 1023223821],
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            printQRInTerminal: false,
            logger: logger,
            browser: Browsers.macOS('Desktop'),
            markOnlineOnConnect: false,
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;

            if (qr) {
                try {
                    const qrImageBuffer = await QRCode.toBuffer(qr);
                    await bot.sendPhoto(chatId, qrImageBuffer, { caption: '📸 Scan this QR code with WhatsApp > Linked Devices.' });
                } catch (e) { console.log("QR error:", e); }
            }

            if (connection === 'open') {
                activeSessions.set(chatId, sock);
                bot.sendMessage(chatId, "✅ WhatsApp linked! Use `.grstatus <text>`");
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    activeSessions.delete(chatId);
                    bot.sendMessage(chatId, "❌ Logged out. Use `/link` to reconnect.");
                } else if (statusCode === DisconnectReason.restartRequired) {
                    startWhatsAppSession(chatId);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
