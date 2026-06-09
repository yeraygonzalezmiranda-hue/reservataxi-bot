const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN || '8707482336:AAETg0jJ6F5VgLcHCDYqeEHxemnZeALcMPI';
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || '';
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || '898842399';
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI).then(() => {
  console.log('MongoDB conectado');
  iniciarRecordatorios();
}).catch(err => console.error('Error MongoDB:', err));

const conductorSchema = new mongoose.Schema({
  chatId: { type: String, unique: true },
  nombre: String,
  activo: { type: Boolean, default: true },
  fechaRegistro: { type: Date, default: Date.now }
});

const reservaSchema = new mongoose.Schema({
  datos: Object,
  clienteChatId: String,
  estado: { type: String, default: 'pendiente' },
  conductorAsignado: String,
  mensajesEnviados: [{ chatId: String, messageId: Number }],
  recordatorioEnviado: { type: Boolean, default: false },
  fechaServicio: Date,
  fechaCreacion: { type: Date, default: Date.now }
});

const Conductor = mongoose.model('Conductor', conductorSchema);
const Reserva = mongoose.model('Reserva', reservaSchema);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const bot = new TelegramBot(TOKEN, { polling: true });

// =================== COMANDOS ===================

bot.onText(/\/start/, async (msg) => {
  const chatId = String(msg.chat.id);
  const nombre = msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : '');

  if (chatId === OWNER_CHAT_ID) {
    bot.sendMessage(chatId,
      '🚖 *Panel de Administración*\n\n' +
      'Comandos disponibles:\n' +
      '📋 /pendientes — Ver reservas pendientes\n' +
      '✅ /asignadas — Ver reservas asignadas\n' +
      '❌ /canceladas — Ver reservas canceladas\n' +
      '👥 /conductores — Ver conductores registrados\n' +
      '📊 /resumen — Resumen del día',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  try {
    const existente = await Conductor.findOne({ chatId });
    if (!existente) {
      await Conductor.create({ chatId, nombre });
      bot.sendMessage(chatId, `✅ *¡Registrado correctamente!*\n\nHola ${nombre}, ya recibirás las reservas disponibles en este chat.`, { parse_mode: 'Markdown' });
      bot.sendMessage(OWNER_CHAT_ID, `🆕 Nuevo conductor registrado: *${nombre}* (ID: ${chatId})`, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, `👋 Hola ${nombre}, ya estás registrado. Recibirás las próximas reservas aquí.`);
    }
  } catch (err) {
    console.error(err);
  }
});

// Panel admin - reservas pendientes
bot.onText(/\/pendientes/, async (msg) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const reservas = await Reserva.find({ estado: 'pendiente' }).sort({ fechaCreacion: -1 }).limit(10);
  if (reservas.length === 0) return bot.sendMessage(OWNER_CHAT_ID, '📋 No hay reservas pendientes.');
  let texto = `📋 *RESERVAS PENDIENTES (${reservas.length})*\n\n`;
  reservas.forEach((r, i) => {
    texto += `*${i+1}.* ${r.datos.nombre} — ${r.datos.fecha} ${r.datos.hora}\n`;
    texto += `   📍 ${r.datos.origen} → ${r.datos.destino}\n\n`;
  });
  bot.sendMessage(OWNER_CHAT_ID, texto, { parse_mode: 'Markdown' });
});

// Panel admin - reservas asignadas
bot.onText(/\/asignadas/, async (msg) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const reservas = await Reserva.find({ estado: 'asignada' }).sort({ fechaCreacion: -1 }).limit(10);
  if (reservas.length === 0) return bot.sendMessage(OWNER_CHAT_ID, '✅ No hay reservas asignadas.');
  let texto = `✅ *RESERVAS ASIGNADAS (${reservas.length})*\n\n`;
  reservas.forEach((r, i) => {
    texto += `*${i+1}.* ${r.datos.nombre} — ${r.datos.fecha} ${r.datos.hora}\n`;
    texto += `   📍 ${r.datos.origen} → ${r.datos.destino}\n\n`;
  });
  bot.sendMessage(OWNER_CHAT_ID, texto, { parse_mode: 'Markdown' });
});

// Panel admin - reservas canceladas
bot.onText(/\/canceladas/, async (msg) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const reservas = await Reserva.find({ estado: 'cancelada' }).sort({ fechaCreacion: -1 }).limit(10);
  if (reservas.length === 0) return bot.sendMessage(OWNER_CHAT_ID, '❌ No hay reservas canceladas.');
  let texto = `❌ *RESERVAS CANCELADAS (${reservas.length})*\n\n`;
  reservas.forEach((r, i) => {
    texto += `*${i+1}.* ${r.datos.nombre} — ${r.datos.fecha} ${r.datos.hora}\n`;
    texto += `   📍 ${r.datos.origen} → ${r.datos.destino}\n\n`;
  });
  bot.sendMessage(OWNER_CHAT_ID, texto, { parse_mode: 'Markdown' });
});

