// Build forzado - v2 - authAdmin fix confirmado
const http = require('http');
const WebSocket = require('ws');
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const https = require('https');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const webpush = require('web-push');

// =================== CONFIG ===================
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const GOOGLE_CALENDAR_CREDENTIALS = process.env.GOOGLE_CALENDAR_CREDENTIALS || '';
const JWT_SECRET = process.env.JWT_SECRET || 'taxilaspalmas2026';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin2026';
const APP_URL = process.env.APP_URL || '';
const COMISION_PORCENTAJE = 10;
const LICENCIA_PRIORITARIA = process.env.LICENCIA_PRIORITARIA || '1374';
// MINUTOS_PRIORIDAD ahora configurable via cacheConfig.prioridadMinutos

// =================== WEB PUSH (notificaciones reales, con pantalla bloqueada) ===================
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:reservas@taxilaspalmasdegrancanaria.com';
let pushDisponible = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    pushDisponible = true;
  } catch(e) { console.error('⚠️ Error configurando VAPID:', e.message); }
} else {
  console.warn('⚠️ AVISO: Notificaciones push reales desactivadas (faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).');
}

if (!MONGODB_URI) { console.error('ERROR: Falta MONGODB_URI'); process.exit(1); }

let cacheConfig = { antelacion: 2, cancelacion: 0.5, prioridadMinutos: 2 };

process.on('unhandledRejection', (r) => console.error('Promesa rechazada:', r));
process.on('uncaughtException', (e) => console.error('Excepción no capturada:', e.message));

// =================== HELPERS TIEMPO ===================
function ahoraCanarias() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Atlantic/Canary' }));
}
function cumpleAntelacion(fecha, hora) {
  try {
    const f = new Date(`${fecha}T${hora}:00`);
    return !isNaN(f) && (f - ahoraCanarias()) / 60000 >= cacheConfig.antelacion * 60;
  } catch(e) { return false; }
}
function horasATexto(h) {
  if (h < 1) return `${Math.round(h * 60)} minutos`;
  if (h === 1) return '1 hora';
  return `${h} horas`;
}
function numReserva(n) { return n ? 'RT-' + String(n).padStart(4, '0') : ''; }
function normalizarLicencia(v) { return String(v || '').replace(/[^0-9]/g, ''); }
function esLicenciaPrioritaria(licencia) { return normalizarLicencia(licencia) === normalizarLicencia(LICENCIA_PRIORITARIA); }

async function comprobarDiaBloqueado(fecha, hora) {
  const festivoDoc = await Festivo.findOne({ fecha });
  if (!festivoDoc || festivoDoc.tipo !== 'sin_servicio') return null;
  // Sin rango de horas = bloqueado el día completo
  if (!festivoDoc.horaInicio || !festivoDoc.horaFin) {
    return `No realizamos servicios el día ${fecha}${festivoDoc.descripcion ? ' (' + festivoDoc.descripcion + ')' : ''}. Consultas: 828 810 938.`;
  }
  // Con rango de horas: solo bloquea si la hora solicitada cae dentro del rango
  if (hora >= festivoDoc.horaInicio && hora <= festivoDoc.horaFin) {
    return `No realizamos servicios el día ${fecha} entre las ${festivoDoc.horaInicio} y las ${festivoDoc.horaFin}${festivoDoc.descripcion ? ' (' + festivoDoc.descripcion + ')' : ''}. Consultas: 828 810 938.`;
  }
  return null;
}

if (!GOOGLE_CALENDAR_CREDENTIALS || !GOOGLE_CALENDAR_ID) {
  console.warn('⚠️  AVISO: Google Calendar NO está configurado (falta GOOGLE_CALENDAR_CREDENTIALS o GOOGLE_CALENDAR_ID). Las reservas NO se agendarán en Calendar hasta que se configure.');
}

// =================== GOOGLE CALENDAR ===================
let calendarClient = null;
function getCalendarClient() {
  if (calendarClient) return calendarClient;
  if (!GOOGLE_CALENDAR_CREDENTIALS || !GOOGLE_CALENDAR_ID) return null;
  try {
    let raw = GOOGLE_CALENDAR_CREDENTIALS.trim();
    if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf-8');
    const credentials = JSON.parse(raw);
    if (credentials.private_key?.includes('\\n'))
      credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/calendar'] });
    calendarClient = google.calendar({ version: 'v3', auth });
    return calendarClient;
  } catch(e) { console.error('Error Calendar client:', e.message); return null; }
}

async function crearEventoCalendario(reserva, nombreConductor) {
  const calendar = getCalendarClient();
  if (!calendar) return null;
  try {
    const d = reserva.datos;
    const inicio = new Date(`${d.fecha}T${d.hora}:00`);
    if (isNaN(inicio)) return null;
    const fin = new Date(inicio.getTime() + 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const toISO = (f) => `${f.getFullYear()}-${pad(f.getMonth()+1)}-${pad(f.getDate())}T${pad(f.getHours())}:${pad(f.getMinutes())}:00`;
    const destAero = /aeropuerto|airport|lpa/i.test(d.destino || '');
    const origAero = /aeropuerto|airport|lpa/i.test(d.origen || '');
    const colorId = destAero ? '6' : origAero ? '7' : '8';
    const sillasTexto = Array.isArray(d.sillas) && d.sillas.length ? d.sillas.join(', ') : (d.sillas || '');
    const lineas = [
      `👤 Cliente: ${d.nombre || '—'}`,
      `📞 Teléfono: ${d.telefono || '—'}`,
      d.correo ? `✉️ Correo: ${d.correo}` : '',
      `📍 Origen: ${d.origen || '—'}`,
      `🏁 Destino: ${d.destino || '—'}`,
      `🕐 Hora: ${d.hora || '—'}`,
      `👥 Pasajeros: ${d.pasajeros || '—'}`,
      d.vehiculoNombre ? `🚖 Vehículo: ${d.vehiculoNombre}` : '',
      sillasTexto ? `🧒 Sillas: ${sillasTexto}` : '',
      d.vuelo ? `✈️ Nº de vuelo: ${d.vuelo}` : '',
      d.pasaporte ? `🛂 Pasaporte/doc.: ${d.pasaporte}` : '',
      `🚕 Conductor: ${nombreConductor || 'Sin asignar'}`,
      d.precioEstimado ? `💰 Precio estimado: ${d.precioEstimado}€` : '',
      d.observaciones ? `💬 Observaciones: ${d.observaciones}` : ''
    ].filter(Boolean);
    const res = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: `🚖 ${numReserva(reserva.numero)} — ${d.nombre || 'Cliente'} · ${d.origen} → ${d.destino}`,
        description: lineas.join('\n'),
        location: d.origen || '',
        start: { dateTime: toISO(inicio), timeZone: 'Atlantic/Canary' },
        end: { dateTime: toISO(fin), timeZone: 'Atlantic/Canary' },
        colorId,
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }, { method: 'popup', minutes: 15 }] }
      }
    });
    return res.data.id;
  } catch(e) { console.error('Error crear evento Calendar:', e.message); return null; }
}

async function borrarEventoCalendario(eventoId) {
  if (!eventoId) return;
  const calendar = getCalendarClient();
  if (!calendar) return;
  try { await calendar.events.delete({ calendarId: GOOGLE_CALENDAR_ID, eventId: eventoId }); } catch(e) {}
}

// (Eliminada calcularDistanciaKm: usaba Directions API y no se utilizaba en ningún endpoint.
// El cálculo real de distancia se hace en /calcular-tarifa con Distance Matrix API.)

async function determinarTarifa(fecha, hora) {
  const horaNum = parseInt(hora.replace(':', ''));
  const diaSemana = new Date(fecha + 'T12:00:00').getDay();
  const festivo = await Festivo.findOne({ fecha });
  if (diaSemana === 0 || festivo) return 'festiva';
  if (horaNum >= 600 && horaNum <= 2159) return 'diurna';
  return 'nocturna';
}

function calcularPrecio(distanciaKm, tipo, esAeropuerto) {
  const base = tipo === 'diurna' ? 3.85 : 4.25;
  const km = tipo === 'diurna' ? 1.35 : 1.55;
  let precio = base + (distanciaKm * km);
  if (esAeropuerto) precio += 2.10;
  return Math.round(precio / 0.05) * 0.05;
}

async function detectarMunicipio(origen, coords) {
  const t = (origen || '').toLowerCase();
  if (t.includes('aeropuerto') || t.includes('airport') || t.includes('lpa') || t.includes('gando')) return 'AEROPUERTO';
  const ZONAS = { 'maspalomas': 'San Bartolomé de Tirajana', 'playa del ingles': 'San Bartolomé de Tirajana', 'playa del inglés': 'San Bartolomé de Tirajana', 'meloneras': 'San Bartolomé de Tirajana', 'puerto rico': 'Mogán', 'arguineguin': 'Mogán', 'vecindario': 'Santa Lucía de Tirajana' };
  for (const z in ZONAS) if (t.includes(z)) return ZONAS[z];
  const MUNICIPIOS = ['Las Palmas de Gran Canaria', 'Telde', 'Santa Lucía de Tirajana', 'San Bartolomé de Tirajana', 'Mogán', 'Arucas', 'Gáldar', 'Agüimes', 'Ingenio'];
  for (const m of MUNICIPIOS) if (t.includes(m.toLowerCase())) return m;
  return null;
}

