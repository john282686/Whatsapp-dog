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
        activeSessions.set(chatId, sock);
        bot.sendMessage(chatId, "✅ WhatsApp linked! You can now type `.grstatus <text>` inside WhatsApp.");
        simulateHumanPresence(sock);
    }

    if (connection === 'close') {
        clearTimeout(qrTimeout);
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMessage = lastDisconnect?.error?.message || "Unknown error";
        
        console.log(`Disconnected. Code: ${statusCode} (${errorMessage})`);

        // 🚨 CRITICAL FIX: If 401 (loggedOut), DO NOT RECONNECT.
        if (statusCode === DisconnectReason.loggedOut) {
            bot.sendMessage(chatId, "❌ WhatsApp logged out the session. Clearing old data...");
            
            // 1. Delete the session from MongoDB using the correct function
            const { removeCreds } = await useMongoAuthState(MONGO_URI, sessionId);
            await removeCreds(); 
            
            // 2. Tell the user to start fresh
            activeSessions.delete(chatId);
            bot.sendMessage(chatId, "✅ Old session deleted. Please use `/link` to scan a new QR code.");

        } else if (statusCode === DisconnectReason.restartRequired) {
            // 515 is normal after scanning the QR code, so we reconnect
            startWhatsAppSession(chatId, false); 
        } else {
            // For any other error, we can safely try to reconnect
            if (!isInitialConnection) {
                bot.sendMessage(chatId, "❌ Connection lost. Use `/link` to reconnect.");
            }
        }
    }
});
