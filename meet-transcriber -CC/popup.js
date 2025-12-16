let uiExporting = false;
let uiLastHasUser = null; // estado previo de sesión para mostrar spinner solo en transiciones
let uiAuthFlashLock = false; // evita flashes simultáneos
// Flags de UI persistentes se manejan vía chrome.storage.local

function flashSpinner(message, ms = 1500, mode = 'login') {
  try {
    if (uiAuthFlashLock) return;
    uiAuthFlashLock = true;
    const busy = document.getElementById('busy');
    if (!busy) return;
    // Aplicar variante visual
    busy.classList.remove('login','logout');
    busy.classList.add(mode === 'logout' ? 'logout' : 'login');
    const label = busy.querySelector('span');
    const prevText = label ? label.textContent : 'Procesando…';
    const defaultMsg = mode === 'logout' ? 'Cerrando sesión de TaskFlow…' : 'Autenticando…';
    if (label) label.textContent = message || defaultMsg;
    setBusy(true);
    setTimeout(() => {
      try { if (label) label.textContent = prevText || 'Procesando…'; } catch {}
      busy.classList.remove('login','logout');
      // Si hay exportación en curso, mantenemos el spinner visible
      if (!uiExporting) setBusy(false);
      uiAuthFlashLock = false;
    }, ms);
  } catch {}
}

function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return resolve({ ok:false, error: err.message });
      resolve(res);
    });
  });
}

// ping al abrir para activar el SW
(async () => {
  // Si se abre con busy=1, mostrar spinner inmediatamente
  try {
    const initBusy = window.location.search.includes('busy=1');
    if (initBusy) setBusy(true);
  } catch {}
  const r = await send("PING");
  if (!r?.ok) {
    // pequeño retry por si el SW tardó en levantarse
    setTimeout(() => send("PING"), 300);
  }
  // Refrescar tarjeta de sesión
  try { await refreshSessionCard(); } catch {}
  // Renderizar listado al iniciar
  try { await renderSessionsList(false); } catch {}
  // Sincronizar estado inicial de exportación desde storage (fallback si se perdió el mensaje)
  try {
    const s = await chrome.storage?.local?.get?.('uiExporting');
    uiExporting = !!(s && s.uiExporting);
    setBusy(uiExporting);
    const wrap = document.getElementById('sessions');
    if (wrap) wrap.style.display = uiExporting ? 'none' : 'block';
    document.querySelectorAll('#sessionsList .btn-icon').forEach(b => b.disabled = uiExporting);
  } catch {}
  // Auto‑refresh mientras auto‑subida está activa o ventana auto=1
  try {
    const isAutoWin = window.location.search.includes('auto=1');
    if (isAutoWin) {
      const interval = setInterval(async () => { try { await refreshSessionCard(); } catch {} }, 500);
      window.addEventListener('unload', () => clearInterval(interval));
    }
  } catch {}
  // Escuchar cambios en sesiones (SESSIONS_UPDATED) y refrescar listado solo cuando cambie
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'SESSIONS_UPDATED') {
        renderSessionsList(false);
      }
      if (msg && msg.type === 'EXPORTING_STATUS') {
        const exporting = !!(msg?.payload?.exporting);
        uiExporting = exporting;
        try {
          setBusy(exporting);
          const wrap = document.getElementById('sessions');
          if (wrap) wrap.style.display = exporting ? 'none' : 'block';
        } catch {}
        try { document.querySelectorAll('#sessionsList .btn-icon').forEach(b => b.disabled = exporting); } catch {}
      }
      if (msg && msg.type === 'AUTO_UPLOAD_DONE') {
        try {
          // evitar parpadeo: mantener spinner un mínimo breve
          setTimeout(() => setBusy(false), 300);
          const wrap = document.getElementById('sessions');
          if (wrap) wrap.style.display = 'block';
        } catch {}
        try { document.querySelectorAll('#sessionsList .btn-icon').forEach(b => b.disabled = false); } catch {}
        try {
          const box = document.getElementById('supabaseNotice');
          if (box) {
            if (msg?.payload?.uploaded) {
              box.className = 'notice success';
              box.textContent = 'Subida completada ✔';
              box.style.display = 'block';
            } else {
              box.className = 'notice error';
              box.textContent = 'Error al subir a Supabase';
              box.style.display = 'block';
            }
          }
        } catch {}
      }
      if (msg && msg.type === 'MEETING_STARTED') {
        // Reset visual: ocultar avisos y spinner
        try { setBusy(false); uiExporting = false; } catch {}
        try {
          const box = document.getElementById('supabaseNotice');
          if (box) { box.style.display = 'none'; }
        } catch {}
        try { refreshSessionCard(); } catch {}
      }
    });
  } catch {}

  // Renderizar requisito de inicio de sesión (sin inputs ni botón)
  try {
    await renderLoginRequirement();
  } catch {}
  // Sincronizar toggle de auto-subida
  try { await syncAutoUploadToggle(); } catch {}
})();