// Panel admin - conductores
bot.onText(/\/conductores/, async (msg) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const conductores = await Conductor.find().sort({ fechaRegistro: -1 });
  if (conductores.length === 0) return bot.sendMessage(OWNER_CHAT_ID, '👥 No hay conductores registrados.');
  let texto = `👥 *CONDUCTORES REGISTRADOS (${conductores.length})*\n\n`;
  conductores.forEach((c, i) => {
    texto += `*${i+1}.* ${c.nombre} — ${c.activo ? '🟢 Activo' : '🔴 Inactivo'}\n`;
  });
  bot.sendMessage(OWNER_CHAT_ID, texto, { parse_mode: 'Markdown' });
});

// Panel admin - resumen del día
bot.onText(/\/resumen/, async (msg) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const manana = new Date(hoy);
  manana.setDate(manana.getDate() + 1);

  const pendientes = await Reserva.countDocuments({ estado: 'pendiente', fechaCreacion: { $gte: hoy, $lt: manana } });
  const asignadas = await Reserva.countDocuments({ estado: 'asignada', fechaCreacion: { $gte: hoy, $lt: manana } });
  const canceladas = await Reserva.countDocuments({ estado: 'cancelada', fechaCreacion: { $gte: hoy, $lt: manana } });
  const conductores = await Conductor.countDocuments({ activo: true });

  bot.sendMessage(OWNER_CHAT_ID,
    `📊 *RESUMEN DE HOY*\n\n` +
    `📋 Pendientes: ${pendientes}\n` +
    `✅ Asignadas: ${asignadas}\n` +
    `❌ Canceladas: ${canceladas}\n` +
    `👥 Conductores activos: ${conductores}`,
    { parse_mode: 'Markdown' }
  );
});

// =================== CALLBACKS ===================

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

      reserva.estado = 'asignada';
      reserva.conductorAsignado = chatId;
      await reserva.save();

      const conductor = await Conductor.findOne({ chatId });
      const nombreConductor = conductor ? conductor.nombre : 'Un conductor';

      bot.editMessageText(`✅ *Reserva aceptada*\n\nHas aceptado este servicio.`, {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown'
      });

      bot.sendMessage(chatId, `📋 *Detalles del servicio:*\n\n${formatearReserva(reserva.datos, false)}`, { parse_mode: 'Markdown' });

      bot.sendMessage(OWNER_CHAT_ID, `✅ *Reserva asignada*\n\nConductor: ${nombreConductor}\n\n${formatearReserva(reserva.datos, true)}`, { parse_mode: 'Markdown' });

      for (const msg of reserva.mensajesEnviados) {
        if (msg.chatId !== chatId) {
          try {
            bot.editMessageText(`⚠️ *Servicio ya asignado*\n\nEste servicio ya ha sido tomado por otro conductor.`, {
              chat_id: msg.chatId, message_id: msg.messageId, parse_mode: 'Markdown'
            });
          } catch (e) {}
        }
      }

      if (reserva.clienteChatId) {
        const d = reserva.datos;
        try {
          bot.sendMessage(reserva.clienteChatId,
            `✅ *¡Tu reserva ha sido aceptada!*\n\n` +
            `📅 *Fecha:* ${d.fecha} a las ${d.hora}\n` +
            `📍 *Origen:* ${d.origen}\n` +
            `🏁 *Destino:* ${d.destino}\n\n` +
            `🚖 Un conductor estará contigo a la hora indicada.\n\n` +
            `❌ Para cancelar tu reserva escribe /cancelar`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {}
      }

      bot.answerCallbackQuery(query.id, { text: '✅ ¡Reserva aceptada!' });

    } catch (err) {
      console.error(err);
      bot.answerCallbackQuery(query.id, { text: 'Error. Inténtalo de nuevo.' });
    }
  }

  if (data.startsWith('rechazar_')) {
    bot.answerCallbackQuery(query.id, { text: 'Has rechazado este servicio.' });
    bot.editMessageText(`❌ *Servicio rechazado*`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown'
    });
  }

  if (data.startsWith('confirmar_cancelar_')) {
    const reservaId = data.replace('confirmar_cancelar_', '');
    try {
      const reserva = await Reserva.findById(reservaId);
      if (!reserva || reserva.estado === 'cancelada') {
        bot.answerCallbackQuery(query.id, { text: 'Esta reserva ya fue cancelada.' });
        return;
      }

      reserva.estado = 'cancelada';
      await reserva.save();

      bot.editMessageText(`❌ *Reserva cancelada*\n\nTu reserva ha sido cancelada correctamente.`, {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown'
      });

      bot.sendMessage(OWNER_CHAT_ID, `❌ *Reserva cancelada por el cliente*\n\n${formatearReserva(reserva.datos, true)}`, { parse_mode: 'Markdown' });

      if (reserva.conductorAsignado) {
        try {
          bot.sendMessage(reserva.conductorAsignado, `❌ *Servicio cancelado*\n\nEl cliente ha cancelado la reserva:\n📅 ${reserva.datos.fecha} a las ${reserva.datos.hora}\n📍 ${reserva.datos.origen} → ${reserva.datos.destino}`, { parse_mode: 'Markdown' });
        } catch (e) {}
      }

      bot.answerCallbackQuery(query.id, { text: '❌ Reserva cancelada' });
    } catch (err) {
      console.error(err);
    }
  }

  if (data === 'no_cancelar') {
    bot.editMessageText(`✅ Tu reserva sigue activa.`, {
      chat_id: chatId, message_id: messageId
    });
    bot.answerCallbackQuery(query.id, { text: 'Cancelación abortada' });
  }
});

