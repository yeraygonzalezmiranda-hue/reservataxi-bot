const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { google } = require('googleapis');

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || '898842399';
const MONGODB_URI = process.env.MONGODB_URI;
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY;
const GOOGLE_CALENDAR_CREDENTIALS = process.env.GOOGLE_CALENDAR_CREDENTIALS; // JSON de la cuenta de servicio
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID; // p. ej. yeraygonzalezmiranda@gmail.com
const COMISION_PORCENTAJE = 10;
const MINIMO_HORAS_ANTELACION = 2; // valor inicial; el real se gestiona en cacheConfig.antelacion
const LICENCIA_PRIORITARIA = '1374'; // Conductor con prioridad: recibe la reserva primero, sin comisión
const MINUTOS_PRIORIDAD = 2; // Minutos que tiene el conductor prioritario antes de repartir al resto


// Configuración ajustable en memoria (se rellena desde la BD al arrancar)
let cacheConfig = { antelacion: 2, cancelacion: 0.5 };

if (!TOKEN) {
  console.error('ERROR: Falta la variable BOT_TOKEN en Railway.');
  process.exit(1);
}

// =================== ANTELACIÓN MÍNIMA ===================

// Hora actual en Canarias (el servidor de Railway funciona en UTC)
function ahoraCanarias() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Atlantic/Canary' }));
}

// =================== GOOGLE CALENDAR ===================
// Crea el cliente de Calendar a partir de las credenciales de la cuenta de servicio.
let calendarClient = null;
function getCalendarClient() {
  if (calendarClient) return calendarClient;
  if (!GOOGLE_CALENDAR_CREDENTIALS || !GOOGLE_CALENDAR_ID) return null;
  try {
    let raw = GOOGLE_CALENDAR_CREDENTIALS.trim();
    // Si las credenciales vienen en Base64 (recomendado, no se rompe al pegar en Railway),
    // las descodificamos. Detectamos Base64 porque no empieza por "{".
    if (!raw.startsWith('{')) {
      try { raw = Buffer.from(raw, 'base64').toString('utf-8'); } catch (e) {}
    }
    const credentials = JSON.parse(raw);
    // Arreglar la clave privada por si los saltos de línea quedaron como texto "\n".
    if (credentials.private_key && credentials.private_key.includes('\\n')) {
      credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    }
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar']
    });
    calendarClient = google.calendar({ version: 'v3', auth });
    return calendarClient;
  } catch (e) {
    console.error('Error al crear cliente de Calendar:', e.message);
    return null;
  }
}

// Crea un evento en el calendario para una reserva aceptada.
// Devuelve el ID del evento creado, o null si no se pudo.
async function crearEventoCalendario(reserva, nombreConductor) {
  const calendar = getCalendarClient();
  if (!calendar) {
    console.log('Google Calendar no configurado (faltan credenciales o ID). Se omite.');
    return null;
  }
  try {
    const d = reserva.datos;
    // Construir inicio y fin en horario de Canarias (Atlantic/Canary)
    const inicio = new Date(`${d.fecha}T${d.hora}:00`);
    if (isNaN(inicio)) { console.error('Fecha de reserva inválida para el calendario'); return null; }
    const fin = new Date(inicio.getTime() + 60 * 60 * 1000); // duración 1 hora
    const toISO = (fecha) => {
      // Formato YYYY-MM-DDTHH:MM:SS (sin Z), con timeZone aparte
      const p = (n) => String(n).padStart(2, '0');
      return `${fecha.getFullYear()}-${p(fecha.getMonth()+1)}-${p(fecha.getDate())}T${p(fecha.getHours())}:${p(fecha.getMinutes())}:00`;
    };

    // Color: naranja (6) si va HACIA el aeropuerto, azul (7) si viene DESDE el aeropuerto
    const destinoEsAeropuerto = /aeropuerto|airport|lpa/i.test(d.destino || '');
    const origenEsAeropuerto = /aeropuerto|airport|lpa/i.test(d.origen || '');
    let colorId = '8'; // gris por defecto
    if (destinoEsAeropuerto) colorId = '6';      // ciudad → aeropuerto = naranja
    else if (origenEsAeropuerto) colorId = '7';  // aeropuerto → ciudad = azul

    const precio = d.precioEstimado ? `\nPrecio estimado: ${d.precioEstimado} €` : '';
    const vuelo = d.vuelo ? `\nVuelo: ${d.vuelo}` : '';
    const pax = d.pasajeros ? `\nPasajeros: ${d.pasajeros}` : '';
    const obs = d.observaciones ? `\nObservaciones: ${d.observaciones}` : '';
    const tel = d.telefono ? `\nTeléfono cliente: ${d.telefono}` : '';

    const evento = {
      summary: `🚖 ${numReserva(reserva.numero)} — ${d.origen} → ${d.destino}`,
      description: `Cliente: ${d.nombre || '-'}${tel}\nConductor: ${nombreConductor || '-'}${precio}${vuelo}${pax}${obs}`,
      start: { dateTime: toISO(inicio), timeZone: 'Atlantic/Canary' },
      end: { dateTime: toISO(fin), timeZone: 'Atlantic/Canary' },
      colorId,
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
          { method: 'popup', minutes: 15 }
        ]
      }
    };

    const res = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: evento
    });
    console.log('Evento de calendario creado:', res.data.id);
    return res.data.id;
  } catch (e) {
    console.error('Error creando evento en Calendar:', e.message);
    try { bot.sendMessage(OWNER_CHAT_ID, `⚠️ No se pudo crear el evento en Google Calendar: ${e.message}`); } catch (err) {}
    return null;
  }
}

// Borra un evento del calendario (al cancelar una reserva).
async function borrarEventoCalendario(eventoId) {
  if (!eventoId) return;
  const calendar = getCalendarClient();
  if (!calendar) return;
  try {
    await calendar.events.delete({ calendarId: GOOGLE_CALENDAR_ID, eventId: eventoId });
    console.log('Evento de calendario borrado:', eventoId);
  } catch (e) {
    console.error('Error borrando evento de Calendar:', e.message);
  }
}

function cumpleAntelacion(fecha, hora) {
  try {
    const fechaReserva = new Date(`${fecha}T${hora}:00`);
    if (isNaN(fechaReserva)) return false;
    const minutos = (fechaReserva - ahoraCanarias()) / 60000;
    return minutos >= cacheConfig.antelacion * 60;
  } catch (e) {
    return false;
  }
}

// =================== EMAIL (API de Brevo — Railway bloquea SMTP) ===================

const BREVO_API_KEY = process.env.BREVO_API_KEY;