function setBusy(on) {
  try {
    const busy = document.getElementById('busy');
    if (!busy) return;
    busy.style.display = on ? 'flex' : 'none';
    const card = document.getElementById('session-card');
    const hdr = document.getElementById('featuresHeader') || document.querySelector('.header-row');
    const sessions = document.getElementById('sessions');
    const loginMsg = document.getElementById('loginRequired');
    const allowUI = !(loginMsg && loginMsg.style.display !== 'none'); // true si login NO está visible
    if (card) card.style.display = on ? 'none' : (allowUI ? (card.style.display || 'flex') : 'none');
    if (hdr) hdr.style.display = on ? 'none' : (allowUI ? 'flex' : 'none');
    if (sessions) sessions.style.display = on ? 'none' : (allowUI ? (sessions.style.display || 'block') : 'none');
  } catch {}
}

// Renderizar aviso de login en TaskFlow y sincronizar perfil (userEmail/selfName) con lastPageLocalStorage
async function renderLoginRequirement() {
  try {
    const emailWrap = document.getElementById('emailWrap');
    const emailView = document.getElementById('emailView');
    const nameView = document.getElementById('nameView');
    const emailText = document.getElementById('emailText');
    const nameText = document.getElementById('nameText');
    const profileCard = document.getElementById('profileCard');
    const notice = document.getElementById('supabaseNotice');
    const loginBox = document.getElementById('loginRequired');
    const hdr = document.getElementById('featuresHeader') || document.querySelector('.header-row');
    const infoBanner = document.getElementById('infoBanner');
    const sessions = document.getElementById('sessions');
    const subsInfo = document.getElementById('subsInfo');
    const card = document.getElementById('session-card');

    // Nunca mostrar inputs/botón de email
    if (emailWrap) emailWrap.style.display = 'none';

    const s = await chrome.storage?.local?.get?.(['lastPageLocalStorage','userEmail','selfName','uiPrevHasUser','uiInitialEmptySpinnerShown']);
    const last = s?.lastPageLocalStorage;
    const user = last?.data?.user;
    const hasUser = !!(user && user.email && (user.full_name || user.name));
    const prevHadUser = !!(s && s.uiPrevHasUser);
    const initialEmptyShown = !!(s && s.uiInitialEmptySpinnerShown);
    const hasLastKey = !!(s && Object.prototype.hasOwnProperty.call(s, 'lastPageLocalStorage'));

    if (hasUser) {
      // Mostrar spinner solo en la primera detección de login o transición real desde sin sesión
      try {
        if (prevHadUser !== true) {
          flashSpinner('Autenticando…', 1500, 'login');
        }
      } catch {}
      const email = String(user.email || '');
      const fullname = String(user.full_name || user.name || '');
      // Sincronizar perfil local para el resto del flujo que depende de userEmail/selfName
      try { await chrome.storage?.local?.set?.({ userEmail: email, selfName: fullname, userName: fullname, uiPrevHasUser: true }); } catch {}
      // Mostrar datos de sesión
      if (notice) notice.style.display = 'none';
      if (loginBox) loginBox.style.display = 'none';
      if (hdr) hdr.style.display = 'flex';
      // Mantener infoBanner controlado por refreshSessionCard (meetingActive + autoUpload)
      if (infoBanner) infoBanner.style.display = infoBanner.style.display || 'none';
      if (subsInfo) subsInfo.style.display = 'block';
      if (sessions) sessions.style.display = 'block';
      // No tocar session-card aquí; lo maneja refreshSessionCard
      if (profileCard) profileCard.style.display = 'block';
      if (emailView) emailView.style.display = email ? 'block' : 'none';
      if (nameView) nameView.style.display = fullname ? 'block' : 'none';
      if (emailText) emailText.textContent = email;
      if (nameText) nameText.textContent = fullname;
    } else {
      // Limpiar perfil y mostrar aviso de login requerido
      try { await chrome.storage?.local?.remove?.(['userEmail','selfName','userName']); } catch {}
      if (emailView) emailView.style.display = 'none';
      if (nameView) nameView.style.display = 'none';
      // Mostrar spinner profesional al limpiar sesión
      try {
        // Condiciones para mostrar spinner en "sin sesión":
        // 1) Transición real de sesión → sin sesión (persistente)
        // 2) Si existe lastPageLocalStorage pero está vacío (solo una vez)
        //    No mostrar nada si la clave no existe (primer instalación).
        if (prevHadUser === true) {
          flashSpinner('Cerrando sesión de TaskFlow…', 1500, 'logout');
          try { await chrome.storage?.local?.set?.({ uiPrevHasUser: false, uiInitialEmptySpinnerShown: true }); } catch {}
        } else if (hasLastKey && !initialEmptyShown) {
          flashSpinner('Cerrando sesión de TaskFlow…', 1500, 'logout');
          try { await chrome.storage?.local?.set?.({ uiInitialEmptySpinnerShown: true }); } catch {}
        }
      } catch {}
      if (profileCard) profileCard.style.display = 'none';
      if (notice) notice.style.display = 'none';
      if (loginBox) loginBox.style.display = 'block';
      if (hdr) hdr.style.display = 'none';
      if (infoBanner) infoBanner.style.display = 'none';
      if (subsInfo) subsInfo.style.display = 'none';
      if (sessions) sessions.style.display = 'none';
      // No tocar session-card aquí; queda oculto por defecto
    }
    // Actualizar estado previo para futuras transiciones
    uiLastHasUser = !!hasUser;
    // Persistir última impresión de sesión para próximas aperturas
    try { await chrome.storage?.local?.set?.({ uiPrevHasUser: !!hasUser }); } catch {}
  } catch {}
}

