const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const path = require('path');
const https = require('https');
const nodemailer = require('nodemailer');

const TOKEN = process.env.BOT_TOKEN || '8707482336:AAETg0jJ6F5VgLcHCDYqeEHxemnZeALcMPI';
const PORT = process.env.PORT || 3000;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || '898842399';
const MONGODB_URI = process.env.MONGODB_URI;
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY;
const COMISION_PORCENTAJE = 10;

// =================== EMAIL ===================

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.hostinger.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: true,
  auth: {
    user: process.env.SMTP_USER || 'reservas@taxilaspalmasdegrancanaria.com',
    pass: process.env.SMTP_PASS
  }
});

async function enviarEmailConfirmacion(datos) {
  if (!datos.correo) return;
  try {
    await mailer.sendMail({
      from: '"Reserva Taxi Las Palmas" <reservas@taxilaspalmasdegrancanaria.com>',
      to: datos.correo,
      subject: '✅ Tu reserva de taxi ha sido confirmada',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#f0f0f0;padding:24px;border-radius:12px;">
          <div style="text-align:center;border-bottom:2px solid #f5c400;padding-bottom:16px;margin-bottom:24px;">
            <h1 style="color:#f5c400;font-size:20px;margin:0;">🚖 RESERVA TAXI LAS PALMAS</h1>
            <p style="color:#aaa;margin:4px 0 0;">Gran Canaria</p>
          </div>
          <h2 style="color:#7dd87d;font-size:18px;">✅ ¡Tu reserva ha sido confirmada!</h2>
          <p style="color:#ccc;margin:12px 0;">Hola <strong>${datos.nombre}</strong>, un conductor ha aceptado tu servicio.</p>
          <div style="background:#1c1c1c;border-radius:10px;padding:16px;margin:20px 0;">
            <p style="margin:6px 0;">📅 <strong>Fecha:</strong> ${datos.fecha} a las ${datos.hora}</p>
            <p style="margin:6px 0;">📍 <strong>Origen:</strong> ${datos.origen}</p>
            <p style="margin:6px 0;">🏁 <strong>Destino:</strong> ${datos.destino}</p>
            <p style="margin:6px 0;">👥 <strong>Pasajeros:</strong> ${datos.pasajeros}</p>
            ${datos.precioEstimado ? `<p style="margin:6px 0;color:#f5c400;">💰 <strong>Precio estimado:</strong> ${datos.precioEstimado} €</p>` : ''}
          </div>
          <p style="color:#aaa;font-size:14px;">🚖 Un conductor estará en el punto de recogida a la hora indicada.</p>
          <p style="color:#aaa;font-size:14px;">Para cancelar o cualquier consulta:</p>
          <p style="color:#f5c400;font-size:14px;">📞 652 875 437 | ✉️ reservas@taxilaspalmasdegrancanaria.com</p>
          <div style="text-align:center;margin-top:24px;padding-top:16px;border-top:1px solid #333;">
            <p style="color:#555;font-size:12px;">Reserva Taxi Las Palmas de Gran Canaria</p>
          </div>
        </div>
      `
    });
    console.log('Email enviado a:', datos.correo);
  } catch (err) {
    console.error('Error email:', err.message);
  }
}

// =================== SCHEMAS ===================

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

const festivoSchema = new mongoose.Schema({
  fecha: { type: String, unique: true },
  descripcion: String,
  fechaCreacion: { type: Date, default: Date.now }
});

const comisionSchema = new mongoose.Schema({
  conductorChatId: String,
  conductorNombre: String,
  reservaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Reserva' },
  precioCarrera: Number,
  comision: Number,
  mes: String,
  pagada: { type: Boolean, default: false },
  fechaCreacion: { type: Date, default: Date.now }
});

const Conductor = mongoose.model('Conductor', conductorSchema);
const Reserva = mongoose.model('Reserva', reservaSchema);
const Festivo = mongoose.model('Festivo', festivoSchema);
const Comision = mongoose.model('Comision', comisionSchema);

mongoose.connect(MONGODB_URI).then(async () => {
  console.log('MongoDB conectado');
  await cargarFestivosIniciales();
  iniciarRecordatorios();
  iniciarResumenMensual();
}).catch(err => console.error('Error MongoDB:', err));

async function cargarFestivosIniciales() {
  const count = await Festivo.countDocuments();
  if (count === 0) {
    await Festivo.insertMany([
      { fecha: '2026-01-01', descripcion: 'Año Nuevo' },
      { fecha: '2026-01-06', descripcion: 'Reyes' },
      { fecha: '2026-02-19', descripcion: 'Carnaval jueves' },
      { fecha: '2026-02-20', descripcion: 'Carnaval viernes' },
      { fecha: '2026-04-02', descripcion: 'Jueves Santo' },
      { fecha: '2026-04-03', descripcion: 'Viernes Santo' },
      { fecha: '2026-05-01', descripcion: 'Día del Trabajo' },
      { fecha: '2026-05-30', descripcion: 'Día de Canarias' },
      { fecha: '2026-06-24', descripcion: 'San Juan' },
      { fecha: '2026-08-15', descripcion: 'Asunción' },
      { fecha: '2026-10-12', descripcion: 'Fiesta Nacional' },
      { fecha: '2026-11-01', descripcion: 'Todos los Santos' },
      { fecha: '2026-12-06', descripcion: 'Constitución' },
      { fecha: '2026-12-08', descripcion: 'Inmaculada' },
      { fecha: '2026-12-25', descripcion: 'Navidad' },
    ]);
    console.log('Festivos iniciales cargados');
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const bot = new TelegramBot(TOKEN, { polling: true });

// =================== TARIFAS ===================

async function determinarTarifa(fecha, hora) {
  const horaNum = parseInt(hora.replace(':', ''));
  const diaSemana = new Date(fecha + 'T12:00:00').getDay();
  const esDomingo = diaSemana === 0;
  const festivo = await Festivo.findOne({ fecha });
  if (esDomingo || festivo) return 'festiva';
  if (horaNum >= 600 && horaNum <= 2159) return 'diurna';
  return 'nocturna';
}

async function calcularDistanciaKm(origen, destino) {
  return new Promise((resolve, reject) => {
    const origenEnc = encodeURIComponent(origen + ', Las Palmas de Gran Canaria');
    const destinoEnc = encodeURIComponent(destino + ', Las Palmas de Gran Canaria');
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origenEnc}&destinations=${destinoEnc}&key=${GOOGLE_MAPS_KEY}&language=es`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const elemento = json.rows[0].elements[0];
          if (elemento.status === 'OK') {
            resolve(Math.round(elemento.distance.value / 100) / 10);
          } else {
            reject(new Error('Ruta no encontrada'));
          }
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function calcularPrecio(distanciaKm, tipo, esAeropuerto) {
  const precioBase = tipo === 'diurna' ? 3.85 : 4.25;
  const precioPorKm = tipo === 'diurna' ? 1.35 : 1.55;
  let precio = precioBase + (distanciaKm * precioPorKm);
  if (esAeropuerto) precio += 2.10;
  return Math.round(precio * 100) / 100;
}

app.post('/calcular-tarifa', async (req, res) => {
  const { origen, destino, fecha, hora } = req.body;
  try {
    const distanciaKm = await calcularDistanciaKm(origen, destino);
    const tipo = await determinarTarifa(fecha, hora);
    const esAeropuerto =
      origen.toLowerCase().includes('aeropuerto') || origen.toLowerCase().includes('lpa') || origen.toLowerCase().includes('gando') ||
      destino.toLowerCase().includes('aeropuerto') || destino.toLowerCase().includes('lpa') || destino.toLowerCase().includes('gando');
    const precio = calcularPrecio(distanciaKm, tipo, esAeropuerto);
    res.json({
      ok: true,
      precio: precio.toFixed(2),
      distanciaKm,
      tipo,
      precioBase: tipo === 'diurna' ? '3,85' : '4,25',
      km: tipo === 'diurna' ? '1,35' : '1,55',
      suplementoAeropuerto: esAeropuerto
    });
  } catch (err) {
    console.error('Error tarifa:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// =================== COMISIONES ===================

async function registrarComision(reserva, conductorChatId) {
  const precio = parseFloat(reserva.datos.precioEstimado);
  if (!precio || precio <= 0) return;
  const conductor = await Conductor.findOne({ chatId: conductorChatId });
  const comision = Math.round(precio * COMISION_PORCENTAJE) / 100;
  const ahora = new Date();
  const mes = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`;
  await Comision.create({
    conductorChatId,
    conductorNombre: conductor ? conductor.nombre : 'Desconocido',
    reservaId: reserva._id,
    precioCarrera: precio,
    comision,
    mes
  });
  return comision;
}

async function obtenerDeudaConductor(conductorChatId) {
  const comisiones = await Comision.find({ conductorChatId, pagada: false });
  const total = comisiones.reduce((sum, c) => sum + c.comision, 0);
  return { total: Math.round(total * 100) / 100, carreras: comisiones.length };
}

async function obtenerResumenMesConductor(conductorChatId, mes) {
  const comisiones = await Comision.find({ conductorChatId, mes });
  const totalCarreras = comisiones.reduce((sum, c) => sum + c.precioCarrera, 0);
  const totalComision = comisiones.reduce((sum, c) => sum + c.comision, 0);
  return {
    carreras: comisiones.length,
    totalCarreras: Math.round(totalCarreras * 100) / 100,
    totalComision: Math.round(totalComision * 100) / 100
  };
}

function iniciarResumenMensual() {
  setInterval(async () => {
    const ahora = new Date();
    if (ahora.getDate() === 1 && ahora.getHours() === 9 && ahora.getMinutes() < 5) {
      const mesAnterior = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1);
      const mes = `${mesAnterior.getFullYear()}-${String(mesAnterior.getMonth() + 1).padStart(2, '0')}`;
      const nombreMes = mesAnterior.toLocaleString('es-ES', { month: 'long', year: 'numeric' });
      const conductores = await Conductor.find({ activo: true });
      let resumenAdmin = `📊 *RESUMEN DE COMISIONES — ${nombreMes.toUpperCase()}*\n\n`;
      let totalGeneral = 0;
      for (const conductor of conductores) {
        const resumen = await obtenerResumenMesConductor(conductor.chatId, mes);
        if (resumen.carreras === 0) continue;
        totalGeneral += resumen.totalComision;
        resumenAdmin += `👤 *${conductor.nombre}*\n   Carreras: ${resumen.carreras} | Facturado: ${resumen.totalCarreras}€ | Comisión: ${resumen.totalComision}€\n\n`;
        try {
          await bot.sendMessage(conductor.chatId,
            `📊 *RESUMEN DE ${nombreMes.toUpperCase()}*\n\n` +
            `Has realizado *${resumen.carreras} carrera(s)* por un total de *${resumen.totalCarreras}€*.\n\n` +
            `💰 Tu comisión pendiente del mes: *${resumen.totalComision}€*\n\n` +
            `Por favor realiza el ingreso antes del día 7.\nIBAN: ES53 0049 0359 9924 1643 2863`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {}
      }
      resumenAdmin += `\n💰 *TOTAL A COBRAR: ${Math.round(totalGeneral * 100) / 100}€*`;
      bot.sendMessage(OWNER_CHAT_ID, resumenAdmin, { parse_mode: 'Markdown' });
    }
  }, 5 * 60 * 1000);
}

// =================== COMANDOS BOT ===================

bot.onText(/\/start/, async (msg) => {
  const chatId = String(msg.chat.id);
  const nombre = msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : '');
  if (chatId === OWNER_CHAT_ID) {
    bot.sendMessage(chatId,
      '🚖 *Panel de Administración*\n\n' +
      '📋 /pendientes\n✅ /asignadas\n❌ /canceladas\n👥 /conductores\n📊 /resumen\n\n' +
      '💰 *Comisiones:*\n/deudas\n/pagado NombreConductor\n\n' +
      '📅 *Festivos:*\n/festivos\n/addfestivo YYYY-MM-DD Descripción\n/delfestivo YYYY-MM-DD',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  try {
    const existente = await Conductor.findOne({ chatId });
    if (!existente) {
      await Conductor.create({ chatId, nombre });
      bot.sendMessage(chatId, `✅ *¡Registrado correctamente!*\n\nHola ${nombre}, ya recibirás las reservas disponibles.\n\n💡 Escribe /mideuda para ver tu comisión pendiente.`, { parse_mode: 'Markdown' });
      bot.sendMessage(OWNER_CHAT_ID, `🆕 Nuevo conductor: *${nombre}* (ID: ${chatId})`, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, `👋 Hola ${nombre}, ya estás registrado.\n\n💡 /mideuda para ver tu comisión.`);
    }
  } catch (err) { console.error(err); }
});

bot.onText(/\/mideuda/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (chatId === OWNER_CHAT_ID) return;
  const { total, carreras } = await obtenerDeudaConductor(chatId);
  const ahora = new Date();
  const mes = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`;
  const resumenMes = await obtenerResumenMesConductor(chatId, mes);
  bot.sendMessage(chatId,
    `💰 *TU COMISIÓN PENDIENTE*\n\nTotal sin pagar: *${total}€*\nCarreras pendientes: ${carreras}\n\n📅 *Este mes (${mes}):*\nCarreras: ${resumenMes.carreras} | Facturado: ${resumenMes.totalCarreras}€ | Comisión: ${resumenMes.totalComision}€\n\nIBAN: ES53 0049 0359 9924 1643 2863`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/deudas/, async (msg) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const conductores = await Conductor.find({ activo: true });
  if (!conductores.length) return bot.sendMessage(OWNER_CHAT_ID, '👥 No hay conductores.');
  let texto = `💰 *DEUDAS DE COMISIONES*\n\n`;
  let totalGeneral = 0;
  for (const conductor of conductores) {
    const { total, carreras } = await obtenerDeudaConductor(conductor.chatId);
    if (total > 0) { texto += `👤 *${conductor.nombre}*: ${total}€ (${carreras} carreras)\n`; totalGeneral += total; }
  }
  texto += `\n💰 *TOTAL: ${Math.round(totalGeneral * 100) / 100}€*`;
  bot.sendMessage(OWNER_CHAT_ID, texto, { parse_mode: 'Markdown' });
});

bot.onText(/\/pagado (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const nombre = match[1].trim();
  const conductor = await Conductor.findOne({ nombre: new RegExp(nombre, 'i') });
  if (!conductor) return bot.sendMessage(OWNER_CHAT_ID, `❌ No encontrado: "${nombre}"`);
  const result = await Comision.updateMany({ conductorChatId: conductor.chatId, pagada: false }, { pagada: true });
  bot.sendMessage(OWNER_CHAT_ID, `✅ ${result.modifiedCount} comisiones pagadas para *${conductor.nombre}*`, { parse_mode: 'Markdown' });
  try { bot.sendMessage(conductor.chatId, `✅ *Tu deuda ha sido liquidada.* Gracias por el pago. 🙏`, { parse_mode: 'Markdown' }); } catch (e) {}
});

bot.onText(/\/festivos/, async (msg) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const festivos = await Festivo.find().sort({ fecha: 1 });
  if (!festivos.length) return bot.sendMessage(OWNER_CHAT_ID, '📅 No hay festivos.');
  let texto = `📅 *FESTIVOS (${festivos.length})*\n\n`;
  festivos.forEach(f => { texto += `• ${f.fecha} — ${f.descripcion}\n`; });
  bot.sendMessage(OWNER_CHAT_ID, texto, { parse_mode: 'Markdown' });
});

bot.onText(/\/addfestivo (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const partes = match[1].trim().split(' ');
  const fecha = partes[0];
  const descripcion = partes.slice(1).join(' ') || 'Festivo';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return bot.sendMessage(OWNER_CHAT_ID, '❌ Formato: /addfestivo 2026-12-25 Navidad');
  try {
    await Festivo.create({ fecha, descripcion });
    bot.sendMessage(OWNER_CHAT_ID, `✅ Festivo añadido: *${fecha}* — ${descripcion}`, { parse_mode: 'Markdown' });
  } catch (e) { bot.sendMessage(OWNER_CHAT_ID, `⚠️ Esa fecha ya existe.`); }
});

bot.onText(/\/delfestivo (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const fecha = match[1].trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return bot.sendMessage(OWNER_CHAT_ID, '❌ Formato: /delfestivo 2026-12-25');
  const resultado = await Festivo.deleteOne({ fecha });
  if (resultado.deletedCount > 0) bot.sendMessage(OWNER_CHAT_ID, `✅ Festivo eliminado: *${fecha}*`, { parse_mode: 'Markdown' });
  else bot.sendMessage(OWNER_CHAT_ID, `❌ No encontrado: ${fecha}`);
});

bot.onText(/\/pendientes/, async (msg) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const reservas = await Reserva.find({ estado: 'pendiente' }).sort({ fechaCreacion: -1 }).limit(10);
  if (!reservas.length) return bot.sendMessage(OWNER_CHAT_ID, '📋 No hay reservas pendientes.');
  let texto = `📋 *PENDIENTES (${reservas.length})*\n\n`;
  reservas.forEach((r, i) => { texto += `*${i+1}.* ${r.datos.nombre} — ${r.datos.fecha} ${r.datos.hora}\n   📍 ${r.datos.origen} → ${r.datos.destino}\n\n`; });
  bot.sendMessage(OWNER_CHAT_ID, texto, { parse_mode: 'Markdown' });
});

bot.onText(/\/asignadas/, async (msg) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const reservas = await Reserva.find({ estado: 'asignada' }).sort({ fechaCreacion: -1 }).limit(10);
  if (!reservas.length) return bot.sendMessage(OWNER_CHAT_ID, '✅ No hay asignadas.');
  let texto = `✅ *ASIGNADAS (${reservas.length})*\n\n`;
  reservas.forEach((r, i) => { texto += `*${i+1}.* ${r.datos.nombre} — ${r.datos.fecha} ${r.datos.hora}\n   📍 ${r.datos.origen} → ${r.datos.destino}\n\n`; });
  bot.sendMessage(OWNER_CHAT_ID, texto, { parse_mode: 'Markdown' });
});

bot.onText(/\/canceladas/, async (msg) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const reservas = await Reserva.find({ estado: 'cancelada' }).sort({ fechaCreacion: -1 }).limit(10);
  if (!reservas.length) return bot.sendMessage(OWNER_CHAT_ID, '❌ No hay canceladas.');
  let texto = `❌ *CANCELADAS (${reservas.length})*\n\n`;
  reservas.forEach((r, i) => { texto += `*${i+1}.* ${r.datos.nombre} — ${r.datos.fecha} ${r.datos.hora}\n   📍 ${r.datos.origen} → ${r.datos.destino}\n\n`; });
  bot.sendMessage(OWNER_CHAT_ID, texto, { parse_mode: 'Markdown' });
});

bot.onText(/\/conductores/, async (msg) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const conductores = await Conductor.find().sort({ fechaRegistro: -1 });
  if (!conductores.length) return bot.sendMessage(OWNER_CHAT_ID, '👥 No hay conductores.');
  let texto = `👥 *CONDUCTORES (${conductores.length})*\n\n`;
  conductores.forEach((c, i) => { texto += `*${i+1}.* ${c.nombre} — ${c.activo ? '🟢 Activo' : '🔴 Inactivo'}\n`; });
  bot.sendMessage(OWNER_CHAT_ID, texto, { parse_mode: 'Markdown' });
});

bot.onText(/\/resumen/, async (msg) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const manana = new Date(hoy); manana.setDate(manana.getDate()+1);
  const [pendientes, asignadas, canceladas, conductores] = await Promise.all([
    Reserva.countDocuments({ estado: 'pendiente', fechaCreacion: { $gte: hoy, $lt: manana } }),
    Reserva.countDocuments({ estado: 'asignada', fechaCreacion: { $gte: hoy, $lt: manana } }),
    Reserva.countDocuments({ estado: 'cancelada', fechaCreacion: { $gte: hoy, $lt: manana } }),
    Conductor.countDocuments({ activo: true })
  ]);
  bot.sendMessage(OWNER_CHAT_ID, `📊 *RESUMEN HOY*\n\n📋 Pendientes: ${pendientes}\n✅ Asignadas: ${asignadas}\n❌ Canceladas: ${canceladas}\n👥 Conductores: ${conductores}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/cancelar/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (chatId === OWNER_CHAT_ID) return;
  const reserva = await Reserva.findOne({ clienteChatId: chatId, estado: { $in: ['pendiente', 'asignada'] } }).sort({ fechaCreacion: -1 });
  if (!reserva) return bot.sendMessage(chatId, '❌ No tienes ninguna reserva activa.');
  const d = reserva.datos;
  bot.sendMessage(chatId, `⚠️ *¿Cancelar esta reserva?*\n\n📅 ${d.fecha} a las ${d.hora}\n📍 ${d.origen} → ${d.destino}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '❌ Sí, cancelar', callback_data: `confirmar_cancelar_${reserva._id}` },
      { text: '✅ No, mantener', callback_data: 'no_cancelar' }
    ]]}
  });
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
      const comision = await registrarComision(reserva, chatId);
      const comisionTxt = comision ? `\n💰 Comisión registrada: ${comision}€` : '';

      bot.editMessageText(`✅ *Reserva aceptada*\n\nHas aceptado este servicio.${comisionTxt}`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
      bot.sendMessage(chatId, `📋 *Detalles del servicio:*\n\n${formatearReserva(reserva.datos, false)}`, { parse_mode: 'Markdown' });
      bot.sendMessage(OWNER_CHAT_ID, `✅ *Reserva asignada*\n\nConductor: ${nombreConductor}\n\n${formatearReserva(reserva.datos, true)}`, { parse_mode: 'Markdown' });

      for (const msg of reserva.mensajesEnviados) {
        if (msg.chatId !== chatId) {
          try { bot.editMessageText(`⚠️ *Servicio ya asignado*`, { chat_id: msg.chatId, message_id: msg.messageId, parse_mode: 'Markdown' }); } catch (e) {}
        }
      }

      // Notificar al cliente por Telegram si tiene cuenta
      if (reserva.clienteChatId) {
        const d = reserva.datos;
        const precioTxt = d.precioEstimado ? `\n💰 *Precio estimado:* ${d.precioEstimado} €` : '';
        try {
          bot.sendMessage(reserva.clienteChatId,
            `✅ *¡Tu reserva ha sido aceptada!*\n\n📅 *Fecha:* ${d.fecha} a las ${d.hora}\n📍 *Origen:* ${d.origen}\n🏁 *Destino:* ${d.destino}${precioTxt}\n\n🚖 Un conductor estará contigo a la hora indicada.\n\n❌ Para cancelar escribe /cancelar`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {}
      }

      // Enviar email si la reserva viene de la web o no tiene Telegram
      if (!reserva.clienteChatId || reserva.datos.fuente === 'web') {
        await enviarEmailConfirmacion(reserva.datos);
      }

      bot.answerCallbackQuery(query.id, { text: '✅ ¡Reserva aceptada!' });
    } catch (err) {
      console.error(err);
      bot.answerCallbackQuery(query.id, { text: 'Error. Inténtalo de nuevo.' });
    }
  }

  if (data.startsWith('rechazar_')) {
    bot.answerCallbackQuery(query.id, { text: 'Has rechazado este servicio.' });
    bot.editMessageText(`❌ *Servicio rechazado*`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
  }

  if (data.startsWith('confirmar_cancelar_')) {
    const reservaId = data.replace('confirmar_cancelar_', '');
    try {
      const reserva = await Reserva.findById(reservaId);
      if (!reserva || reserva.estado === 'cancelada') { bot.answerCallbackQuery(query.id, { text: 'Ya cancelada.' }); return; }
      reserva.estado = 'cancelada';
      await reserva.save();
      bot.editMessageText(`❌ *Reserva cancelada correctamente.*`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
      bot.sendMessage(OWNER_CHAT_ID, `❌ *Cancelada por cliente*\n\n${formatearReserva(reserva.datos, true)}`, { parse_mode: 'Markdown' });
      if (reserva.conductorAsignado) {
        try { bot.sendMessage(reserva.conductorAsignado, `❌ *Servicio cancelado*\n\n📅 ${reserva.datos.fecha} a las ${reserva.datos.hora}\n📍 ${reserva.datos.origen} → ${reserva.datos.destino}`, { parse_mode: 'Markdown' }); } catch (e) {}
      }
      bot.answerCallbackQuery(query.id, { text: '❌ Reserva cancelada' });
    } catch (err) { console.error(err); }
  }

  if (data === 'no_cancelar') {
    bot.editMessageText(`✅ Tu reserva sigue activa.`, { chat_id: chatId, message_id: messageId });
    bot.answerCallbackQuery(query.id, { text: 'Cancelación abortada' });
  }
});

// =================== RECORDATORIOS ===================

function iniciarRecordatorios() {
  setInterval(async () => {
    try {
      const ahora = new Date();
      const en60min = new Date(ahora.getTime() + 60 * 60 * 1000);
      const en55min = new Date(ahora.getTime() + 55 * 60 * 1000);
      const reservas = await Reserva.find({ estado: 'asignada', recordatorioEnviado: false, fechaServicio: { $gte: en55min, $lte: en60min } });
      for (const reserva of reservas) {
        try { bot.sendMessage(reserva.conductorAsignado, `⏰ *RECORDATORIO — Servicio en 1 hora*\n\n${formatearReserva(reserva.datos, false)}`, { parse_mode: 'Markdown' }); } catch (e) {}
        bot.sendMessage(OWNER_CHAT_ID, `⏰ *Recordatorio enviado*\n\n${formatearReserva(reserva.datos, true)}`, { parse_mode: 'Markdown' });
        reserva.recordatorioEnviado = true;
        await reserva.save();
      }
    } catch (err) { console.error('Error recordatorios:', err); }
  }, 60 * 1000);
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
  if (data.precioEstimado) msg += `💰 *Precio estimado:* ${data.precioEstimado} €\n`;
  if (data.vuelo) msg += `✈️ *Vuelo:* ${data.vuelo}\n`;
  if (data.pasaporte) msg += `🛂 *Pasaporte:* ${data.pasaporte}\n`;
  if (data.observaciones) msg += `📝 *Observaciones:* ${data.observaciones}\n`;
  return msg;
}

// =================== RESERVAS ===================

app.post('/reserva', async (req, res) => {
  const { clienteChatId, ...data } = req.body;
  let fechaServicio = null;
  try { fechaServicio = new Date(`${data.fecha}T${data.hora}:00`); } catch (e) {}

  try {
    const conductores = await Conductor.find({ activo: true });
    if (!conductores.length) {
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
          reply_markup: { inline_keyboard: [[
            { text: '✅ Aceptar', callback_data: `aceptar_${reserva._id}` },
            { text: '❌ Rechazar', callback_data: `rechazar_${reserva._id}` }
          ]]}
        });
        mensajesEnviados.push({ chatId: conductor.chatId, messageId: msg.message_id });
      } catch (e) { console.error(`Error enviando a conductor:`, e.message); }
    }

    reserva.mensajesEnviados = mensajesEnviados;
    await reserva.save();
    await bot.sendMessage(OWNER_CHAT_ID, `📨 *Nueva reserva de ${conductores.length} conductor(es)*\n\n${formatearReserva(data, true)}`, { parse_mode: 'Markdown' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