// =================== EMAIL BREVO ===================
function enviarEmailBrevo(payload) {
  return new Promise((resolve, reject) => {
    if (!BREVO_API_KEY) return reject(new Error('Falta BREVO_API_KEY'));
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve(data) : reject(new Error(`Brevo ${res.statusCode}: ${data}`)));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function enviarEmailConfirmacion(datos, reservaId, nombreConductor, numero) {
  if (!datos.correo || !BREVO_API_KEY) return;
  try {
    const idioma = ['es','en','de','fr','it','pt'].includes(datos.idioma) ? datos.idioma : 'es';
    const T = {
      es: { subject: 'Tu reserva de taxi ha sido confirmada', titulo: '✅ Tu reserva ha sido confirmada', hola: (n) => `Hola <strong>${n}</strong>, un conductor ha aceptado tu servicio.`, nRes: 'Nº de reserva:', cond: 'Tu conductor:', fecha: 'Fecha:', alas: 'a las', ori: 'Origen:', des: 'Destino:', pax: 'Pasajeros:' },
      en: { subject: 'Your taxi booking has been confirmed', titulo: '✅ Your booking has been confirmed', hola: (n) => `Hello <strong>${n}</strong>, a driver has accepted your service.`, nRes: 'Booking no.:', cond: 'Your driver:', fecha: 'Date:', alas: 'at', ori: 'Pickup:', des: 'Destination:', pax: 'Passengers:' },
      de: { subject: 'Ihre Taxibuchung wurde bestätigt', titulo: '✅ Ihre Buchung wurde bestätigt', hola: (n) => `Hallo <strong>${n}</strong>, ein Fahrer hat Ihren Service angenommen.`, nRes: 'Buchungsnr.:', cond: 'Ihr Fahrer:', fecha: 'Datum:', alas: 'um', ori: 'Abholort:', des: 'Zielort:', pax: 'Passagiere:' },
      fr: { subject: 'Votre réservation de taxi a été confirmée', titulo: '✅ Votre réservation a été confirmée', hola: (n) => `Bonjour <strong>${n}</strong>, un chauffeur a accepté votre course.`, nRes: 'N° de réservation:', cond: 'Votre chauffeur:', fecha: 'Date:', alas: 'à', ori: 'Départ:', des: 'Destination:', pax: 'Passagers:' },
      it: { subject: 'La tua prenotazione taxi è stata confermata', titulo: '✅ La tua prenotazione è confermata', hola: (n) => `Ciao <strong>${n}</strong>, un autista ha accettato il tuo servizio.`, nRes: 'N° prenotazione:', cond: 'Il tuo autista:', fecha: 'Data:', alas: 'alle', ori: 'Partenza:', des: 'Destinazione:', pax: 'Passeggeri:' },
      pt: { subject: 'A sua reserva de táxi foi confirmada', titulo: '✅ A sua reserva foi confirmada', hola: (n) => `Olá <strong>${n}</strong>, um motorista aceitou o seu serviço.`, nRes: 'Nº de reserva:', cond: 'O seu motorista:', fecha: 'Data:', alas: 'às', ori: 'Partida:', des: 'Destino:', pax: 'Passageiros:' }
    }[idioma];
    const base = process.env.BASE_URL || '';
    const cancelarHtml = (reservaId && base) ? `<div style="text-align:center;margin:16px 0;"><a href="${base}/cancelar?id=${reservaId}" style="display:inline-block;padding:12px 24px;background:#e05050;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;">Cancelar mi reserva</a></div>` : '';

    // Bloque especial si el origen es el aeropuerto
    const esOrigenAeropuerto = /aeropuerto|airport|lpa|gando/i.test(datos.origen || '');
    const aeropuertoInfo = {
      es: `<div style="background:#fff8e1;border:2px solid #f5c400;border-radius:10px;padding:18px;margin:16px 0;"><h3 style="color:#b8860b;margin:0 0 12px;font-size:16px;">📍 ¿Dónde encontrar a tu conductor?</h3><p style="margin:6px 0;font-size:14px;">🪧 <strong>Señal:</strong> Tu conductor llevará un cartel con tu nombre: <strong>${datos.nombre}</strong></p><div style="background:#fffde7;border-radius:8px;padding:12px;margin:10px 0;"><p style="margin:4px 0;font-size:14px;font-weight:bold;color:#7a6000;">✈️ Vuelo nacional</p><p style="margin:4px 0;font-size:13px;color:#7a6000;">Planta 0 — junto a la puerta de salida de la cinta de equipajes, frente al Café Pans</p></div><div style="background:#fffde7;border-radius:8px;padding:12px;margin:10px 0;"><p style="margin:4px 0;font-size:14px;font-weight:bold;color:#7a6000;">🌍 Vuelo internacional</p><p style="margin:4px 0;font-size:13px;color:#7a6000;">Planta 0 — junto al cajero ATM, a la salida de aduana</p></div><p style="margin:6px 0;font-size:14px;">⏱️ <strong>El conductor esperará</strong> hasta 60 minutos tras el aterrizaje</p><p style="margin:6px 0;font-size:14px;">📞 <strong>Si no lo encuentras:</strong> Llama al <strong>828 810 938</strong></p></div>`,
      en: `<div style="background:#fff8e1;border:2px solid #f5c400;border-radius:10px;padding:18px;margin:16px 0;"><h3 style="color:#b8860b;margin:0 0 12px;font-size:16px;">📍 Where to meet your driver?</h3><p style="margin:6px 0;font-size:14px;">🪧 <strong>Sign:</strong> Your driver will hold a sign with your name: <strong>${datos.nombre}</strong></p><div style="background:#fffde7;border-radius:8px;padding:12px;margin:10px 0;"><p style="margin:4px 0;font-size:14px;font-weight:bold;color:#7a6000;">✈️ Domestic flight</p><p style="margin:4px 0;font-size:13px;color:#7a6000;">Ground floor — next to the baggage claim exit door, in front of Café Pans</p></div><div style="background:#fffde7;border-radius:8px;padding:12px;margin:10px 0;"><p style="margin:4px 0;font-size:14px;font-weight:bold;color:#7a6000;">🌍 International flight</p><p style="margin:4px 0;font-size:13px;color:#7a6000;">Ground floor — next to the ATM, at the customs exit</p></div><p style="margin:6px 0;font-size:14px;">⏱️ <strong>Your driver will wait</strong> up to 60 minutes after landing</p><p style="margin:6px 0;font-size:14px;">📞 <strong>Can't find them?</strong> Call <strong>828 810 938</strong></p></div>`,
      de: `<div style="background:#fff8e1;border:2px solid #f5c400;border-radius:10px;padding:18px;margin:16px 0;"><h3 style="color:#b8860b;margin:0 0 12px;font-size:16px;">📍 Wo finden Sie Ihren Fahrer?</h3><p style="margin:6px 0;font-size:14px;">🪧 <strong>Schild:</strong> Ihr Fahrer hält ein Schild mit Ihrem Namen: <strong>${datos.nombre}</strong></p><div style="background:#fffde7;border-radius:8px;padding:12px;margin:10px 0;"><p style="margin:4px 0;font-size:14px;font-weight:bold;color:#7a6000;">✈️ Inlandsflug</p><p style="margin:4px 0;font-size:13px;color:#7a6000;">Erdgeschoss — neben dem Ausgang des Gepäckbandes, gegenüber dem Café Pans</p></div><div style="background:#fffde7;border-radius:8px;padding:12px;margin:10px 0;"><p style="margin:4px 0;font-size:14px;font-weight:bold;color:#7a6000;">🌍 Internationaler Flug</p><p style="margin:4px 0;font-size:13px;color:#7a6000;">Erdgeschoss — neben dem Geldautomaten, am Zollausgang</p></div><p style="margin:6px 0;font-size:14px;">⏱️ <strong>Ihr Fahrer wartet</strong> bis zu 60 Minuten nach der Landung</p><p style="margin:6px 0;font-size:14px;">📞 <strong>Nicht gefunden?</strong> Rufen Sie an: <strong>828 810 938</strong></p></div>`,
      fr: `<div style="background:#fff8e1;border:2px solid #f5c400;border-radius:10px;padding:18px;margin:16px 0;"><h3 style="color:#b8860b;margin:0 0 12px;font-size:16px;">📍 Où trouver votre chauffeur ?</h3><p style="margin:6px 0;font-size:14px;">🪧 <strong>Panneau :</strong> Votre chauffeur tiendra un panneau avec votre nom : <strong>${datos.nombre}</strong></p><div style="background:#fffde7;border-radius:8px;padding:12px;margin:10px 0;"><p style="margin:4px 0;font-size:14px;font-weight:bold;color:#7a6000;">✈️ Vol intérieur</p><p style="margin:4px 0;font-size:13px;color:#7a6000;">Rez-de-chaussée — à côté de la sortie du tapis de bagages, en face du Café Pans</p></div><div style="background:#fffde7;border-radius:8px;padding:12px;margin:10px 0;"><p style="margin:4px 0;font-size:14px;font-weight:bold;color:#7a6000;">🌍 Vol international</p><p style="margin:4px 0;font-size:13px;color:#7a6000;">Rez-de-chaussée — à côté du distributeur ATM, à la sortie de la douane</p></div><p style="margin:6px 0;font-size:14px;">⏱️ <strong>Votre chauffeur attendra</strong> jusqu'à 60 minutes après l'atterrissage</p><p style="margin:6px 0;font-size:14px;">📞 <strong>Introuvable ?</strong> Appelez le <strong>828 810 938</strong></p></div>`,
      it: `<div style="background:#fff8e1;border:2px solid #f5c400;border-radius:10px;padding:18px;margin:16px 0;"><h3 style="color:#b8860b;margin:0 0 12px;font-size:16px;">📍 Dove trovare il tuo autista?</h3><p style="margin:6px 0;font-size:14px;">🪧 <strong>Cartello:</strong> Il tuo autista terrà un cartello con il tuo nome: <strong>${datos.nombre}</strong></p><div style="background:#fffde7;border-radius:8px;padding:12px;margin:10px 0;"><p style="margin:4px 0;font-size:14px;font-weight:bold;color:#7a6000;">✈️ Volo nazionale</p><p style="margin:4px 0;font-size:13px;color:#7a6000;">Piano terra — vicino all'uscita del nastro bagagli, di fronte al Café Pans</p></div><div style="background:#fffde7;border-radius:8px;padding:12px;margin:10px 0;"><p style="margin:4px 0;font-size:14px;font-weight:bold;color:#7a6000;">🌍 Volo internazionale</p><p style="margin:4px 0;font-size:13px;color:#7a6000;">Piano terra — vicino al bancomat ATM, all'uscita della dogana</p></div><p style="margin:6px 0;font-size:14px;">⏱️ <strong>Il tuo autista aspetterà</strong> fino a 60 minuti dopo l'atterraggio</p><p style="margin:6px 0;font-size:14px;">📞 <strong>Non lo trovi?</strong> Chiama il <strong>828 810 938</strong></p></div>`,
      pt: `<div style="background:#fff8e1;border:2px solid #f5c400;border-radius:10px;padding:18px;margin:16px 0;"><h3 style="color:#b8860b;margin:0 0 12px;font-size:16px;">📍 Onde encontrar o seu motorista?</h3><p style="margin:6px 0;font-size:14px;">🪧 <strong>Placa:</strong> O seu motorista terá uma placa com o seu nome: <strong>${datos.nombre}</strong></p><div style="background:#fffde7;border-radius:8px;padding:12px;margin:10px 0;"><p style="margin:4px 0;font-size:14px;font-weight:bold;color:#7a6000;">✈️ Voo doméstico</p><p style="margin:4px 0;font-size:13px;color:#7a6000;">Rés do chão — junto à saída da cinta de bagagens, em frente ao Café Pans</p></div><div style="background:#fffde7;border-radius:8px;padding:12px;margin:10px 0;"><p style="margin:4px 0;font-size:14px;font-weight:bold;color:#7a6000;">🌍 Voo internacional</p><p style="margin:4px 0;font-size:13px;color:#7a6000;">Rés do chão — junto ao multibanco ATM, à saída da alfândega</p></div><p style="margin:6px 0;font-size:14px;">⏱️ <strong>O seu motorista aguardará</strong> até 60 minutos após a aterragem</p><p style="margin:6px 0;font-size:14px;">📞 <strong>Não o encontra?</strong> Ligue para <strong>828 810 938</strong></p></div>`
    };
    const bloqueAeropuerto = esOrigenAeropuerto ? (aeropuertoInfo[idioma] || aeropuertoInfo.es) : '';

    await enviarEmailBrevo({
      sender: { name: 'Reserva Taxi Las Palmas', email: 'reservadetaxilp@gmail.com' },
      to: [{ email: datos.correo, name: datos.nombre }],
      subject: T.subject,
      htmlContent: `<div style="font-family:Arial,sans-serif;padding:24px;background:#f9f9f9;max-width:600px;margin:0 auto;"><h2 style="color:#f5c400;background:#1a1a1a;padding:16px;border-radius:8px;">🚖 Reserva Taxi Las Palmas</h2><h3 style="color:#2d8a2d;">${T.titulo}</h3><p>${T.hola(datos.nombre)}</p><div style="background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;margin:16px 0;"><p>🎫 <strong>${T.nRes}</strong> ${numReserva(numero)}</p>${nombreConductor ? `<p>🚖 <strong>${T.cond}</strong> ${nombreConductor}</p>` : ''}<p>📅 <strong>${T.fecha}</strong> ${datos.fecha} ${T.alas} ${datos.hora}</p><p>📍 <strong>${T.ori}</strong> ${datos.origen}</p><p>🏁 <strong>${T.des}</strong> ${datos.destino}</p><p>👥 <strong>${T.pax}</strong> ${datos.pasajeros}</p>${datos.precioEstimado ? `<p>💰 <strong>Precio estimado:</strong> ${datos.precioEstimado}€</p>` : ''}</div>${bloqueAeropuerto}${cancelarHtml}<p>📞 Consultas: <strong>828 810 938</strong></p><p>✉️ reservas@taxilaspalmasdegrancanaria.com</p></div>`
    });
    console.log('Email confirmacion enviado a:', datos.correo);
  } catch(e) { console.error('Error email confirmacion:', e.message); }
}

async function enviarEmailCancelacion(datos, numero, motivo) {
  if (!datos.correo || !BREVO_API_KEY) return;
  try {
    const idioma = ['es','en','de','fr','it','pt'].includes(datos.idioma) ? datos.idioma : 'es';
    const T = {
      es: { subject: 'Tu reserva de taxi ha sido cancelada', titulo: '❌ Reserva cancelada', hola: (n) => `Hola <strong>${n}</strong>, tu reserva ha sido cancelada.`, nRes: 'Nº reserva:', fecha: 'Fecha:', alas: 'a las', ori: 'Origen:', des: 'Destino:', motLbl: 'Motivo:' },
      en: { subject: 'Your taxi booking has been cancelled', titulo: '❌ Booking cancelled', hola: (n) => `Hello <strong>${n}</strong>, your booking has been cancelled.`, nRes: 'Booking no.:', fecha: 'Date:', alas: 'at', ori: 'Pickup:', des: 'Destination:', motLbl: 'Reason:' },
      de: { subject: 'Ihre Taxibuchung wurde storniert', titulo: '❌ Buchung storniert', hola: (n) => `Hallo <strong>${n}</strong>, Ihre Buchung wurde storniert.`, nRes: 'Buchungsnr.:', fecha: 'Datum:', alas: 'um', ori: 'Abholort:', des: 'Zielort:', motLbl: 'Grund:' },
      fr: { subject: 'Votre réservation de taxi a été annulée', titulo: '❌ Réservation annulée', hola: (n) => `Bonjour <strong>${n}</strong>, votre réservation a été annulée.`, nRes: 'N° réservation:', fecha: 'Date:', alas: 'à', ori: 'Départ:', des: 'Destination:', motLbl: 'Motif:' },
      it: { subject: 'La tua prenotazione taxi è stata annullata', titulo: '❌ Prenotazione annullata', hola: (n) => `Ciao <strong>${n}</strong>, la tua prenotazione è stata annullata.`, nRes: 'N° prenotazione:', fecha: 'Data:', alas: 'alle', ori: 'Partenza:', des: 'Destinazione:', motLbl: 'Motivo:' },
      pt: { subject: 'A sua reserva de táxi foi cancelada', titulo: '❌ Reserva cancelada', hola: (n) => `Olá <strong>${n}</strong>, a sua reserva foi cancelada.`, nRes: 'Nº reserva:', fecha: 'Data:', alas: 'às', ori: 'Partida:', des: 'Destino:', motLbl: 'Motivo:' }
    }[idioma];
    await enviarEmailBrevo({
      sender: { name: 'Reserva Taxi Las Palmas', email: 'reservadetaxilp@gmail.com' },
      to: [{ email: datos.correo, name: datos.nombre }],
      subject: T.subject,
      htmlContent: `<div style="font-family:Arial,sans-serif;padding:24px;background:#f9f9f9;max-width:600px;margin:0 auto;"><h2 style="color:#f5c400;background:#1a1a1a;padding:16px;border-radius:8px;">🚖 Reserva Taxi Las Palmas</h2><h3 style="color:#e23b3b;">${T.titulo}</h3><p>${T.hola(datos.nombre)}</p><div style="background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;margin:16px 0;">${numero ? `<p><strong>${T.nRes}</strong> ${numReserva(numero)}</p>` : ''}<p><strong>${T.fecha}</strong> ${datos.fecha} ${T.alas} ${datos.hora}</p><p><strong>${T.ori}</strong> ${datos.origen}</p><p><strong>${T.des}</strong> ${datos.destino}</p>${motivo ? `<p><strong>${T.motLbl}</strong> ${motivo}</p>` : ''}</div><p>📞 <strong>828 810 938</strong></p><p>✉️ reservas@taxilaspalmasdegrancanaria.com</p></div>`
    });
    console.log('Email cancelacion enviado a:', datos.correo);
  } catch(e) { console.error('Error email cancelacion:', e.message); }
}

async function enviarEmailRecordatorio(reserva) {
  if (!reserva.datos?.correo || !BREVO_API_KEY) return;
  try {
    await enviarEmailBrevo({
      sender: { name: 'Reserva Taxi Las Palmas', email: 'reservadetaxilp@gmail.com' },
      to: [{ email: reserva.datos.correo, name: reserva.datos.nombre }],
      subject: 'Recordatorio: tu taxi llega en 1 hora',
      htmlContent: `<div style="font-family:Arial,sans-serif;padding:24px;background:#f9f9f9;max-width:600px;margin:0 auto;"><h2 style="color:#f5c400;background:#1a1a1a;padding:16px;border-radius:8px;">🚖 Reserva Taxi Las Palmas</h2><h3 style="color:#2d8a2d;">⏰ Tu taxi llega en 1 hora</h3><p>Hola <strong>${reserva.datos.nombre}</strong>, te recordamos tu recogida:</p><div style="background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;margin:16px 0;"><p>🎫 <strong>Nº reserva:</strong> ${numReserva(reserva.numero)}</p>${reserva.conductorNombre ? `<p>🚖 <strong>Tu conductor:</strong> ${reserva.conductorNombre}</p>` : ''}<p>📅 <strong>Fecha:</strong> ${reserva.datos.fecha} a las ${reserva.datos.hora}</p><p>📍 <strong>Origen:</strong> ${reserva.datos.origen}</p><p>🏁 <strong>Destino:</strong> ${reserva.datos.destino}</p></div><p>📞 <strong>828 810 938</strong></p></div>`
    });
  } catch(e) { console.error('Error email recordatorio:', e.message); }
}

async function enviarCodigoVerificacion(email, nombre, codigo) {
  if (!BREVO_API_KEY) return;
  try {
    await enviarEmailBrevo({
      sender: { name: 'Reserva Taxi Las Palmas', email: 'reservadetaxilp@gmail.com' },
      to: [{ email, name: nombre }],
      subject: 'Código de verificación — App Conductores',
      htmlContent: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#111;color:#f0f0f0;border-radius:12px;padding:32px"><h2 style="color:#f5c400;margin:0 0 16px">🚖 Reserva Taxi Las Palmas</h2><p>Hola <strong>${nombre}</strong>, tu código de verificación es:</p><div style="font-size:42px;font-weight:bold;color:#f5c400;text-align:center;letter-spacing:12px;margin:24px 0">${codigo}</div><p style="color:#aaa;font-size:13px">Este código expira en 30 minutos.</p></div>`
    });
  } catch(e) { console.error('Error email codigo:', e.message); }
}

async function enviarEmailCopiaNuevaReserva(datos, numero) {
  if (!BREVO_API_KEY) return;
  try {
    await enviarEmailBrevo({
      sender: { name: 'Reserva Taxi Las Palmas', email: 'reservadetaxilp@gmail.com' },
      to: [{ email: 'yeraygonzalezmiranda@gmail.com', name: 'Yeray' }],
      subject: `🆕 Nueva reserva ${numReserva(numero)} — ${datos.fecha} ${datos.hora}`,
      htmlContent: `<div style="font-family:Arial,sans-serif;padding:24px;background:#f9f9f9;max-width:600px;margin:0 auto;"><h2 style="color:#f5c400;background:#1a1a1a;padding:16px;border-radius:8px;">🚖 Nueva reserva recibida</h2><div style="background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;margin:16px 0;"><p>🎫 <strong>Nº reserva:</strong> ${numReserva(numero)}</p><p>👤 <strong>Cliente:</strong> ${datos.nombre || '—'}</p><p>📞 <strong>Teléfono:</strong> ${datos.telefono || '—'}</p><p>✉️ <strong>Correo:</strong> ${datos.correo || '—'}</p><p>📅 <strong>Fecha:</strong> ${datos.fecha} a las ${datos.hora}</p><p>📍 <strong>Origen:</strong> ${datos.origen}</p><p>🏁 <strong>Destino:</strong> ${datos.destino}</p><p>👥 <strong>Pasajeros:</strong> ${datos.pasajeros}</p>${datos.vuelo ? `<p>✈️ <strong>Nº de vuelo:</strong> ${datos.vuelo}</p>` : ''}${datos.pasaporte ? `<p>🛂 <strong>Pasaporte/doc.:</strong> ${datos.pasaporte}</p>` : ''}${datos.precioEstimado ? `<p>💰 <strong>Precio estimado:</strong> ${datos.precioEstimado}€</p>` : ''}${datos.observaciones ? `<p>💬 <strong>Observaciones:</strong> ${datos.observaciones}</p>` : ''}</div></div>`
    });
    console.log(`✅ Email copia enviado para reserva ${numReserva(numero)}`);
  } catch(e) { console.error('Error email copia nueva reserva:', e.message, e.stack ? e.stack.split('\n')[1] : ''); }
}

async function enviarEmailConductorServicioAsignado(conductor, reserva) {
  if (!conductor.email || !BREVO_API_KEY) return;
  try {
    const d = reserva.datos;
    const reservaId = reserva._id;
    const base = process.env.APP_URL || 'https://reservataxilaspalmas.com';
    const sillasTexto = Array.isArray(d.sillas) && d.sillas.length ? d.sillas.join(', ') : '';
    await enviarEmailBrevo({
      sender: { name: 'Reserva Taxi Las Palmas', email: 'reservadetaxilp@gmail.com' },
      to: [{ email: conductor.email, name: conductor.nombre }],
      subject: `🚖 Servicio asignado ${numReserva(reserva.numero)} — ${d.fecha} ${d.hora}`,
      htmlContent: `
        <div style="font-family:Arial,sans-serif;padding:24px;background:#f9f9f9;max-width:600px;margin:0 auto;">
          <h2 style="color:#f5c400;background:#1a1a1a;padding:16px;border-radius:8px;">🚖 Reserva Taxi Las Palmas</h2>
          <h3 style="color:#1a1d29;">Hola <strong>${conductor.nombre}</strong>, tienes un servicio asignado.</h3>
          <div style="background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;margin:16px 0;">
            <p>🎫 <strong>Nº reserva:</strong> ${numReserva(reserva.numero)}</p>
            <p>👤 <strong>Cliente:</strong> ${d.nombre || '—'}</p>
            <p>📅 <strong>Fecha:</strong> ${d.fecha} a las ${d.hora}</p>
            <p>📍 <strong>Origen:</strong> ${d.origen}</p>
            <p>🏁 <strong>Destino:</strong> ${d.destino}</p>
            <p>👥 <strong>Pasajeros:</strong> ${d.pasajeros}</p>
            ${d.vuelo ? `<p>✈️ <strong>Nº de vuelo:</strong> ${d.vuelo}</p>` : ''}
            ${d.pasaporte ? `<p>🛂 <strong>Pasaporte/doc.:</strong> ${d.pasaporte}</p>` : ''}
            ${sillasTexto ? `<p>🧒 <strong>Sillas infantiles:</strong> ${sillasTexto}</p>` : ''}
            ${d.precioEstimado ? `<p>💰 <strong>Precio estimado:</strong> ${d.precioEstimado}€</p>` : ''}
            ${d.observaciones ? `<p>💬 <strong>Observaciones:</strong> ${d.observaciones}</p>` : ''}
          </div>
          <div style="text-align:center;margin:20px 0;">
            <a href="${base}/conductores.html" style="display:inline-block;padding:14px 28px;background:#f5b800;color:#1a1a1a;border-radius:10px;text-decoration:none;font-weight:bold;font-size:15px;margin-bottom:10px;">📱 Abrir app de conductor</a>
          </div>
          <p style="text-align:center;font-size:13px;color:#888;">Gestiona el servicio desde la app: voy en camino → cliente recogido → finalizar</p>
          <p style="margin-top:16px;">📞 Consultas: <strong>828 810 938</strong></p>
        </div>`
    });
    console.log(`✅ Email conductor enviado a ${conductor.email} para reserva ${numReserva(reserva.numero)}`);
  } catch(e) { console.error('Error email conductor asignado:', e.message); }
}
const conductorSchema = new mongoose.Schema({
  chatId: { type: String, unique: true },
  nombre: String, licencia: String, telefono: String, email: String,
  password: String, plaza: String, matricula: String, matriculaEU: String,
  codigoVerificacion: String, codigoExpira: Date,
  aprobado: { type: Boolean, default: false },
  activo: { type: Boolean, default: true },
  comisionPorcentaje: { type: Number, default: 10 },
  penalizadoHasta: Date,
  fechaRegistro: { type: Date, default: Date.now }
});

const reservaSchema = new mongoose.Schema({
  numero: Number,
  datos: Object,
  // estados: pendiente|asignada|en_camino|recogido|completada|cancelada
  estado: { type: String, default: 'pendiente' },
  conductorAsignado: String,
  conductorNombre: String,
  eventoCalendarioId: String,
  recordatorioEnviado: { type: Boolean, default: false },
  recordatorioClienteEnviado: { type: Boolean, default: false },
  avisoSinAceptarEnviado: { type: Boolean, default: false },
  ubicacionLat: Number,
  ubicacionLng: Number,
  ultimaUbicacion: Date,
  fechaServicio: Date,
  fechaCreacion: { type: Date, default: Date.now }
});

const contadorSchema = new mongoose.Schema({ nombre: { type: String, unique: true }, valor: { type: Number, default: 0 } });

const festivoSchema = new mongoose.Schema({
  fecha: { type: String, unique: true },
  descripcion: String,
  // tipo: 'festivo' | 'festivo_plus' | 'sin_servicio'
  tipo: { type: String, default: 'festivo' },
  suplementoPlus: { type: Number, default: 0 },
  // Para tipo 'sin_servicio': si horaInicio/horaFin están vacíos, se bloquea el día completo (24h).
  // Si tienen valor (formato "HH:MM"), solo se bloquea ese rango horario dentro del día.
  horaInicio: { type: String, default: '' },
  horaFin: { type: String, default: '' }
});

const tarifaSchema = new mongoose.Schema({
  nombre: { type: String, unique: true },
  valor: Number,
  descripcion: String
});

const vehiculoSchema = new mongoose.Schema({
  nombre: String,
  descripcion: String,
  plazas: { type: Number, default: 4 },
  maletasGrandes: { type: Number, default: 2 },
  maletasPequenas: { type: Number, default: 2 },
  suplemento: { type: Number, default: 0 },
  foto: { type: String, default: '' }, // base64 o URL
  activo: { type: Boolean, default: true },
  orden: { type: Number, default: 0 },
  fechaCreacion: { type: Date, default: Date.now }
});

const comisionSchema = new mongoose.Schema({
  conductorId: String, conductorNombre: String,
  reservaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Reserva' },
  precioCarrera: Number, comision: Number, mes: String,
  pagada: { type: Boolean, default: false },
  fechaCreacion: { type: Date, default: Date.now }
});

const configSchema = new mongoose.Schema({ nombre: { type: String, unique: true }, valor: Number });


const Conductor = mongoose.model('Conductor', conductorSchema);

const pushSubSchema = new mongoose.Schema({
  // destinatario: 'admin' o el _id del conductor (string)
  destinatario: { type: String, required: true },
  endpoint: { type: String, required: true, unique: true },
  keys: { p256dh: String, auth: String },
  fechaCreacion: { type: Date, default: Date.now }
});
const PushSub = mongoose.model('PushSub', pushSubSchema);

async function enviarPushA(destinatario, payload) {
  if (!pushDisponible) return;
  try {
    const subs = await PushSub.find({ destinatario });
    const datos = JSON.stringify(payload);
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, datos);
      } catch(e) {
        // Suscripción caducada o inválida (410/404): la borramos para no reintentar en vano.
        if (e.statusCode === 410 || e.statusCode === 404) {
          PushSub.deleteOne({ endpoint: s.endpoint }).catch(()=>{});
        } else {
          console.error('Error enviando push a', destinatario, ':', e.message);
        }
      }
    }
  } catch(e) { console.error('Error enviarPushA:', e.message); }
}
async function enviarPushATodosConductores(payload) {
  if (!pushDisponible) return;
  try {
    const subs = await PushSub.find({ destinatario: { $ne: 'admin' } });
    const datos = JSON.stringify(payload);
    for (const s of subs) {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, datos); }
      catch(e) { if (e.statusCode === 410 || e.statusCode === 404) PushSub.deleteOne({ endpoint: s.endpoint }).catch(()=>{}); }
    }
  } catch(e) { console.error('Error enviarPushATodosConductores:', e.message); }
}
const Reserva = mongoose.model('Reserva', reservaSchema);
const Contador = mongoose.model('Contador', contadorSchema);
const Festivo = mongoose.model('Festivo', festivoSchema);
const Comision = mongoose.model('Comision', comisionSchema);
const Config = mongoose.model('Config', configSchema);
const Tarifa = mongoose.model('Tarifa', tarifaSchema);
const Vehiculo = mongoose.model('Vehiculo', vehiculoSchema);


