let uiExporting = false;

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

  // Inicializar UI de correo (mostrar sólo si no está guardado)
  try {
    const wrap = document.getElementById('emailWrap');
    const msgEl = document.getElementById('emailMsg');
    const nameMsgEl = document.getElementById('nameMsg');
    const inputEl = document.getElementById('email');
    const nameEl = document.getElementById('selfName');
    const btnSave = document.getElementById('saveEmail');
    const editLink = document.getElementById('editEmailLink');
    const emailView = document.getElementById('emailView');
    const nameView = document.getElementById('nameView');
    const emailText = document.getElementById('emailText');
    const nameText = document.getElementById('nameText');
    const autoToggle = document.getElementById('autoUpload');
    const autoMsg = document.getElementById('autoMsg');
    const data = await chrome.storage?.local?.get?.(['userEmail','selfName']);
    const hasEmail = !!(data && data.userEmail);
    const hasName = !!(data && data.selfName);
    const hasProfile = hasEmail && hasName;
    if (wrap) wrap.style.display = hasProfile ? 'none' : 'block';
    if (editLink) editLink.style.display = hasProfile ? 'inline' : 'none';
    if (emailView) emailView.style.display = hasEmail ? 'block' : 'none';
    if (nameView) nameView.style.display = hasName ? 'block' : 'none';
    if (emailText && hasEmail) emailText.textContent = String(data.userEmail);
    if (nameText && hasName) nameText.textContent = String(data.selfName);
    try {
      const s = await chrome.storage?.local?.get?.('autoUploadOnEnd');
      const enabled = !!(s && s.autoUploadOnEnd);
      if (autoToggle) autoToggle.checked = enabled;
      if (autoMsg) autoMsg.textContent = enabled ? '' : '';
      // Guardar cambios
      if (autoToggle) {
        autoToggle.addEventListener('change', async () => {
          try {
            await chrome.storage?.local?.set?.({ autoUploadOnEnd: !!autoToggle.checked });
          } catch {}
        });
      }
    } catch {}
    if (editLink && inputEl && nameEl && wrap) {
      editLink.addEventListener('click', async () => {
        try {
          const cur = await chrome.storage?.local?.get?.(['userEmail','selfName']);
          const email = (cur && cur.userEmail) ? String(cur.userEmail) : '';
          const sname = (cur && cur.selfName) ? String(cur.selfName) : '';
          inputEl.value = email;
          nameEl.value = sname;
        } catch {}
        wrap.style.display = 'block';
        editLink.style.display = 'none';
        if (emailView) emailView.style.display = 'none';
        if (nameView) nameView.style.display = 'none';
        if (msgEl) { msgEl.textContent = ''; msgEl.style.color = '#2e7d32'; }
        if (nameMsgEl) { nameMsgEl.textContent = ''; nameMsgEl.style.color = '#2e7d32'; }
      });
    }
    if (btnSave && inputEl && nameEl) {
      btnSave.addEventListener('click', async () => {
        const val = String(inputEl.value || '').trim();
        const nameVal = String(nameEl.value || '').trim();
        const validEmail = /^[^\s@]+@[^\s@]+\.com(?:\.ar)?$/.test(val);
        const validName = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s.'-]{1,}$/.test(nameVal);
        if (!validEmail || !validName) {
          if (!validEmail && msgEl) { msgEl.textContent = 'Correo inválido (.com o .com.ar requerido)'; msgEl.style.color = '#8a1c1f'; }
          if (!validName && nameMsgEl) { nameMsgEl.textContent = 'Nombre inválido'; nameMsgEl.style.color = '#8a1c1f'; }
          return;
        }
        try {
          await chrome.storage?.local?.set?.({ userEmail: val, selfName: nameVal });
          try { await send('SELF_NAME_UPDATED'); } catch {}
          if (msgEl) { msgEl.textContent = 'Guardado'; msgEl.style.color = '#2e7d32'; }
          if (nameMsgEl) { nameMsgEl.textContent = 'Guardado'; nameMsgEl.style.color = '#2e7d32'; }
          if (wrap) wrap.style.display = 'none';
          if (editLink) editLink.style.display = 'inline';
          if (emailView) { emailView.style.display = 'block'; }
          if (nameView) { nameView.style.display = 'block'; }
          if (emailText) { emailText.textContent = val; }
          if (nameText) { nameText.textContent = nameVal; }
        } catch (e) {
          if (msgEl) { msgEl.textContent = 'Error guardando correo'; msgEl.style.color = '#8a1c1f'; }
          if (nameMsgEl) { nameMsgEl.textContent = 'Error guardando nombre'; nameMsgEl.style.color = '#8a1c1f'; }
        }
      });
      // Validación en tiempo real y deshabilitar botón si alguno es inválido
      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.com(?:\.ar)?$/;
      const NAME_RE = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s.'-]{1,}$/;
      const validateProfileUI = () => {
        try {
          const val = String(inputEl.value || '').trim();
          const nameV = String(nameEl.value || '').trim();
          const okEmail = EMAIL_RE.test(val);
          const okName = NAME_RE.test(nameV);
          const ok = okEmail && okName;
          if (btnSave) btnSave.disabled = !ok;
          if (msgEl) {
            msgEl.textContent = okEmail ? '' : 'Correo inválido (.com o .com.ar requerido)';
            msgEl.style.color = okEmail ? '#2e7d32' : '#8a1c1f';
          }
          if (nameMsgEl) {
            nameMsgEl.textContent = okName ? '' : 'Nombre inválido';
            nameMsgEl.style.color = okName ? '#2e7d32' : '#8a1c1f';
          }
          inputEl.setAttribute('aria-invalid', String(!okEmail));
          nameEl.setAttribute('aria-invalid', String(!okName));
        } catch {}
      };
      try {
        inputEl.addEventListener('input', validateProfileUI);
        inputEl.addEventListener('blur', validateProfileUI);
        nameEl.addEventListener('input', validateProfileUI);
        nameEl.addEventListener('blur', validateProfileUI);
        // Inicializar estado al mostrar el formulario
        validateProfileUI();
      } catch {}
    }
  } catch {}
})();

function setBusy(on) {
  try {
    const busy = document.getElementById('busy');
    if (!busy) return;
    busy.style.display = on ? 'flex' : 'none';
    const card = document.getElementById('session-card');
    const hdr = document.querySelector('.header-row');
    const sessions = document.getElementById('sessions');
    if (card) card.style.display = on ? 'none' : (card.style.display || 'flex');
    if (hdr) hdr.style.display = on ? 'none' : 'flex';
    if (sessions) sessions.style.display = on ? 'none' : (sessions.style.display || 'block');
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
        box.textContent = 'Completa nombre y correo para exportar (descargar y subir).';
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
        box.textContent = 'Ingresa un correo para exportar (descargar y subir).';
        box.style.display = 'block';
        // Mostrar el formulario de correo si está oculto
        try {
          const wrap = document.getElementById('emailWrap');
          if (wrap) wrap.style.display = 'block';
        } catch {}
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
