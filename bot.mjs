import TelegramBot from 'node-telegram-bot-api';
import makeWASocket, { DisconnectReason, prepareWAMessageMedia, Browsers, makeCacheableSignalKeyStore, fetchLatestWaWebVersion } from '@whiskeysockets/baileys';
import { useMongoAuthState } from 'baileys-mongodb';
import { MongoClient } from 'mongodb';
import P from 'pino';
import QRCode from 'qrcode';
import https from 'https';
import { getLinkPreview } from 'link-preview-js';
import express from 'express';

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

// 🚨 GLOBAL SOCKET MANAGER
const activeSockets = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function clearSessionFromDB(sessionId) {
    let client;
    try {
        client = new MongoClient(MONGO_URI);
        await client.connect();
        const db = client.db();
        await db.collection('sessions').deleteOne({ _id: sessionId });
        await db.collection('baileys_auth').deleteOne({ _id: sessionId });
        console.log(`✅ Session ${sessionId} wiped.`);
    } catch (e) {
        console.error("DB clear warning:", e.message);
    } finally {
        if (client) await client.close();
    }
}

bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, "👋 Use `/link` to connect your WhatsApp via QR Code."));

bot.onText(/\/reset/, async (msg) => {
    const chatId = msg.chat.id;
    const sessionId = `session-${chatId}`;
    bot.sendMessage(chatId, "🧹 Clearing session...");
    
    // Kill old socket if exists
    if (activeSockets.has(chatId)) {
        const oldSock = activeSockets.get(chatId);
        oldSock.end(new Error('Reset requested'));
        activeSockets.delete(chatId);
    }
    
    await clearSessionFromDB(sessionId);
    bot.sendMessage(chatId, "✅ Session cleared! Use `/link` to try again.");
});

bot.onText(/\/link/, async (msg) => {
    const chatId = msg.chat.id;
    
    // Kill old socket if exists
    if (activeSockets.has(chatId)) {
        const oldSock = activeSockets.get(chatId);
        oldSock.end(new Error('Relinking requested'));
        activeSockets.delete(chatId);
    }
    
    const sessionId = `session-${chatId}`;
    bot.sendMessage(chatId, "🧹 Preparing a fresh session...");
    await clearSessionFromDB(sessionId);
    await sleep(2000);
    
    bot.sendMessage(chatId, "⏳ Generating QR Code... Please wait.");
    startWhatsAppSession(chatId, true);
});