async function refreshSessionCard() {
  // Obtener info de sesión desde SW y pestaña activa
  const info = await send('GET_SESSION_INFO');
  const card = document.getElementById('session-card');
  const banner = document.getElementById('infoBanner');
  // Eliminado: tarjeta de estado vacío
  if (!info?.ok) { card.style.display = 'none'; if (banner) banner.style.display = 'none'; return; }
  const { meetingCode, startedAt, endedAt, lines, meetingActive, exporting, exported } = info;
  const isAutoWin = window.location.search.includes('auto=1');
  // Mostrar/ocultar spinner.
  // Mantener spinner en ventana auto‑abierta aunque aún no marque 'exporting',
  // y ocultarlo sólo cuando ya se haya exportado.
  try {
    const isExporting = uiExporting || !!exporting;
    setBusy(isExporting);
    try { document.querySelectorAll('#sessionsList .btn-icon').forEach(b => b.disabled = isExporting); } catch {}
  } catch {}
  // Deshabilitar el botón de descarga mientras exporta
  try {
    const btnGlobal = document.getElementById('download');
    if (btnGlobal) btnGlobal.disabled = !!exporting;
  } catch {}
  // Si la sesión ya fue exportada, ocultar tarjeta y spinner; el usuario decide si cierra
  if (exported) {
    try {
      const card = document.getElementById('session-card');
      const banner = document.getElementById('infoBanner');
      if (banner) banner.style.display = 'none';
      if (card) card.style.display = 'none';
      setBusy(false);
    } catch {}
    return;
  }
  // Durante la reunión (hay pestaña de Meet activa): no mostrar tarjeta
  if (meetingActive) {
    if (card) card.style.display = 'none'; // no usar card; listado único
    // Mostrar banner SOLO si auto‑subida está activada
    try {
      const s = await chrome.storage?.local?.get?.('autoUploadOnEnd');
      const autoEnabled = !!(s && s.autoUploadOnEnd);
      if (banner) banner.style.display = autoEnabled ? 'block' : 'none';
    } catch { if (banner) banner.style.display = 'none'; }
    return;
  }
  // Ocultar banner fuera de la reunión
  if (banner) banner.style.display = 'none';
  // Reunión finalizada o sin pestaña activa: mostrar tarjeta siempre
  const dateEl = document.getElementById('date');
  const timeEl = document.getElementById('time');
  const btnDownload = document.getElementById('download');
  const statusEl = document.getElementById('status');
  const fmt = (ts) => new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  // Perfil (nombre + correo) requerido para exportar
  let hasEmail = false, hasName = false;
  try {
    const s = await chrome.storage?.local?.get?.(['userEmail','selfName']);
    hasEmail = !!(s && s.userEmail);
    hasName = !!(s && s.selfName);
  } catch {}
  const hasProfile = hasEmail && hasName;
  try {
    const d = new Date(startedAt || Date.now());
    const monthNames = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    dateEl.textContent = `${monthNames[d.getMonth()]} ${String(d.getDate()).padStart(2,'0')}`;
  } catch { dateEl.textContent = '—'; }
  // Mostrar tarjeta SOLO si hay líneas (evitar descargas vacías)
  const startStr = startedAt ? fmt(startedAt) : '—';
  const endStr = endedAt ? fmt(endedAt) : '—';
  // No usar el card en esta vista: listado único
  if (card) card.style.display = 'none';

  // Auto‑subida la maneja el Service Worker; en popup solo mostramos spinner según 'exporting'.
  // Renderizar listado de sesiones guardadas una vez (no interval)
  try { await renderSessionsList(false); } catch {}
}

