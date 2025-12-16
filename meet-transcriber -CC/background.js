// --- Estado ---
const state = { transcript: [], startedAt: null, capturing: true, selfName: null, exporting: false, compatActive: false, compatAuto: true, noiseStreak: 0, lastEventAt: 0, lastBacklogSaveKey: '', lastBacklogSaveAt: 0, lastBacklogSig: '', accessToken: null };
// UI window control / notifications
let uiWindowId = null;
let notificationHandlersRegistered = false;
let lastMeetingEndedAt = 0;
const meetingEndCooldownMs = 5000;
// Seguimiento de pestañas de Meet para fallback al cerrar
const meetTabIds = new Set();
// Limpiar referencia de ventana cuando se cierre
try {
  chrome.windows.onRemoved.addListener((wid) => { if (wid === uiWindowId) uiWindowId = null; });
} catch {}

// --- Utilidades ---
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString("es-AR", { hour12: false });
}
async function getSelfName() {
  if (state.selfName) return state.selfName;
  try {
    const data = await chrome.storage?.local?.get?.("selfName");
    const name = (data && data.selfName) ? String(data.selfName).trim() : "";
    if (name) state.selfName = name;
  } catch {}
  return state.selfName || null;
}
function normalizeSpeaker(s) {
  const base = s || "";
  if (/^(tu|tú|you)$/i.test(base)) {
    const nm = state.selfName && String(state.selfName).trim();
    return nm || "Tú";
  }
  return base || "Tú";
}

// --- Perfil del usuario desde snapshot de la página ---
function extractEmailFromSnapshot(data) {
  try {
    const d = data || {};
    const email = d?.user?.email || d?.email || '';
    const val = String(email || '').trim();
    if (!val) return '';
    // Validación básica
    const ok = /.+@.+\..+/.test(val);
    return ok ? val : '';
  } catch { return ''; }
}
function extractNameFromSnapshot(data) {
  try {
    const d = data || {};
    const name = d?.user?.full_name || d?.full_name || '';
    const val = String(name || '').trim();
    return val || '';
  } catch { return ''; }
}
async function updateProfileFromSnapshot(data, origin) {
  try {
    const isEmpty = !data || (typeof data === 'object' && Object.keys(data).length === 0);
    if (isEmpty) {
      await clearProfileAndNotify('empty_snapshot', origin);
      return;
    }
    const email = extractEmailFromSnapshot(data);
    const name = extractNameFromSnapshot(data);
    const accessToken = String(data?.access_token || '').trim();
    const updates = {};
    if (email) updates.userEmail = email;
    if (name) { updates.selfName = name; state.selfName = name; }
    if (accessToken) { state.accessToken = accessToken; updates.accessToken = accessToken; }
    if (Object.keys(updates).length) {
      await chrome.storage?.local?.set?.(updates);
      try { chrome.runtime?.sendMessage?.({ type: 'SELF_NAME_UPDATED' }); } catch {}
      try { chrome.runtime?.sendMessage?.({ type: 'PROFILE_UPDATED', payload: { email, name } }); } catch {}
      console.info('[MEETIX] Perfil actualizado desde página:', { origin, email, name, hasToken: !!accessToken });
    } else {
      console.debug('[MEETIX] Snapshot recibido sin perfil útil', { origin });
    }
  } catch (e) {
    console.warn('[MEETIX] updateProfileFromSnapshot fallo:', e);
  }
}
async function initProfileFromLastPageLocalStorage() {
  try {
    const s = await chrome.storage?.local?.get?.('lastPageLocalStorage');
    const rec = s?.lastPageLocalStorage;
    if (!rec || !rec.data) return;
    await updateProfileFromSnapshot(rec.data, rec.origin);
  } catch {}
}