async function siguienteNumeroReserva() {
  const c = await Contador.findOneAndUpdate({ nombre: 'reserva' }, { $inc: { valor: 1 } }, { new: true, upsert: true });
  return c.valor;
}

async function cargarConfig() {
  try {
    const ant = await Config.findOne({ nombre: 'antelacion' });
    const can = await Config.findOne({ nombre: 'cancelacion' });
    const pri = await Config.findOne({ nombre: 'prioridadMinutos' });
    cacheConfig.antelacion = ant ? ant.valor : 2;
    cacheConfig.cancelacion = can ? can.valor : 0.5;
    cacheConfig.prioridadMinutos = pri ? pri.valor : 2;
  } catch(e) {}
}

async function cargarFestivos() {
  const count = await Festivo.countDocuments();
  if (count === 0) {
    await Festivo.insertMany([
      { fecha: '2026-01-01', descripcion: 'Año Nuevo' }, { fecha: '2026-01-06', descripcion: 'Reyes' },
      { fecha: '2026-04-02', descripcion: 'Jueves Santo' }, { fecha: '2026-04-03', descripcion: 'Viernes Santo' },
      { fecha: '2026-05-01', descripcion: 'Día del Trabajo' }, { fecha: '2026-05-30', descripcion: 'Día de Canarias' },
      { fecha: '2026-08-15', descripcion: 'Asunción' }, { fecha: '2026-10-12', descripcion: 'Fiesta Nacional' },
      { fecha: '2026-11-01', descripcion: 'Todos los Santos' }, { fecha: '2026-12-06', descripcion: 'Constitución' },
      { fecha: '2026-12-08', descripcion: 'Inmaculada' }, { fecha: '2026-12-25', descripcion: 'Navidad' }
    ]);
    console.log('Festivos iniciales cargados');
  }
}