function enviarEmailBrevo(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`Brevo ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function enviarEmailConfirmacion(datos, reservaId, nombreConductor, numero) {
  if (!datos.correo) {
    console.log('Reserva sin correo, no se envía email:', datos.nombre);
    try { bot.sendMessage(OWNER_CHAT_ID, `⚠️ La reserva de *${datos.nombre}* no tiene correo, no se envió email de confirmación.`, { parse_mode: 'Markdown' }); } catch (e) {}
    return;
  }
  if (!BREVO_API_KEY) {
    console.error('Falta la variable BREVO_API_KEY');
    try { bot.sendMessage(OWNER_CHAT_ID, `❌ No se pudo enviar el email: falta la variable BREVO_API_KEY en Railway.`); } catch (e) {}
    return;
  }
  try {
    // Idioma del cliente (es / en / de). Por defecto español.
    const idioma = ['es', 'en', 'de'].includes(datos.idioma) ? datos.idioma : 'es';
    const T = {
      es: {
        subject: 'Tu reserva de taxi ha sido confirmada',
        confirmada: '✅ Tu reserva ha sido confirmada',
        hola: (n) => `Hola <strong>${n}</strong>, un conductor ha aceptado tu servicio.`,
        nReserva: 'Nº de reserva:', conductor: 'Tu conductor:',
        fecha: 'Fecha:', alas: 'a las', origen: 'Origen:', destino: 'Destino:',
        pasajeros: 'Pasajeros:', precio: 'Precio estimado:',
        necesitasCancelar: '¿Necesitas cancelar tu reserva?', cancelarBtn: 'Cancelar mi reserva',
        cancelarNota: 'Solo se puede cancelar online hasta 2 horas antes del servicio.',
        conductorPunto: '🚖 Un conductor estará en el punto de recogida a la hora indicada.',
        cancelarConsultas: '📞 Para cancelar o consultas:'
      },
      en: {
        subject: 'Your taxi booking has been confirmed',
        confirmada: '✅ Your booking has been confirmed',
        hola: (n) => `Hello <strong>${n}</strong>, a driver has accepted your service.`,
        nReserva: 'Booking no.:', conductor: 'Your driver:',
        fecha: 'Date:', alas: 'at', origen: 'Pickup:', destino: 'Destination:',
        pasajeros: 'Passengers:', precio: 'Estimated price:',
        necesitasCancelar: 'Need to cancel your booking?', cancelarBtn: 'Cancel my booking',
        cancelarNota: 'Online cancellation is only possible up to 2 hours before the service.',
        conductorPunto: '🚖 A driver will be at the pickup point at the scheduled time.',
        cancelarConsultas: '📞 To cancel or for any questions:'
      },
      de: {
        subject: 'Ihre Taxibuchung wurde bestätigt',
        confirmada: '✅ Ihre Buchung wurde bestätigt',
        hola: (n) => `Hallo <strong>${n}</strong>, ein Fahrer hat Ihren Service angenommen.`,
        nReserva: 'Buchungsnr.:', conductor: 'Ihr Fahrer:',
        fecha: 'Datum:', alas: 'um', origen: 'Abholort:', destino: 'Zielort:',
        pasajeros: 'Passagiere:', precio: 'Geschätzter Preis:',
        necesitasCancelar: 'Müssen Sie Ihre Buchung stornieren?', cancelarBtn: 'Meine Buchung stornieren',
        cancelarNota: 'Eine Online-Stornierung ist nur bis 2 Stunden vor dem Service möglich.',
        conductorPunto: '🚖 Ein Fahrer wird zur angegebenen Zeit am Abholort sein.',
        cancelarConsultas: '📞 Zum Stornieren oder bei Fragen:'
      }
    }[idioma];

    const precioHtml = datos.precioEstimado ? `<p><strong>${T.precio}</strong> ${datos.precioEstimado} €</p>` : '';
    const numeroHtml = numero ? `<p>🎫 <strong>${T.nReserva}</strong> RT-${String(numero).padStart(4, '0')}</p>` : '';
    // Solo el NOMBRE del conductor, nunca su teléfono.
    const conductorHtml = nombreConductor ? `<p>🚖 <strong>${T.conductor}</strong> ${nombreConductor}</p>` : '';
    const base = process.env.BASE_URL || '';
    const cancelarHtml = (reservaId && base) ? `
        <div style="background:#fff;border:1px solid #f0d0d0;border-radius:8px;padding:16px;margin:16px 0;text-align:center;">
          <p style="margin:0 0 12px;color:#666;font-size:14px;">${T.necesitasCancelar}</p>
          <a href="${base}/cancelar?id=${reservaId}" style="display:inline-block;padding:12px 24px;background:#e05050;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;">${T.cancelarBtn}</a>
          <p style="margin:12px 0 0;color:#999;font-size:12px;">${T.cancelarNota}</p>
        </div>` : '';
    await enviarEmailBrevo({
      sender: { name: 'Reserva Taxi Las Palmas', email: 'reservadetaxilp@gmail.com' },
      to: [{ email: datos.correo, name: datos.nombre }],
      subject: T.subject,
      htmlContent: `<div style="font-family:Arial,sans-serif;padding:24px;background:#f9f9f9;max-width:600px;margin:0 auto;">
        <h2 style="color:#f5c400;background:#1a1a1a;padding:16px;border-radius:8px;">🚖 Reserva Taxi Las Palmas</h2>
        <h3 style="color:#2d8a2d;">${T.confirmada}</h3>
        <p>${T.hola(datos.nombre)}</p>
        <div style="background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;margin:16px 0;">
          ${numeroHtml}
          ${conductorHtml}
          <p>📅 <strong>${T.fecha}</strong> ${datos.fecha} ${T.alas} ${datos.hora}</p>
          <p>📍 <strong>${T.origen}</strong> ${datos.origen}</p>
          <p>🏁 <strong>${T.destino}</strong> ${datos.destino}</p>
          <p>👥 <strong>${T.pasajeros}</strong> ${datos.pasajeros}</p>
          ${precioHtml}
        </div>
        ${cancelarHtml}
        <p>${T.conductorPunto}</p>
        <p>${T.cancelarConsultas} <strong>828 810 938</strong></p>
        <p>✉️ reservas@taxilaspalmasdegrancanaria.com</p>
      </div>`
    });
    console.log('Email Brevo enviado a:', datos.correo);
    try { bot.sendMessage(OWNER_CHAT_ID, `📧 Email de confirmación enviado a ${datos.correo}`); } catch (e) {}
  } catch (err) {
    console.error('Error email Brevo:', err.message);
    try { bot.sendMessage(OWNER_CHAT_ID, `❌ Error al enviar email a ${datos.correo}: ${err.message}`); } catch (e) {}
  }
}

// =================== SCHEMAS ===================

const conductorSchema = new mongoose.Schema({
  chatId: { type: String, unique: true },
  nombre: String,
  licencia: String,
  aprobado: { type: Boolean, default: false },
  activo: { type: Boolean, default: true },
  fechaRegistro: { type: Date, default: Date.now }
});

const reservaSchema = new mongoose.Schema({
  numero: Number,                                          // Número corto legible (RT-0042)
  datos: Object,
  clienteChatId: String,
  estado: { type: String, default: 'pendiente' },          // pendiente / asignada / completada / cancelada
  conductorAsignado: String,
  conductorNombre: String,                                 // Nombre del taxista asignado
  mensajesEnviados: [{ chatId: String, messageId: Number }],
  recordatorioEnviado: { type: Boolean, default: false },  // Recordatorio al taxista (1h antes)
  recordatorioClienteEnviado: { type: Boolean, default: false }, // Recordatorio al cliente (1h antes)
  avisoSinAceptarEnviado: { type: Boolean, default: false },      // Aviso al admin si nadie acepta en 10 min
  eventoCalendarioId: String,                              // ID del evento en Google Calendar (para poder borrarlo si se cancela)
  fechaServicio: Date,
  fechaCreacion: { type: Date, default: Date.now }
});

// Contador para los números de reserva cortos
const contadorSchema = new mongoose.Schema({
  nombre: { type: String, unique: true },
  valor: { type: Number, default: 0 }
});
const Contador = mongoose.model('Contador', contadorSchema);

async function siguienteNumeroReserva() {
  const c = await Contador.findOneAndUpdate(
    { nombre: 'reserva' },
    { $inc: { valor: 1 } },
    { new: true, upsert: true }
  );
  return c.valor;
}

// =================== CONFIGURACIÓN AJUSTABLE ===================
// Guarda valores que el admin puede cambiar desde el bot (se mantienen tras reinicios).
const configSchema = new mongoose.Schema({
  nombre: { type: String, unique: true },
  valor: Number
});
const Config = mongoose.model('Config', configSchema);

// Valores por defecto (en horas)
const ANTELACION_DEFECTO = 2;        // antelación mínima para reservar
const CANCELACION_DEFECTO = 0.5;     // margen para cancelar online (0.5 h = 30 min)

async function cargarConfig() {
  try {
    const ant = await Config.findOne({ nombre: 'antelacion' });
    const can = await Config.findOne({ nombre: 'cancelacion' });
    cacheConfig.antelacion = ant ? ant.valor : ANTELACION_DEFECTO;
    cacheConfig.cancelacion = can ? can.valor : CANCELACION_DEFECTO;
  } catch (e) { console.error('Error cargando config:', e.message); }
}

async function guardarConfig(nombre, valor) {
  await Config.findOneAndUpdate({ nombre }, { valor }, { upsert: true });
  cacheConfig[nombre] = valor;
}

// Convierte horas a texto legible: 2 -> "2 horas", 0.5 -> "30 minutos", 1 -> "1 hora"
function horasATexto(horas) {
  if (horas < 1) return `${Math.round(horas * 60)} minutos`;
  if (horas === 1) return `1 hora`;
  return `${horas} horas`;
}


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
  await cargarConfig();
  await cargarFestivosIniciales();
  // Migración: los conductores que ya existían antes de añadir el sistema de aprobación
  // (campo 'aprobado' sin definir) se marcan como aprobados para que sigan recibiendo reservas.
  try {
    const res = await Conductor.updateMany(
      { aprobado: { $exists: false } },
      { $set: { aprobado: true } }
    );
    if (res.modifiedCount) console.log(`Conductores existentes aprobados automáticamente: ${res.modifiedCount}`);
  } catch (e) { console.error('Error migrando conductores:', e.message); }
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

// --- SEO: servir la home y reservar.html con el canonical/og del dominio real ---
// Cada dominio (reservataxilaspalmas.com y radiotaxigrancanaria.es) se presenta a
// Google como él mismo, para que ambos posicionen por separado sin contenido duplicado.
function servirConCanonical(nombreArchivo) {
  return (req, res, next) => {
    try {
      const ruta = path.join(__dirname, 'public', nombreArchivo);
      if (!fs.existsSync(ruta)) return next();
      let html = fs.readFileSync(ruta, 'utf8');
      const host = req.headers.host || 'reservataxilaspalmas.com';
      const base = 'https://' + host + '/';
      // Sustituir el canonical y og:url fijos por el dominio real de la petición
      html = html.replace(/https:\/\/reservataxilaspalmas\.com\//g, base);
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    } catch (e) { return next(); }
  };
}
app.get('/', servirConCanonical('index.html'));
app.get('/index.html', servirConCanonical('index.html'));
app.get('/reservar.html', servirConCanonical('reservar.html'));

app.use(express.static(path.join(__dirname, 'public')));

// Página para comprobar qué versión está desplegada
app.get('/version', (req, res) => {
  res.send(`VERSION 2 — Bloqueo de ${MINIMO_HORAS_ANTELACION}h ACTIVO ✅ | Hora Canarias: ${ahoraCanarias().toLocaleString('es-ES')}`);
});

// Configuración pública para el formulario web: le dice la antelación mínima actual
// (en horas) para que el texto y la validación coincidan con lo que tienes en el bot.
app.get('/config-publica', (req, res) => {
  res.json({
    antelacionHoras: cacheConfig.antelacion,
    antelacionTexto: horasATexto(cacheConfig.antelacion),
    telefono: '828 810 938'
  });
});

// Polling con reintentos automáticos: si Telegram o la red fallan, no se rinde.
const bot = new TelegramBot(TOKEN, {
  polling: {
    interval: 300,           // cada cuánto pregunta a Telegram (ms)
    autoStart: true,
    params: { timeout: 10 }, // espera de cada consulta (segundos)
  }
});

// Gestión de errores de polling: el bot se recupera solo en vez de quedarse colgado.
let avisoCaidaEnviado = false;
bot.on('polling_error', (error) => {
  const codigo = error && error.code ? error.code : 'desconocido';
  console.error(`⚠️ polling_error [${codigo}]:`, error && error.message ? error.message : error);

  // Error 409 = hay DOS instancias del bot a la vez (dos despliegues). Avisar y reintentar.
  if (codigo === 'ETELEGRAM' && String(error.message).includes('409')) {
    console.error('Conflicto 409: parece que hay dos instancias del bot ejecutándose.');
  }

  // Si es un fallo de red/conexión, reintentar el polling tras unos segundos.
  if (codigo === 'EFATAL' || codigo === 'ETIMEDOUT' || codigo === 'ECONNRESET') {
    setTimeout(() => {
      bot.stopPolling().then(() => bot.startPolling()).catch(() => {});
    }, 5000);
  }
});

// Error general del bot (no detiene el proceso, solo lo registra).
bot.on('error', (error) => {
  console.error('⚠️ Error general del bot:', error && error.message ? error.message : error);
});

// Latido de salud: cada 5 minutos comprueba que el bot sigue conectado a Telegram.
// Si se cae la conexión, avisa al admin una sola vez y trata de reconectar.
setInterval(async () => {
  try {
    await bot.getMe();
    if (avisoCaidaEnviado) {
      avisoCaidaEnviado = false;
      try { await bot.sendMessage(OWNER_CHAT_ID, '✅ El bot ha recuperado la conexión y funciona con normalidad.'); } catch (e) {}
    }
  } catch (e) {
    console.error('⚠️ El bot no responde a getMe():', e.message);
    if (!avisoCaidaEnviado) {
      avisoCaidaEnviado = true;
      try { await bot.sendMessage(OWNER_CHAT_ID, '⚠️ Aviso: el bot está teniendo problemas de conexión con Telegram. Intentando reconectar automáticamente.'); } catch (e2) {}
    }
    try { await bot.stopPolling(); await bot.startPolling(); } catch (e3) {}
  }
}, 5 * 60 * 1000);

// Si ocurre un error no capturado en cualquier parte, lo registramos para que el
// proceso NO se cierre de golpe (Railway lo reiniciaría, pero así evitamos caídas tontas).
process.on('unhandledRejection', (motivo) => {
  console.error('⚠️ Promesa rechazada sin gestionar:', motivo);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Excepción no capturada:', err && err.message ? err.message : err);
});

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

// Los 21 municipios de Gran Canaria (para detección por texto)
const MUNICIPIOS_GC = [
  'Agaete', 'Agüimes', 'Artenara', 'Arucas', 'Firgas', 'Gáldar',
  'Ingenio', 'Mogán', 'Moya', 'Las Palmas de Gran Canaria', 'San Bartolomé de Tirajana',
  'La Aldea de San Nicolás', 'Santa Brígida', 'Santa Lucía de Tirajana', 'Santa María de Guía',
  'Tejeda', 'Telde', 'Teror', 'Valleseco', 'Valsequillo', 'Vega de San Mateo'
];

// Zonas turísticas conocidas y su municipio real
const ZONAS_MUNICIPIO = {
  'maspalomas': 'San Bartolomé de Tirajana',
  'playa del ingles': 'San Bartolomé de Tirajana',
  'playa del inglés': 'San Bartolomé de Tirajana',
  'san agustin': 'San Bartolomé de Tirajana',
  'meloneras': 'San Bartolomé de Tirajana',
  'puerto rico': 'Mogán',
  'puerto de mogan': 'Mogán',
  'arguineguin': 'Mogán',
  'vecindario': 'Santa Lucía de Tirajana',
  'el doctoral': 'Santa Lucía de Tirajana',
  'jinamar': 'Telde',
  'jinámar': 'Telde'
};

// Detecta el municipio de recogida. Usa Google si hay coordenadas; si no, el texto.
async function detectarMunicipio(origenTexto, origenCoords) {
  // Aeropuerto: caso especial, se trata aparte
  const t = (origenTexto || '').toLowerCase();
  if (t.includes('aeropuerto') || t.includes('airport') || t.includes('lpa') || t.includes('gando')) {
    return 'AEROPUERTO';
  }
  // 1) Con coordenadas exactas: preguntar a Google (geocodificación inversa)
  if (origenCoords && GOOGLE_MAPS_KEY) {
    try {
      const municipio = await municipioDesdeCoords(origenCoords);
      if (municipio) return municipio;
    } catch (e) { console.error('Error municipio coords:', e.message); }
  }
  // 2) Sin coordenadas: buscar por texto (zonas turísticas primero, luego municipios)
  for (const zona in ZONAS_MUNICIPIO) {
    if (t.includes(zona)) return ZONAS_MUNICIPIO[zona];
  }
  for (const m of MUNICIPIOS_GC) {
    if (t.includes(m.toLowerCase())) return m;
  }
  return null; // No se pudo determinar
}

function municipioDesdeCoords(coords) {
  return new Promise((resolve, reject) => {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(coords)}&key=${GOOGLE_MAPS_KEY}&language=es&result_type=locality|administrative_area_level_3`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'OK' && json.results.length > 0) {
            for (const result of json.results) {
              for (const comp of result.address_components) {
                if (comp.types.includes('locality') || comp.types.includes('administrative_area_level_3')) {
                  return resolve(comp.long_name);
                }
              }
            }
          }
          resolve(null);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function calcularDistanciaKm(origen, destino, origenCoords, destinoCoords) {
  return new Promise((resolve, reject) => {
    // Si hay coordenadas exactas (elegidas del autocompletar), se usan tal cual.
    // Si no, se usa el texto con la ciudad añadida (Google adivina el punto).
    const origenParam = origenCoords ? origenCoords : (origen + ', Las Palmas de Gran Canaria, España');
    const destinoParam = destinoCoords ? destinoCoords : (destino + ', Las Palmas de Gran Canaria, España');
    const origenEnc = encodeURIComponent(origenParam);
    const destinoEnc = encodeURIComponent(destinoParam);
    // Directions API: calcula la ruta igual que la app de Google Maps.
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origenEnc}&destination=${destinoEnc}&key=${GOOGLE_MAPS_KEY}&language=es&region=es&departure_time=now&traffic_model=best_guess&alternatives=false`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'OK' && json.routes && json.routes.length > 0) {
            const ruta = json.routes[0];
            let metros = 0;
            for (const leg of ruta.legs) metros += leg.distance.value;
            // Ajuste fijo: la API suele dar de más, se restan 800 m al recorrido.
            metros = metros - 800;
            if (metros < 0) metros = 0;
            resolve(Math.round(metros / 100) / 10);
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
  const { origen, destino, fecha, hora, origenCoords, destinoCoords } = req.body;
  if (!cumpleAntelacion(fecha, hora)) {
    return res.json({
      ok: false,
      error: `No realizamos servicios inmediatos. Las reservas requieren un mínimo de ${horasATexto(cacheConfig.antelacion)} de antelación. Consultas: 828 810 938.`
    });
  }
  try {
    const distanciaKm = await calcularDistanciaKm(origen, destino, origenCoords, destinoCoords);
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
  // El conductor prioritario (licencia 1374) está EXENTO de comisión.
  if (conductor && String(conductor.licencia) === String(LICENCIA_PRIORITARIA)) {
    await Comision.deleteMany({ reservaId: reserva._id, pagada: false });
    return 0;
  }
  const comision = Math.round(precio * COMISION_PORCENTAJE) / 100;
  const ahora = new Date();
  const mes = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`;
  // Limpiar cualquier comisión pendiente previa de esta reserva (p. ej. de un conductor anterior tras reasignar)
  await Comision.deleteMany({ reservaId: reserva._id, pagada: false });
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
    const ahora = ahoraCanarias();
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
            `📊 *RESUMEN DE ${nombreMes.toUpperCase()}*\n\nHas realizado *${resumen.carreras} carrera(s)* por un total de *${resumen.totalCarreras}€*.\n\n💰 Tu comisión pendiente del mes: *${resumen.totalComision}€*\n\nPor favor realiza el ingreso antes del día 7.\nIBAN: ES53 0049 0359 9924 1643 2863`,
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

bot.onText(/\/diagcalendar/, async (msg) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  let informe = '🔍 *DIAGNÓSTICO GOOGLE CALENDAR*\n\n';
  // 1) ¿Existen las variables?
  informe += `1️⃣ Variable credenciales: ${GOOGLE_CALENDAR_CREDENTIALS ? '✅ existe' : '❌ NO existe'}\n`;
  informe += `2️⃣ Variable ID: ${GOOGLE_CALENDAR_ID ? `✅ ${GOOGLE_CALENDAR_ID}` : '❌ NO existe'}\n`;
  // 2) ¿Se puede leer la credencial?
  try {
    let raw = (GOOGLE_CALENDAR_CREDENTIALS || '').trim();
    if (!raw.startsWith('{')) {
      raw = Buffer.from(raw, 'base64').toString('utf-8');
      informe += `3️⃣ Formato: Base64 → descodificado\n`;
    } else {
      informe += `3️⃣ Formato: JSON directo\n`;
    }
    const cred = JSON.parse(raw);
    informe += `4️⃣ JSON válido: ✅\n`;
    informe += `5️⃣ client_email: ${cred.client_email ? '✅ ' + cred.client_email.substring(0, 25) + '...' : '❌ falta'}\n`;
    informe += `6️⃣ private_key: ${cred.private_key ? (cred.private_key.includes('BEGIN PRIVATE KEY') ? '✅ presente' : '⚠️ formato raro') : '❌ falta'}\n`;
  } catch (e) {
    informe += `4️⃣ ❌ Error al leer credenciales: ${e.message}\n`;
  }
  // 3) Intentar crear un evento de prueba
  informe += `\n7️⃣ Probando crear evento de prueba...\n`;
  bot.sendMessage(OWNER_CHAT_ID, informe, { parse_mode: 'Markdown' });
  try {
    const calendar = getCalendarClient();
    if (!calendar) { bot.sendMessage(OWNER_CHAT_ID, '❌ No se pudo crear el cliente de Calendar (revisa credenciales).'); return; }
    const ahora = new Date();
    const inicio = new Date(ahora.getTime() + 24 * 60 * 60 * 1000);
    const res = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: '✅ PRUEBA — Bot Taxi (puedes borrar este evento)',
        start: { dateTime: inicio.toISOString(), timeZone: 'Atlantic/Canary' },
        end: { dateTime: new Date(inicio.getTime() + 30*60*1000).toISOString(), timeZone: 'Atlantic/Canary' }
      }
    });
    bot.sendMessage(OWNER_CHAT_ID, `✅ *¡FUNCIONA!* Evento de prueba creado en tu calendario (mañana a esta hora). ID: ${res.data.id}\n\nPuedes borrarlo. El calendario ya está conectado correctamente.`, { parse_mode: 'Markdown' });
  } catch (e) {
    bot.sendMessage(OWNER_CHAT_ID, `❌ Error al crear evento:\n\n${e.message}\n\nEnvíame esta captura.`);
  }
});