async function clearProfileAndNotify(reason = 'clear', origin = '') {
  try {
    state.selfName = null;
    state.accessToken = null;
    await chrome.storage?.local?.remove?.(['userEmail','selfName','accessToken']);
    try { chrome.runtime?.sendMessage?.({ type: 'SESSION_CLEARED', payload: { reason, origin } }); } catch {}
    console.info('[MEETIX] Perfil limpiado:', { reason, origin });
  } catch (e) {
    console.warn('[MEETIX] clearProfile error:', e);
  }
}
// Heurística ligera para detectar texto de discurso humano
function looksLikeSpeech(s) {
  try {
    const text = String(s || '').trim();
    if (!text || text.length < 2 || text.length > 800) return false;
    // Evitar mensajes de cuenta regresiva del lobby
    const lower = text.toLowerCase();
    if (/^quedan\s+\d+\s+(segundos|minutos)\b/.test(lower)) return false;
    if (/^faltan\s+\d+\s+(segundos|minutos)\b/.test(lower)) return false;
    if (/\b\d+\s+(seconds|minutes)\s+left\b/.test(lower)) return false;
    const letters = (text.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length;
    const letterRatio = letters / Math.max(1, text.length);
    const words = (text.match(/\S+/g) || []).length;
    const punctuation = (text.match(/[.,!?¡¿;:]/g) || []).length;
    if (words >= 2 && letterRatio > 0.5 && punctuation <= 10) return true;
  } catch {}
  return false;
}
// Sanitizador de nombres de oradores para evitar etiquetas del UI
function sanitizeSpeakerName(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  const noiseSpeakers = [
    'estás presentando',
    'la presentación está empezando',
    'fijado para ti',
    'detalles de la reunión',
    'activar subtítulos',
    'desactivar subtítulos',
    'activar pantalla completa',
    'quitar de la llamada',
    'traer aquí la llamada',
    'los usuarios se han unido por teléfono',
    'desactivar subtítulos',
    'cambiar ajuste de imagen en imagen automática',
    'imagen en imagen',
    'no puedes activar el audio de la presentación',
  ];
  if (noiseSpeakers.some(p => lower.startsWith(p))) return '';
  // Quitar sufijos tipo "(Tu presentación)" / "(Presentación)" / variantes
  s = s.replace(/\s*\((tu|tú)?\s*presentaci[óo]n\)\s*$/i, '');
  s = s.replace(/\s*\((your)?\s*presentation\)\s*$/i, '');
  return s.trim();
}
// Construcción profesional de nombre de archivo: "<selfName>-YYYY-MM-DD-HH-mm-ss"
function getSafeSelfName() {
  try {
    const nm = (state.selfName && String(state.selfName)) || '';
    const base = nm.trim() || '';
    if (!base) return '';
    // remover acentos y normalizar
    const ascii = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    // reemplazar espacios y caracteres no permitidos por '-'
    const safe = ascii.replace(/[^A-Za-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$|\./g, '').trim();
    return safe;
  } catch { return ''; }
}
function buildFileBase() {
  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g, "-");
  const nm = getSafeSelfName();
  return (nm ? nm : 'meetix-transcript') + '-' + stamp;
}
function formatMD(items) {
  const header =
    `# Transcripción — Google Meet (ES)\n\n` +
    `> Inicio: ${new Date(state.startedAt || Date.now()).toLocaleString(
      "es-AR"
    )}\n` +
    `> Líneas: ${items.length}\n\n`;
  const body = items
    .map((i) => {
      const speaker = `**${normalizeSpeaker(i.speaker)}**`;
      return `- ${speaker}: ${i.text}`;
    })
    .join("\n");
  return header + body + "\n";
}
async function downloadMD(name, content, opts = { saveAs: true }) {
  // Evita caracteres inválidos en el nombre
  name = name.replace(/[\\/:"*?<>|]+/g, "_");
  const dataUrl = "data:text/plain;charset=utf-8," + encodeURIComponent(content);
  const saveAsFlag = !!(opts && opts.saveAs);
  await chrome.downloads.download({ url: dataUrl, filename: name, saveAs: saveAsFlag });
}

async function openExportWindow() {
  const url = chrome.runtime.getURL('popup.html?auto=1');
  try {
    if (uiWindowId) {
      try {
        const info = await chrome.windows.get(uiWindowId, { populate: false });
        if (info) {
          await chrome.windows.update(uiWindowId, { focused: true });
          return;
        }
      } catch {}
    }
    const w = await chrome.windows.create({ url, type: 'popup', width: 380, height: 560, focused: true });
    uiWindowId = w?.id || null;
  } catch (e) {
    console.warn('[MEETIX] openExportWindow error:', e);
  }
}

// Ventana emergente con indicador de procesamiento inicial
async function openExportWindowBusy() {
  const url = chrome.runtime.getURL('popup.html?auto=1&busy=1');
  try {
    if (uiWindowId) {
      try {
        const info = await chrome.windows.get(uiWindowId, { populate: false });
        if (info) {
          await chrome.windows.update(uiWindowId, { focused: true });
          return;
        }
      } catch {}
    }
    const w = await chrome.windows.create({ url, type: 'popup', width: 380, height: 560, focused: true });
    uiWindowId = w?.id || null;
  } catch (e) {
    console.warn('[MEETIX] openExportWindowBusy error:', e);
  }
}

// Helper: verificar si la auto‑subida está activada
async function isAutoUploadEnabled() {
  try {
    const s = await chrome.storage?.local?.get?.('autoUploadOnEnd');
    return !!(s && s.autoUploadOnEnd);
  } catch { return false; }
}

function ensureNotificationHandlers() {
  if (notificationHandlersRegistered) return;
  try {
    chrome.notifications.onClicked.addListener((id) => { if (id === 'meetix-ended') openExportWindow(); });
    chrome.notifications.onButtonClicked.addListener((id, idx) => { if (id === 'meetix-ended' && idx === 0) openExportWindow(); });
    chrome.windows.onRemoved.addListener((wid) => { if (wid === uiWindowId) uiWindowId = null; });
    notificationHandlersRegistered = true;
  } catch (e) {
    console.warn('[MEETIX] ensureNotificationHandlers error:', e);
  }
}

function scheduleQuietAutoExport(delayMs = 15000) {
  try {
    chrome.alarms.clear('meetix_quiet_export', () => {
      chrome.alarms.create('meetix_quiet_export', { when: Date.now() + delayMs });
    });
  } catch (e) {
    console.warn('[MEETIX] scheduleQuietAutoExport error:', e);
  }
}

// Determinar si hay una reunión de Meet activa (con código)
async function isMeetingActive() {
  try {
    let tabs = await new Promise((resolve) => {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (t) => resolve(t || []) );
    });
    let tab = tabs && tabs[0];
    const isMeet = (u) => /https:\/\/meet\.google\.com\//.test(String(u || ''));
    if (!tab?.id || !isMeet(tab.url)) {
      const allMeet = await new Promise((resolve) => {
        chrome.tabs.query({ url: 'https://meet.google.com/*' }, (t) => resolve(t || []) );
      });
      tab = allMeet.find((t) => t.active) || allMeet[0];
    }
    if (!tab?.id || !isMeet(tab.url)) return false;
    const codeRe = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\b|\?|$)/i;
    let meetingActive = !!codeRe.test(String(tab.url || ''));
    // Si el documento muestra claramente que saliste, override
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        func: () => {
          const txt = (document.body?.innerText || '').toLowerCase();
          const markers = [
            'has abandonado la reunión',
            'has salido de la reunión',
            'se volverá a mostrar la pantalla de inicio',
            'volviendo a la pantalla de inicio',
            'you left the meeting',
            "you've left the meeting",
            'returning to the home screen'
          ];
          const ended = markers.some(m => txt.includes(m));
          return { ended };
        }
      });
      const ended = !!(res && res[0] && res[0].result && res[0].result.ended);
      if (ended) meetingActive = false;
    } catch {}
    return meetingActive;
  } catch { return false; }
}

// Ejecuta auto-export si pasó un período de silencio
try {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (!alarm || alarm.name !== 'meetix_quiet_export') return;
    const quietFor = Date.now() - (state.lastEventAt || 0);
    if (quietFor < 14000) return; // aún no suficientemente quieto
    // No exportar si la reunión sigue activa
    const active = await isMeetingActive();
    if (active) return;
    // Verificar toggle y correo, y que exista algún dato recuperable
    await ensureTranscriptLoaded();
    const hasData = !!(state.transcript && state.transcript.length);
    await maybeAutoExportOnEnd(hasData);
  });
} catch (e) {
  console.warn('[MEETIX] alarms.onAlarm register error:', e);
}

  async function maybeAutoExportOnEnd(hasData, force = false) {
  try {
    // No auto‑exportar si aún hay una reunión activa, salvo que forcemos desde MEETING_ENDED
    const active = await isMeetingActive();
    if (active && !force) return;
    const cfg = await chrome.storage?.local?.get?.(['autoUploadOnEnd','userEmail']);
    const enabled = !!(cfg && cfg.autoUploadOnEnd);
    const email = String((cfg && cfg.userEmail) || '').trim();
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!enabled || !valid) return;
    if (state.exporting) return;
    // Evitar duplicados: si ya exportamos o dentro de 60s del último export, excepto cuando es forzado
    if (!force && state.exported) return;
    if (!force && state.lastExportAt && (Date.now() - state.lastExportAt) < 60_000) return;
    state.exporting = true;
    try {
      chrome.runtime?.sendMessage?.({ type: 'EXPORTING_STATUS', payload: { exporting: true } });
      await chrome.storage?.local?.set?.({ uiExporting: true });
    } catch {}
      try {
        // Recolectar eventos
        let items = await getEventsFromActiveTab();
        if (!items || !items.length) {
          await ensureTranscriptLoaded();
          items = state.transcript || [];
        }
        if (!items || !items.length) {
          const data = await chrome.storage?.local?.get?.(['transcriptCache','startedAt']);
          const cache = Array.isArray(data?.transcriptCache) ? data.transcriptCache : [];
          if (cache.length) {
            items = cache;
            if (!state.startedAt) state.startedAt = (typeof data?.startedAt === 'number') ? data.startedAt : Date.now();
          }
        }
        // Fallback final: tomar del backlog recién guardado si todo lo anterior está vacío
        if (!items || !items.length) {
          try {
            const { sessions, transcripts } = await loadSessionsStore();
            // Buscar por startedAt actual o tomar la última
            let target = sessions.find(s => s?.startedAt && s.startedAt === state.startedAt);
            if (!target) target = sessions[0];
            const evts = target ? transcripts[target.id] : [];
            if (Array.isArray(evts) && evts.length) {
              items = evts;
              // Alinear startedAt con la sesión del backlog
              if (!state.startedAt && target?.startedAt) state.startedAt = target.startedAt;
            }
          } catch {}
        }
        if (!items || !items.length) return; // respeto: no exportar vacío
        try { await getSelfName(); } catch {}
        try { await ensureSelfNameFromTab(); } catch {}
        const base = buildFileBase();
        const content = formatMD(items);
        const blob = new Blob([content], { type: 'text/plain' });
        // Auto‑subida: NO descargar localmente
        // Subir
        let up = null;
        try {
          up = await uploadToSupabase(blob, `${base}.txt`, {
            startedAt: state.startedAt || Date.now(),
            endedAt: Date.now(),
            lines: items.length,
            userEmail: email
          });
        } catch (e) {
          console.error('[Supabase] upload error:', e);
        }
        const ok = !!(up && up.ok);
        if (ok) {
          // Marcar sesión como exportada para evitar repetición
          state.exported = true;
          state.lastExportAt = Date.now();
          try { await chrome.storage?.local?.set?.({ exportedSessionAt: state.startedAt, exportedAt: state.lastExportAt }); } catch {}
          // Limpiar transcript para ocultar card y evitar re‑export manual
          try { state.transcript = []; await chrome.storage?.local?.set?.({ transcriptCache: [] }); } catch {}
          // Si existe sesión en backlog coincidente, marcar como exportada
          try {
            const { sessions } = await loadSessionsStore();
            const match = sessions.find(s => s?.startedAt && s.startedAt === state.startedAt);
            if (match) await markSessionExported(match.id);
          } catch {}
          // Notificar al popup para que desactive spinner (sin cerrar automáticamente)
          try { chrome.runtime?.sendMessage?.({ type: 'AUTO_UPLOAD_DONE', payload: { uploaded: true } }); } catch {}
        }
        else {
          // Notificar fallo de subida para que el popup muestre error y desactive spinner
          try { chrome.runtime?.sendMessage?.({ type: 'AUTO_UPLOAD_DONE', payload: { uploaded: false } }); } catch {}
        }
        // No usamos notificaciones; la ventana emergente se abrió en MEETING_ENDED
      } finally {
        state.exporting = false;
        try {
          chrome.runtime?.sendMessage?.({ type: 'EXPORTING_STATUS', payload: { exporting: false } });
          await chrome.storage?.local?.set?.({ uiExporting: false });
        } catch {}
      }
  } catch (e) {
    console.warn('[MEETIX] maybeAutoExportOnEnd error:', e);
  }
}