// =================== MONGODB ===================
async function cargarTarifas() {
  const count = await Tarifa.countDocuments();
  if (count === 0) {
    await Tarifa.insertMany([
      { nombre: 'diurna_bajada', valor: 3.85, descripcion: 'Bajada de bandera diurna (06:00–21:59)' },
      { nombre: 'diurna_km', valor: 1.35, descripcion: 'Precio por km diurno' },
      { nombre: 'diurna_aeropuerto', valor: 2.10, descripcion: 'Suplemento aeropuerto (diurno)' },
      { nombre: 'nocturna_bajada', valor: 4.25, descripcion: 'Bajada de bandera nocturna/festiva (22:00–05:59 + dom + festivos)' },
      { nombre: 'nocturna_km', valor: 1.55, descripcion: 'Precio por km nocturno/festivo' },
      { nombre: 'nocturna_aeropuerto', valor: 2.10, descripcion: 'Suplemento aeropuerto (nocturno/festivo)' },
      { nombre: 'silla_grupo0', valor: 0, descripcion: 'Silla Grupo 0 (0–13kg)' },
      { nombre: 'silla_grupo1', valor: 0, descripcion: 'Silla Grupo 1 (9–18kg)' },
      { nombre: 'silla_grupo2', valor: 0, descripcion: 'Silla Grupo 2 (15–25kg)' },
      { nombre: 'silla_grupo3', valor: 0, descripcion: 'Silla Grupo 3 (22–36kg)' },
      { nombre: 'silla_alzador', valor: 0, descripcion: 'Alzador (22–36kg)' }
    ]);
    console.log('Tarifas iniciales cargadas');
  }
}

mongoose.connect(MONGODB_URI).then(async () => {
  console.log('MongoDB conectado');
  await cargarConfig();
  await cargarFestivos();
  await cargarTarifas();
  iniciarRecordatorios();
  iniciarResumenMensual();
}).catch(e => console.error('Error MongoDB:', e));

// =================== EXPRESS ===================
const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// =================== AUTH MIDDLEWARES ===================
function authAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    const dec = jwt.verify(token, JWT_SECRET);
    if (dec.role !== 'admin') return res.status(403).json({ error: 'No es admin' });
    req.admin = dec;
    next();
  } catch(e) { res.status(401).json({ error: 'Token inválido' }); }
}

function authConductor(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.conductor = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) { res.status(401).json({ error: 'Token inválido' }); }
}

const noCache = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
};
app.get('/', noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'reservar.html')));
app.get('/reservar', noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'reservar.html')));
app.get('/admin', noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/conductores', noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'conductores.html')));
app.get('/seguimiento', noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'seguimiento.html')));

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY, disponible: pushDisponible });
});

app.post('/api/admin/push/suscribir', authAdmin, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Suscripción inválida' });
    await PushSub.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      { destinatario: 'admin', endpoint: subscription.endpoint, keys: subscription.keys },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/conductores/push/suscribir', authConductor, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Suscripción inválida' });
    await PushSub.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      { destinatario: req.conductor.id, endpoint: subscription.endpoint, keys: subscription.keys },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/push/desuscribir', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) await PushSub.deleteOne({ endpoint });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.get('/config-publica', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.json({ antelacionHoras: cacheConfig.antelacion, antelacionTexto: horasATexto(cacheConfig.antelacion), telefono: '828 810 938' });
});

async function calcularPrecioConTarifas(distanciaKm, fecha, hora, esAeropuerto, sillas, vehiculoId) {
  const tarifas = await Tarifa.find();
  const T = {};
  tarifas.forEach(t => T[t.nombre] = t.valor);

  const fechaDate = new Date(`${fecha}T${hora}:00`);
  const horaNum = parseInt(hora.split(':')[0]) * 100 + parseInt(hora.split(':')[1]);
  const diaSemana = fechaDate.getDay();
  const esNoche = horaNum >= 2200 || horaNum < 600;
  const esDomingo = diaSemana === 0;

  const festivoDoc = await Festivo.findOne({ fecha });
  const esFestivo = !!festivoDoc && festivoDoc.tipo !== 'sin_servicio';
  const esFestivoPlus = festivoDoc?.tipo === 'festivo_plus';
  const suplementoPlus = esFestivoPlus ? (festivoDoc.suplementoPlus || 0) : 0;

  let tipo = 'diurna';
  if (esNoche || esDomingo || esFestivo) tipo = 'nocturna';
  if (esFestivoPlus) tipo = 'festivo_plus';

  const bajada = tipo === 'diurna' ? T.diurna_bajada : T.nocturna_bajada;
  const precioKm = tipo === 'diurna' ? T.diurna_km : T.nocturna_km;
  const suplementoAeropuerto = esAeropuerto ? (tipo === 'diurna' ? T.diurna_aeropuerto : T.nocturna_aeropuerto) : 0;

  let suplementoSillas = 0;
  const sillaMap = { 'Grupo 0': T.silla_grupo0, 'Grupo 1': T.silla_grupo1, 'Grupo 2': T.silla_grupo2, 'Grupo 3': T.silla_grupo3, 'Alzador': T.silla_alzador };
  if (sillas && Array.isArray(sillas)) {
    sillas.forEach(s => {
      const key = Object.keys(sillaMap).find(k => s.includes(k));
      if (key) suplementoSillas += sillaMap[key] || 0;
    });
  }

  let suplementoVehiculo = 0;
  let nombreVehiculo = '';
  if (vehiculoId) {
    try {
      const veh = await Vehiculo.findById(vehiculoId);
      if (veh) { suplementoVehiculo = veh.suplemento || 0; nombreVehiculo = veh.nombre; }
    } catch(e) {}
  }

  const subtotal = bajada + (distanciaKm * precioKm) + suplementoAeropuerto + suplementoSillas + suplementoPlus + suplementoVehiculo;
  const precioBruto = Math.max(subtotal, bajada);
  const precio = (Math.round(precioBruto / 0.05) * 0.05).toFixed(2);
  return { precio, tipo, bajada, precioKm, suplementoAeropuerto, suplementoSillas, suplementoPlus, suplementoVehiculo, nombreVehiculo };
}

