const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN || '8707482336:AAETg0jJ6F5VgLcHCDYqeEHxemnZeALcMPI';
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || '';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const bot = new TelegramBot(TOKEN, { polling: true });

// Comando /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const webAppUrl = `${BASE_URL}/`;

  bot.sendMessage(chatId, '🚖 *Bienvenido a Reserva Taxi Las Palmas de Gran Canaria*\n\nPulsa el botón para hacer tu reserva:', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        {
          text: '📋 Hacer una reserva',
          web_app: { url: webAppUrl }
        }
      ]]
    }
  });
});

// Recibir datos del formulario
app.post('/reserva', async (req, res) => {
  const data = req.body;

  let mensaje = `🚖 *NUEVA RESERVA*\n\n`;
  mensaje += `👤 *Nombre:* ${data.nombre}\n`;
  mensaje += `📧 *Correo:* ${data.correo}\n`;
  mensaje += `📞 *Teléfono:* ${data.telefono}\n`;
  mensaje += `📅 *Fecha y hora:* ${data.fecha} a las ${data.hora}\n`;
  mensaje += `📍 *Origen:* ${data.origen}\n`;
  mensaje += `🏁 *Destino:* ${data.destino}\n`;
  mensaje += `👥 *Pasajeros:* ${data.pasajeros}\n`;

  if (data.origen && data.origen.toLowerCase().includes('aeropuerto')) {
    mensaje += `✈️ *Número de vuelo:* ${data.vuelo || '-'}\n`;
    mensaje += `🛂 *Número de pasaporte:* ${data.pasaporte || '-'}\n`;
  }

  if (data.observaciones) {
    mensaje += `📝 *Observaciones:* ${data.observaciones}\n`;
  }

  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || '898842399';

  try {
    await bot.sendMessage(OWNER_CHAT_ID, mensaje, { parse_mode: 'Markdown' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