// --- Upload a Supabase (endpoint público, sin JWT) ---
async function uploadToSupabase(blob, filename, meta = {}) {
  const endpoint = 'https://qmegcaikuxlnbvyouqpx.supabase.co/functions/v1/PostTranscription';
  const fd = new FormData();
  fd.append('file', blob, filename);
  fd.append('filename', filename);
  fd.append('started_at', String(meta.startedAt || ''));
  fd.append('ended_at', String(meta.endedAt || ''));
  fd.append('lines', String(meta.lines || 0));
  fd.append('user_email', String(meta.userEmail || ''));
  const res = await fetch(endpoint, { method: 'POST', body: fd });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || res.statusText || 'upload_failed');
  }
  return data; // { ok, id, path, public_url }
}
// Persistencia simple de transcripción para mantener información en el popup
async function persistState() {
  try {
    await chrome.storage?.local?.set?.({
      transcriptCache: state.transcript,
      startedAt: state.startedAt,
    });
  } catch {}
}

// Restaurar si hubiera datos previos
(async () => {
  try {
    const data = await chrome.storage?.local?.get?.(['transcriptCache','startedAt']);
    if (Array.isArray(data?.transcriptCache) && data.transcriptCache.length && !state.transcript.length) {
      state.transcript = data.transcriptCache;
    }
    if (typeof data?.startedAt === 'number' && !state.startedAt) state.startedAt = data.startedAt;
  } catch {}
})();
async function exportNow() {
  if (!state.transcript.length)
    return { ok: false, reason: "Sin datos para exportar" };
  // Asegurar que selfName esté cargado antes de formatear
  try { await getSelfName(); } catch {}
  const base = buildFileBase();
  await downloadMD(`${base}.txt`, formatMD(state.transcript));
  return { ok: true };
}

// Intentar aprender selfName desde la pestaña activa (participantes con "(Tú)") si aún falta
async function ensureSelfNameFromTab() {
  if (state.selfName && String(state.selfName).trim()) return;
  try {
    let [tab] = await new Promise((resolve) => {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (t) => resolve(t || []));
    });
    const isMeet = (u) => /https:\/\/meet\.google\.com\//.test(String(u || ""));
    if (!tab?.id || !isMeet(tab.url)) {
      const allMeet = await new Promise((resolve) => {
        chrome.tabs.query({ url: "https://meet.google.com/*" }, (t) => resolve(t || []) );
      });
      tab = allMeet.find((t) => t.active) || allMeet[0];
    }
    if (!tab?.id) return;
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: () => {
        try {
          const els = Array.from(document.querySelectorAll('[aria-label]'));
          for (const el of els) {
            const al = String(el.getAttribute('aria-label') || '').trim();
            const mTu = al.match(/^(.+?)\s*\((tu|tú|you)\)\s*$/i);
            if (mTu && mTu[1]) {
              const nm = mTu[1].trim();
              if (nm && !/^(tu|tú|you)$/i.test(nm)) return nm;
            }
          }
          const spanTu = Array.from(document.querySelectorAll('span.notranslate'))
            .map(s => String(s.textContent || '').trim())
            .find(t => /(\(\s*(tu|tú|you)\s*\))$/i.test(t));
          if (spanTu) return spanTu.replace(/\(\s*(tu|tú|you)\s*\)$/i, '').trim();
        } catch {}
        return null;
      }
    });
    const cand = res && res[0] && res[0].result;
    if (cand && !/^(tu|tú|you)$/i.test(cand) && !/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(cand)) {
      state.selfName = cand;
      try { chrome.storage?.local?.set?.({ selfName: cand }); } catch {}
    }
  } catch {}
}

function transformEvent(e) {
  try {
    const text = String(e.text || '').trim();
    const lower = text.toLowerCase();
    const speakerRaw = String(e.speaker || '').trim();
    // descartes incondicionales
    if (!text) return null;
    if (lower === 'detalles de la reunión') return null;
    if (lower.includes('se volverá a mostrar la pantalla de inicio')) return null;
    // ruido UI específico
    if (lower.includes('volver a meet') || lower.includes('return to meet')) return null;
    if (/\(.*(tú|you).*?(presentando|presenting).*?\)/i.test(text)) return null;
    // presentaciones y pantalla principal (variantes con/ sin acento)
    if (/presentaci[óo]n.*pantalla\s+principal/i.test(lower)) return null;
    const uiPhrases = [
      'presentación se ha añadido a la pantalla principal',
      'presentacion se ha añadido a la pantalla principal',
      'presentación está en la pantalla principal',
      'presentacion está en la pantalla principal',
      'tu presentación se ha añadido a la pantalla principal',
      'tu presentacion se ha añadido a la pantalla principal',
      'tu presentación está en la pantalla principal',
      'tu presentacion está en la pantalla principal',
      'efecto espejo infinito',
      'no compartas la pantalla completa',
      'ventana del navegador entera',
      'comparte una sola pestaña',
      'ventana diferente'
    ];
    if (uiPhrases.some(p => lower.includes(p))) return null;
    // color/paleta ruido
    const colors = ['blanco','negro','azul','verde','rojo','amarillo','cian','magenta'];
    let colorHits = 0; for (const c of colors) { if (lower.includes(c)) colorHits++; }
    if (lower.includes('circlecolor') || lower.includes('texto predeterminado') || lower.includes('color predeterminado') || colorHits >= 4) return null;
    // oradores no humanos
    if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(speakerRaw)) return null;
    if (/^google\s+meet$/i.test(speakerRaw)) return null;
    // reasignación de oradores de sistema
    const systemSpeaker = /^(tu\s+reunión\s+es\s+segura|fijado\s+para\s+ti|los\s+usuarios\s+se\s+han\s+unido\s+por\s+tel[ée]fono)$/i.test(speakerRaw);
    const spSan = sanitizeSpeakerName(systemSpeaker ? 'tu' : speakerRaw);
    const finalSpeaker = spSan ? normalizeSpeaker(spSan) : (state.selfName ? String(state.selfName).trim() : 'Tú');
    return { speaker: finalSpeaker, text };
  } catch { return null; }
}