app.post('/calcular-tarifa', async (req, res) => {
  try {
    const { fecha, hora, origenCoords, destinoCoords, sillas, vehiculoId, esAdmin } = req.body;
    if (!origenCoords || !destinoCoords || !GOOGLE_MAPS_KEY)
      return res.json({ ok: false, error: 'Faltan coordenadas o clave Maps' });

    if (!esAdmin) {
      const bloqueo = await comprobarDiaBloqueado(fecha, hora);
      if (bloqueo) return res.json({ ok: false, error: bloqueo });
    }

    // Obtener distancia de Google Maps usando Directions API con alternativas para elegir la más corta
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origenCoords}&destination=${destinoCoords}&mode=driving&alternatives=true&key=${GOOGLE_MAPS_KEY}`;
    const mapsRes = await new Promise((resolve, reject) => {
      https.get(url, (r) => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
    if (!mapsRes.routes || mapsRes.routes.length === 0) return res.json({ ok: false, error: 'No se pudo calcular la ruta' });
    // Elegir la ruta con MENOS kilómetros entre todas las alternativas
    const rutaMasCorta = mapsRes.routes.reduce((min, ruta) => {
      const dist = ruta.legs.reduce((s, l) => s + l.distance.value, 0);
      return dist < min.distancia ? { distancia: dist, ruta } : min;
    }, { distancia: Infinity, ruta: null }).ruta;
    const distanciaKmBruta = rutaMasCorta.legs.reduce((s, l) => s + l.distance.value, 0) / 1000;
    const REDUCCION_KM = 1.5;
    const distanciaKm = Math.max(0, distanciaKmBruta - REDUCCION_KM);
    console.log(`[DISTANCIA] Rutas disponibles: ${mapsRes.routes.length} → Más corta: ${distanciaKmBruta.toFixed(2)} km → Tras reducción: ${distanciaKm.toFixed(2)} km`);

    const DISTANCIA_MINIMA_KM = 10;
    if (!esAdmin && distanciaKm < DISTANCIA_MINIMA_KM) {
      return res.json({ ok: false, error: 'El servicio que usted intenta solicitar pertenece al servicio de taxi urbano de su municipio. Nuestra compañía es un servicio de taxi interurbano.', distanciaKm: parseFloat(distanciaKm.toFixed(1)) });
    }

    const { precio, tipo, bajada, precioKm, suplementoAeropuerto, suplementoSillas, suplementoPlus, suplementoVehiculo, nombreVehiculo } = await calcularPrecioConTarifas(distanciaKm, fecha, hora, req.body.esAeropuerto, sillas, vehiculoId);

    res.json({
      ok: true,
      precio: parseFloat(precio),
      distanciaKm: distanciaKm.toFixed(1),
      tipo,
      bajada,
      precioKm,
      suplementoAeropuerto,
      suplementoSillas,
      suplementoPlus,
      suplementoVehiculo,
      vehiculoNombre: nombreVehiculo,
      desglose: {
        bajada,
        km: `${distanciaKm.toFixed(1)} km × ${precioKm}€ = ${(distanciaKm * precioKm).toFixed(2)}€`,
        aeropuerto: suplementoAeropuerto,
        sillas: suplementoSillas,
        plus: suplementoPlus,
        vehiculo: suplementoVehiculo
      }
    });
  } catch(e) { console.error('Error calcular-tarifa:', e.message); res.status(500).json({ ok: false }); }
});


app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Contraseña incorrecta' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ ok: true, token });
});

// =================== RESERVA PÚBLICA ===================
app.post('/reserva', async (req, res) => {
  try {
    const data = req.body;
    if (!cumpleAntelacion(data.fecha, data.hora))
      return res.json({ ok: false, error: `Mínimo ${horasATexto(cacheConfig.antelacion)} de antelación. Consultas: 828 810 938.` });
    const bloqueo = await comprobarDiaBloqueado(data.fecha, data.hora);
    if (bloqueo) return res.json({ ok: false, error: bloqueo });
    let fechaServicio = null;
    try { fechaServicio = new Date(`${data.fecha}T${data.hora}:00`); } catch(e) {}
    try { data.municipio = await detectarMunicipio(data.origen, data.origenCoords); } catch(e) {}
    const numero = await siguienteNumeroReserva();
    const reserva = await Reserva.create({ numero, datos: data, fechaServicio });
    notificarAdmin({ tipo: 'nueva_reserva', numero: numReserva(numero), fecha: data.fecha, hora: data.hora, origen: data.origen, destino: data.destino, pasajeros: data.pasajeros, precio: data.precioEstimado, cliente: data.nombre });
    notificarConductores({ tipo: 'nueva_reserva', numero: numReserva(numero), fecha: data.fecha, hora: data.hora, destino: data.destino, pasajeros: data.pasajeros, precio: data.precioEstimado });
    enviarEmailCopiaNuevaReserva(data, numero).catch(()=>{});

    let numeroVuelta = null, reservaVueltaId = null;
    if (data.tipoTrayecto === 'idavuelta' && data.fechaVuelta && data.horaVuelta && data.origenVuelta && data.destinoVuelta) {
      try {
        const distanciaKmIda = parseFloat(data.distanciaKmIda) || null;
        if (distanciaKmIda) {
          const esAeropuertoVuelta = /aeropuerto|airport|lpa|gando/i.test(data.origenVuelta) || /aeropuerto|airport|lpa|gando/i.test(data.destinoVuelta);
          const calc = await calcularPrecioConTarifas(distanciaKmIda, data.fechaVuelta, data.horaVuelta, esAeropuertoVuelta, data.sillas, data.vehiculoId);
          const datosVuelta = {
            ...data,
            origen: data.origenVuelta, destino: data.destinoVuelta,
            fecha: data.fechaVuelta, hora: data.horaVuelta,
            vuelo: data.vueloVuelta || '', pasaporte: data.pasaporteVuelta || '',
            precioEstimado: parseFloat(calc.precio), tarifaTipo: calc.tipo,
            tipoTrayecto: 'idavuelta', esViajeDeVuelta: true, reservaIdaNumero: numero
          };
          let fechaServicioVuelta = null;
          try { fechaServicioVuelta = new Date(`${data.fechaVuelta}T${data.horaVuelta}:00`); } catch(e) {}
          numeroVuelta = await siguienteNumeroReserva();
          const reservaVuelta = await Reserva.create({ numero: numeroVuelta, datos: datosVuelta, fechaServicio: fechaServicioVuelta });
          reservaVueltaId = reservaVuelta._id;
          notificarAdmin({ tipo: 'nueva_reserva', numero: numReserva(numeroVuelta), fecha: datosVuelta.fecha, hora: datosVuelta.hora, origen: datosVuelta.origen, destino: datosVuelta.destino, pasajeros: datosVuelta.pasajeros, precio: datosVuelta.precioEstimado, cliente: datosVuelta.nombre });
          notificarConductores({ tipo: 'nueva_reserva', numero: numReserva(numeroVuelta), fecha: datosVuelta.fecha, hora: datosVuelta.hora, destino: datosVuelta.destino, pasajeros: datosVuelta.pasajeros, precio: datosVuelta.precioEstimado });
          enviarEmailCopiaNuevaReserva(datosVuelta, numeroVuelta).catch(()=>{});
        }
      } catch(e) { console.error('Error creando reserva de vuelta:', e.message); }
    }

    res.json({ ok: true, reservaId: reserva._id, reservaVueltaId, numeroVuelta: numeroVuelta ? numReserva(numeroVuelta) : null });
  } catch(e) { console.error('Error /reserva:', e.message); res.status(500).json({ ok: false, error: 'Error interno' }); }
});

// =================== ADMIN RESERVAS ===================
app.post('/api/admin/nueva-reserva', authAdmin, async (req, res) => {
  try {
    const data = req.body;
    if (!data.nombre || !data.fecha || !data.hora || !data.origen || !data.destino || !data.pasajeros)
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    if (!cumpleAntelacion(data.fecha, data.hora))
      return res.status(400).json({ error: `Mínimo ${horasATexto(cacheConfig.antelacion)} de antelación.` });
    let fechaServicio = null;
    try { fechaServicio = new Date(`${data.fecha}T${data.hora}:00`); } catch(e) {}
    try { data.municipio = await detectarMunicipio(data.origen, null); } catch(e) {}
    const numero = await siguienteNumeroReserva();
    const reserva = await Reserva.create({ numero, datos: data, fechaServicio });
    try { const eid = await crearEventoCalendario(reserva, null); if (eid) { reserva.eventoCalendarioId = eid; await reserva.save(); } } catch(e) {}
    notificarAdmin({ tipo: 'nueva_reserva', numero: numReserva(numero), fecha: data.fecha, hora: data.hora, origen: data.origen, destino: data.destino, pasajeros: data.pasajeros, precio: data.precioEstimado || null, cliente: data.nombre });
    notificarConductores({ tipo: 'nueva_reserva', numero: numReserva(numero), fecha: data.fecha, hora: data.hora, destino: data.destino, pasajeros: data.pasajeros, precio: data.precioEstimado || null });
    enviarEmailCopiaNuevaReserva(data, numero).catch(()=>{});
    res.json({ ok: true, numero: numReserva(numero), id: reserva._id });
  } catch(e) { console.error('Error nueva-reserva:', e.message); res.status(500).json({ error: 'Error interno' }); }
});

app.get('/api/admin/reservas', authAdmin, async (req, res) => {
  try {
    const { estado } = req.query;
    const filtro = estado && estado !== 'todas' ? { estado } : {};
    const reservas = await Reserva.find(filtro).sort({ fechaCreacion: -1 }).limit(100);
    res.json(reservas.map(r => ({
      id: r._id.toString(), numero: numReserva(r.numero), estado: r.estado,
      fecha: r.datos.fecha, hora: r.datos.hora, origen: r.datos.origen, destino: r.datos.destino,
      pasajeros: r.datos.pasajeros, precio: r.datos.precioEstimado,
      cliente: r.datos.nombre, telefono: r.datos.telefono, correo: r.datos.correo,
      notas: r.datos.observaciones, vuelo: r.datos.vuelo, pasaporte: r.datos.pasaporte,
      conductor: r.conductorNombre || null, fechaCreacion: r.fechaCreacion
    })));
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/admin/cancelar/:id', authAdmin, async (req, res) => {
  try {
    const reserva = await Reserva.findById(req.params.id);
    if (!reserva) return res.status(404).json({ error: 'No encontrada' });
    const motivo = req.body?.motivo || null;
    const conductorAnterior = reserva.conductorAsignado;
    reserva.estado = 'cancelada';
    await reserva.save();
    await Comision.deleteMany({ reservaId: reserva._id, pagada: false });
    await borrarEventoCalendario(reserva.eventoCalendarioId);
    notificarAdmin({ tipo: 'reserva_cancelada', numero: numReserva(reserva.numero), fecha: reserva.datos.fecha, hora: reserva.datos.hora, motivo });
    if (conductorAnterior) notificarConductores({ tipo: 'reserva_cancelada', numero: numReserva(reserva.numero), fecha: reserva.datos.fecha, hora: reserva.datos.hora, origen: reserva.datos.origen }, conductorAnterior);
    try { await enviarEmailCancelacion(reserva.datos, reserva.numero, motivo); } catch(e) {}
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.delete('/api/admin/reservas/:id', authAdmin, async (req, res) => {
  try {
    const reserva = await Reserva.findById(req.params.id);
    if (!reserva) return res.status(404).json({ error: 'No encontrada' });
    const force = req.query.force === 'true';
    if (!force && reserva.estado !== 'cancelada') return res.status(400).json({ error: 'Solo se pueden eliminar reservas canceladas o finalizadas' });
    if (force && !['cancelada','completada'].includes(reserva.estado)) return res.status(400).json({ error: 'Solo se pueden eliminar reservas canceladas o finalizadas' });
    if (reserva.eventoCalendarioId) await borrarEventoCalendario(reserva.eventoCalendarioId);
    // Solo borrar comisiones si la reserva es cancelada (nunca se realizó).
    // Si está completada, la comisión se mantiene para el registro contable.
    if (reserva.estado === 'cancelada') await Comision.deleteMany({ reservaId: reserva._id });
    await Reserva.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch(e) { console.error('Error eliminar reserva:', e.message); res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/admin/reasignar/:id', authAdmin, async (req, res) => {
  try {
    const reserva = await Reserva.findById(req.params.id);
    if (!reserva) return res.status(404).json({ error: 'No encontrada' });
    const conductorAnterior = reserva.conductorAsignado;
    await Comision.deleteMany({ reservaId: reserva._id, pagada: false });
    await borrarEventoCalendario(reserva.eventoCalendarioId);
    reserva.estado = 'pendiente';
    reserva.conductorAsignado = null;
    reserva.conductorNombre = null;
    reserva.eventoCalendarioId = null;
    await reserva.save();
    notificarAdmin({ tipo: 'reserva_reasignada', numero: numReserva(reserva.numero), fecha: reserva.datos.fecha, hora: reserva.datos.hora });
    if (conductorAnterior) notificarConductores({ tipo: 'reserva_reasignada', numero: numReserva(reserva.numero), fecha: reserva.datos.fecha, hora: reserva.datos.hora, origen: reserva.datos.origen }, conductorAnterior);
    notificarConductores({ tipo: 'nueva_reserva', numero: numReserva(reserva.numero), fecha: reserva.datos.fecha, hora: reserva.datos.hora, destino: reserva.datos.destino, pasajeros: reserva.datos.pasajeros });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/admin/asignar-conductor/:id', authAdmin, async (req, res) => {
  try {
    const { conductorId } = req.body;
    const reserva = await Reserva.findById(req.params.id);
    if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada' });
    const conductor = await Conductor.findById(conductorId);
    if (!conductor) return res.status(404).json({ error: 'Conductor no encontrado' });
    const conductorAnterior = reserva.conductorAsignado;
    await Comision.deleteMany({ reservaId: reserva._id, pagada: false });
    await borrarEventoCalendario(reserva.eventoCalendarioId);
    reserva.estado = 'asignada';
    reserva.conductorAsignado = conductor._id.toString();
    reserva.conductorNombre = conductor.nombre;
    reserva.eventoCalendarioId = null;
    await reserva.save();
    const esPrioritario = esLicenciaPrioritaria(conductor.licencia);
    if (!esPrioritario && reserva.datos.precioEstimado) {
      const precio = parseFloat(reserva.datos.precioEstimado);
      const pct = conductor.comisionPorcentaje || COMISION_PORCENTAJE;
      await new Comision({ conductorId: conductor._id.toString(), conductorNombre: conductor.nombre, reservaId: reserva._id, precioCarrera: precio, comision: parseFloat((precio * pct / 100).toFixed(2)), mes: new Date().toISOString().slice(0, 7) }).save();
    }
    try { const eid = await crearEventoCalendario(reserva, conductor.nombre); if (eid) { reserva.eventoCalendarioId = eid; await reserva.save(); } } catch(e) {}
    notificarAdmin({ tipo: 'reserva_aceptada', numero: numReserva(reserva.numero), conductor: conductor.nombre, fecha: reserva.datos.fecha, hora: reserva.datos.hora, origen: reserva.datos.origen, destino: reserva.datos.destino });
    notificarConductores({ tipo: 'reserva_asignada', numero: numReserva(reserva.numero), fecha: reserva.datos.fecha, hora: reserva.datos.hora, origen: reserva.datos.origen, destino: reserva.datos.destino, pasajeros: reserva.datos.pasajeros, precio: reserva.datos.precioEstimado }, conductor._id.toString());
    // También enviar como servicio_asignado para compatibilidad con APK conductor
    notificarConductores({ tipo: 'servicio_asignado', numero: numReserva(reserva.numero), fecha: reserva.datos.fecha, hora: reserva.datos.hora, origen: reserva.datos.origen, destino: reserva.datos.destino, pasajeros: reserva.datos.pasajeros, precio: reserva.datos.precioEstimado }, conductor._id.toString());
    if (conductorAnterior && conductorAnterior !== conductor._id.toString()) {
      // Reasignación: avisar al conductor anterior y NO volver a mandar email al cliente
      notificarConductores({ tipo: 'reserva_reasignada', numero: numReserva(reserva.numero), fecha: reserva.datos.fecha, hora: reserva.datos.hora }, conductorAnterior);
      const condAnteriorDoc = await Conductor.findById(conductorAnterior).catch(()=>null);
      if (condAnteriorDoc?.email && BREVO_API_KEY) {
        enviarEmailBrevo({
          sender: { name: 'Reserva Taxi Las Palmas', email: 'reservadetaxilp@gmail.com' },
          to: [{ email: condAnteriorDoc.email, name: condAnteriorDoc.nombre }],
          subject: `🔄 Servicio reasignado — ${numReserva(reserva.numero)}`,
          htmlContent: `<div style="font-family:Arial,sans-serif;padding:24px;background:#f9f9f9;max-width:600px;margin:0 auto;"><h2 style="color:#1a1a1a;background:#eee;padding:16px;border-radius:8px;">🔄 Servicio reasignado</h2><p>Hola <strong>${condAnteriorDoc.nombre}</strong>, el servicio <strong>${numReserva(reserva.numero)}</strong> (${reserva.datos.fecha} ${reserva.datos.hora}) ha sido reasignado a otro conductor por el administrador.</p><p>📞 Consultas: <strong>828 810 938</strong></p></div>`
        }).catch(()=>{});
      }
    } else if (!conductorAnterior) {
      // Primera asignación: enviar email al cliente
      try { await enviarEmailConfirmacion(reserva.datos, reserva._id, conductor.nombre, reserva.numero); } catch(e) {}
    }
    enviarEmailConductorServicioAsignado(conductor, reserva).catch(()=>{});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// =================== ADMIN CONDUCTORES ===================
app.get('/api/admin/conductores', authAdmin, async (req, res) => {
  try {
    const conductores = await Conductor.find().sort({ fechaRegistro: -1 }).select('-password -codigoVerificacion -codigoExpira');
    res.json(conductores.map(c => ({ id: c._id.toString(), nombre: c.nombre, licencia: c.licencia, plaza: c.plaza, telefono: c.telefono, email: c.email, matricula: c.matricula, matriculaEU: c.matriculaEU, aprobado: c.aprobado, activo: c.activo, fechaRegistro: c.fechaRegistro })));
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/admin/conductores/:id/aprobar', authAdmin, async (req, res) => {
  try {
    const c = await Conductor.findByIdAndUpdate(req.params.id, { aprobado: true, activo: true }, { new: true });
    if (!c) return res.status(404).json({ error: 'No encontrado' });
    try { await enviarEmailBrevo({ sender: { name: 'Reserva Taxi Las Palmas', email: 'reservadetaxilp@gmail.com' }, to: [{ email: c.email, name: c.nombre }], subject: '✅ Tu cuenta ha sido aprobada', htmlContent: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#111;color:#f0f0f0;border-radius:12px;padding:32px"><h2 style="color:#f5c400">🚖 ¡Bienvenido, ${c.nombre}!</h2><p>Tu cuenta ha sido aprobada. Ya puedes entrar en la app de conductores.</p></div>` }); } catch(e) {}
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/admin/conductores/:id/denegar', authAdmin, async (req, res) => {
  try {
    const c = await Conductor.findByIdAndDelete(req.params.id);
    if (!c) return res.status(404).json({ error: 'No encontrado' });
    try { await enviarEmailBrevo({ sender: { name: 'Reserva Taxi Las Palmas', email: 'reservadetaxilp@gmail.com' }, to: [{ email: c.email, name: c.nombre }], subject: 'Solicitud no aprobada', htmlContent: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#111;color:#f0f0f0;border-radius:12px;padding:32px"><h2 style="color:#f5c400">Reserva Taxi Las Palmas</h2><p>Hola ${c.nombre}, tu solicitud de registro no ha sido aprobada.</p></div>` }); } catch(e) {}
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/admin/conductores/:id/toggle-activo', authAdmin, async (req, res) => {
  try {
    const c = await Conductor.findById(req.params.id);
    if (!c) return res.status(404).json({ error: 'No encontrado' });
    c.activo = !c.activo;
    await c.save();
    res.json({ ok: true, activo: c.activo });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/admin/conductores/:id/penalizar', authAdmin, async (req, res) => {
  try {
    const { minutos } = req.body;
    const c = await Conductor.findById(req.params.id);
    if (!c) return res.status(404).json({ error: 'No encontrado' });
    c.activo = false;
    await c.save();
    if (minutos && minutos > 0) {
      setTimeout(async () => { try { await Conductor.findByIdAndUpdate(req.params.id, { activo: true }); } catch(e) {} }, minutos * 60000);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.delete('/api/admin/conductores/:id', authAdmin, async (req, res) => {
  try {
    await Conductor.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// =================== ADMIN COMISIONES ===================
app.get('/api/admin/comisiones', authAdmin, async (req, res) => {
  try {
    const comisiones = await Comision.find({ pagada: false }).sort({ fechaCreacion: -1 });
    const porConductor = {};
    for (const c of comisiones) {
      if (!porConductor[c.conductorId]) porConductor[c.conductorId] = { id: c.conductorId, nombre: c.conductorNombre, total: 0, servicios: 0 };
      porConductor[c.conductorId].total += c.comision;
      porConductor[c.conductorId].servicios++;
    }
    res.json(Object.values(porConductor).map(c => ({ ...c, total: parseFloat(c.total.toFixed(2)) })));
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/admin/comisiones/pagar/:conductorId', authAdmin, async (req, res) => {
  try {
    await Comision.updateMany({ conductorId: req.params.conductorId, pagada: false }, { pagada: true, fechaPago: new Date() });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.get('/api/admin/comisiones/pagadas', authAdmin, async (req, res) => {
  try {
    const comisiones = await Comision.find({ pagada: true }).sort({ fechaPago: -1 });
    // Agrupar por conductor y mes
    const porConductorMes = {};
    for (const c of comisiones) {
      const mes = c.mes || (c.fechaCreacion ? c.fechaCreacion.toISOString().slice(0,7) : 'sin-mes');
      const key = c.conductorId + '|' + mes;
      if (!porConductorMes[key]) porConductorMes[key] = { id: c.conductorId, nombre: c.conductorNombre, mes, total: 0, servicios: 0, fechaPago: c.fechaPago };
      porConductorMes[key].total += c.comision;
      porConductorMes[key].servicios++;
    }
    res.json(Object.values(porConductorMes).map(c => ({ ...c, total: parseFloat(c.total.toFixed(2)) })));
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// =================== ADMIN STATS ===================
app.get('/api/admin/stats', authAdmin, async (req, res) => {
  try {
    const [pendientes, asignadas, conductoresActivos, solicitudes, comData] = await Promise.all([
      Reserva.countDocuments({ estado: 'pendiente' }),
      Reserva.countDocuments({ estado: 'asignada' }),
      Conductor.countDocuments({ activo: true, aprobado: true }),
      Conductor.countDocuments({ aprobado: false }),
      Comision.aggregate([{ $match: { pagada: false } }, { $group: { _id: null, total: { $sum: '$comision' } } }])
    ]);
    res.json({ pendientes, asignadas, conductoresActivos, solicitudes, comisionesPendientes: comData[0] ? parseFloat(comData[0].total.toFixed(2)) : 0 });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// (Rutas /api/admin/festivos completas más abajo, con validación de tipo y upsert)

// =================== CONDUCTORES APP ===================
app.post('/api/conductores/registro', async (req, res) => {
  try {
    const { nombre, telefono, email, password, licencia, plaza, matricula, matriculaEU } = req.body;
    if (!nombre || !telefono || !email || !password || !licencia || !plaza)
      return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    const existe = await Conductor.findOne({ $or: [{ email }, { licencia }] });
    if (existe) return res.status(400).json({ error: 'Ya existe un conductor con ese email o licencia' });
    const hash = await bcrypt.hash(password, 10);
    const chatId = 'web_' + Date.now();
    await new Conductor({ chatId, nombre, telefono, email, password: hash, licencia, plaza, matricula, matriculaEU, aprobado: false }).save();
    notificarAdmin({ tipo: 'nueva_solicitud', nombre, licencia, plaza });
    res.json({ ok: true });
  } catch(e) { console.error('Error registro:', e.message); res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/conductores/solicitar-codigo', async (req, res) => {
  try {
    const { email, password } = req.body;
    const conductor = await Conductor.findOne({ email });
    if (!conductor) return res.status(400).json({ error: 'Email o contraseña incorrectos' });
    if (!conductor.aprobado) return res.status(403).json({ error: 'Tu cuenta aún no ha sido aprobada' });
    if (!conductor.activo) return res.status(403).json({ error: 'Tu cuenta está desactivada. Contacta al administrador.' });
    const ok = await bcrypt.compare(password, conductor.password);
    if (!ok) return res.status(400).json({ error: 'Email o contraseña incorrectos' });
    const codigo = String(Math.floor(100000 + Math.random() * 900000));
    conductor.codigoVerificacion = codigo;
    conductor.codigoExpira = new Date(Date.now() + 30 * 60 * 1000);
    await conductor.save();
    await enviarCodigoVerificacion(email, conductor.nombre, codigo);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/conductores/verificar-codigo', async (req, res) => {
  try {
    const { email, codigo } = req.body;
    const conductor = await Conductor.findOne({ email });
    if (!conductor) return res.status(400).json({ error: 'Conductor no encontrado' });
    if (conductor.codigoVerificacion !== codigo) return res.status(400).json({ error: 'Código incorrecto' });
    if (new Date() > conductor.codigoExpira) return res.status(400).json({ error: 'Código expirado' });
    conductor.codigoVerificacion = null;
    conductor.codigoExpira = null;
    await conductor.save();
    const token = jwt.sign({ id: conductor._id.toString(), chatId: conductor.chatId, nombre: conductor.nombre }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, nombre: conductor.nombre });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.get('/api/conductores/servicios', authConductor, async (req, res) => {
  try {
    const conductor = await Conductor.findById(req.conductor.id);
    if (!conductor || !conductor.activo) return res.status(403).json({ error: 'Cuenta desactivada. Contacta al administrador.' });
    const esPrioritario = esLicenciaPrioritaria(conductor.licencia);
    const ahora = new Date();
    const haceXmin = new Date(ahora.getTime() - cacheConfig.prioridadMinutos * 60 * 1000);
    const filtro = esPrioritario ? { estado: 'pendiente' } : { estado: 'pendiente', fechaCreacion: { $lte: haceXmin } };
    const reservas = await Reserva.find(filtro).sort({ fechaCreacion: -1 }).limit(20);
    res.json(reservas.map(r => ({
      id: r._id, numero: numReserva(r.numero), fecha: r.datos.fecha, hora: r.datos.hora,
      origen: r.datos.origen, destino: r.datos.destino, pasajeros: r.datos.pasajeros,
      precio: r.datos.precioEstimado, notas: r.datos.observaciones,
      vuelo: r.datos.vuelo, pasaporte: r.datos.pasaporte,
      nombre: r.datos.nombre, sillas: r.datos.sillas, vehiculoNombre: r.datos.vehiculoNombre
    })));
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/conductores/aceptar/:id', authConductor, async (req, res) => {
  try {
    const reserva = await Reserva.findById(req.params.id);
    if (!reserva || reserva.estado !== 'pendiente') return res.status(400).json({ error: 'Esta reserva ya no está disponible' });
    const conductor = await Conductor.findById(req.conductor.id);
    if (!conductor) return res.status(404).json({ error: 'Conductor no encontrado' });
    const esPrioritarioCheck = esLicenciaPrioritaria(conductor.licencia);
    if (!esPrioritarioCheck) {
      const minutosTranscurridos = (new Date() - reserva.fechaCreacion) / 60000;
      if (minutosTranscurridos < cacheConfig.prioridadMinutos) {
        return res.status(403).json({ error: `Esta reserva aún está en periodo de prioridad. Disponible en ${Math.ceil(cacheConfig.prioridadMinutos - minutosTranscurridos)} min.` });
      }
    }
    reserva.estado = 'asignada';
    reserva.conductorAsignado = conductor._id.toString();
    reserva.conductorNombre = conductor.nombre;
    await reserva.save();
    const esPrioritario = esLicenciaPrioritaria(conductor.licencia);
    if (!esPrioritario && reserva.datos.precioEstimado) {
      try {
        const precio = parseFloat(reserva.datos.precioEstimado);
        const pct = conductor.comisionPorcentaje || COMISION_PORCENTAJE;
        await new Comision({ conductorId: conductor._id.toString(), conductorNombre: conductor.nombre, reservaId: reserva._id, precioCarrera: precio, comision: parseFloat((precio * pct / 100).toFixed(2)), mes: new Date().toISOString().slice(0, 7) }).save();
      } catch(eComision) { console.error('Error creando comisión (la reserva sí quedó asignada):', eComision.message); }
    }
    try { const eid = await crearEventoCalendario(reserva, conductor.nombre); if (eid) { reserva.eventoCalendarioId = eid; await reserva.save(); } } catch(e) {}
    notificarAdmin({ tipo: 'reserva_aceptada', numero: numReserva(reserva.numero), conductor: conductor.nombre, fecha: reserva.datos.fecha, hora: reserva.datos.hora, origen: reserva.datos.origen, destino: reserva.datos.destino });
    try { await enviarEmailConfirmacion(reserva.datos, reserva._id, conductor.nombre, reserva.numero); } catch(e) {}
    enviarEmailConductorServicioAsignado(conductor, reserva).catch(()=>{});
    res.json({ ok: true });
  } catch(e) { console.error('Error aceptar:', e.message); res.status(500).json({ error: 'Error interno' }); }
});

app.get('/api/conductores/mis-servicios', authConductor, async (req, res) => {
  try {
    const conductor = await Conductor.findById(req.conductor.id);
    const reservas = await Reserva.find({ conductorAsignado: conductor._id.toString(), estado: { $in: ['asignada', 'en_camino', 'recogido', 'completada'] } }).sort({ fechaServicio: -1 }).limit(30);
    res.json(reservas.map(r => ({
      id: r._id, numero: numReserva(r.numero), fecha: r.datos.fecha, hora: r.datos.hora,
      origen: r.datos.origen, destino: r.datos.destino, pasajeros: r.datos.pasajeros,
      precio: r.datos.precioEstimado, estado: r.estado, notas: r.datos.observaciones,
      vuelo: r.datos.vuelo, pasaporte: r.datos.pasaporte,
      nombre: r.datos.nombre, sillas: r.datos.sillas, vehiculoNombre: r.datos.vehiculoNombre
    })));
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/conductores/finalizar/:id', authConductor, async (req, res) => {
  try {
    const conductor = await Conductor.findById(req.conductor.id);
    const reserva = await Reserva.findOne({ _id: req.params.id, conductorAsignado: conductor._id.toString() });
    if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada' });
    reserva.estado = 'completada';
    await reserva.save();
    notificarAdmin({ tipo: 'reserva_completada', numero: numReserva(reserva.numero), conductor: conductor.nombre, fecha: reserva.datos.fecha, hora: reserva.datos.hora });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.get('/api/conductores/perfil', authConductor, async (req, res) => {
  try {
    const c = await Conductor.findById(req.conductor.id).select('-password -codigoVerificacion -codigoExpira');
    if (!c) return res.status(404).json({ error: 'No encontrado' });
    res.json({ nombre: c.nombre, telefono: c.telefono, email: c.email, licencia: c.licencia, plaza: c.plaza, matricula: c.matricula, matriculaEU: c.matriculaEU });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/conductores/cambiar-password', authConductor, async (req, res) => {
  try {
    const { actual, nueva } = req.body;
    if (!actual || !nueva || nueva.length < 6) return res.status(400).json({ error: 'La contraseña nueva debe tener al menos 6 caracteres' });
    const c = await Conductor.findById(req.conductor.id);
    if (!await bcrypt.compare(actual, c.password)) return res.status(400).json({ error: 'Contraseña actual incorrecta' });
    c.password = await bcrypt.hash(nueva, 10);
    await c.save();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.get('/api/conductores/comisiones', authConductor, async (req, res) => {
  try {
    const conductor = await Conductor.findById(req.conductor.id);
    const comisiones = await Comision.find({ conductorId: conductor._id.toString() }).sort({ fechaCreacion: -1 }).limit(50);
    const totalPendiente = comisiones.filter(x => !x.pagada).reduce((s, x) => s + x.comision, 0);
    res.json({ totalPendiente: parseFloat(totalPendiente.toFixed(2)), comisiones: comisiones.map(x => ({ mes: x.mes, precioCarrera: x.precioCarrera, comision: x.comision, pagada: x.pagada, fecha: x.fechaCreacion })) });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// =================== CANCELACIÓN CLIENTE ===================
app.get('/cancelar', async (req, res) => {
  const html = (ico, titulo, msg, color) => `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cancelar reserva</title><style>body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}.box{max-width:440px;background:#141414;border:1px solid ${color};border-radius:16px;padding:32px;text-align:center}.ico{font-size:54px;margin-bottom:16px}h1{color:${color};font-size:22px;margin:0 0 12px}p{color:#bbb;font-size:15px;line-height:1.6;margin:0 0 20px}.btn{display:inline-block;padding:14px 28px;background:#e05050;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;text-decoration:none}.tel{color:#f5c400;text-decoration:none;font-weight:700}</style></head><body><div class="box"><div class="ico">${ico}</div><h1>${titulo}</h1>${msg}</div></body></html>`;
  try {
    const reserva = await Reserva.findById(req.query.id);
    if (!reserva) return res.send(html('❓', 'Reserva no encontrada', '<p>El enlace no es válido. Llama al <a class="tel" href="tel:+34828810938">828 810 938</a>.</p>', '#888'));
    if (reserva.estado === 'cancelada') return res.send(html('✅', 'Ya estaba cancelada', '<p>Esta reserva ya figura como cancelada.</p>', '#7dd87d'));
    if (reserva.fechaServicio) {
      const mins = (new Date(reserva.fechaServicio) - ahoraCanarias()) / 60000;
      if (mins < 120) return res.send(html('⏱️', 'No se puede cancelar online', `<p>Tu servicio es demasiado próximo. Llama al <a class="tel" href="tel:+34828810938">828 810 938</a>.</p>`, '#f5c400'));
    }
    const d = reserva.datos;
    res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cancelar reserva</title><style>body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}.box{max-width:440px;background:#141414;border:1px solid #f5c400;border-radius:16px;padding:32px;text-align:center}.ico{font-size:54px;margin-bottom:16px}h1{color:#f5c400;font-size:22px;margin:0 0 12px}p{color:#bbb;font-size:15px;line-height:1.6;margin:0 0 20px}.btn{display:inline-block;padding:14px 28px;background:#e05050;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;text-decoration:none}</style></head><body><div class="box"><div class="ico">⚠️</div><h1>¿Cancelar tu reserva?</h1><p>📅 ${d.fecha} a las ${d.hora}<br>📍 ${d.origen} → ${d.destino}</p><a class="btn" href="/cancelar-confirmar?id=${req.query.id}">Sí, cancelar reserva</a></div></body></html>`);
  } catch(e) { res.send(html('❓', 'Enlace no válido', '<p>Llama al <a class="tel" href="tel:+34828810938">828 810 938</a>.</p>', '#888')); }
});

app.get('/cancelar-confirmar', async (req, res) => {
  try {
    const reserva = await Reserva.findById(req.query.id);
    if (!reserva || reserva.estado === 'cancelada') return res.redirect('/');
    if (reserva.fechaServicio) {
      const mins = (new Date(reserva.fechaServicio) - ahoraCanarias()) / 60000;
      if (mins < 120) return res.redirect('/cancelar?id=' + req.query.id);
    }
    const conductorAnterior = reserva.conductorAsignado;
    reserva.estado = 'cancelada';
    await reserva.save();
    await Comision.deleteMany({ reservaId: reserva._id, pagada: false });
    await borrarEventoCalendario(reserva.eventoCalendarioId);
    notificarAdmin({ tipo: 'reserva_cancelada', numero: numReserva(reserva.numero), fecha: reserva.datos.fecha, hora: reserva.datos.hora, motivo: 'Cancelada por el cliente' });
    if (conductorAnterior) notificarConductores({ tipo: 'reserva_cancelada', numero: numReserva(reserva.numero), fecha: reserva.datos.fecha, hora: reserva.datos.hora }, conductorAnterior);
    res.send('<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cancelada</title><style>body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}.box{max-width:440px;background:#141414;border:1px solid #7dd87d;border-radius:16px;padding:32px;text-align:center}.ico{font-size:54px;margin-bottom:16px}h1{color:#7dd87d;font-size:22px;margin:0 0 12px}p{color:#bbb;font-size:15px;line-height:1.6}</style></head><body><div class="box"><div class="ico">✅</div><h1>Reserva cancelada</h1><p>Tu reserva ha sido cancelada correctamente. Esperamos verte pronto.</p></div></body></html>');
  } catch(e) { res.redirect('/'); }
});

// =================== RECORDATORIOS ===================
function iniciarRecordatorios() {
  setInterval(async () => {
    try {
      const ahora = ahoraCanarias();
      const en60 = new Date(ahora.getTime() + 60 * 60 * 1000);
      const en55 = new Date(ahora.getTime() + 55 * 60 * 1000);
      const reservas = await Reserva.find({ estado: 'asignada', recordatorioClienteEnviado: false, fechaServicio: { $gte: en55, $lte: en60 } });
      for (const r of reservas) {
        try { await enviarEmailRecordatorio(r); } catch(e) {}
        r.recordatorioClienteEnviado = true;
        await r.save();
      }
      const hace10 = new Date(Date.now() - 10 * 60 * 1000);
      const sinAceptar = await Reserva.find({ estado: 'pendiente', avisoSinAceptarEnviado: false, fechaCreacion: { $lte: hace10 } });
      for (const r of sinAceptar) {
        notificarAdmin({ tipo: 'reserva_sin_aceptar', numero: numReserva(r.numero), fecha: r.datos.fecha, hora: r.datos.hora, origen: r.datos.origen });
        r.avisoSinAceptarEnviado = true;
        await r.save();
      }
    } catch(e) { console.error('Error recordatorios:', e.message); }
  }, 60 * 1000);
}

// =================== RESUMEN MENSUAL ===================
function iniciarResumenMensual() {
  setInterval(async () => {
    try {
      const ahora = ahoraCanarias();
      if (ahora.getDate() === 1 && ahora.getHours() === 9 && ahora.getMinutes() < 5) {
        const mesAnterior = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1);
        const mes = `${mesAnterior.getFullYear()}-${String(mesAnterior.getMonth() + 1).padStart(2, '0')}`;
        const conductores = await Conductor.find({ activo: true, aprobado: true });
        for (const conductor of conductores) {
          const comisiones = await Comision.find({ conductorId: conductor._id.toString(), mes });
          if (!comisiones.length) continue;
          const totalCarreras = comisiones.reduce((s, c) => s + c.precioCarrera, 0);
          const totalComision = comisiones.reduce((s, c) => s + c.comision, 0);
          if (conductor.email && BREVO_API_KEY) {
            try {
              await enviarEmailBrevo({
                sender: { name: 'Reserva Taxi Las Palmas', email: 'reservadetaxilp@gmail.com' },
                to: [{ email: conductor.email, name: conductor.nombre }],
                subject: `Resumen de comisiones — ${mesAnterior.toLocaleString('es-ES', { month: 'long', year: 'numeric' })}`,
                htmlContent: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#111;color:#f0f0f0;border-radius:12px;padding:32px"><h2 style="color:#f5c400">📊 Resumen mensual</h2><p>Hola ${conductor.nombre},</p><p>Has realizado <strong>${comisiones.length} carreras</strong> por un total de <strong>${totalCarreras.toFixed(2)}€</strong>.</p><p>Tu comisión pendiente del mes: <strong style="color:#f5c400;font-size:20px">${totalComision.toFixed(2)}€</strong></p><p>Por favor realiza el ingreso antes del día 7.<br>IBAN: ES07 1583 0001 1790 4940 3249</p></div>`
              });
            } catch(e) {}
          }
        }
        notificarAdmin({ tipo: 'resumen_mensual', mes });
      }
    } catch(e) { console.error('Error resumen mensual:', e.message); }
  }, 5 * 60 * 1000);
}


// =================== UBICACIÓN GPS (WebSocket push) ===================
// El conductor envía su ubicación vía WS directamente (ver wsClients handler)
// Endpoint para que el cliente consulte la última ubicación conocida
app.get('/api/reserva/:id/ubicacion', async (req, res) => {
  try {
    const r = await Reserva.findById(req.params.id).select('estado ubicacionLat ubicacionLng ultimaUbicacion conductorNombre numero datos');
    if (!r) return res.status(404).json({ error: 'No encontrada' });
    res.json({
      estado: r.estado,
      numero: numReserva(r.numero),
      lat: r.ubicacionLat,
      lng: r.ubicacionLng,
      actualizado: r.ultimaUbicacion,
      conductor: (r.estado === 'en_camino' || r.estado === 'recogido') ? r.conductorNombre : null,
      origen: r.datos?.origen || null,
      destino: r.datos?.destino || null
    });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// Conductor: voy en camino
app.post('/api/conductores/en-camino/:id', authConductor, async (req, res) => {
  try {
    const conductor = await Conductor.findById(req.conductor.id);
    const reserva = await Reserva.findOne({ _id: req.params.id, conductorAsignado: conductor._id.toString() });
    if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (reserva.estado !== 'asignada') return res.status(400).json({ error: 'Estado incorrecto' });
    reserva.estado = 'en_camino';
    // Mantener orden lógico: si el recordatorio de "llega en 1 hora" aún no se envió,
    // se envía justo antes que el de "en camino" para que el cliente lo reciba primero.
    if (!reserva.recordatorioClienteEnviado) {
      try { await enviarEmailRecordatorio(reserva); } catch(e) {}
      reserva.recordatorioClienteEnviado = true;
    }
    await reserva.save();
    // Notificar al cliente y admin por WS
    notificarAdmin({ tipo: 'conductor_en_camino', numero: numReserva(reserva.numero), conductor: conductor.nombre });
    notificarCliente(reserva._id.toString(), { tipo: 'conductor_en_camino', numero: numReserva(reserva.numero), conductor: conductor.nombre });
    // Email al cliente (siempre después del recordatorio, si lo hubo)
    try { await enviarEmailEstado(reserva, 'en_camino', conductor.nombre); } catch(e) {}
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// Conductor: cliente recogido
app.post('/api/conductores/recogido/:id', authConductor, async (req, res) => {
  try {
    const conductor = await Conductor.findById(req.conductor.id);
    const reserva = await Reserva.findOne({ _id: req.params.id, conductorAsignado: conductor._id.toString() });
    if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (reserva.estado !== 'en_camino') return res.status(400).json({ error: 'Estado incorrecto' });
    reserva.estado = 'recogido';
    reserva.ubicacionLat = null;
    reserva.ubicacionLng = null;
    await reserva.save();
    notificarAdmin({ tipo: 'cliente_recogido', numero: numReserva(reserva.numero), conductor: conductor.nombre });
    notificarCliente(reserva._id.toString(), { tipo: 'cliente_recogido', numero: numReserva(reserva.numero) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// =================== ADMIN TARIFAS ===================
app.get('/api/admin/tarifas', authAdmin, async (req, res) => {
  try { res.json(await Tarifa.find()); } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.put('/api/admin/tarifas/:nombre', authAdmin, async (req, res) => {
  try {
    const t = await Tarifa.findOneAndUpdate({ nombre: req.params.nombre }, { valor: req.body.valor }, { new: true });
    if (!t) return res.status(404).json({ error: 'Tarifa no encontrada' });
    res.json({ ok: true, tarifa: t });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// Configuración de la antelación mínima para reservar
app.get('/api/admin/antelacion', authAdmin, async (req, res) => {
  try { res.json({ horas: cacheConfig.antelacion }); }
  catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.put('/api/admin/antelacion', authAdmin, async (req, res) => {
  try {
    const horas = parseFloat(req.body.horas);
    if (isNaN(horas) || horas < 0) return res.status(400).json({ error: 'Valor no válido' });
    await Config.findOneAndUpdate({ nombre: 'antelacion' }, { valor: horas }, { upsert: true });
    cacheConfig.antelacion = horas;
    res.json({ ok: true, horas });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// Configuración de la ventana de prioridad (minutos exclusivos para LICENCIA_PRIORITARIA)
app.get('/api/admin/prioridad', authAdmin, async (req, res) => {
  try { res.json({ minutos: cacheConfig.prioridadMinutos }); }
  catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.put('/api/admin/prioridad', authAdmin, async (req, res) => {
  try {
    const minutos = parseFloat(req.body.minutos);
    if (isNaN(minutos) || minutos < 0) return res.status(400).json({ error: 'Valor no válido' });
    await Config.findOneAndUpdate({ nombre: 'prioridadMinutos' }, { valor: minutos }, { upsert: true });
    cacheConfig.prioridadMinutos = minutos;
    res.json({ ok: true, minutos });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// Tarifas públicas para el formulario de reserva
app.get('/api/tarifas', async (req, res) => {
  try {
    const tarifas = await Tarifa.find();
    const obj = {};
    tarifas.forEach(t => obj[t.nombre] = t.valor);
    res.json(obj);
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// =================== ADMIN VEHÍCULOS ===================
app.get('/api/admin/vehiculos', authAdmin, async (req, res) => {
  try {
    const vehiculos = await Vehiculo.find().sort({ orden: 1, fechaCreacion: 1 });
    res.json(vehiculos);
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/admin/vehiculos', authAdmin, async (req, res) => {
  try {
    const { nombre, descripcion, plazas, maletasGrandes, maletasPequenas, suplemento, foto } = req.body;
    if (!nombre || !plazas) return res.status(400).json({ error: 'Faltan datos obligatorios' });
    const count = await Vehiculo.countDocuments();
    const v = await new Vehiculo({
      nombre, descripcion: descripcion || '',
      plazas: parseInt(plazas) || 4,
      maletasGrandes: parseInt(maletasGrandes) || 0,
      maletasPequenas: parseInt(maletasPequenas) || 0,
      suplemento: parseFloat(suplemento) || 0,
      foto: foto || '',
      orden: count
    }).save();
    res.json({ ok: true, vehiculo: v });
  } catch(e) { console.error('Error crear vehiculo:', e.message); res.status(500).json({ error: 'Error interno' }); }
});

app.put('/api/admin/vehiculos/:id', authAdmin, async (req, res) => {
  try {
    const { nombre, descripcion, plazas, maletasGrandes, maletasPequenas, suplemento, foto } = req.body;
    const update = {
      nombre, descripcion: descripcion || '',
      plazas: parseInt(plazas) || 4,
      maletasGrandes: parseInt(maletasGrandes) || 0,
      maletasPequenas: parseInt(maletasPequenas) || 0,
      suplemento: parseFloat(suplemento) || 0
    };
    if (foto) update.foto = foto;
    const v = await Vehiculo.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!v) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true, vehiculo: v });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/admin/vehiculos/:id/toggle-activo', authAdmin, async (req, res) => {
  try {
    const v = await Vehiculo.findById(req.params.id);
    if (!v) return res.status(404).json({ error: 'No encontrado' });
    v.activo = !v.activo;
    await v.save();
    res.json({ ok: true, activo: v.activo });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.delete('/api/admin/vehiculos/:id', authAdmin, async (req, res) => {
  try {
    await Vehiculo.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// Listado público de vehículos activos (para el formulario de reserva)
app.get('/api/vehiculos', async (req, res) => {
  try {
    const vehiculos = await Vehiculo.find({ activo: true }).sort({ orden: 1, fechaCreacion: 1 });
    res.json(vehiculos);
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// =================== ADMIN FESTIVOS Y DÍAS SIN SERVICIO ===================
app.get('/api/admin/festivos', authAdmin, async (req, res) => {
  try { res.json(await Festivo.find().sort({ fecha: 1 })); } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/admin/festivos', authAdmin, async (req, res) => {
  try {
    const { fecha, descripcion, tipo, suplementoPlus, horaInicio, horaFin } = req.body;
    if (!fecha) return res.status(400).json({ error: 'Falta la fecha' });
    const tipoValido = ['festivo', 'festivo_plus', 'sin_servicio'].includes(tipo) ? tipo : 'festivo';
    const f = await Festivo.findOneAndUpdate(
      { fecha },
      {
        descripcion: descripcion || 'Festivo',
        tipo: tipoValido,
        suplementoPlus: tipoValido === 'festivo_plus' ? (parseFloat(suplementoPlus)||0) : 0,
        horaInicio: tipoValido === 'sin_servicio' ? (horaInicio || '') : '',
        horaFin: tipoValido === 'sin_servicio' ? (horaFin || '') : ''
      },
      { upsert: true, new: true }
    );
    res.json({ ok: true, festivo: f });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.delete('/api/admin/festivos/:fecha', authAdmin, async (req, res) => {
  try {
    await Festivo.deleteOne({ fecha: req.params.fecha });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// Festivos públicos para validación en formulario
app.get('/api/festivos', async (req, res) => {
  try { res.json(await Festivo.find().sort({ fecha: 1 })); } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// =================== ADMIN CONDUCTORES EXTENDIDO ===================
app.put('/api/admin/conductores/:id', authAdmin, async (req, res) => {
  try {
    const { nombre, telefono, email, licencia, plaza, matricula, matriculaEU, comisionPorcentaje } = req.body;
    const c = await Conductor.findByIdAndUpdate(req.params.id, { nombre, telefono, email, licencia, plaza, matricula, matriculaEU, comisionPorcentaje: parseFloat(comisionPorcentaje) || 10 }, { new: true });
    if (!c) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

// =================== WEBSOCKET ===================
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer });
const wsClients = new Set();

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.tipo = null;
  wsClients.add(ws);
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.tipo === 'auth_admin') {
        try { const dec = jwt.verify(msg.token, JWT_SECRET); if (dec.role === 'admin') ws.tipo = 'admin'; } catch(e) {}
      } else if (msg.tipo === 'auth_conductor') {
        try { const dec = jwt.verify(msg.token, JWT_SECRET); ws.tipo = 'conductor'; ws.conductorId = dec.id; } catch(e) {}
      } else if (msg.tipo === 'auth_cliente') {
        if (msg.reservaId) { ws.tipo = 'cliente'; ws.reservaId = msg.reservaId; clientesReserva.set(msg.reservaId, ws); }
      } else if (msg.tipo === 'ubicacion_gps') {
        if (msg.reservaId && typeof msg.lat === 'number' && typeof msg.lng === 'number') {
          // Guardar en DB
          Reserva.findByIdAndUpdate(msg.reservaId, { ubicacionLat: msg.lat, ubicacionLng: msg.lng, ultimaUbicacion: new Date() }).catch(e => console.error('Error guardando ubicación GPS:', e.message));
          // Notificar al cliente que sigue esta reserva
          notificarCliente(msg.reservaId, { tipo: 'ubicacion_gps', lat: msg.lat, lng: msg.lng });
          // Notificar también al admin
          notificarAdmin({ tipo: 'ubicacion_gps', reservaId: msg.reservaId, lat: msg.lat, lng: msg.lng });
        }
      } else if (msg.tipo === 'ping') {
        try { ws.send(JSON.stringify({ tipo: 'pong' })); } catch(e) {}
      }
    } catch(e) {}
  });
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => {
    wsClients.delete(ws);
    if (ws.reservaId && clientesReserva.get(ws.reservaId) === ws) clientesReserva.delete(ws.reservaId);
  });
  ws.on('error', () => wsClients.delete(ws));
});

setInterval(() => {
  for (const ws of wsClients) {
    if (!ws.isAlive) { ws.terminate(); wsClients.delete(ws); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch(e) {}
  }
}, 30000);

// Mapa de reservaId -> wsClient del cliente (para tracking GPS)
const clientesReserva = new Map();

function notificarCliente(reservaId, evento) {
  const ws = clientesReserva.get(reservaId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(evento)); } catch(e) {}
  }
}

async function enviarEmailEstado(reserva, estado, nombreConductor) {
  if (!reserva.datos.correo || !BREVO_API_KEY) return;
  const idioma = ['es','en','de'].includes(reserva.datos.idioma) ? reserva.datos.idioma : 'es';
  const msgs = {
    es: { en_camino: { sub: '🚖 Tu conductor está en camino', body: (id, num) => '<p>Tu conductor <strong>' + nombreConductor + '</strong> está en camino a recogerte.</p><p><a href="' + APP_URL + '/seguimiento?id=' + id + '" style="display:inline-block;background:#f5b800;color:#1a1d29;padding:14px 28px;border-radius:10px;font-weight:800;text-decoration:none;font-size:15px;">📍 Ver ubicación en tiempo real</a></p><p>Nº reserva: <strong>' + num + '</strong></p>' } },
    en: { en_camino: { sub: '🚖 Your driver is on the way', body: (id, num) => '<p>Your driver <strong>' + nombreConductor + '</strong> is on the way.</p><p><a href="' + APP_URL + '/seguimiento?id=' + id + '" style="display:inline-block;background:#f5b800;color:#1a1d29;padding:14px 28px;border-radius:10px;font-weight:800;text-decoration:none;font-size:15px;">📍 Track in real time</a></p><p>Booking: <strong>' + num + '</strong></p>' } },
    de: { en_camino: { sub: '🚖 Ihr Fahrer ist unterwegs', body: (id, num) => '<p>Ihr Fahrer <strong>' + nombreConductor + '</strong> ist unterwegs.</p><p><a href="' + APP_URL + '/seguimiento?id=' + id + '" style="display:inline-block;background:#f5b800;color:#1a1d29;padding:14px 28px;border-radius:10px;font-weight:800;text-decoration:none;font-size:15px;">📍 Standort verfolgen</a></p><p>Buchung: <strong>' + num + '</strong></p>' } }
  };
  const T = (msgs[idioma] || msgs.es)[estado];
  if (!T) return;
  const bodyHtml = typeof T.body === 'function'
    ? T.body(reserva._id.toString(), numReserva(reserva.numero))
    : T.body;
  await enviarEmailBrevo({
    sender: { name: 'Reserva Taxi Las Palmas', email: 'reservadetaxilp@gmail.com' },
    to: [{ email: reserva.datos.correo, name: reserva.datos.nombre }],
    subject: T.sub,
    htmlContent: `<div style="font-family:Arial,sans-serif;padding:24px;background:#f9f9f9;max-width:600px;margin:0 auto;">
      <div style="background:#1a1a1a;padding:16px 20px;border-radius:12px;margin-bottom:20px;display:flex;align-items:center;gap:12px;">
        <span style="font-size:28px;">🚖</span>
        <span style="color:#f5b800;font-size:18px;font-weight:800;">Reserva Taxi Las Palmas</span>
      </div>
      <p style="font-size:15px;color:#2b2f3a;margin-bottom:16px;">Hola <strong>${reserva.datos.nombre}</strong>,</p>
      <p style="font-size:15px;color:#2b2f3a;line-height:1.6;margin-bottom:20px;">${bodyHtml}</p>
      <div style="background:#f5f7fb;border-radius:10px;padding:14px 16px;margin-bottom:20px;font-size:14px;color:#5c6373;">
        <div>📅 <strong>${reserva.datos.fecha}</strong> a las <strong>${reserva.datos.hora}</strong></div>
        <div style="margin-top:6px;">📍 ${reserva.datos.origen}</div>
        <div style="margin-top:4px;">🏁 ${reserva.datos.destino}</div>
      </div>
      <p style="font-size:13px;color:#5c6373;">📞 <strong>828 810 938</strong> · reservas@taxilaspalmasdegrancanaria.com</p>
    </div>`
  });
}

function payloadPushParaEvento(evento, contexto) {
  const url = contexto === 'admin' ? '/admin.html' : '/conductores.html';
  const mapas = {
    nueva_reserva:      { title: '🚖 Nueva reserva', body: `${evento.numero||''} — ${evento.fecha||''} ${evento.hora||''}${evento.destino?' · '+evento.destino:''}` },
    reserva_cancelada:  { title: '❌ Reserva cancelada', body: `${evento.numero||''}${evento.motivo?': '+evento.motivo:''}` },
    reserva_asignada:   { title: '📋 Servicio asignado', body: `${evento.numero||''} — ${evento.fecha||''} ${evento.hora||''}` },
    servicio_asignado:  { title: '📋 Servicio asignado', body: `${evento.numero||''} — ${evento.fecha||''} ${evento.hora||''}` },
    reserva_reasignada: { title: '🔄 Reserva reasignada', body: `${evento.numero||''}` },
    conductor_aceptado: { title: '✅ Conductor asignado', body: `${evento.conductor||''} aceptó ${evento.numero||''}` }
  };
  const base = mapas[evento.tipo] || { title: 'Reserva Taxi Las Palmas', body: 'Tienes una actualización' };
  return { ...base, tag: evento.tipo || 'aviso', url, ts: Date.now() };
}

function notificarAdmin(evento) {
  const p = JSON.stringify(evento);
  for (const ws of wsClients)
    if (ws.tipo === 'admin' && ws.readyState === WebSocket.OPEN) try { ws.send(p); } catch(e) {}
  enviarPushA('admin', payloadPushParaEvento(evento, 'admin'));
}

function notificarConductores(evento, soloId) {
  const p = JSON.stringify(evento);
  for (const ws of wsClients) {
    if (ws.tipo !== 'conductor' || ws.readyState !== WebSocket.OPEN) continue;
    if (soloId && ws.conductorId !== soloId) continue;
    try { ws.send(p); } catch(e) {}
  }
  const pushPayload = payloadPushParaEvento(evento, 'conductor');
  if (soloId) enviarPushA(soloId, pushPayload);
  else enviarPushATodosConductores(pushPayload);
}

httpServer.listen(PORT, () => console.log(`Servidor en puerto ${PORT} — HTTP + WebSocket`));