// --- CONNECTION LOGIC ---
async function startWhatsAppSession(chatId, isInitialConnection = false) {
    try {
        // 🚨 KILL EXISTING SOCKET TO PREVENT CONFLICT LOOPS
        if (activeSockets.has(chatId)) {
            const existing = activeSockets.get(chatId);
            existing.end(new Error('New session started'));
            activeSockets.delete(chatId);
        }

        const sessionId = `session-${chatId}`;
        const { state, saveCreds } = await useMongoAuthState(MONGO_URI, sessionId);
        const { version } = await fetchLatestWaWebVersion({});

        const sock = makeWASocket({
            version: version,
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            printQRInTerminal: false,
            logger: logger,
            browser: Browsers.macOS('Desktop'),
            markOnlineOnConnect: false,
            syncFullHistory: false,
            keepAliveIntervalMs: 30000 // Ping WhatsApp every 30s
        });

        // Save to global map
        activeSockets.set(chatId, sock);
        sock.ev.on('creds.update', saveCreds);
        let qrTimeout;

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;

            if (qr) {
                clearTimeout(qrTimeout);
                try {
                    const qrImageBuffer = await QRCode.toBuffer(qr);
                    await bot.sendPhoto(chatId, qrImageBuffer, { caption: '📸 Scan this QR code with WhatsApp > Linked Devices.' });
                } catch (e) { console.log("QR error:", e); }
            }

            if (connection === 'connecting') {
                qrTimeout = setTimeout(() => {
                    bot.sendMessage(chatId, "❌ Timeout: WhatsApp took too long to respond.");
                    sock.end(new Error('QR timeout'));
                }, 60000);
            }

            if (connection === 'open') {
                clearTimeout(qrTimeout);
                isInitialConnection = false; 
                bot.sendMessage(chatId, "✅ WhatsApp linked! You can now type `.grstatus <text>` inside WhatsApp.");
                
                // 🚨 RENDER KEEP-ALIVE: Send a presence update every 10 seconds to prevent Render from sleeping
                setInterval(async () => {
                    try {
                        await sock.sendPresenceUpdate('available');
                    } catch (e) {}
                }, 10000);

                simulateHumanPresence(sock);
            }

            if (connection === 'close') {
                clearTimeout(qrTimeout);
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                // 🚨 PREVENT FLOODING: Only notify and reconnect if this is the active socket
                if (activeSockets.get(chatId) !== sock) return; 

                if (statusCode === DisconnectReason.loggedOut) {
                    activeSockets.delete(chatId);
                    bot.sendMessage(chatId, "❌ WhatsApp logged out. Clearing data...");
                    await clearSessionFromDB(sessionId);
                    bot.sendMessage(chatId, "✅ Old session deleted. Use `/link` to scan a new QR code.");
                } else if (statusCode === DisconnectReason.restartRequired) {
                    console.log("515 Restart Required. Reconnecting...");
                    startWhatsAppSession(chatId, false); 
                } else {
                    console.log(`Connection dropped (Code: ${statusCode}). Reconnecting...`);
                    await sleep(5000);
                    // Only reconnect if we haven't been overwritten by a new socket
                    if (activeSockets.get(chatId) === sock) {
                        startWhatsAppSession(chatId, false);
                    }
                }
            }
        });

        // --- WHATSAPP MESSAGE LISTENER ---
        sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;
            for (const msg of m.messages) {
                if (!msg.message) continue;
                
                let messageContent = msg.message;
                if (messageContent.ephemeralMessage) messageContent = messageContent.ephemeralMessage.message;
                if (messageContent.viewOnceMessage) messageContent = messageContent.viewOnceMessage.message;
                if (messageContent.viewOnceMessageV2) messageContent = messageContent.viewOnceMessageV2.message;
                
                if (!messageContent) continue;

                const text = messageContent.conversation || messageContent.extendedTextMessage?.text;
                if (!text) continue;

                // 🚨 DEBUG: Log to Render and Telegram so we know it received the message
                if (text.includes('.grstatus')) {
                    bot.sendMessage(chatId, `🚨 CAUGHT CMD: "${text}"`).catch(() => {});
                }

                if (text.startsWith('.grstatus ') && msg.key.fromMe) {
                    const statusMessage = text.replace('.grstatus ', '').trim();
                    
                    await sock.sendMessage(msg.key.remoteJid, { text: "⏳ Preparing status..." });
                    postStatusToGroups(sock, statusMessage, msg.key.remoteJid);
                }
            }
        });

    } catch (err) {
        console.error("Session error:", err);
        if (isInitialConnection) bot.sendMessage(chatId, "❌ Internal error. Check Render logs.");
    }
}

// --- BACKGROUND HUMAN SIMULATION ---
async function simulateHumanPresence(sock) {
    while (true) {
        const waitMins = Math.floor(Math.random() * (90 - 30 + 1)) + 30;
        await sleep(waitMins * 60 * 1000);
        try {
            const myJid = `${sock.user.id.split(':')[0]}@s.whatsapp.net`;
            await sock.sendPresenceUpdate('composing', myJid);
            await sleep(Math.floor(Math.random() * 4000) + 3000);
            await sock.sendPresenceUpdate('paused', myJid);
        } catch (error) { }
    }
}

// --- POSTING LOGIC ---
async function postStatusToGroups(sock, statusMessage, targetJid) {
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

        await sock.sendMessage(targetJid, { text: `📊 Found ${validGroups.length} groups. Posting NOW...` });

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
                const humanJitter = Math.floor(Math.random() * 700) + 100;
                await sleep(1000 + humanJitter);
                if (batchCount === 20) {
                    await sleep(15000);
                    batchCount = 0;
                }
            }
        }
        
        await sock.sendMessage(targetJid, { text: `🎉 Finished! Successfully posted to ${successCount}/${validGroups.length} groups.` });
    } catch (error) {
        console.error("Posting error:", error);
        await sock.sendMessage(targetJid, { text: `❌ Error during posting: ${error.message}` });
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