function filterAndNormalizeEvts(evts) {
  const out = [];
  for (const e of evts || []) {
    const t = transformEvent(e);
    if (t) out.push(t);
  }
  return out;
}

async function exportFromEvents(evts) {
  if (!evts || !evts.length) return { ok: false, reason: "Sin datos para exportar" };
  // Asegurar que selfName esté cargado o aprenderlo desde la pestaña
  try { await getSelfName(); } catch {}
  try { await ensureSelfNameFromTab(); } catch {}
  const normalized = filterAndNormalizeEvts(evts);
  if (!normalized.length) return { ok: false, reason: "Sin datos útiles para exportar" };
  const base = buildFileBase();
  await downloadMD(`${base}.txt`, formatMD(normalized));
  return { ok: true };
}

async function exportFromStorage() {
  try {
    const data = await chrome.storage?.local?.get?.(['transcriptCache','startedAt']);
    const cache = Array.isArray(data?.transcriptCache) ? data.transcriptCache : [];
    if (!cache.length) return { ok: false, reason: 'Sin datos para exportar' };
    const oldStarted = (typeof data?.startedAt === 'number') ? data.startedAt : Date.now();
    const prev = { ...state };
    state.startedAt = prev.startedAt || oldStarted;
    const res = await exportFromEvents(cache);
    // Restaurar estado previo (no sobrecargar en memoria si no queremos)
    state.startedAt = prev.startedAt;
    return res;
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

async function getEventsFromActiveTab() {
  try {
    // Intentar primero en la última ventana enfocada
    let tabs = await new Promise((resolve) => {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (t) => {
        resolve(t || []);
      });
    });
    let tab = tabs && tabs[0];
    // Si el activo no es Meet, buscar cualquier pestaña de Meet en todas las ventanas
    const isMeet = (u) => /https:\/\/meet\.google\.com\//.test(String(u || ""));
    if (!tab?.id || !isMeet(tab.url)) {
      const allMeet = await new Promise((resolve) => {
        chrome.tabs.query({ url: "https://meet.google.com/*" }, (t) => resolve(t || []) );
      });
      tab = allMeet.find((t) => t.active) || allMeet[0];
    }
    if (!tab?.id) return [];

    // Agregar eventos desde todos los frames (Meet usa iframes)
    let frames = [];
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => true,
      });
      frames = (results || []).map(r => r.frameId).filter(id => typeof id === 'number');
    } catch {}

    const evtsAll = [];
    if (frames.length) {
      for (const fid of frames) {
        try {
          const r = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, { type: "MVP_GET_EVENTS" }, { frameId: fid }, (res) => {
              const err = chrome.runtime.lastError;
              if (err || !res?.ok) return resolve([]);
              resolve(res.events || []);
            });
          });
          if (r && r.length) evtsAll.push(...r);
        } catch {}
      }
    }
    // Si por alguna razón no pudimos iterar frames, intentar top frame
    if (!evtsAll.length) {
      try {
        const rTop = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tab.id, { type: "MVP_GET_EVENTS" }, (res) => {
            const err = chrome.runtime.lastError;
            if (err || !res?.ok) return resolve([]);
            resolve(res.events || []);
          });
        });
        if (rTop && rTop.length) evtsAll.push(...rTop);
      } catch {}
    }
    return evtsAll;
  } catch {
    return [];
  }
}

// Asegura que el transcript esté cargado desde storage si el estado en memoria está vacío
async function ensureTranscriptLoaded() {
  try {
    if (!state.transcript || !state.transcript.length) {
      const data = await chrome.storage?.local?.get?.(['transcriptCache','startedAt']);
      const cache = Array.isArray(data?.transcriptCache) ? data.transcriptCache : [];
      if (cache.length) {
        state.transcript = cache;
        if (!state.startedAt) state.startedAt = (typeof data?.startedAt === 'number') ? data.startedAt : Date.now();
      }
    }
  } catch {}
}

function mergeEventsIntoTranscript(evts) {
  for (const e of evts) {
    const payload = {
      speaker: normalizeSpeaker(e.speaker || ""),
      text: String(e.text || "").trim(),
      ts: Date.now(),
    };
    if (!payload.text) continue;
    const last = state.transcript[state.transcript.length - 1];
    if (last) {
      const sameSpeaker = (last.speaker || "") === (payload.speaker || "");
      const a = (last.text || "").trim();
      const b = payload.text;
      const norm = (s) => s.replace(/[\s]+/g, " ").trim();
      const aa = norm(a);
      const bb = norm(b);
      if (sameSpeaker) {
        if (aa === bb) continue; // dedup
        if (aa.length < bb.length && bb.startsWith(aa)) {
          last.text = b; // coalesce
          last.ts = payload.ts;
          continue;
        }
      }
    }
    state.transcript.push(payload);
  }
}

// --- Backlog de sesiones (máximo 5) ---
async function getActiveMeetingCode() {
  try {
    let tabs = await new Promise((resolve) => {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (t) => resolve(t || []));
    });
    let tab = tabs && tabs[0];
    const isMeet = (u) => /https:\/\/meet\.google\.com\//.test(String(u || ""));
    if (!tab?.id || !isMeet(tab.url)) {
      const allMeet = await new Promise((resolve) => {
        chrome.tabs.query({ url: "https://meet.google.com/*" }, (t) => resolve(t || []) );
      });
      tab = allMeet.find((t) => t.active) || allMeet[0];
    }
    const codeMatch = tab?.url?.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
    return codeMatch ? codeMatch[1] : '';
  } catch { return ''; }
}

async function loadSessionsStore() {
  const data = await chrome.storage?.local?.get?.(['mx_sessions','mx_transcripts']);
  const sessions = Array.isArray(data?.mx_sessions) ? data.mx_sessions : [];
  const transcripts = (data?.mx_transcripts && typeof data.mx_transcripts === 'object') ? data.mx_transcripts : {};
  return { sessions, transcripts };
}

async function saveSessionsStore(sessions, transcripts, notify = true) {
  await chrome.storage?.local?.set?.({ mx_sessions: sessions, mx_transcripts: transcripts });
  if (notify) {
    try { chrome.runtime?.sendMessage?.({ type: 'SESSIONS_UPDATED' }); } catch {}
  }
}