async function safeSend(type, payload, retries = 2, delay = 250) {
  let res = await send(type, payload);
  if (res?.error?.includes("Receiving end does not exist") && retries > 0) {
    await new Promise(r => setTimeout(r, delay));
    return safeSend(type, payload, retries - 1, delay * 2);
  }
  return res;
}

// Sincroniza el checkbox de auto-subida con storage y mantiene cambios
async function syncAutoUploadToggle() {
  try {
    const autoToggle = document.getElementById('autoUpload');
    if (!autoToggle) return;
    const s = await chrome.storage?.local?.get?.('autoUploadOnEnd');
    const enabled = !!(s && s.autoUploadOnEnd);
    autoToggle.checked = enabled;
    if (!autoToggle.dataset.bound) {
      autoToggle.addEventListener('change', async () => {
        try { await chrome.storage?.local?.set?.({ autoUploadOnEnd: !!autoToggle.checked }); } catch {}
      });
      autoToggle.dataset.bound = '1';
    }
  } catch {}
}

// Controles de captura (si existen en el DOM)
const btnStart = document.getElementById('start');
if (btnStart) {
  btnStart.addEventListener('click', async () => {
    await safeSend('CAPTURE_TOGGLE', { enabled: true });
    await safeSend('MVP_START');
    window.close();
  });
}
const btnStop = document.getElementById('stop');
if (btnStop) {
  btnStop.addEventListener('click', async () => {
    await safeSend('CAPTURE_TOGGLE', { enabled: false });
    await safeSend('MVP_STOP');
    window.close();
  });
}
document.getElementById('download').addEventListener('click', async () => {
  const btn = document.getElementById('download');
  if (btn) btn.disabled = true;
  setBusy(true);
  // Verificar perfil completo antes de exportar
  try {
    const s = await chrome.storage?.local?.get?.(['userEmail','selfName']);
    const hasEmail = !!(s && s.userEmail);
    const hasName = !!(s && s.selfName);
    if (!hasEmail || !hasName) {
      const box = document.getElementById('supabaseNotice');
      if (box) {
        box.className = 'notice error';
        box.textContent = 'Debes iniciar sesión en TaskFlow para exportar.';
        box.style.display = 'block';
      }
      setBusy(false);
      if (btn) btn.disabled = false;
      return;
    }
  } catch {}
  const r = await safeSend('EXPORT_AND_PUSH', { silent: false, noDownload: true });
  // Notificación de subida
  try {
    const box = document.getElementById('supabaseNotice');
    if (box) {
      if (r?.reason === 'missing_email') {
        box.className = 'notice error';
        box.textContent = 'Debes iniciar sesión en TaskFlow para exportar.';
        box.style.display = 'block';
      } else
      if (r?.ok && r?.uploaded) {
        box.className = 'notice success';
        const url = r?.public_url || '';
        const dl = r?.download_error ? ' · Descarga local no disponible' : '';
        box.innerHTML = url ? `Archivo subido exitosamente ✔${dl} · <a href="${url}" target="_blank" rel="noopener">Abrir</a>` : `Archivo subido exitosamente ✔${dl}`;
        box.style.display = 'block';
        // Ocultar tarjeta tras subir y limpiar estado
        try {
          const card = document.getElementById('session-card');
          const empty = document.getElementById('empty');
          if (card) card.style.display = 'none';
          if (empty) empty.style.display = 'block';
          await safeSend('CLEAR_TRANSCRIPT');
        } catch {}
      } else if (r?.ok && !r?.uploaded) {
        box.className = 'notice error';
        box.textContent = 'Error al subir a Supabase';
        box.style.display = 'block';
      } else {
        box.className = 'notice error';
        // Silenciar mensaje si hay exportación en progreso
        if (r?.reason === 'export_in_progress') {
          box.style.display = 'none';
        } else {
          box.textContent = r?.reason || r?.error || 'Error al exportar';
          box.style.display = 'block';
        }
      }
    }
  } catch {}
  // Si está exportando, no hacer fallback ni mostrar alertas
  if (r?.reason === 'export_in_progress') return;
  if (r?.reason === 'missing_email') { if (btn) btn.disabled = false; return; }
  setBusy(false);
  if (btn) setTimeout(() => { try { btn.disabled = false; } catch {} }, 1500);
  if (r?.ok) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'MVP_EXPORT' }, (res) => {
        const err = chrome.runtime.lastError;
        // Silenciar alertas en fallback
      });
      return;
    }
  } catch {}
  // Evitar mostrar alertas genéricas
});
// Listado de sesiones guardadas
function fmtItemDate(ts) {
  try {
    const d = new Date(ts);
    const monthNames = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    const day = `${monthNames[d.getMonth()]} ${String(d.getDate()).padStart(2,'0')}`;
    const hm = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
    return { day, hm };
  } catch { return { day:'—', hm:'—' }; }
}

