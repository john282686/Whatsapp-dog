const TelegramBot = require('node-telegram-bot-api');
const { makeWASocket, DisconnectReason, prepareWAMessageMedia, Browsers, makeCacheableSignalKeyStore } = require('stian-baileys');
const { useMongoAuthState } = require('baileys-mongodb');
const P = require('pino');
const QRCode = require('qrcode'); // For generating QR images
const https = require('https');
const { getLinkPreview } = require('link-preview-js');
const express = require('express');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const logger = P({ level: 'silent' });

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Stores active WhatsApp sockets and user states
const activeSessions = new Map();
const userStates = new Map(); 

// --- 🟢 TELEGRAM COMMANDS ---

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "👋 Welcome to the Multi-Bot Manager!\n\nUse `/link` to connect your WhatsApp account.\nUse `.grstatus <text>` to post a status.");
});

bot.onText(/\/link/, (msg) => {
    const chatId = msg.chat.id;
    if (activeSessions.has(chatId)) {
        return bot.sendMessage(chatId, "⚠️ You already have a WhatsApp account linked.");
    }
    
    // Ask the user to choose their method
    userStates.set(chatId, { action: 'AWAITING_METHOD' });
    bot.sendMessage(chatId, "How would you like to link your WhatsApp?\n\n1️⃣ Reply with `1` for QR Code\n2️⃣ Reply with `2` for Pairing Code", { parse_mode: 'Markdown' });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim() : '';
    
    if (!text || text.startsWith('/')) return; // Ignore commands for this handler

    const state = userStates.get(chatId);

    // 1. User chooses method
    if (state && state.action === 'AWAITING_METHOD') {
        if (text === '1') {
            userStates.set(chatId, { action: 'CONNECTING_QR' });
            bot.sendMessage(chatId, "⏳ Generating QR Code... Please wait.");
            startWhatsAppSession(chatId, 'qr');
        } else if (text === '2') {
            userStates.set(chatId, { action: 'AWAITING_PHONE' });
            bot.sendMessage(chatId, "📱 Please send your WhatsApp phone number with the country code (e.g., `233201065918`). Do not include the `+` sign.");
        } else {
            bot.sendMessage(chatId, "❌ Invalid choice. Please reply with `1` or `2`.");
        }
        return;
    }

    // 2. User provides phone number for Pairing Code
    if (state && state.action === 'AWAITING_PHONE') {
        const cleanNumber = text.replace(/\D/g, '');
        if (cleanNumber.length < 10) {
            return bot.sendMessage(chatId, "❌ Invalid number. Please try again.");
        }
        userStates.set(chatId, { action: 'CONNECTING_PAIR' });
        bot.sendMessage(chatId, "⏳ Requesting Pairing Code from WhatsApp...");
        startWhatsAppSession(chatId, 'pair', cleanNumber);
        return;
    }

    // 3. Handle .grstatus command
    if (text.startsWith('.grstatus ')) {
        const sock = activeSessions.get(chatId);
        if (!sock) {
            return bot.sendMessage(chatId, "❌ You need to link your WhatsApp first using `/link`.");
        }
        
        const statusMessage = text.replace('.grstatus ', '').trim();
        bot.sendMessage(chatId, "🚀 Preparing status...");
        postStatusToGroups(sock, statusMessage, chatId);
    }
});

// --- 🟡 WHATSAPP CONNECTION LOGIC ---

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

            // If user chose QR Code
            if (method === 'qr' && qr) {
                try {
                    const qrImageBuffer = await QRCode.toBuffer(qr);
                    await bot.sendPhoto(chatId, qrImageBuffer, { caption: '📸 Scan this QR code with WhatsApp > Linked Devices.' });
                } catch (e) {
                    console.log("Error sending QR image:", e);
                }
            }

            // If user chose Pairing Code
            if (method === 'pair' && connection === 'connecting' && !sock.authState.creds.registered && !codeRequested) {
                codeRequested = true;
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    bot.sendMessage(chatId, `📱 YOUR PAIRING CODE: *${code}*\n\nGo to WhatsApp > Linked Devices > Link with phone number instead.`, { parse_mode: 'Markdown' });
                } catch (e) {
                    bot.sendMessage(chatId, `❌ Failed to get pairing code: ${e.message}`);
                    userStates.delete(chatId);
                }
            }

            if (connection === 'open') {
                activeSessions.set(chatId, sock);
                userStates.delete(chatId);
                bot.sendMessage(chatId, "✅ WhatsApp linked successfully!\nYou can now use `.grstatus <text>`");
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    activeSessions.delete(chatId);
                    userStates.delete(chatId);
                    bot.sendMessage(chatId, "❌ WhatsApp logged out. Use `/link` to reconnect.");
                } else {
                    // Reconnect logic handled by PM2 / Render if it crashes, or manual retry here.
                }
            }
        });
    } catch (err) {
        console.log("Error starting session:", err);
        bot.sendMessage(chatId, "❌ Internal error starting session.");
    }
}

// --- 🚀 STATUS POSTING LOGIC ---

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

// --- 🌐 RENDER KEEP-ALIVE ---
const app = express();
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(process.env.PORT || 3000, () => console.log('Server ready'));

setInterval(() => {
    if (process.env.RENDER_EXTERNAL_URL) {
        https.get(process.env.RENDER_EXTERNAL_URL, (res) => console.log(`Ping: ${res.statusCode}`)).on('error', () => {});
    }
}, 14 * 60 * 1000);

console.log("Telegram Manager Bot is running...");