async function saveCurrentSessionToBacklog() {
  try {
    await ensureTranscriptLoaded();
    const evts = Array.isArray(state.transcript) ? state.transcript.slice() : [];
    if (!evts.length) return;
    // Validar que exista al menos una línea de discurso real
    const hasRealSpeech = evts.some(e => looksLikeSpeech(e.text));
    if (!hasRealSpeech) return;
    const startedAtVal = state.startedAt || Date.now();
    const id = String(startedAtVal);
    const meetingCode = await getActiveMeetingCode();
    const meta = { id, meetingCode, startedAt: startedAtVal, endedAt: Date.now(), lines: evts.length, exported: false };
    const { sessions, transcripts } = await loadSessionsStore();
    // Debounce para evitar doble guardado por eventos simultáneos
    const key = `${startedAtVal}`;
    const now = Date.now();
    if (state.lastBacklogSaveKey === key && (now - (state.lastBacklogSaveAt || 0)) < 5000) return;
    state.lastBacklogSaveKey = key;
    state.lastBacklogSaveAt = now;
    // Firma de sesión para evitar duplicados incluso si startedAt se resetea
    const firstTs = (evts[0] && evts[0].ts) ? evts[0].ts : 0;
    const sig = `${meetingCode || ''}|${firstTs}|${evts.length}`;
    if (state.lastBacklogSig === sig && (now - (state.lastBacklogSaveAt || 0)) < 15000) return;
    state.lastBacklogSig = sig;
    // Insertar al principio y recortar a máximo 5
    // Evitar colisiones por id
    const existingIdx = sessions.findIndex(s => String(s.id) === id);
    if (existingIdx >= 0) {
      sessions.splice(existingIdx, 1);
    }
    sessions.unshift(meta);
    transcripts[id] = evts;
    while (sessions.length > 5) {
      const removed = sessions.pop();
      try { delete transcripts[removed.id]; } catch {}
    }
    await saveSessionsStore(sessions, transcripts);
    // Resetear solo la transcripción para evitar arrastres (mantener startedAt para marcadores de export)
    try {
      state.transcript = [];
      await chrome.storage?.local?.set?.({ transcriptCache: [] });
    } catch {}
  } catch (e) {
    console.warn('[MEETIX] saveCurrentSessionToBacklog error:', e);
  }
}

async function removeSessionById(sessionId) {
  const { sessions, transcripts } = await loadSessionsStore();
  const idx = sessions.findIndex(s => String(s.id) === String(sessionId));
  if (idx >= 0) sessions.splice(idx, 1);
  try { delete transcripts[sessionId]; } catch {}
  await saveSessionsStore(sessions, transcripts);
}

async function getSessionTranscript(sessionId) {
  const { transcripts } = await loadSessionsStore();
  const evts = transcripts[sessionId];
  return Array.isArray(evts) ? evts : [];
}

async function markSessionExported(sessionId) {
  const { sessions, transcripts } = await loadSessionsStore();
  const idx = sessions.findIndex(s => String(s.id) === String(sessionId));
  if (idx >= 0) sessions[idx].exported = true;
  // Al exportar, se remueve del listado según requerimiento
  const sess = sessions[idx];
  if (sess) {
    sessions.splice(idx, 1);
    try { delete transcripts[sessionId]; } catch {}
  }
  await saveSessionsStore(sessions, transcripts);
}

async function uploadBacklogIfEnabled() {
  try {
    const cfg = await chrome.storage?.local?.get?.(['autoUploadOnEnd','userEmail']);
    const enabled = !!(cfg && cfg.autoUploadOnEnd);
    const email = String((cfg && cfg.userEmail) || '').trim();
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!enabled || !valid) return;
    const { sessions } = await loadSessionsStore();
    // Evitar subir la sesión ya exportada recientemente
    let exportedAtStart = 0;
    try {
      const data = await chrome.storage?.local?.get?.('exportedSessionAt');
      exportedAtStart = (typeof data?.exportedSessionAt === 'number') ? data.exportedSessionAt : 0;
    } catch {}
    for (const s of sessions.slice()) {
      try {
        if (s?.exported) { await removeSessionById(s.id); continue; }
        if (exportedAtStart && s?.startedAt && s.startedAt === exportedAtStart) { await markSessionExported(s.id); continue; }
        const evts = await getSessionTranscript(s.id);
        if (!evts || !evts.length) { await removeSessionById(s.id); continue; }
        // Subir sin descargar local
        await exportAndUploadFromEvents(evts, { noDownload: true, metaOverride: s });
        await markSessionExported(s.id);
      } catch (e) {
        console.warn('[MEETIX] upload backlog error:', e);
      }
    }
  } catch {}
}

async function exportAndUploadFromEvents(evts, opts = { noDownload: false, metaOverride: null }) {
  // Normalizar eventos y preparar contenido
  try { await getSelfName(); } catch {}
  try { await ensureSelfNameFromTab(); } catch {}
  const normalized = filterAndNormalizeEvts(evts);
  if (!normalized.length) return { ok: false, reason: 'Sin datos útiles para exportar' };
  const base = buildFileBase();
  const content = formatMD(normalized);
  const blob = new Blob([content], { type: 'text/plain' });
  // Descarga local opcional
  let downloadError = false;
  if (!opts?.noDownload) {
    try { await downloadMD(`${base}.txt`, content, { saveAs: true }); } catch (e) { downloadError = true; }
  }
  // Subir
  let up = null;
  try {
    const meta = opts?.metaOverride || { startedAt: state.startedAt || Date.now(), endedAt: Date.now(), lines: normalized.length, userEmail: '' };
    const userEmailData = await chrome.storage?.local?.get?.('userEmail').catch(() => ({}));
    meta.userEmail = (userEmailData && userEmailData.userEmail) ? String(userEmailData.userEmail) : meta.userEmail;
    up = await uploadToSupabase(blob, `${base}.txt`, meta);
  } catch (e) { console.error('[Supabase] upload error:', e); }
  return { ok: true, uploaded: !!(up && up.ok), public_url: up?.public_url, path: up?.path, id: up?.id, download_error: downloadError };
}

