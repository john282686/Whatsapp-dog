import TelegramBot from 'node-telegram-bot-api';
import { makeWASocket, DisconnectReason, Browsers, makeCacheableSignalKeyStore } from 'stian-baileys';
import { useMongoAuthState } from 'baileys-mongodb';
import { MongoClient } from 'mongodb';
import P from 'pino';
import QRCode from 'qrcode';
import https from 'https';
import express from 'express';

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });
const app = express();
app.use(express.json());
app.post(`/bot${process.env.TELEGRAM_TOKEN}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
app.listen(process.env.PORT || 3000, () => console.log('Server listening'));

const logger = P({ level: 'silent' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

bot.onText(/\/link/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "⏳ Wiping old session and generating QR...");
    
    // Force clear the database before connecting
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const db = client.db();
    await db.collection('sessions').deleteOne({ _id: `session-${chatId}` });
    await db.collection('baileys_auth').deleteOne({ _id: `session-${chatId}` });
    await client.close();

    startSession(chatId);
});

async function startSession(chatId) {
    const { state, saveCreds } = await useMongoAuthState(process.env.MONGO_URI, `session-${chatId}`);
    
    const sock = makeWASocket({
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        printQRInTerminal: false,
        logger: logger,
        browser: Browsers.macOS('Desktop'), // Bypasses the 405 error
        markOnlineOnConnect: false,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    let qrTimeout = setTimeout(() => {
        bot.sendMessage(chatId, "❌ Timeout. WhatsApp is blocking Render. Please try again in 1 hour.");
        sock.end(new Error('QR Timeout'));
    }, 45000); // Stop trying after 45 seconds

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            clearTimeout(qrTimeout);
            const qrImage = await QRCode.toBuffer(qr);
            await bot.sendPhoto(chatId, qrImage, { caption: '📸 Scan this QR code.' });
        }

        if (connection === 'open') {
            clearTimeout(qrTimeout);
            bot.sendMessage(chatId, "✅ WhatsApp linked successfully!");
        }

        if (connection === 'close') {
            clearTimeout(qrTimeout);
            const code = lastDisconnect?.error?.output?.statusCode;
            bot.sendMessage(chatId, `❌ Disconnected. Code: ${code}`);
            if (code !== DisconnectReason.loggedOut) {
                setTimeout(() => startSession(chatId), 5000);
            }
        }
    });
        }