bot.onText(/\/start/, async (msg) => {
  const chatId = String(msg.chat.id);
  const nombre = msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : '');
  if (chatId === OWNER_CHAT_ID) {
    bot.sendMessage(chatId,
      '🚖 *Panel de Administración*\n\n📋 /pendientes\n✅ /asignadas\n❌ /canceladas\n🚫 /cancelarreserva ID\n🔄 /reasignar ID\n\n👥 /conductores\n🔴 /desactivar Nombre\n🟢 /activar Nombre\n🗑️ /eliminarconductor Nombre\n📊 /resumen\n\n⚙️ *Configuración:*\n/config\n/antelacion HORAS\n/cancelacion MINUTOS\n\n💰 *Comisiones:*\n/deudas\n/pagado NombreConductor\n\n📅 *Festivos:*\n/festivos\n/addfestivo YYYY-MM-DD Descripción\n/delfestivo YYYY-MM-DD',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  try {
    const existente = await Conductor.findOne({ chatId });
    if (!existente) {
      // Nuevo: se registra como PENDIENTE de aprobación. No recibe reservas hasta que el admin lo apruebe.
      await Conductor.create({ chatId, nombre, aprobado: false, activo: false });
      bot.sendMessage(chatId, `👋 Hola ${nombre}.\n\nHas solicitado acceso como conductor. Tu solicitud está *pendiente de aprobación* por el administrador.\n\nRecibirás un aviso cuando se apruebe. Gracias por tu paciencia.`, { parse_mode: 'Markdown' });
      bot.sendMessage(OWNER_CHAT_ID,
        `🆕 *Solicitud de acceso de conductor*\n\n👤 Nombre: *${nombre}*\n🆔 ID: ${chatId}\n\n¿Le das acceso al bot?`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[
            { text: '✅ Aprobar', callback_data: `aprobar_${chatId}` },
            { text: '❌ Rechazar', callback_data: `rechazarcond_${chatId}` }
          ]]}
        }
      );
    } else if (!existente.aprobado) {
      bot.sendMessage(chatId, `👋 Hola ${nombre}, tu solicitud sigue *pendiente de aprobación*. Te avisaremos cuando se apruebe.`, { parse_mode: 'Markdown' });
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

bot.onText(/\/config/, async (msg) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  bot.sendMessage(OWNER_CHAT_ID,
    `⚙️ *Configuración actual*\n\n⏱️ Antelación mínima para reservar: *${horasATexto(cacheConfig.antelacion)}*\n❌ Margen para cancelar online: *${horasATexto(cacheConfig.cancelacion)}*\n\n*Para cambiarlas:*\n/antelacion 2 → 2 horas\n/antelacion 1 → 1 hora\n/antelacion 0.5 → 30 minutos\n\n/cancelacion 30 → 30 minutos\n/cancelacion 60 → 1 hora\n/cancelacion 15 → 15 minutos`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/antelacion (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const valor = parseFloat(match[1].trim().replace(',', '.'));
  if (isNaN(valor) || valor < 0 || valor > 72) {
    return bot.sendMessage(OWNER_CHAT_ID, `❌ Valor no válido. Ejemplos:\n/antelacion 2 (2 horas)\n/antelacion 0.5 (30 minutos)`);
  }
  await guardarConfig('antelacion', valor);
  bot.sendMessage(OWNER_CHAT_ID, `✅ Antelación mínima para reservar cambiada a *${horasATexto(valor)}*.\n\nLas nuevas reservas ya usan este valor.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/cancelacion (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const minutos = parseFloat(match[1].trim().replace(',', '.'));
  if (isNaN(minutos) || minutos < 0 || minutos > 1440) {
    return bot.sendMessage(OWNER_CHAT_ID, `❌ Valor no válido. Indica los MINUTOS. Ejemplos:\n/cancelacion 30 (30 minutos)\n/cancelacion 60 (1 hora)`);
  }
  const horas = minutos / 60;
  await guardarConfig('cancelacion', horas);
  bot.sendMessage(OWNER_CHAT_ID, `✅ Margen para cancelar online cambiado a *${horasATexto(horas)}*.\n\nLos clientes podrán cancelar online hasta ${horasATexto(horas)} antes del servicio.`, { parse_mode: 'Markdown' });
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
  // Solo mostrar las pendientes cuyo servicio aún no ha pasado (margen de 1h).
  const limite = new Date(Date.now() - 60 * 60 * 1000);
  const reservas = await Reserva.find({
    estado: 'pendiente',
    $or: [ { fechaServicio: { $gte: limite } }, { fechaServicio: null }, { fechaServicio: { $exists: false } } ]
  }).sort({ fechaServicio: 1 }).limit(10);
  if (!reservas.length) return bot.sendMessage(OWNER_CHAT_ID, '📋 No hay reservas pendientes.');
  let texto = `📋 *PENDIENTES (${reservas.length})*\n\n`;
  reservas.forEach((r, i) => { texto += `*${i+1}.* ${r.datos.nombre} — ${r.datos.fecha} ${r.datos.hora}\n   📍 ${r.datos.origen} → ${r.datos.destino}\n   🆔 \`${r._id}\`\n\n`; });
  texto += `\n💡 Para cancelar: /cancelarreserva ID`;
  bot.sendMessage(OWNER_CHAT_ID, texto, { parse_mode: 'Markdown' });
});

bot.onText(/\/asignadas/, async (msg) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  // Solo mostrar las asignadas cuyo servicio aún no ha pasado (margen de 1h).
  const limite = new Date(Date.now() - 60 * 60 * 1000);
  const reservas = await Reserva.find({
    estado: 'asignada',
    $or: [ { fechaServicio: { $gte: limite } }, { fechaServicio: null }, { fechaServicio: { $exists: false } } ]
  }).sort({ fechaServicio: 1 }).limit(10);
  if (!reservas.length) return bot.sendMessage(OWNER_CHAT_ID, '✅ No hay asignadas.');
  let texto = `✅ *ASIGNADAS (${reservas.length})*\n\n`;
  reservas.forEach((r, i) => { texto += `*${i+1}.* ${r.datos.nombre} — ${r.datos.fecha} ${r.datos.hora}\n   📍 ${r.datos.origen} → ${r.datos.destino}\n   🆔 \`${r._id}\`\n\n`; });
  texto += `\n💡 Cancelar: /cancelarreserva ID\n🔄 Cambiar de taxista: /reasignar ID`;
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

bot.onText(/\/cancelarreserva (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const reservaId = match[1].trim();
  try {
    const reserva = await Reserva.findById(reservaId);
    if (!reserva) return bot.sendMessage(OWNER_CHAT_ID, `❌ No se encontró ninguna reserva con ese ID.`);
    if (reserva.estado === 'cancelada') return bot.sendMessage(OWNER_CHAT_ID, `⚠️ Esa reserva ya estaba cancelada.`);
    reserva.estado = 'cancelada';
    await reserva.save();
    // Borrar el evento del calendario si existía
    await borrarEventoCalendario(reserva.eventoCalendarioId);
    // Anular la comisión: una reserva cancelada no genera cobro al conductor
    const comisionesBorradas = await Comision.deleteMany({ reservaId: reserva._id, pagada: false });
    let aviso = `❌ *Reserva cancelada*\n\n${formatearReserva(reserva.datos, true)}`;
    if (comisionesBorradas.deletedCount > 0) aviso += `\n💰 Comisión anulada al conductor.`;
    bot.sendMessage(OWNER_CHAT_ID, aviso, { parse_mode: 'Markdown' });
    // Avisar al conductor asignado
    if (reserva.conductorAsignado) {
      try { bot.sendMessage(reserva.conductorAsignado, `❌ *Servicio cancelado*\n\n📅 ${reserva.datos.fecha} a las ${reserva.datos.hora}\n📍 ${reserva.datos.origen} → ${reserva.datos.destino}${comisionesBorradas.deletedCount > 0 ? '\n\n💰 La comisión de este servicio ha sido anulada.' : ''}`, { parse_mode: 'Markdown' }); } catch (e) {}
    }
    // Avisar al cliente si reservó por Telegram
    if (reserva.clienteChatId) {
      try { bot.sendMessage(reserva.clienteChatId, `❌ *Tu reserva ha sido cancelada.*\n\n📅 ${reserva.datos.fecha} a las ${reserva.datos.hora}\n📍 ${reserva.datos.origen} → ${reserva.datos.destino}\n\nPara cualquier consulta: 828 810 938`, { parse_mode: 'Markdown' }); } catch (e) {}
    }
  } catch (err) {
    console.error(err);
    bot.sendMessage(OWNER_CHAT_ID, `❌ ID no válido. Copia el ID completo desde /pendientes o /asignadas.`);
  }
});

bot.onText(/\/reasignar (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const reservaId = match[1].trim();
  try {
    const reserva = await Reserva.findById(reservaId);
    if (!reserva) return bot.sendMessage(OWNER_CHAT_ID, `❌ No se encontró ninguna reserva con ese ID.`);
    if (reserva.estado === 'cancelada') return bot.sendMessage(OWNER_CHAT_ID, `⚠️ Esa reserva está cancelada, no se puede reasignar.`);
    if (reserva.estado === 'pendiente') return bot.sendMessage(OWNER_CHAT_ID, `⚠️ Esa reserva ya está pendiente, ningún conductor la tiene asignada.`);

    const conductorAnterior = reserva.conductorAsignado;
    const comisionesBorradas = await Comision.deleteMany({ reservaId: reserva._id, pagada: false });

    if (conductorAnterior) {
      try { bot.sendMessage(conductorAnterior, `🔄 *Servicio reasignado*\n\nEl servicio del ${reserva.datos.fecha} a las ${reserva.datos.hora} (${reserva.datos.origen} → ${reserva.datos.destino}) ha sido retirado y ofrecido a otros conductores.${comisionesBorradas.deletedCount > 0 ? '\n\n💰 La comisión de este servicio ya no se te cobrará.' : ''}`, { parse_mode: 'Markdown' }); } catch (e) {}
    }

    reserva.estado = 'pendiente';
    reserva.conductorAsignado = null;
    // No vaciamos mensajesEnviados: así los mensajes anteriores también se
    // actualizarán a "Servicio ya asignado" cuando alguien acepte.
    await reserva.save();

    const numConductores = await repartirReservaAConductores(reserva);
    bot.sendMessage(OWNER_CHAT_ID, `🔄 Reserva reasignada\n\nVuelve a estar pendiente y se ha enviado a ${numConductores} conductor(es). La comisión pasará a quien la acepte.\n\n${formatearReserva(reserva.datos, true)}`);
  } catch (err) {
    console.error(err);
    bot.sendMessage(OWNER_CHAT_ID, `❌ ID no válido. Copia el ID completo desde /asignadas.`);
  }
});

bot.onText(/\/conductores/, async (msg) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const conductores = await Conductor.find().sort({ fechaRegistro: -1 });
  if (!conductores.length) return bot.sendMessage(OWNER_CHAT_ID, '👥 No hay conductores.');
  let texto = `👥 *CONDUCTORES (${conductores.length})*\n\n`;
  conductores.forEach((c, i) => {
    const lic = c.licencia ? ` (lic. ${c.licencia}${String(c.licencia) === String(LICENCIA_PRIORITARIA) ? ' ⭐' : ''})` : '';
    let estado;
    if (!c.aprobado) estado = '⏳ Pendiente de aprobar';
    else if (c.activo) estado = '🟢 Activo';
    else estado = '🔴 Inactivo';
    texto += `*${i+1}.* ${c.nombre}${lic} — ${estado}\n`;
  });
  texto += `\n💡 Para pausar/activar:\n/desactivar NombreConductor\n/activar NombreConductor\n\n🪪 Asignar licencia:\n/licencia NombreConductor Número`;
  bot.sendMessage(OWNER_CHAT_ID, texto, { parse_mode: 'Markdown' });
});

bot.onText(/\/desactivar (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const nombre = match[1].trim();
  const conductor = await Conductor.findOne({ nombre: new RegExp(nombre, 'i') });
  if (!conductor) return bot.sendMessage(OWNER_CHAT_ID, `❌ No encontrado: "${nombre}"`);
  conductor.activo = false;
  await conductor.save();
  bot.sendMessage(OWNER_CHAT_ID, `🔴 *${conductor.nombre}* desactivado. No recibirá nuevas reservas hasta que lo reactives.`, { parse_mode: 'Markdown' });
  try { bot.sendMessage(conductor.chatId, `🔴 Has sido puesto en pausa temporalmente. No recibirás reservas hasta nuevo aviso.`); } catch (e) {}
});

bot.onText(/\/activar (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const nombre = match[1].trim();
  const conductor = await Conductor.findOne({ nombre: new RegExp(nombre, 'i') });
  if (!conductor) return bot.sendMessage(OWNER_CHAT_ID, `❌ No encontrado: "${nombre}"`);
  conductor.activo = true;
  await conductor.save();
  bot.sendMessage(OWNER_CHAT_ID, `🟢 *${conductor.nombre}* activado. Ya vuelve a recibir reservas.`, { parse_mode: 'Markdown' });
  try { bot.sendMessage(conductor.chatId, `🟢 Ya estás activo de nuevo. Volverás a recibir reservas.`); } catch (e) {}
});

bot.onText(/\/licencia (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  // Formato: /licencia NombreConductor NúmeroLicencia   (ej: /licencia Taxi L.M 1374)
  const partes = match[1].trim().split(/\s+/);
  if (partes.length < 2) {
    return bot.sendMessage(OWNER_CHAT_ID, `Uso: /licencia NombreConductor Número\n\nEjemplo: /licencia Taxi L.M 1374`);
  }
  const numLicencia = partes[partes.length - 1];       // el último trozo es la licencia
  const nombre = partes.slice(0, -1).join(' ');         // lo anterior es el nombre
  const conductor = await Conductor.findOne({ nombre: new RegExp(nombre, 'i') });
  if (!conductor) return bot.sendMessage(OWNER_CHAT_ID, `❌ No encontrado: "${nombre}"`);
  conductor.licencia = numLicencia;
  await conductor.save();
  const esPrioritario = String(numLicencia) === String(LICENCIA_PRIORITARIA);
  bot.sendMessage(OWNER_CHAT_ID, `✅ Licencia ${numLicencia} asignada a *${conductor.nombre}*.${esPrioritario ? `\n\n⭐ Este conductor ahora es PRIORITARIO: recibirá cada reserva en exclusiva durante ${MINUTOS_PRIORIDAD} min y sin comisión.` : ''}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/eliminarconductor (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== OWNER_CHAT_ID) return;
  const nombre = match[1].trim();
  const conductor = await Conductor.findOne({ nombre: new RegExp(nombre, 'i') });
  if (!conductor) return bot.sendMessage(OWNER_CHAT_ID, `❌ No encontrado: "${nombre}"`);
  // Pedir confirmación con botón, porque es permanente
  bot.sendMessage(OWNER_CHAT_ID,
    `⚠️ *¿Eliminar a ${conductor.nombre} definitivamente?*\n\nEsta acción es permanente: se borra el conductor del sistema. Su historial de comisiones ya cobradas se conserva.\n\nSi solo quieres que deje de recibir reservas temporalmente, usa /desactivar.`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '🗑️ Sí, eliminar', callback_data: `delconductor_${conductor.chatId}` },
        { text: '↩️ No, cancelar', callback_data: 'no_delconductor' }
      ]]}
    }
  );
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

// Reparte una reserva (ya existente y en estado pendiente) a todos los conductores activos.
// Envía la reserva a un conjunto de conductores y acumula los mensajes enviados.
async function enviarReservaA(reserva, conductores) {
  const mensajesEnviados = Array.isArray(reserva.mensajesEnviados) ? [...reserva.mensajesEnviados] : [];
  const yaEnviados = new Set(mensajesEnviados.map(m => String(m.chatId)));
  const texto = `🚖 NUEVA RESERVA DISPONIBLE — ${numReserva(reserva.numero)}\n\n${formatearReserva(reserva.datos, 'disponible')}\n⏰ Responde rápido para aceptarla.`;
  for (const conductor of conductores) {
    if (yaEnviados.has(String(conductor.chatId))) continue; // no enviar dos veces al mismo
    try {
      const msg = await bot.sendMessage(conductor.chatId, texto, {
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
  return mensajesEnviados.length;
}

async function repartirReservaAConductores(reserva) {
  const conductores = await Conductor.find({ activo: true });
  // ¿Hay un conductor prioritario (licencia 1374) activo?
  const prioritario = conductores.find(c => String(c.licencia) === String(LICENCIA_PRIORITARIA));

  if (prioritario) {
    // FASE 1: enviar SOLO al conductor prioritario y esperar X minutos.
    await enviarReservaA(reserva, [prioritario]);
    try { bot.sendMessage(OWNER_CHAT_ID, `⭐ Reserva ${numReserva(reserva.numero)} enviada en exclusiva a ${prioritario.nombre} (lic. ${LICENCIA_PRIORITARIA}) durante ${MINUTOS_PRIORIDAD} min.`); } catch (e) {}
    // Programar el reparto al resto si no la acepta a tiempo.
    setTimeout(async () => {
      try {
        const actual = await Reserva.findById(reserva._id);
        if (!actual || actual.estado !== 'pendiente') return; // ya la aceptó (él u otro), no hacer nada
        const activos = await Conductor.find({ activo: true });
        const resto = activos.filter(c => String(c.licencia) !== String(LICENCIA_PRIORITARIA));
        if (resto.length) {
          await enviarReservaA(actual, resto);
          try { bot.sendMessage(OWNER_CHAT_ID, `⏱️ ${prioritario.nombre} no aceptó ${numReserva(actual.numero)} en ${MINUTOS_PRIORIDAD} min. Enviada al resto de conductores.`); } catch (e) {}
        }
      } catch (e) { console.error('Error en reparto diferido:', e.message); }
    }, MINUTOS_PRIORIDAD * 60 * 1000);
    return 1;
  }

  // Si no hay conductor prioritario, reparto normal a todos.
  return await enviarReservaA(reserva, conductores);
}

bot.on('callback_query', async (query) => {
  const chatId = String(query.message.chat.id);
  const messageId = query.message.message_id;
  const data = query.data;

  // Aprobar un conductor pendiente (solo el admin)
  if (data.startsWith('aprobar_')) {
    if (chatId !== OWNER_CHAT_ID) { bot.answerCallbackQuery(query.id, { text: 'Solo el administrador.' }); return; }
    const condChatId = data.replace('aprobar_', '');
    try {
      const conductor = await Conductor.findOne({ chatId: condChatId });
      if (!conductor) { bot.answerCallbackQuery(query.id, { text: 'Conductor no encontrado.' }); return; }
      conductor.aprobado = true;
      conductor.activo = true;
      await conductor.save();
      bot.editMessageText(`✅ Conductor *${conductor.nombre}* aprobado. Ya recibe reservas.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
      try { bot.sendMessage(condChatId, `✅ *¡Acceso aprobado!*\n\nYa estás dado de alta como conductor. A partir de ahora recibirás las reservas disponibles.\n\n💡 /mideuda para ver tu comisión.`, { parse_mode: 'Markdown' }); } catch (e) {}
      bot.answerCallbackQuery(query.id, { text: '✅ Aprobado' });
    } catch (e) { console.error(e); bot.answerCallbackQuery(query.id, { text: 'Error.' }); }
    return;
  }

  // Rechazar un conductor pendiente: se elimina del todo (solo el admin)
  if (data.startsWith('rechazarcond_')) {
    if (chatId !== OWNER_CHAT_ID) { bot.answerCallbackQuery(query.id, { text: 'Solo el administrador.' }); return; }
    const condChatId = data.replace('rechazarcond_', '');
    try {
      const conductor = await Conductor.findOne({ chatId: condChatId });
      const nombre = conductor ? conductor.nombre : 'Conductor';
      await Conductor.deleteOne({ chatId: condChatId });
      bot.editMessageText(`❌ Solicitud de *${nombre}* rechazada. No tiene acceso al bot.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
      try { bot.sendMessage(condChatId, `❌ Tu solicitud de acceso no ha sido aprobada. Si crees que es un error, contacta con el administrador.`); } catch (e) {}
      bot.answerCallbackQuery(query.id, { text: 'Rechazado' });
    } catch (e) { console.error(e); bot.answerCallbackQuery(query.id, { text: 'Error.' }); }
    return;
  }

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
      const conductor = await Conductor.findOne({ chatId });
      const nombreConductor = conductor ? conductor.nombre : 'Un conductor';
      // Nombre con licencia para mostrar al cliente (ej: "Taxi L.M (Licencia 1374)")
      const conductorConLicencia = (conductor && conductor.licencia) ? `${nombreConductor} (Licencia ${conductor.licencia})` : nombreConductor;
      reserva.conductorNombre = nombreConductor;
      await reserva.save();
      const comision = await registrarComision(reserva, chatId);
      const comisionTxt = comision ? `\n💰 Comisión registrada: ${comision}€` : '';

      // Mensaje al taxista con botones de navegación y completado
      bot.editMessageText(`✅ Reserva aceptada — ${numReserva(reserva.numero)}\n\nHas aceptado este servicio.${comisionTxt}`, { chat_id: chatId, message_id: messageId });

      // Enlace a Google Maps para la recogida: usa coordenadas exactas si las hay,
      // y si no, la dirección de texto. Sirve para que el conductor navegue directo.
      const recogida = (reserva.datos.origenCoords && reserva.datos.origenCoords.includes(','))
        ? reserva.datos.origenCoords
        : reserva.datos.origen;
      const enlaceMapa = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(recogida)}&travelmode=driving`;

      bot.sendMessage(chatId, `📋 Detalles del servicio:\n\n${formatearReserva(reserva.datos, false)}`, {
        reply_markup: { inline_keyboard: [
          [ { text: '🧭 Ir a la recogida (Google Maps)', url: enlaceMapa } ],
          [ { text: '🏁 Marcar servicio completado', callback_data: `completar_${reserva._id}` } ]
        ]}
      });
      bot.sendMessage(OWNER_CHAT_ID, `✅ Reserva asignada — ${numReserva(reserva.numero)}\n\nConductor: ${nombreConductor}\n\n${formatearReserva(reserva.datos, true)}`);

      // Actualizar TODOS los demás mensajes de esta reserva (de todos los reenvíos,
      // de cualquier taxista) a "Servicio ya asignado". Solo se salta el mensaje
      // concreto que el taxista acaba de pulsar (ese ya se editó arriba).
      for (const msg of reserva.mensajesEnviados) {
        if (String(msg.messageId) === String(messageId) && msg.chatId === chatId) continue;
        try { bot.editMessageText(`⚠️ *Servicio ya asignado*`, { chat_id: msg.chatId, message_id: msg.messageId, parse_mode: 'Markdown' }); } catch (e) {}
      }

      if (reserva.clienteChatId) {
        const d = reserva.datos;
        const precioTxt = d.precioEstimado ? `\n💰 *Precio estimado:* ${d.precioEstimado} €` : '';
        try {
          bot.sendMessage(reserva.clienteChatId,
            `✅ *¡Tu reserva ha sido aceptada!*\n\n🎫 *Reserva:* ${numReserva(reserva.numero)}\n📅 *Fecha:* ${d.fecha} a las ${d.hora}\n📍 *Origen:* ${d.origen}\n🏁 *Destino:* ${d.destino}${precioTxt}\n\n🚖 *Tu conductor:* ${conductorConLicencia}\nEstará contigo a la hora indicada.\n\n❌ Para cancelar escribe /cancelar`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {}
      }

      // Enviar email de confirmación SIEMPRE (web, WhatsApp, Telegram, Facebook...)
      // Solo se omite si la reserva no tiene correo.
      await enviarEmailConfirmacion(reserva.datos, reserva._id, conductorConLicencia, reserva.numero);

      // Crear el evento en Google Calendar del administrador
      try {
        const eventoId = await crearEventoCalendario(reserva, conductorConLicencia);
        if (eventoId) {
          reserva.eventoCalendarioId = eventoId;
          await reserva.save();
        }
      } catch (e) { console.error('No se pudo crear evento de calendario:', e.message); }

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

  if (data.startsWith('completar_')) {
    const reservaId = data.replace('completar_', '');
    try {
      const reserva = await Reserva.findById(reservaId);
      if (!reserva) { bot.answerCallbackQuery(query.id, { text: 'Reserva no encontrada.' }); return; }
      if (reserva.estado === 'completada') { bot.answerCallbackQuery(query.id, { text: 'Ya estaba marcada como completada.' }); return; }
      if (reserva.conductorAsignado !== chatId) { bot.answerCallbackQuery(query.id, { text: 'Este servicio no es tuyo.', show_alert: true }); return; }
      reserva.estado = 'completada';
      await reserva.save();
      bot.editMessageText(`🏁 Servicio completado — ${numReserva(reserva.numero)}\n\n${formatearReserva(reserva.datos, false)}\n✅ ¡Gracias!`, { chat_id: chatId, message_id: messageId });
      bot.sendMessage(OWNER_CHAT_ID, `🏁 *Servicio completado* — ${numReserva(reserva.numero)}\n\nConductor: ${reserva.conductorNombre || 'Desconocido'}\n${reserva.datos.origen} → ${reserva.datos.destino}`, { parse_mode: 'Markdown' });
      bot.answerCallbackQuery(query.id, { text: '🏁 Servicio marcado como completado' });
    } catch (err) {
      console.error(err);
      bot.answerCallbackQuery(query.id, { text: 'Error. Inténtalo de nuevo.' });
    }
  }

  if (data.startsWith('confirmar_cancelar_')) {
    const reservaId = data.replace('confirmar_cancelar_', '');
    try {
      const reserva = await Reserva.findById(reservaId);
      if (!reserva || reserva.estado === 'cancelada') { bot.answerCallbackQuery(query.id, { text: 'Ya cancelada.' }); return; }
      reserva.estado = 'cancelada';
      await reserva.save();
      await borrarEventoCalendario(reserva.eventoCalendarioId);
      // Anular la comisión del conductor: una reserva cancelada no genera cobro
      const comisionesBorradas = await Comision.deleteMany({ reservaId: reserva._id, pagada: false });
      bot.editMessageText(`❌ *Reserva cancelada correctamente.*`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
      bot.sendMessage(OWNER_CHAT_ID, `❌ Cancelada por cliente\n\n${formatearReserva(reserva.datos, true)}`);
      if (reserva.conductorAsignado) {
        try { bot.sendMessage(reserva.conductorAsignado, `❌ *Servicio cancelado*\n\n📅 ${reserva.datos.fecha} a las ${reserva.datos.hora}\n📍 ${reserva.datos.origen} → ${reserva.datos.destino}${comisionesBorradas.deletedCount > 0 ? '\n\n💰 La comisión de este servicio ha sido anulada.' : ''}`, { parse_mode: 'Markdown' }); } catch (e) {}
      }
      bot.answerCallbackQuery(query.id, { text: '❌ Reserva cancelada' });
    } catch (err) { console.error(err); }
  }

  if (data === 'no_cancelar') {
    bot.editMessageText(`✅ Tu reserva sigue activa.`, { chat_id: chatId, message_id: messageId });
    bot.answerCallbackQuery(query.id, { text: 'Cancelación abortada' });
  }

  if (data.startsWith('delconductor_')) {
    if (chatId !== OWNER_CHAT_ID) { bot.answerCallbackQuery(query.id); return; }
    const conductorChatId = data.replace('delconductor_', '');
    try {
      const conductor = await Conductor.findOne({ chatId: conductorChatId });
      if (!conductor) { bot.editMessageText(`❌ El conductor ya no existe.`, { chat_id: chatId, message_id: messageId }); bot.answerCallbackQuery(query.id); return; }
      const nombre = conductor.nombre;
      await Conductor.deleteOne({ chatId: conductorChatId });
      bot.editMessageText(`🗑️ Conductor *${nombre}* eliminado del sistema.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
      bot.answerCallbackQuery(query.id, { text: 'Conductor eliminado' });
    } catch (err) {
      console.error(err);
      bot.answerCallbackQuery(query.id, { text: 'Error al eliminar.' });
    }
  }

  if (data === 'no_delconductor') {
    bot.editMessageText(`↩️ Eliminación cancelada. El conductor sigue en el sistema.`, { chat_id: chatId, message_id: messageId });
    bot.answerCallbackQuery(query.id, { text: 'Cancelado' });
  }
});

// =================== RECORDATORIOS ===================

function iniciarRecordatorios() {
  setInterval(async () => {
    try {
      const ahora = ahoraCanarias();
      const en60min = new Date(ahora.getTime() + 60 * 60 * 1000);
      const en55min = new Date(ahora.getTime() + 55 * 60 * 1000);

      // 1) Recordatorio al TAXISTA (1h antes)
      const reservas = await Reserva.find({ estado: 'asignada', recordatorioEnviado: false, fechaServicio: { $gte: en55min, $lte: en60min } });
      for (const reserva of reservas) {
        try { bot.sendMessage(reserva.conductorAsignado, `⏰ RECORDATORIO — Servicio en 1 hora — ${numReserva(reserva.numero)}\n\n${formatearReserva(reserva.datos, false)}`); } catch (e) {}
        bot.sendMessage(OWNER_CHAT_ID, `⏰ Recordatorio enviado al taxista\n\n${formatearReserva(reserva.datos, true)}`);
        reserva.recordatorioEnviado = true;
        await reserva.save();
      }

      // 2) Recordatorio al CLIENTE (1h antes), por email
      const reservasCliente = await Reserva.find({ estado: { $in: ['asignada'] }, recordatorioClienteEnviado: false, fechaServicio: { $gte: en55min, $lte: en60min } });
      for (const reserva of reservasCliente) {
        if (reserva.datos && reserva.datos.correo && BREVO_API_KEY) {
          try {
            await enviarEmailBrevo({
              sender: { name: 'Reserva Taxi Las Palmas', email: 'reservadetaxilp@gmail.com' },
              to: [{ email: reserva.datos.correo, name: reserva.datos.nombre }],
              subject: 'Recordatorio: tu taxi llega en 1 hora',
              htmlContent: `<div style="font-family:Arial,sans-serif;padding:24px;background:#f9f9f9;max-width:600px;margin:0 auto;">
                <h2 style="color:#f5c400;background:#1a1a1a;padding:16px;border-radius:8px;">🚖 Reserva Taxi Las Palmas</h2>
                <h3 style="color:#2d8a2d;">⏰ Tu taxi llega en 1 hora</h3>
                <p>Hola <strong>${reserva.datos.nombre}</strong>, te recordamos tu recogida:</p>
                <div style="background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;margin:16px 0;">
                  <p>🎫 <strong>Nº de reserva:</strong> ${numReserva(reserva.numero)}</p>
                  ${reserva.conductorNombre ? `<p>🚖 <strong>Tu conductor:</strong> ${reserva.conductorNombre}</p>` : ''}
                  <p>📅 <strong>Fecha:</strong> ${reserva.datos.fecha} a las ${reserva.datos.hora}</p>
                  <p>📍 <strong>Origen:</strong> ${reserva.datos.origen}</p>
                  <p>🏁 <strong>Destino:</strong> ${reserva.datos.destino}</p>
                </div>
                <p>📞 Consultas: <strong>828 810 938</strong></p>
              </div>`
            });
          } catch (e) { console.error('Error recordatorio cliente:', e.message); }
        }
        reserva.recordatorioClienteEnviado = true;
        await reserva.save();
      }

      // 3) Aviso al ADMIN si una reserva lleva 10 min PENDIENTE sin que nadie la acepte
      const hace10min = new Date(Date.now() - 10 * 60 * 1000);
      const sinAceptar = await Reserva.find({ estado: 'pendiente', avisoSinAceptarEnviado: false, fechaCreacion: { $lte: hace10min } });
      for (const reserva of sinAceptar) {
        bot.sendMessage(OWNER_CHAT_ID, `⚠️ Reserva sin aceptar — ${numReserva(reserva.numero)}\n\nLleva más de 10 minutos pendiente y ningún taxista la ha aceptado.\n\n${formatearReserva(reserva.datos, true)}\n\n🆔 ${reserva._id}`);
        // A los 10 min ya no aplicamos prioridad: se envía a TODOS los conductores activos
        // (incluido el prioritario) para que cualquiera pueda cogerla.
        try {
          const todos = await Conductor.find({ activo: true });
          await enviarReservaA(reserva, todos);
        } catch (e) {}
        reserva.avisoSinAceptarEnviado = true;
        await reserva.save();
      }
    } catch (err) { console.error('Error recordatorios:', err); }
  }, 60 * 1000);
}

// =================== HELPERS ===================

// Formatea el número corto de reserva: 42 -> RT-0042
function numReserva(numero) {
  if (!numero) return '';
  return 'RT-' + String(numero).padStart(4, '0');
}

// Línea de municipio (cabecera): 🏙️ Municipio: TELDE  o  ✈️ AEROPUERTO
function lineaMunicipio(data) {
  if (!data.municipio) return '';
  if (data.municipio === 'AEROPUERTO') return `✈️ Zona: AEROPUERTO\n`;
  return `📍 Zona: ${data.municipio}\n`;
}

// nivel: 'disponible' (sin datos personales), 'taxista' (nombre sí, contacto no), 'admin' (todo)
// Se mantiene compatibilidad: true => 'admin', false => 'taxista'
// Texto plano (sin Markdown) para que ningún carácter de las direcciones corte el mensaje.
function formatearReserva(data, nivel = 'taxista') {
  if (nivel === true) nivel = 'admin';
  if (nivel === false) nivel = 'taxista';

  const linea = '━━━━━━━━━━━━━━━';
  let msg = '';

  if (nivel === 'disponible') {
    // Estado PENDIENTE: solo zona, fecha, hora, destino y pasajeros.
    // Se ocultan origen exacto, precio y datos del cliente hasta que un taxista acepta.
    msg += lineaMunicipio(data);
    msg += linea + '\n';
    msg += `🗓️ ${data.fecha}\n`;
    msg += `🕐 ${data.hora} h\n`;
    msg += `🎯 Hacia: ${data.destino}\n`;
    msg += `👥 ${data.pasajeros} pasajero(s)\n`;
    return msg;
  }

  // Niveles 'taxista' y 'admin'
  msg += lineaMunicipio(data);
  msg += linea + '\n';
  msg += `🗓️ ${data.fecha}  ·  🕐 ${data.hora} h\n`;
  msg += `\n`;
  msg += `🟢 Recogida:\n   ${data.origen}\n`;
  msg += `🔴 Destino:\n   ${data.destino}\n`;
  msg += `\n`;
  msg += `👥 Pasajeros: ${data.pasajeros}\n`;
  if (data.precioEstimado) msg += `💰 Tarifa estimada: ${data.precioEstimado} €\n`;
  if (data.vuelo) msg += `✈️ Vuelo: ${data.vuelo}\n`;
  if (data.pasaporte) msg += `🛂 Pasaporte: ${data.pasaporte}\n`;
  if (data.observaciones) msg += `📝 Notas: ${data.observaciones}\n`;
  msg += linea + '\n';

  // Datos del cliente
  msg += `\n👤 Cliente: ${data.nombre}\n`;
  if (nivel === 'admin') {
    // Solo el admin ve el contacto del cliente
    msg += `📧 ${data.correo}\n`;
    msg += `📞 ${data.telefono}\n`;
  }
  return msg;
}

// =================== RESERVAS ===================

app.post('/reserva', async (req, res) => {
  const { clienteChatId, ...data } = req.body;

  if (!cumpleAntelacion(data.fecha, data.hora)) {
    return res.json({
      ok: false,
      error: `No realizamos servicios inmediatos. Las reservas requieren un mínimo de ${horasATexto(cacheConfig.antelacion)} de antelación. Consultas: 828 810 938.`
    });
  }

  let fechaServicio = null;
  try { fechaServicio = new Date(`${data.fecha}T${data.hora}:00`); } catch (e) {}

  // Detectar el municipio del origen (o AEROPUERTO)
  try {
    data.municipio = await detectarMunicipio(data.origen, data.origenCoords);
  } catch (e) { data.municipio = null; }

  try {
    const conductores = await Conductor.find({ activo: true });
    if (!conductores.length) {
      await bot.sendMessage(OWNER_CHAT_ID, `🚖 NUEVA RESERVA (sin conductores)\n\n${formatearReserva(data, true)}`);
      return res.json({ ok: true });
    }

    const numero = await siguienteNumeroReserva();
    const reserva = await Reserva.create({ numero, datos: data, clienteChatId: clienteChatId || null, fechaServicio });

    // Usar la función unificada: envía el audio de alarma + el mensaje a cada conductor
    // y guarda los mensajes para poder actualizarlos todos al aceptar.
    const numEnviados = await repartirReservaAConductores(reserva);

    await bot.sendMessage(OWNER_CHAT_ID, `📨 Nueva reserva enviada a ${numEnviados} conductor(es)\n\n${formatearReserva(data, true)}`);
    res.json({ ok: true, reservaId: reserva._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

// =================== CANCELACIÓN WEB POR EL CLIENTE ===================

const BASE_URL = process.env.BASE_URL || '';

// Página que ve el cliente al pulsar el enlace de cancelación
app.get('/cancelar', async (req, res) => {
  const id = req.query.id;
  const html = (titulo, mensaje, color) => `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Cancelar reserva</title>
    <style>body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0a0a;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
    .box{max-width:440px;background:#141414;border:1px solid ${color};border-radius:16px;padding:32px;text-align:center}
    .icon{font-size:54px;margin-bottom:16px}h1{color:${color};font-size:22px;margin:0 0 12px}p{color:#bbb;font-size:15px;line-height:1.6;margin:0 0 20px}
    .btn{display:inline-block;padding:14px 28px;background:#e05050;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;text-decoration:none}
    .tel{color:#f5c400;text-decoration:none;font-weight:700}</style></head><body><div class="box">${titulo}${mensaje}</div></body></html>`;

  try {
    const reserva = await Reserva.findById(id);
    if (!reserva) {
      return res.send(html('<div class="icon">❓</div>', '<h1>Reserva no encontrada</h1><p>El enlace no es válido. Para cualquier consulta llama al <a class="tel" href="tel:+34828810938">828 810 938</a>.</p>', '#888'));
    }
    if (reserva.estado === 'cancelada') {
      return res.send(html('<div class="icon">✅</div>', '<h1>Ya estaba cancelada</h1><p>Esta reserva ya figura como cancelada. No tienes que hacer nada más.</p>', '#7dd87d'));
    }
    // No permitir cancelar online con menos del margen de cancelación configurado
    if (reserva.fechaServicio) {
      const minutos = (new Date(reserva.fechaServicio) - ahoraCanarias()) / 60000;
      if (minutos < cacheConfig.cancelacion * 60) {
        return res.send(html('<div class="icon">⏱️</div>', `<h1>No se puede cancelar online</h1><p>Tu servicio es en menos de ${horasATexto(cacheConfig.cancelacion)}. Para cancelarlo, llama directamente al <a class="tel" href="tel:+34828810938">828 810 938</a>.</p>`, '#f5c400'));
      }
    }
    const d = reserva.datos;
    // Mostrar pantalla de confirmación con un botón que llama a /cancelar-confirmar
    return res.send(html('<div class="icon">⚠️</div>', `<h1>¿Cancelar tu reserva?</h1>
      <p>📅 ${d.fecha} a las ${d.hora}<br>📍 ${d.origen} → ${d.destino}</p>
      <a class="btn" href="/cancelar-confirmar?id=${id}">Sí, cancelar reserva</a>`, '#f5c400'));
  } catch (e) {
    return res.send(html('<div class="icon">❓</div>', '<h1>Enlace no válido</h1><p>Para cualquier consulta llama al <a class="tel" href="tel:+34828810938">828 810 938</a>.</p>', '#888'));
  }
});

// Confirmación real de la cancelación (cuando el cliente pulsa el botón)
app.get('/cancelar-confirmar', async (req, res) => {
  const id = req.query.id;
  const html = (titulo, mensaje, color) => `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Cancelar reserva</title>
    <style>body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0a0a;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
    .box{max-width:440px;background:#141414;border:1px solid ${color};border-radius:16px;padding:32px;text-align:center}
    .icon{font-size:54px;margin-bottom:16px}h1{color:${color};font-size:22px;margin:0 0 12px}p{color:#bbb;font-size:15px;line-height:1.6;margin:0}
    .tel{color:#f5c400;text-decoration:none;font-weight:700}</style></head><body><div class="box">${titulo}${mensaje}</div></body></html>`;

  try {
    const reserva = await Reserva.findById(id);
    if (!reserva) return res.send(html('<div class="icon">❓</div>', '<h1>Reserva no encontrada</h1><p>El enlace no es válido.</p>', '#888'));
    if (reserva.estado === 'cancelada') return res.send(html('<div class="icon">✅</div>', '<h1>Ya estaba cancelada</h1><p>No tienes que hacer nada más.</p>', '#7dd87d'));
    if (reserva.fechaServicio) {
      const minutos = (new Date(reserva.fechaServicio) - ahoraCanarias()) / 60000;
      if (minutos < cacheConfig.cancelacion * 60) {
        return res.send(html('<div class="icon">⏱️</div>', `<h1>No se puede cancelar online</h1><p>Tu servicio es en menos de ${horasATexto(cacheConfig.cancelacion)}. Llama al <a class="tel" href="tel:+34828810938">828 810 938</a>.</p>`, '#f5c400'));
      }
    }
    reserva.estado = 'cancelada';
    await reserva.save();
    await borrarEventoCalendario(reserva.eventoCalendarioId);
    // Anular comisión del conductor
    const comisionesBorradas = await Comision.deleteMany({ reservaId: reserva._id, pagada: false });
    // Avisar al admin
    bot.sendMessage(OWNER_CHAT_ID, `❌ Cancelada por el cliente (web)\n\n${formatearReserva(reserva.datos, true)}${comisionesBorradas.deletedCount > 0 ? '\n💰 Comisión anulada al conductor.' : ''}`);
    // Avisar al conductor asignado
    if (reserva.conductorAsignado) {
      try { bot.sendMessage(reserva.conductorAsignado, `❌ *Servicio cancelado por el cliente*\n\n📅 ${reserva.datos.fecha} a las ${reserva.datos.hora}\n📍 ${reserva.datos.origen} → ${reserva.datos.destino}${comisionesBorradas.deletedCount > 0 ? '\n\n💰 La comisión de este servicio ha sido anulada.' : ''}`, { parse_mode: 'Markdown' }); } catch (e) {}
    }
    return res.send(html('<div class="icon">✅</div>', '<h1>Reserva cancelada</h1><p>Tu reserva ha sido cancelada correctamente. Esperamos verte pronto.</p>', '#7dd87d'));
  } catch (e) {
    console.error(e);
    return res.send(html('<div class="icon">❓</div>', '<h1>Enlace no válido</h1><p>Para cualquier consulta llama al <a class="tel" href="tel:+34828810938">828 810 938</a>.</p>', '#888'));
  }
});

app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