// Comando cancelar para clientes
bot.onText(/\/cancelar/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (chatId === OWNER_CHAT_ID) return;

  const reserva = await Reserva.findOne({
    clienteChatId: chatId,
    estado: { $in: ['pendiente', 'asignada'] }
  }).sort({ fechaCreacion: -1 });

  if (!reserva) {
    bot.sendMessage(chatId, '❌ No tienes ninguna reserva activa para cancelar.');
    return;
  }

  const d = reserva.datos;
  bot.sendMessage(chatId,
    `⚠️ *¿Seguro que quieres cancelar esta reserva?*\n\n` +
    `📅 ${d.fecha} a las ${d.hora}\n` +
    `📍 ${d.origen} → ${d.destino}\n\n` +
    `Esta acción no se puede deshacer.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '❌ Sí, cancelar', callback_data: `confirmar_cancelar_${reserva._id}` },
          { text: '✅ No, mantener', callback_data: 'no_cancelar' }
        ]]
      }
    }
  );
});

// =================== RECORDATORIOS ===================

function iniciarRecordatorios() {
  setInterval(async () => {
    try {
      const ahora = new Date();
      const en60min = new Date(ahora.getTime() + 60 * 60 * 1000);
      const en55min = new Date(ahora.getTime() + 55 * 60 * 1000);

      const reservas = await Reserva.find({
        estado: 'asignada',
        recordatorioEnviado: false,
        fechaServicio: { $gte: en55min, $lte: en60min }
      });

      for (const reserva of reservas) {
        const d = reserva.datos;

        try {
          bot.sendMessage(reserva.conductorAsignado,
            `⏰ *RECORDATORIO — Servicio en 1 hora*\n\n${formatearReserva(d, false)}`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {}

        bot.sendMessage(OWNER_CHAT_ID,
          `⏰ *Recordatorio enviado al conductor*\n\n${formatearReserva(d, true)}`,
          { parse_mode: 'Markdown' }
        );

        reserva.recordatorioEnviado = true;
        await reserva.save();
      }
    } catch (err) {
      console.error('Error recordatorios:', err);
    }
  }, 60 * 1000); // cada minuto
}

// =================== HELPERS ===================

function formatearReserva(data, paraAdmin = false) {
  let msg = `👤 *Nombre:* ${data.nombre}\n`;
  if (paraAdmin) {
    msg += `📧 *Correo:* ${data.correo}\n`;
    msg += `📞 *Teléfono:* ${data.telefono}\n`;
  }
  msg += `📅 *Fecha:* ${data.fecha} a las ${data.hora}\n`;
  msg += `📍 *Origen:* ${data.origen}\n`;
  msg += `🏁 *Destino:* ${data.destino}\n`;
  msg += `👥 *Pasajeros:* ${data.pasajeros}\n`;
  if (data.vuelo) msg += `✈️ *Vuelo:* ${data.vuelo}\n`;
  if (data.pasaporte) msg += `🛂 *Pasaporte:* ${data.pasaporte}\n`;
  if (data.observaciones) msg += `📝 *Observaciones:* ${data.observaciones}\n`;
  return msg;
}

// =================== RESERVAS ===================

app.post('/reserva', async (req, res) => {
  const { clienteChatId, ...data } = req.body;

  // Calcular fecha del servicio
  let fechaServicio = null;
  try {
    fechaServicio = new Date(`${data.fecha}T${data.hora}:00`);
  } catch (e) {}

  try {
    const conductores = await Conductor.find({ activo: true });

    if (conductores.length === 0) {
      await bot.sendMessage(OWNER_CHAT_ID, `🚖 *NUEVA RESERVA* (sin conductores)\n\n${formatearReserva(data, true)}`, { parse_mode: 'Markdown' });
      return res.json({ ok: true });
    }

    const reserva = await Reserva.create({ datos: data, clienteChatId: clienteChatId || null, fechaServicio });
    const mensajesEnviados = [];
    const texto = `🚖 *NUEVA RESERVA DISPONIBLE*\n\n${formatearReserva(data, false)}\n⏰ Responde rápido para aceptarla.`;

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

    reserva.mensajesEnviados = mensajesEnviados;
    await reserva.save();

    await bot.sendMessage(OWNER_CHAT_ID, `📨 *Nueva reserva enviada a ${conductores.length} conductor(es)*\n\n${formatearReserva(data, true)}`, { parse_mode: 'Markdown' });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
