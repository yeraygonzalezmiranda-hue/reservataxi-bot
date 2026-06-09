const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN || '8707482336:AAETg0jJ6F5VgLcHCDYqeEHxemnZeALcMPI';
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || '';
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || '898842399';
const MONGODB_URI = process.env.MONGODB_URI;

// Conectar a MongoDB
mongoose.connect(MONGODB_URI).then(() => console.log('MongoDB conectado')).catch(err => console.error('Error MongoDB:', err));

// Esquemas
const conductorSchema = new mongoose.Schema({
  chatId: { type: String, unique: true },
  nombre: String,
  activo: { type: Boolean, default: true },
  fechaRegistro: { type: Date, default: Date.now }
});

const reservaSchema = new mongoose.Schema({
  datos: Object,
  estado: { type: String, default: 'pendiente' }, // pendiente, asignada, cancelada
  conductorAsignado: String,
  mensajesEnviados: [{ chatId: String, messageId: Number }],
  fechaCreacion: { type: Date, default: Date.now }
});

const Conductor = mongoose.model('Conductor', conductorSchema);
const Reserva = mongoose.model('Reserva', reservaSchema);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const bot = new TelegramBot(TOKEN, { polling: true });

// Comando /start para conductores
bot.onText(/\/start/, async (msg) => {
  const chatId = String(msg.chat.id);
  const nombre = msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : '');

  // Si es el dueño
  if (chatId === OWNER_CHAT_ID) {
    bot.sendMessage(chatId, '🚖 *Panel de administración*\n\nBienvenido, Yeray. Las reservas llegarán aquí automáticamente.', { parse_mode: 'Markdown' });
    return;
  }

  // Registrar conductor si no existe
  try {
    const existente = await Conductor.findOne({ chatId });
    if (!existente) {
      await Conductor.create({ chatId, nombre });
      bot.sendMessage(chatId, `✅ *¡Registrado correctamente!*\n\nHola ${nombre}, ya recibirás las reservas disponibles en este chat.\n\nCuando llegue una reserva verás los detalles y podrás aceptarla.`, { parse_mode: 'Markdown' });
      bot.sendMessage(OWNER_CHAT_ID, `🆕 Nuevo conductor registrado: *${nombre}* (ID: ${chatId})`, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, `👋 Hola ${nombre}, ya estás registrado. Recibirás las próximas reservas aquí.`);
    }
  } catch (err) {
    console.error(err);
  }
});

// Manejar botones de aceptar/rechazar
bot.on('callback_query', async (query) => {
  const chatId = String(query.message.chat.id);
  const messageId = query.message.message_id;
  const data = query.data;

  if (data.startsWith('aceptar_')) {
    const reservaId = data.replace('aceptar_', '');

    try {
      const reserva = await Reserva.findById(reservaId);
      if (!reserva || reserva.estado !== 'pendiente') {
        bot.answerCallbackQuery(query.id, { text: '❌ Esta reserva ya fue asignada.', show_alert: true });
        return;
      }

      // Marcar como asignada
      reserva.estado = 'asignada';
      reserva.conductorAsignado = chatId;
      await reserva.save();

      const conductor = await Conductor.findOne({ chatId });
      const nombreConductor = conductor ? conductor.nombre : 'Un conductor';

      // Confirmar al conductor que aceptó
      bot.editMessageText(`✅ *Reserva aceptada*\n\nHas aceptado este servicio. El cliente ha sido notificado.`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      });

      // Notificar al dueño
      bot.sendMessage(OWNER_CHAT_ID, `✅ *Reserva asignada*\n\nConductor: ${nombreConductor}\n\n${formatearReserva(reserva.datos)}`, { parse_mode: 'Markdown' });

      // Notificar a los demás conductores
      for (const msg of reserva.mensajesEnviados) {
        if (msg.chatId !== chatId) {
          try {
            bot.editMessageText(`⚠️ *Servicio ya asignado*\n\nEste servicio ya ha sido tomado por otro conductor.`, {
              chat_id: msg.chatId,
              message_id: msg.messageId,
              parse_mode: 'Markdown'
            });
          } catch (e) {}
        }
      }

      bot.answerCallbackQuery(query.id, { text: '✅ ¡Reserva aceptada!' });

    } catch (err) {
      console.error(err);
      bot.answerCallbackQuery(query.id, { text: 'Error. Inténtalo de nuevo.' });
    }
  }

  if (data.startsWith('rechazar_')) {
    bot.answerCallbackQuery(query.id, { text: 'Has rechazado este servicio.' });
    bot.editMessageText(`❌ *Servicio rechazado*\n\nHas rechazado este servicio.`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown'
    });
  }
});

function formatearReserva(data) {
  let msg = `👤 *Nombre:* ${data.nombre}\n`;
  msg += `📧 *Correo:* ${data.correo}\n`;
  msg += `📞 *Teléfono:* ${data.telefono}\n`;
  msg += `📅 *Fecha:* ${data.fecha} a las ${data.hora}\n`;
  msg += `📍 *Origen:* ${data.origen}\n`;
  msg += `🏁 *Destino:* ${data.destino}\n`;
  msg += `👥 *Pasajeros:* ${data.pasajeros}\n`;
  if (data.vuelo) msg += `✈️ *Vuelo:* ${data.vuelo}\n`;
  if (data.pasaporte) msg += `🛂 *Pasaporte:* ${data.pasaporte}\n`;
  if (data.observaciones) msg += `📝 *Observaciones:* ${data.observaciones}\n`;
  return msg;
}

// Recibir reserva del formulario
app.post('/reserva', async (req, res) => {
  const data = req.body;

  try {
    const conductores = await Conductor.find({ activo: true });

    if (conductores.length === 0) {
      // No hay conductores, solo notificar al dueño
      await bot.sendMessage(OWNER_CHAT_ID, `🚖 *NUEVA RESERVA* (sin conductores disponibles)\n\n${formatearReserva(data)}`, { parse_mode: 'Markdown' });
      return res.json({ ok: true });
    }

    // Crear reserva en BD
    const reserva = await Reserva.create({ datos: data });

    const mensajesEnviados = [];

    const texto = `🚖 *NUEVA RESERVA DISPONIBLE*\n\n${formatearReserva(data)}\n⏰ Responde rápido para aceptarla.`;

    // Enviar a cada conductor
    for (const conductor of conductores) {
      try {
        const msg = await bot.sendMessage(conductor.chatId, texto, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Aceptar', callback_data: `aceptar_${reserva._id}` },
              { text: '❌ Rechazar', callback_data: `rechazar_${reserva._id}` }
            ]]
          }
        });
        mensajesEnviados.push({ chatId: conductor.chatId, messageId: msg.message_id });
      } catch (e) {
        console.error(`Error enviando a conductor ${conductor.chatId}:`, e.message);
      }
    }

    // Guardar IDs de mensajes
    reserva.mensajesEnviados = mensajesEnviados;
    await reserva.save();

    // Notificar al dueño
    await bot.sendMessage(OWNER_CHAT_ID, `📨 *Nueva reserva enviada a ${conductores.length} conductor(es)*\n\n${formatearReserva(data)}`, { parse_mode: 'Markdown' });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