// --- Listener único ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  try {
    switch (msg?.type) {
      case "PING": {
        // Cargar nombre propio si no está aún en memoria
        (async () => {
          try {
            await getSelfName();
            await initProfileFromLastPageLocalStorage();
          } catch {}
        })();
        sendResponse?.({ ok: true, sw: "alive" });
        return;
      }
      case "LOCALSTORAGE_DATA": {
        // Mensaje reenviado por el content script desde la página (window.postMessage)
        (async () => {
          try {
            const origin = String(msg.origin || '');
            const data = msg.payload || {};
            const rec = { origin, ts: Date.now(), data };
            await chrome.storage?.local?.set?.({ lastPageLocalStorage: rec });
            try { await updateProfileFromSnapshot(data, origin); } catch (e) { console.warn('[MEETIX] updateProfileFromSnapshot error:', e); }
            sendResponse?.({ ok: true });
          } catch (e) {
            sendResponse?.({ ok: false, error: String(e) });
          }
        })();
        return true;
      }
      case "GET_LAST_PAGE_LOCALSTORAGE": {
        (async () => {
          try {
            const s = await chrome.storage?.local?.get?.('lastPageLocalStorage');
            sendResponse?.({ ok: true, data: s?.lastPageLocalStorage || null });
          } catch (e) {
            sendResponse?.({ ok: false, error: String(e) });
          }
        })();
        return true;
      }
      case "SELF_NAME_UPDATED": {
        (async () => {
          try {
            const data = await chrome.storage?.local?.get?.("selfName");
            state.selfName = (data && data.selfName) ? String(data.selfName).trim() : "";
            sendResponse?.({ ok: true, selfName: state.selfName });
          } catch (e) {
            sendResponse?.({ ok: false, error: String(e) });
          }
        })();
        return true;
      }
      case "GET_SESSION_INFO": {
        (async () => {
          try {
            // Detectar código de reunión desde la pestaña activa
            let tabs = await new Promise((resolve) => {
              chrome.tabs.query({ active: true, lastFocusedWindow: true }, (t) => resolve(t || []));
            });
            let tab = tabs && tabs[0];
            const isMeet = (u) => /https:\/\/meet\.google\.com\//.test(String(u || ""));
            if (!tab?.id || !isMeet(tab.url)) {
              const allMeet = await new Promise((resolve) => {
                chrome.tabs.query({ url: "https://meet.google.com/*" }, (t) => resolve(t || []) );
              });
              tab = allMeet.find((t) => t.active) || allMeet[0];
            }
            // Activo solo si estamos dentro de una reunión con código en la URL
            const codeRe = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\b|\?|$)/i;
            let meetingActive = !!(tab && tab.id && isMeet(tab.url) && codeRe.test(String(tab.url || "")));
            try {
              if (tab?.id) {
                const res = await chrome.scripting.executeScript({
                  target: { tabId: tab.id, allFrames: false },
                  func: () => {
                    const txt = (document.body?.innerText || '').toLowerCase();
                    const markers = [
                      'has abandonado la reunión',
                      'has salido de la reunión',
                      'se volverá a mostrar la pantalla de inicio',
                      'volviendo a la pantalla de inicio',
                      'you left the meeting',
                      'returning to the home screen'
                    ];
                    const ended = markers.some(m => txt.includes(m));
                    return { ended };
                  }
                });
                const ended = !!(res && res[0] && res[0].result && res[0].result.ended);
                if (ended) meetingActive = false;
              }
            } catch {}
            const codeMatch = tab?.url?.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
            const meetingCode = codeMatch ? codeMatch[1] : '';
            // Intenta cargar desde storage si el estado está vacío
            await ensureTranscriptLoaded();
            const lines = state.transcript.length;
            const startedAt = state.startedAt || null;
            const endedAt = lines ? Date.now() : null;
            // Leer si la sesión ya fue exportada
            let exported = state.exported;
            try {
              const data = await chrome.storage?.local?.get?.('exportedSessionAt');
              const expAt = (typeof data?.exportedSessionAt === 'number') ? data.exportedSessionAt : 0;
              if (expAt && startedAt && expAt === startedAt) exported = true;
            } catch {}
            const exporting = !!state.exporting;
            sendResponse?.({ ok: true, meetingCode, startedAt, endedAt, lines, meetingActive, exported, exporting });
          } catch (e) {
            sendResponse?.({ ok: false, error: String(e) });
          }
        })();
        return true;
      }
      case "GET_SESSIONS": {
        (async () => {
          try {
            const { sessions, transcripts } = await loadSessionsStore();
            // Limpieza: eliminar sesiones sin discurso real
            const keep = [];
            for (const s of sessions) {
              const evts = transcripts[s.id] || [];
              const ok = Array.isArray(evts) && evts.some(e => looksLikeSpeech(e.text));
              if (ok) keep.push(s);
              else {
                try { delete transcripts[s.id]; } catch {}
              }
            }
            await saveSessionsStore(keep, transcripts, false); // no notificar aquí para evitar bucle
            sendResponse?.({ ok: true, sessions: keep });
          } catch (e) {
            sendResponse?.({ ok: false, error: String(e) });
          }
        })();
        return true;
      }
      case "CAPTION_EVENT": {
        if (!state.capturing) {
          sendResponse?.({ ok: true, skipped: true });
          return;
        }
        if (!state.startedAt) state.startedAt = Date.now();
        // Deduplicación y coalescido por orador
        const payload = msg.payload || {};
        // Filtro de ruido del UI (p. ej., "Detalles de la reunión"). Aplicar sólo si NO parece discurso.
        const lowerText = String(payload.text || "").toLowerCase();
        const uiNoise = (
          lowerText.includes("detalles de la reunión") ||
          lowerText.includes("meeting details") ||
          lowerText.trim() === "más acciones" ||
          lowerText.includes("enlace de la reunión copiado") ||
          lowerText.includes("no puedes activar el micrófono") ||
          lowerText.includes("hay un problema con la cámara") ||
          lowerText.includes("hay un problema con la camara") ||
          lowerText.includes("mostrar más información") ||
          lowerText.includes("mostrar mas informacion") ||
          lowerText.includes("está en esta llamada") ||
          lowerText.includes("esta en esta llamada") ||
          lowerText.includes("la presentación está empezando") ||
          lowerText.includes("estás presentando") ||
          lowerText.includes("fijado para ti") ||
          lowerText.includes("activar pantalla completa") ||
          lowerText.includes("traer aquí la llamada") ||
          lowerText.includes("imagen en imagen") ||
          lowerText.includes("cambiar ajuste de imagen en imagen automática") ||
          lowerText.includes("no puedes activar el audio de la presentación") ||
          lowerText.includes("quitar de la llamada") ||
          lowerText.includes("mostrar mi pantalla de todos modos") ||
          lowerText.includes("dejar de presentar") ||
          lowerText.includes("ha empezado a presentar") ||
          lowerText.includes("empezó a presentar") ||
          lowerText.includes("ha comenzado a presentar") ||
          lowerText.includes("has started presenting") ||
          lowerText.includes("started presenting") ||
          lowerText.includes("ha empezado a compartir") ||
          lowerText.includes("ha comenzado a compartir") ||
          lowerText.includes("efecto espejo infinito") ||
          lowerText.includes("no compartas la pantalla completa") ||
          lowerText.includes("ventana del navegador entera") ||
          lowerText.includes("comparte una sola pestaña") ||
          lowerText.includes("ventana diferente") ||
          lowerText.includes("presentación se ha añadido a la pantalla principal") ||
          lowerText.includes("presentación está en la pantalla principal") ||
          lowerText.includes("tu presentación se ha añadido a la pantalla principal") ||
          lowerText.includes("tu presentación está en la pantalla principal") ||
          lowerText.includes("tu llamada de meet está en otra ventana") ||
          lowerText.includes("subtítulos automáticos desactivados") ||
          lowerText.includes("subtitulos automaticos desactivados") ||
          lowerText.includes("subtítulos automáticos activados") ||
          lowerText.includes("subtitulos automaticos activados") ||
          lowerText.includes("subtítulos desactivados") ||
          lowerText.includes("subtitulos desactivados") ||
          lowerText.includes("subtítulos activados") ||
          lowerText.includes("subtitulos activados") ||
          lowerText.includes("se volverá a mostrar la pantalla de inicio") ||
          // Ruido paleta de colores/ajustes
          lowerText.includes("circlecolor") ||
          lowerText.includes("texto predeterminado") ||
          lowerText.includes("color predeterminado") ||
          /blanco.*negro.*azul.*verde.*rojo.*amarillo.*cian.*magenta/i.test(lowerText)
        );
        // Descarta SIEMPRE mensajes de sistema específicos
        if (
          lowerText.trim() === 'detalles de la reunión' ||
          lowerText.includes('se volverá a mostrar la pantalla de inicio') ||
          lowerText.includes('has abandonado la reunión') ||
          lowerText.includes('has salido de la reunión') ||
          /^quedan\s+\d+\s+(segundos|minutos)\b/.test(lowerText) ||
          /^faltan\s+\d+\s+(segundos|minutos)\b/.test(lowerText) ||
          /\b\d+\s+(seconds|minutes)\s+left\b/.test(lowerText) ||
          lowerText.includes('valora la calidad del audio')
        ) {
          state.noiseStreak++;
          if (state.compatAuto && state.noiseStreak >= 6) state.compatActive = true;
          sendResponse?.({ ok: true, skipped: true, noise: true });
          return;
        }
        // Para el resto, descartar sólo si no parece discurso
        if (uiNoise && !looksLikeSpeech(payload.text)) {
          state.noiseStreak++;
          if (state.compatAuto && state.noiseStreak >= 6) state.compatActive = true;
          sendResponse?.({ ok: true, skipped: true, noise: true });
          return;
        }
        // Filtrar/reasignar speakers UI
        const spRaw = String(payload.speaker || '').trim();
        if (/^logotipo\s+de\s+meet$/i.test(spRaw)) {
          // Puro UI, descartar
          sendResponse?.({ ok: true, skipped: true, noise: true });
          return;
        }
        // Código de reunión como orador (ej. tgx-cfyv-owp) => ruido
        if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(spRaw)) {
          sendResponse?.({ ok: true, skipped: true, noise: true });
          return;
        }
        // Si el speaker es de sistema, reasignar a selfName/Tú para no perder el texto
        const isSystemSpeaker = /^(tu\s+reunión\s+es\s+segura|fijado\s+para\s+ti|los\s+usuarios\s+se\s+han\s+unido\s+por\s+tel[ée]fono)$/i.test(spRaw);
        const last = state.transcript[state.transcript.length - 1];
        if (last) {
          const sameSpeaker = (last.speaker || "") === (payload.speaker || "");
          const a = (last.text || "").trim();
          const b = (payload.text || "").trim();
          const norm = (s) => s.replace(/[\s]+/g, " ").replace(/[，、]/g, ",").trim();
          const aa = norm(a);
          const bb = norm(b);
          if (sameSpeaker) {
            // Mismo texto exacto => dedup
            if (aa === bb) {
              sendResponse?.({ ok: true, dedup: true });
              return;
            }
            // El nuevo texto extiende al anterior => coalesce
            if (aa.length < bb.length && bb.startsWith(aa)) {
              last.text = b;
              last.ts = payload.ts;
              sendResponse?.({ ok: true, coalesced: true });
              return;
            }
          }
        }
        // Sanitizar y normalizar orador con selfName
        const spSan = sanitizeSpeakerName(isSystemSpeaker ? "tu" : (payload.speaker || ""));
        const normalized = {
          speaker: spSan ? normalizeSpeaker(spSan) : (state.selfName ? String(state.selfName).trim() : "Tú"),
          text: payload.text,
          ts: payload.ts,
        };
        state.transcript.push(normalized); // {speaker,text,ts}
        state.noiseStreak = 0; // contenido aceptado, resetear racha de ruido
        state.lastEventAt = Date.now();
        scheduleQuietAutoExport(15000);
        // Persistencia sin await para evitar errores en callback no-async
        try { persistState().catch(() => {}); } catch {}
        sendResponse?.({ ok: true });
        return;
      }
      case "CAPTURE_TOGGLE": {
        state.capturing = !!msg.payload?.enabled;
        sendResponse?.({ ok: true, capturing: state.capturing });
        return;
      }
      case "MEETING_ENDED": {
        (async () => {
          try {
            // Throttle para evitar notificaciones duplicadas en pocos segundos
            const now = Date.now();
            if (lastMeetingEndedAt && (now - lastMeetingEndedAt) < meetingEndCooldownMs) {
              sendResponse?.({ ok: true, notified: false, reason: 'cooldown' });
              return;
            }
            lastMeetingEndedAt = now;
            // Ver si hay datos en estado o en la pestaña para decidir si notificar
            await ensureTranscriptLoaded();
            let hasData = !!(state.transcript && state.transcript.length);
            if (!hasData) {
              const evts = await getEventsFromActiveTab();
              hasData = !!(evts && evts.length);
            }
            // Determinar si ya fue exportado
            let alreadyExported = !!state.exported;
            try {
              const dataExp = await chrome.storage?.local?.get?.('exportedSessionAt');
              const expAt = (typeof dataExp?.exportedSessionAt === 'number') ? dataExp.exportedSessionAt : 0;
              if (expAt && state.startedAt && expAt === state.startedAt) alreadyExported = true;
            } catch {}
            // Abrir ventana sólo si hay datos y no fue exportado ya
            if (hasData && !alreadyExported) {
              // Guardar sesión en backlog para manejar múltiples reuniones
              try { await saveCurrentSessionToBacklog(); } catch {}
              // Abrir popup sólo si auto‑subida está activada
              try { if (await isAutoUploadEnabled()) await openExportWindowBusy(); } catch {}
              // Ejecutar exportación automática: forzar (ya sabemos que terminó)
              await maybeAutoExportOnEnd(hasData, true);
              // Si por algún motivo no marcó como exportada, subir backlog como respaldo
              try { if (!state.exported) await uploadBacklogIfEnabled(); } catch {}
              sendResponse?.({ ok: true, openedWindow: true, hasData });
            } else {
              sendResponse?.({ ok: true, openedWindow: false, hasData, exported: alreadyExported });
            }
          } catch (e) {
            sendResponse?.({ ok: false, error: String(e) });
          }
        })();
        return true;
      }
      case "MEETING_STARTED": {
        (async () => {
          try {
          // Reset mínimo de estado para nueva reunión
          state.exporting = false;
          state.exported = false;
          state.transcript = [];
          state.startedAt = Date.now();
          lastMeetingEndedAt = 0;
          try { await chrome.storage?.local?.set?.({ transcriptCache: [], startedAt: state.startedAt, exportedSessionAt: null, exportedAt: null }); } catch {}
          try { await chrome.storage?.local?.set?.({ uiExporting: false }); } catch {}
          // Notificar UI para refrescar (si está abierta)
          try { chrome.runtime?.sendMessage?.({ type: 'MEETING_STARTED' }); } catch {}
            sendResponse?.({ ok: true });
          } catch (e) {
            sendResponse?.({ ok: false, error: String(e) });
          }
        })();
        return true;
      }
      case "EXPORT_MD": {
        (async () => {
          // Exportar una sesión específica del backlog si viene sessionId
          try {
            const sid = msg?.payload?.sessionId;
            if (sid) {
              const evts = await getSessionTranscript(sid);
              if (evts && evts.length) {
                const res = await exportFromEvents(evts);
                sendResponse(res);
                return;
              }
            }
          } catch {}
          // Preferir los eventos del content script para evitar duplicados
          const evts = await getEventsFromActiveTab();
          if (evts && evts.length) {
            const res = await exportFromEvents(evts);
            sendResponse(res);
            return;
          }
          // Si el SW tiene transcript acumulado, exportar
          await ensureTranscriptLoaded();
          if (state.transcript && state.transcript.length) {
            const res = await exportNow();
            sendResponse(res);
            return;
          }
          // Fallback adicional: exportar directamente desde storage
          const resCache = await exportFromStorage();
          if (resCache?.ok) { sendResponse(resCache); return; }
          // Fallback: delegar exportación al content script por si los eventos están en otro frame
          try {
            let tabs = await new Promise((resolve) => {
              chrome.tabs.query({ active: true, lastFocusedWindow: true }, (t) => resolve(t || []));
            });
            let tab = tabs && tabs[0];
            const isMeet = (u) => /https:\/\/meet\.google\.com\//.test(String(u || ""));
            if (!tab?.id || !isMeet(tab.url)) {
              const allMeet = await new Promise((resolve) => {
                chrome.tabs.query({ url: "https://meet.google.com/*" }, (t) => resolve(t || []) );
              });
              tab = allMeet.find((t) => t.active) || allMeet[0];
            }
            if (tab?.id) {
              chrome.tabs.sendMessage(tab.id, { type: 'MVP_EXPORT' }, (res) => {
                const err = chrome.runtime.lastError;
                if (err) {
                  sendResponse({ ok: false, reason: 'Sin datos para exportar' });
                } else {
                  // content.js hará el DOWNLOAD_MD; aquí solo indicamos que se delegó
                  sendResponse({ ok: true, delegated: true });
                }
              });
              return;
            }
          } catch {}
          // Último recurso
          sendResponse({ ok: false, reason: 'Sin datos para exportar' });
        })();
        return true; // async
      }
      case "EXPORT_AND_PUSH": {
        (async () => {
          // Previene segundo disparo concurrente
          if (state.exporting) {
            sendResponse({ ok: false, reason: 'export_in_progress' });
            return;
          }
          state.exporting = true;
          try {
            chrome.runtime?.sendMessage?.({ type: 'EXPORTING_STATUS', payload: { exporting: true } });
            await chrome.storage?.local?.set?.({ uiExporting: true });
          } catch {}
          const silent = !!msg?.payload?.silent;
          const sessionId = msg?.payload?.sessionId;
          // Validación de correo obligatorio para exportar
          try {
            const data = await chrome.storage?.local?.get?.('userEmail');
            const email = String((data && data.userEmail) || '').trim();
            const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
            if (!valid) {
              state.exporting = false;
              sendResponse({ ok: false, reason: 'missing_email' });
              return;
            }
          } catch {
            state.exporting = false;
            sendResponse({ ok: false, reason: 'missing_email' });
            return;
          }
          // Decidir saltar descarga local según auto-subida o flag
          let skipDownload = !!msg?.payload?.noDownload;
          try {
            if (!skipDownload) {
              const cfg = await chrome.storage?.local?.get?.('autoUploadOnEnd');
              skipDownload = !!(cfg && cfg.autoUploadOnEnd);
            }
          } catch {}
          // Intentar obtener eventos recientes de la pestaña activa o por sessionId
          let items = [];
          if (sessionId) {
            items = await getSessionTranscript(sessionId);
          } else {
            items = await getEventsFromActiveTab();
          }
          // Si no hay, cargar del estado/storage
          if (!items || !items.length) {
            await ensureTranscriptLoaded();
            items = state.transcript || [];
          }
          if (!items || !items.length) {
            try {
              const data = await chrome.storage?.local?.get?.(['transcriptCache','startedAt']);
              const cache = Array.isArray(data?.transcriptCache) ? data.transcriptCache : [];
              if (cache.length) {
                items = cache;
                if (!state.startedAt) state.startedAt = (typeof data?.startedAt === 'number') ? data.startedAt : Date.now();
              }
            } catch {}
          }
          if (items && items.length) {
            try { await getSelfName(); } catch {}
            try { await ensureSelfNameFromTab(); } catch {}
            const base = buildFileBase();
            const content = formatMD(items);
            const blob = new Blob([content], { type: 'text/plain' });
            // Descargar local y subir a Supabase en paralelo
            const userEmailData = await chrome.storage?.local?.get?.('userEmail').catch(() => ({}));
            const meta = {
              startedAt: state.startedAt || Date.now(),
              endedAt: Date.now(),
              lines: items.length,
              userEmail: (userEmailData && userEmailData.userEmail) ? String(userEmailData.userEmail) : ''
            };
            try {
              // Descargar local (omitido si skipDownload)
              let downloadError = false;
              if (!skipDownload) {
                try {
                  await downloadMD(`${base}.txt`, content, { saveAs: !silent });
                } catch (e) {
                  console.warn('[Download] error:', e);
                  downloadError = true;
                }
              }
              // Luego intenta subir y devuelve info para notificación
              let up = null;
              try {
                up = await uploadToSupabase(blob, `${base}.txt`, meta);
              } catch (e) {
                console.error('[Supabase] upload error:', e);
              }
              // Si era una sesión del backlog y subió OK, marcar/exportada y remover
              if (sessionId && up && up.ok) { try { await markSessionExported(sessionId); } catch {} }
              sendResponse({ ok: true, uploaded: !!(up && up.ok), public_url: up?.public_url, path: up?.path, id: up?.id, download_error: downloadError });
            } finally {
              state.exporting = false;
              try {
                chrome.runtime?.sendMessage?.({ type: 'EXPORTING_STATUS', payload: { exporting: false } });
                await chrome.storage?.local?.set?.({ uiExporting: false });
              } catch {}
            }
            return;
          }
          // Si no pudimos obtener datos, delegar a content script para descarga local como último recurso
          try {
            let tabs = await new Promise((resolve) => {
              chrome.tabs.query({ active: true, lastFocusedWindow: true }, (t) => resolve(t || []));
            });
            let tab = tabs && tabs[0];
            const isMeet = (u) => /https:\/\/meet\.google\.com\//.test(String(u || ""));
            if (!tab?.id || !isMeet(tab.url)) {
              const allMeet = await new Promise((resolve) => {
                chrome.tabs.query({ url: "https://meet.google.com/*" }, (t) => resolve(t || []) );
              });
              tab = allMeet.find((t) => t.active) || allMeet[0];
            }
            if (tab?.id) {
              chrome.tabs.sendMessage(tab.id, { type: 'MVP_EXPORT' }, (res) => {
                const err = chrome.runtime.lastError;
                if (err) {
                  sendResponse({ ok: false, reason: 'Sin datos para exportar' });
                } else {
                  // No se pudo subir (sin datos), pero al menos delegamos la descarga
                  sendResponse({ ok: true, delegated: true });
                }
              });
              return;
            }
          } catch {}
          state.exporting = false;
          sendResponse({ ok: false, reason: 'Sin datos para exportar' });
        })();
        return true; // async
      }
      case "CLEAR_TRANSCRIPT": {
        state.transcript = [];
        state.startedAt = null;
        state.exported = false; // permitir reabrir popup sin autocierre
        try {
          chrome.storage?.local?.set?.({ transcriptCache: [], startedAt: null, exportedSessionAt: null, exportedAt: null });
        } catch {}
        sendResponse?.({ ok: true });
        return;
      }
      case "CLEAR_SESSION": {
        (async () => {
          try {
            const sid = msg?.payload?.sessionId;
            if (!sid) { sendResponse?.({ ok: false, error: 'missing_sessionId' }); return; }
            await removeSessionById(sid);
            sendResponse?.({ ok: true });
          } catch (e) {
            sendResponse?.({ ok: false, error: String(e) });
          }
        })();
        return true;
      }
      case "DOWNLOAD_MD": {
        // msg.filename y msg.content vienen desde content.js
        downloadMD(msg.filename, msg.content)
          .then((id) => sendResponse({ ok: true, id }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true; // async
      }
      default:
        sendResponse?.({ ok: false, reason: "Tipo de mensaje no reconocido" });
    }
  } catch (e) {
    console.error("[Meet Transcriber] onMessage error:", e);
    sendResponse?.({ ok: false, reason: String(e) });
  }
});
// Fallback: detectar cierre de pestaña de Meet y disparar auto‑export
try {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    try {
      const url = String(changeInfo?.url || tab?.url || '');
      const isMeet = /https:\/\/meet\.google\.com\//.test(url);
      const codeRe = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\b|\?|$)/i;
      if (isMeet) meetTabIds.add(tabId);
      // Si entramos a una reunión (URL con código), abrir ventana sólo si auto‑subida está activada
      if (isMeet && codeRe.test(url)) {
        (async () => { try { if (await isAutoUploadEnabled()) await openExportWindow(); } catch {} })();
      } else if (meetTabIds.has(tabId) && !isMeet) {
        meetTabIds.delete(tabId);
      }
    } catch {}
  });
  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    try {
      if (!meetTabIds.has(tabId)) return;
      meetTabIds.delete(tabId);
      (async () => {
        try {
          await ensureTranscriptLoaded();
          const hasData = !!(state.transcript && state.transcript.length);
          if (hasData) { try { await saveCurrentSessionToBacklog(); } catch {} }
          await maybeAutoExportOnEnd(hasData);
          try { await uploadBacklogIfEnabled(); } catch {}
        } catch (e) {
          console.warn('[MEETIX] onRemoved autoExport error:', e);
        }
      })();
    } catch {}
  });
} catch (e) {
  console.warn('[MEETIX] tabs listeners register error:', e);
}