async function renderSessionsList(disableActions) {
  const wrap = document.getElementById('sessions');
  const list = document.getElementById('sessionsList');
  if (!wrap || !list) return;
  // Mantener listado visible aunque haya spinner; los botones del card se deshabilitan individualmente
  const res = await safeSend('GET_SESSIONS');
  if (!res?.ok) { wrap.style.display = 'none'; return; }
  const sessions = Array.isArray(res.sessions) ? res.sessions : [];
  // Mostrar el título en negrita sólo si hay elementos en el listado
  try {
    const titleEl = wrap.querySelector('h4');
    if (titleEl) titleEl.style.display = sessions.length ? 'block' : 'none';
    const infoEl = document.getElementById('sessionsInfo');
    if (infoEl) infoEl.style.display = sessions.length ? 'inline' : 'none';
  } catch {}
  // Respetar estado de exportación: si está exportando, ocultar listado aunque existan sesiones
  if (uiExporting) {
    wrap.style.display = 'none';
  } else {
    wrap.style.display = sessions.length ? 'block' : 'none';
  }
  list.innerHTML = '';
  // Perfil para habilitar subidas manuales
  let hasProfile = false;
  try {
    const p = await chrome.storage?.local?.get?.(['userEmail','selfName']);
    hasProfile = !!(p && p.userEmail && p.selfName);
  } catch {}
  for (const s of sessions) {
    const { day, hm } = fmtItemDate(s.startedAt || Date.now());
    const item = document.createElement('div');
    item.className = 'session-item';
    item.innerHTML = `
      <div class="date">${day}</div>
      <div class="meta"><span>${hm} · ${s.lines || 0} líneas</span></div>
      <div class="actions">
        <button class="btn-icon btn-download" title="Subir"> <svg viewBox="0 0 24 24" class="arrow-icon arrow-up"><path fill="currentColor" d="M5 20h14v-2H5v2zm7-12c-.55 0-1 .45-1 1v5.17l-2.59-2.58L7 12l5 5 5-5-1.41-1.41L13 14.17V9c0-.55-.45-1-1-1z"/></svg></button>
        <button class="btn-icon btn-download-txt" title="Descargar .txt"> <svg viewBox="0 0 24 24" class="arrow-icon"><path fill="currentColor" d="M5 20h14v-2H5v2zm7-12c-.55 0-1 .45-1 1v5.17l-2.59-2.58L7 12l5 5 5-5-1.41-1.41L13 14.17V9c0-.55-.45-1-1-1z"/></svg></button>
        <button class="btn-icon btn-delete" title="Eliminar"> <svg viewBox="0 0 24 24"><path fill="currentColor" d="M16 9v10H8V9h8m-1.5-5h-5l-1 1H6v2h12V5h-2.5l-1-1Z"/></svg></button>
      </div>
    `;
    const [btnUp, btnTxt, btnDel] = item.querySelectorAll('button');
    const setCardBusy = (on) => {
      try { [btnUp, btnTxt, btnDel].forEach(b => b.disabled = !!on); } catch {}
    };
    btnUp.disabled = !!disableActions || !hasProfile;
    btnTxt.disabled = !!disableActions;
    btnDel.disabled = !!disableActions;
    btnUp.addEventListener('click', async () => {
      try {
        setCardBusy(true); setBusy(true);
        const r = await safeSend('EXPORT_AND_PUSH', { sessionId: s.id, noDownload: true });
        setBusy(false);
        const box = document.getElementById('supabaseNotice');
        if (box) {
          if (r?.ok && r?.uploaded) {
            box.className = 'notice success';
            const url = r?.public_url || '';
            box.innerHTML = url ? `Archivo subido ✔ · <a href="${url}" target="_blank" rel="noopener">Abrir</a>` : `Archivo subido ✔`;
            box.style.display = 'block';
            // Quitar tarjeta del DOM; el usuario decide si cierra el popup
            try { item.remove(); } catch {}
            return;
          } else {
            box.className = 'notice error';
            box.textContent = r?.reason || r?.error || 'Error al subir';
            box.style.display = 'block';
          }
        }
        setCardBusy(false);
        await renderSessionsList(false);
      } catch { setBusy(false); btnUp.disabled = false; }
    });
    btnTxt.addEventListener('click', async () => {
      try { setCardBusy(true); setBusy(true); await safeSend('EXPORT_MD', { sessionId: s.id }); } finally { setBusy(false); setCardBusy(false); }
    });
    btnDel.addEventListener('click', async () => {
      const ok = confirm('¿Eliminar esta conversación guardada?');
      if (!ok) return;
      try {
        setCardBusy(true);
        setBusy(true);
        const r = await safeSend('CLEAR_SESSION', { sessionId: s.id });
        if (r?.ok) {
          // Mostrar aviso; el usuario decide si cierra el popup
          const box = document.getElementById('supabaseNotice');
          if (box) {
            box.className = 'notice success';
            box.textContent = 'Transcripción eliminada';
            box.style.display = 'block';
          }
          return;
        } else {
          const box = document.getElementById('supabaseNotice');
          if (box) {
            box.className = 'notice error';
            box.textContent = r?.error || 'No se pudo eliminar la transcripción';
            box.style.display = 'block';
          }
        }
      } finally {
        setBusy(false);
        try { setCardBusy(false); } catch {}
      }
    });
    list.appendChild(item);
  }
}
// Botón descargar solo .txt
const btnDownloadTxt = document.getElementById('downloadTxt');
if (btnDownloadTxt) {
  btnDownloadTxt.addEventListener('click', async () => {
    try {
      btnDownloadTxt.disabled = true;
      setBusy(true);
      const r = await safeSend('EXPORT_MD');
      setBusy(false);
      const box = document.getElementById('supabaseNotice');
      if (box) {
        if (r?.ok) {
          box.className = 'notice success';
          box.textContent = 'Descarga local OK (.txt)';
          box.style.display = 'block';
        } else {
          box.className = 'notice error';
          box.textContent = r?.reason || r?.error || 'Sin datos para exportar';
          box.style.display = 'block';
        }
      }
    } finally {
      setBusy(false);
      setTimeout(() => { try { btnDownloadTxt.disabled = false; } catch {} }, 800);
    }
  });
}
// Botón eliminar conversación
const btnDelete = document.getElementById('delete');
if (btnDelete) {
  btnDelete.addEventListener('click', async () => {
    try {
      // Evitar eliminar durante exportación
      const info = await safeSend('GET_SESSION_INFO');
      if (info?.exporting) return;
      // Confirmación simple
      const ok = confirm('¿Eliminar la conversación actual? Esta acción no se puede deshacer.');
      if (!ok) return;
      btnDelete.disabled = true;
      setBusy(true);
      await safeSend('CLEAR_TRANSCRIPT');
      // Ocultar card y mostrar aviso
      try {
        const card = document.getElementById('session-card');
        if (card) card.style.display = 'none';
        const box = document.getElementById('supabaseNotice');
        if (box) {
          box.className = 'notice success';
          box.textContent = 'Conversación eliminada. No se subirá ni descargará.';
          box.style.display = 'block';
        }
      } catch {}
    } finally {
      setBusy(false);
      btnDelete.disabled = false;
    }
  });
}
// Botón eliminar eliminado

// Iniciar nuevamente desde estado vacío
let pollTimer = null;
// Poll liviano: sincroniza estado de exportación desde storage por si se pierde el mensaje
try {
  pollTimer = setInterval(async () => {
    try {
      const s = await chrome.storage?.local?.get?.('uiExporting');
      const flag = !!(s && s.uiExporting);
      if (flag !== uiExporting) {
        uiExporting = flag;
        setBusy(flag);
        const wrap = document.getElementById('sessions');
        if (wrap) wrap.style.display = flag ? 'none' : 'block';
        document.querySelectorAll('#sessionsList .btn-icon').forEach(b => b.disabled = flag);
      }
    } catch {}
  }, 900);
  window.addEventListener('unload', () => { try { clearInterval(pollTimer); } catch {} });
} catch {}

// Re-renderizar UI de sesión cuando cambie lastPageLocalStorage (login/logout de TaskFlow)
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    try {
      if (area !== 'local') return;
      if (changes?.lastPageLocalStorage) {
        renderLoginRequirement();
      }
      if (changes?.autoUploadOnEnd) {
        syncAutoUploadToggle();
      }
    } catch {}
  });
} catch {}
