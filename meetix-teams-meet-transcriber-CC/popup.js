// Popup (MV3): UI de estado, copia/guardado y administración de historial de sesiones
// --- Constants for DOM Elements and Data ---
const UI_ELEMENTS = {
    statusMessage: document.getElementById('status-message'),
    sessionList: document.getElementById('sessionList')
};


// AI templates removed

let currentDefaultFormat = 'txt';

// --- Error Handling ---
function safeExecute(fn, context = '', fallback = null) {
    try {
        return fn();
    } catch (error) {
        console.error(`[Teams Caption Saver] ${context}:`, error);
        return fallback;
    }
}

// --- Utility Functions ---
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function isTeamsUrl(u) {
    return /^https:\/\/(teams\.(microsoft|live|office)\.com)\//.test(String(u || ''));
}
function isMeetUrl(u) {
    return /^https:\/\/meet\.google\.com\//.test(String(u || ''));
}
// Obtiene la pestaña activa si es Meet/Teams para operar sobre ella
async function getActiveCallTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs.find(t => isTeamsUrl(t.url) || isMeetUrl(t.url));
    return tab || null;
}

// Aplica alias de oradores y devuelve texto con timestamps listo para copiar/guardar
async function formatTranscript(transcript, aliases, type = 'standard') {
    const processed = transcript.map(entry => ({
        ...entry,
        Name: aliases[entry.Name] || entry.Name
    }));
    return processed.map(entry => `[${entry.Time}] ${entry.Name}: ${entry.Text}`).join('\n');
}

// --- UI Update Functions ---
// Muestra un estado con retardo mínimo para evitar parpadeos en la UI
function setStatusMessageDelayed(text, color, minMs = 500) {
    try {
        const { statusMessage } = UI_ELEMENTS;
        if (!statusMessage) return;
        const start = window.__statusInitAt || Date.now();
        const now = Date.now();
        const wait = Math.max(0, minMs - (now - start));
        const apply = () => {
            statusMessage.style.display = '';
            statusMessage.textContent = text || '';
            if (color) statusMessage.style.color = color;
        };
        if (wait > 0) {
            setTimeout(apply, wait);
        } else {
            apply();
        }
    } catch {}
}

// Actualiza el mensaje principal según si hay reunión y si la captura está activa
async function updateStatusUI({ capturing, captionCount, isInMeeting }) {
    if (isInMeeting) {
        if (capturing) {
            const text = captionCount > 0 ? `¡Capturando! (${captionCount} líneas registradas)` : 'Capturando… (Esperando voz)';
            setStatusMessageDelayed(text, captionCount > 0 ? '#28a745' : '#ffc107');
        } else {
            setStatusMessageDelayed('En reunión, pero los subtítulos están desactivados.', '#dc3545');
        }
    } else {
        setStatusMessageDelayed('Esperando a que inicie una llamada', '#ffc107');
    }
}

function updateButtonStates(_hasData) {
    // No header buttons
}

function updateSaveButtonText(_format) {}



// AI template management removed


// --- Settings ---
async function loadSettings() {}

async function loadAccountInfo() {
    const card = document.getElementById('accountCard');
    try {
        const local = await chrome.storage.local.get(['selfName','userEmail']);
        let name = String(local?.selfName || '').trim();
        let email = String(local?.userEmail || '').trim();
        if (!name || !email) {
            const sync = await chrome.storage.sync.get(['accountName','accountEmail']);
            name = name || String(sync?.accountName || '').trim();
            email = email || String(sync?.accountEmail || '').trim();
        }
        if (name || email) {
            document.getElementById('accountName').textContent = name || '-';
            document.getElementById('accountEmail').textContent = email || '-';
            card.style.display = 'block';
        } else {
            card.style.display = 'none';
        }
    } catch {
        card.style.display = 'none';
    }
}


// --- Event Handling ---
function setupEventListeners() {}

function setupDropdown(mainButton, dropdownButton, optionsContainer, actionHandler) {
    if (mainButton) {
        mainButton.addEventListener('click', () => optionsContainer.firstElementChild.click());
    }
    dropdownButton.addEventListener('click', (e) => {
        e.stopPropagation();
        optionsContainer.style.display = 'block';
    });
    optionsContainer.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        actionHandler(e.target);
        optionsContainer.style.display = 'none';
    });
}

// Copia al portapapeles la transcripción formateada desde la pestaña activa
async function handleCopy(target) {
    const copyType = target.dataset.copyType;
    if (!copyType) return;

    const tab = await getActiveCallTab();
    if (!tab) return;
    
    UI_ELEMENTS.statusMessage.textContent = "Preparando texto para copiar...";
    try {
        const response = await chrome.tabs.sendMessage(tab.id, { message: "get_transcript_for_copying" });
        if (response?.transcriptArray) {
            const { speakerAliases = {} } = await chrome.storage.session.get('speakerAliases');
            const formattedText = await formatTranscript(response.transcriptArray, speakerAliases, 'standard');
            await navigator.clipboard.writeText(formattedText);
            UI_ELEMENTS.statusMessage.textContent = "¡Copiado al portapapeles!";
            UI_ELEMENTS.statusMessage.style.color = '#28a745';
        }
    } catch (error) {
        UI_ELEMENTS.statusMessage.textContent = "Falló la copia.";
        UI_ELEMENTS.statusMessage.style.color = '#dc3545';
    }
}

// Solicita al content script que prepare la transcripción y dispare el guardado
async function handleSave(target) {
    const format = target.dataset.format;
    if (!format) return;
    
    const tab = await getActiveCallTab();
    if (tab) {
        UI_ELEMENTS.statusMessage.textContent = `Guardando como ${format.toUpperCase()}...`;
        chrome.tabs.sendMessage(tab.id, { message: "return_transcript", format });
    }
}

// --- Session History Management ---
// Inicializa el historial: carga SessionManager si falta y renderiza la lista
async function initializeSessionHistory() {
    try {
        if (typeof SessionManager !== 'function') {
            const script = document.createElement('script');
            script.src = 'sessionManager.js';
            document.head.appendChild(script);
            await new Promise(resolve => {
                script.onload = resolve;
                setTimeout(resolve, 100);
            });
        }
        
        UI_ELEMENTS.sessionList.style.display = 'block';
        await loadSessionList();
        
        // Check if we have saved sessions and update button text
        const sessionManager = new SessionManager();
        const sessions = await sessionManager.getSessionIndex();
        
        // History header removed
        // Render login requirement and profile
        try { await renderLoginRequirement(); } catch {}
        // Listen to storage changes to re-render login UI
        try {
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes?.lastPageLocalStorage || changes?.userEmail || changes?.selfName) {
        renderLoginRequirement();
    }
    try {
        const nv = changes?.lastPageLocalStorage?.newValue;
        if (nv && nv.data && typeof nv.data === 'object' && Object.keys(nv.data).length > 0) {
            chrome.storage.local.set({ uiLogoutOnceShown: false });
        }
    } catch {}
});
        } catch {}
    } catch (error) {
        console.log('[Session History] Initialization skipped:', error.message);
    }
}

// Renderiza sesiones ordenadas y engancha acciones de subir/descargar/eliminar
async function loadSessionList() {
    try {
        const limitInfoEl = document.getElementById('limitInfo');
        const sessionManager = new SessionManager();
        const sessions = await sessionManager.getSessionIndex();
        // const stats = await sessionManager.getStorageStats();
        
        if (!sessions || sessions.length === 0) {
            UI_ELEMENTS.sessionList.innerHTML = '';
            if (limitInfoEl) limitInfoEl.style.display = 'none';
            return;
        }
        if (limitInfoEl) limitInfoEl.style.display = 'block';
        // Mostrar la más nueva arriba sin alterar el orden interno (FIFO)
        const sortedSessions = [...sessions].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        let html = '';
        for (const session of sortedSessions) {
            const timeAgo = getTimeAgo(new Date(session.timestamp));
            const isMeet = session.source === 'meet';
            const isTeams = session.source === 'teams';
            const bgColor = isMeet ? '#ffe8cc' : isTeams ? '#e8ccff' : '#fff3e0';
            const borderColor = isMeet ? '#f5c28b' : isTeams ? '#c28bf5' : '#f5c28b';
            const durationText = (!session.duration || session.duration === '0 min' || session.duration === '~0 min' || session.duration === '—') ? '' : ` • ${session.duration}`;
            const uploadedBadge = session.uploaded ? '<div style="margin-top:6px; font-size:11px; color:#0b5ed7;">Subido al servidor ✔</div>' : '<div style="margin-top:6px; font-size:11px; color:#fd7e14;"> Sin subir al servidor❗</div>';
            html += `
                <div class="session-item" data-id="${session.id}" style="border:1px solid ${borderColor}; border-radius:12px; padding:12px; margin-bottom:10px; background:${bgColor}; width:100%; box-sizing:border-box;">
                    <div class="session-title" style="font-weight:600;">${escapeHtml(session.title)}</div>
                    <div class="session-meta" style="display:flex; justify-content:space-between; font-size:12px; color:#555;">
                        <span>${session.date}${durationText} • ${session.captionCount} líneas</span>
                        <span>${session.speakers.length} oradores</span>
                    </div>
                    <div class="session-meta" style="margin-top: 4px; font-size:11px; color:#888;">
                        <span>${timeAgo}</span>
                    </div>
                    <div class="session-actions" style="margin-top:8px; display:flex; gap:8px;">
                        ${session.uploaded ? '' : '<button class="action-btn action-upload" title="Subir" style="background:#28a745; border-radius:6px; padding:6px 10px; color:#fff;">⬆</button>'}
                        <button class="action-btn action-download" title="Descargar" style="background:#ffc107; border-radius:6px; padding:6px 10px; color:#fff;">⬇</button>
                        <button class="action-btn action-delete" title="Eliminar" style="background:#dc3545; border-radius:6px; padding:6px 10px; color:#fff;">🗑</button>
                    </div>
                    ${uploadedBadge}
                </div>
            `;
        }
        
        // Storage info removed
        
        UI_ELEMENTS.sessionList.innerHTML = html;
        document.querySelectorAll('.action-upload').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.target.closest('.session-item')?.dataset.id;
                if (!id) return;
                const s = await chrome.storage.local.get(['userEmail','selfName']);
                const hasUser = !!(s?.userEmail && s?.selfName);
                const notice = document.getElementById('supabaseNotice');
                if (!hasUser) {
                    if (notice) { notice.style.display = 'block'; notice.textContent = 'Para usar las transcripciones, inicia sesión en TaskFlow.'; }
                    return;
                }
                setBusy(true, 'Procesando…');
                try {
                    await uploadSession(id);
                    // Actualiza el card en sitio: oculta botón de subir y muestra badge de "Subido".
                    const item = e.target.closest('.session-item');
                    if (item) {
                        const uploadBtn = item.querySelector('.action-upload');
                        if (uploadBtn) uploadBtn.remove();
                        const existingBadge = item.querySelector('.session-uploaded-badge');
                        if (!existingBadge) {
                            const badge = document.createElement('div');
                            badge.className = 'session-uploaded-badge';
                            badge.style.marginTop = '6px';
                            badge.style.fontSize = '11px';
                            badge.style.color = '#0b5ed7';
                            badge.textContent = 'Subido al servidor ✔';
                            item.appendChild(badge);
                        }
                        item.setAttribute('data-uploaded', '1');
                    }
                    if (notice) { notice.style.display = 'block'; notice.textContent = 'Subido al servidor ✔'; }
                } catch (err) {
                    if (notice) { notice.style.display = 'block'; notice.textContent = 'Error al subir a Supabase'; }
                } finally {
                    setBusy(false);
                }
                await loadSessionList();
            });
        });
        document.querySelectorAll('.action-download').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.target.closest('.session-item')?.dataset.id;
                if (!id) return;
                await exportSession(id);
            });
        });
        document.querySelectorAll('.action-delete').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const item = e.target.closest('.session-item');
                const id = item?.dataset.id;
                if (!id || !item) return;
                window.__deleteInProgress = true;

                try { item.style.position = 'relative'; } catch {}
                const overlay = document.createElement('div');
                overlay.style.position = 'absolute';
                overlay.style.inset = '0';
                overlay.style.background = 'rgba(255,255,255,0.78)';
                overlay.style.display = 'flex';
                overlay.style.alignItems = 'center';
                overlay.style.justifyContent = 'center';
                overlay.style.gap = '8px';
                overlay.style.zIndex = '10';
                overlay.style.borderRadius = '12px';
                const spinner = document.createElement('div');
                spinner.style.width = '16px';
                spinner.style.height = '16px';
                spinner.style.border = '2px solid #b9c1d9';
                spinner.style.borderTopColor = '#0b5ed7';
                spinner.style.borderRadius = '50%';
                spinner.style.animation = 'spin .8s linear infinite';
                const label = document.createElement('div');
                label.textContent = 'Eliminando…';
                label.style.fontSize = '13px';
                label.style.color = '#0b5ed7';
                overlay.appendChild(spinner);
                overlay.appendChild(label);
                item.appendChild(overlay);
                await new Promise(r => requestAnimationFrame(r));

                const minDelayMs = 800;
                setTimeout(() => {
                    try { overlay.remove(); } catch {}
                    try { item.remove(); } catch {}
                    window.__deleteInProgress = false;
                }, minDelayMs);
                try { chrome.runtime.sendMessage({ message: 'delete_session', sessionId: id }, () => { const _ = chrome.runtime.lastError; }); } catch(_) {}
            });
        });
        
    } catch (error) {
        console.error('[Session History] Failed to load sessions:', error);
        UI_ELEMENTS.sessionList.innerHTML = '<div style="text-align: center; color: #dc3545;">Error al cargar sesiones</div>';
    }
}

// Exporta una sesión: envía datos al background para descargar en el formato actual
async function exportSession(sessionId) {
    try {
        const sessionManager = new SessionManager();
        const sessionData = await sessionManager.loadSession(sessionId);
        const format = currentDefaultFormat;
        await chrome.runtime.sendMessage({
            message: "download_captions",
            transcriptArray: sessionData.transcript,
            format: format,
            meetingTitle: sessionData.metadata.title,
            recordingStartTime: sessionData.metadata.timestamp,
            source: sessionData.metadata.source
        });
    } catch (error) {
        console.error('[Historial de Sesiones] No se pudo exportar la sesión:', error);
        alert('No se pudo exportar la sesión.');
    }
}

// Elimina una sesión del almacenamiento y refresca la UI
async function deleteSession(sessionId) {
    try {
        return await new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({ message: 'delete_session', sessionId }, (_res) => {
                    const err = chrome.runtime.lastError;
                    if (err) {
                        console.warn('[Session History] delete_session lastError:', err.message);
                    }
                    resolve(true);
                });
            } catch (e) {
                console.error('[Session History] Failed to delete session:', e);
                resolve(false);
            }
        });
    } catch (error) {
        console.error('[Session History] Failed to delete session:', error);
        return false;
    }
}

// Sube una sesión a Supabase si hay usuario autenticado; actualiza avisos
async function uploadSession(sessionId) {
    try {
        const sessionManager = new SessionManager();
        const sessionData = await sessionManager.loadSession(sessionId);
        await chrome.runtime.sendMessage({
            message: 'upload_session',
            sessionId,
            transcriptArray: sessionData.transcript,
            meetingTitle: sessionData.metadata.title,
            recordingStartTime: sessionData.metadata.timestamp,
            source: sessionData.metadata.source
        });
    } catch (error) {
        console.error('[Historial de Sesiones] No se pudo subir la sesión:', error);
        alert('No se pudo subir la sesión.');
    }
}

function getTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    const intervals = [
        { key: 'año', plural: 'años', seconds: 31536000 },
        { key: 'mes', plural: 'meses', seconds: 2592000 },
        { key: 'semana', plural: 'semanas', seconds: 604800 },
        { key: 'día', plural: 'días', seconds: 86400 },
        { key: 'hora', plural: 'horas', seconds: 3600 },
        { key: 'minuto', plural: 'minutos', seconds: 60 },
    ];
    for (const { key, plural, seconds: secondsInUnit } of intervals) {
        const interval = Math.floor(seconds / secondsInUnit);
        if (interval >= 1) {
            const unitLabel = interval === 1 ? key : plural;
            return `hace ${interval} ${unitLabel}`;
        }
    }
    return 'ahora mismo';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- Initialization ---
let uiAuthFlashLock = false;
// Arranque del popup: estado inicial, autenticación y render de historial
async function initializePopup() {
    window.__statusInitAt = Date.now();
    await loadSettings();
    setupEventListeners();
    try {
        const status = document.getElementById('status-message');
        if (status) { status.textContent = ''; status.style.display = 'none'; }
    } catch {}
    const st = await chrome.storage.local.get(['lastPageLocalStorage','userEmail','selfName','uiPrevHasUser','uiInitialEmptySpinnerShown']);
    const last = st?.lastPageLocalStorage || null;
    const hasLastKey = !!(st && Object.prototype.hasOwnProperty.call(st, 'lastPageLocalStorage'));
    const dataObj = last?.data;
    const isObj = dataObj && typeof dataObj === 'object';
    const isEmptySnapshot = hasLastKey && last && isObj && Object.keys(dataObj).length === 0;
    const initialEmptyShown = !!(st && st.uiInitialEmptySpinnerShown);
    const profileHasUser = !!(String(st?.userEmail||'').trim() && String(st?.selfName||'').trim());
    const snapshotHasData = hasLastKey && last && isObj && Object.keys(dataObj).length > 0;
    if (isEmptySnapshot && !initialEmptyShown) {
        flashSpinner('Cerrando sesión…', 800, 'logout');
        try { await chrome.storage.local.set({ uiInitialEmptySpinnerShown: true, uiPrevHasUser: false }); } catch {}
        try { await renderLoginRequirement(); } catch {}
        return;
    }
    if (isEmptySnapshot && initialEmptyShown) {
        try { await renderLoginRequirement(); } catch {}
        return;
    }
    if (snapshotHasData && !profileHasUser) {
        flashSpinner('Autenticando…', 800, 'login');
        try { chrome.runtime.sendMessage({ type: 'PING' }); } catch {}
    }
    try { await renderLoginRequirement(); } catch {}
    try { await initAutoUploadToggle(); } catch {}
    await loadAccountInfo();

    

    const sess = await chrome.storage.local.get(['userEmail','selfName']);
    const hasUser2 = !!(sess?.userEmail && sess?.selfName);
    if (!hasUser2) {
        const status = document.getElementById('status-message');
        if (status) { status.style.display = 'none'; status.textContent = ''; }
        return;
    }
    await initializeSessionHistory();

    const tab = await getActiveCallTab();
    if (!tab) {
        setStatusMessageDelayed('Abre Teams o Google Meet para usar la extensión.', '#dc3545');
        return;
    }

    try {
        if (isTeamsUrl(tab.url)) {
            const status = await chrome.tabs.sendMessage(tab.id, { message: 'get_status' });
            if (status) {
                await updateStatusUI(status);
                const hasData = status.captionCount > 0;
                updateButtonStates(hasData);
                try { chrome.runtime.sendMessage({ message: 'update_badge_status', capturing: !!status.capturing }); } catch {}
            }
        } else if (isMeetUrl(tab.url)) {
            const info = await chrome.runtime.sendMessage({ message: 'GET_SESSION_INFO' });
            if (info?.ok) {
                const capturing = !!info.meetingActive;
                const captionCount = Number(info.lines || 0);
                const isInMeeting = !!info.meetingActive;
                await updateStatusUI({ capturing, captionCount, isInMeeting });
            }
        }
        setBusy(false);
    } catch (error) {
        // This error is expected when content script isn't loaded yet
        if (String(error.message || '').includes('Could not establish connection')) {
            console.log("Content script not ready. This is normal if the Teams page was just opened.");
            UI_ELEMENTS.statusMessage.innerHTML = 'Refrescá tu pestaña de reunión (F5) para activar la extensión.';
            UI_ELEMENTS.statusMessage.style.color = '#ffc107';
            
            // Refresh prompt only; content script is declared in manifest
            UI_ELEMENTS.statusMessage.textContent = 'Refrescá tu pestaña de reunión para activar la extensión.';
            UI_ELEMENTS.statusMessage.style.color = '#dc3545';
        } else {
            console.error("Unexpected error:", error.message);
            UI_ELEMENTS.statusMessage.textContent = 'Error de conexión. Refrescá la pestaña y probá nuevamente.';
            UI_ELEMENTS.statusMessage.style.color = '#dc3545';
        }
    }
}

// Keyboard shortcuts removed

// Escucha eventos de actualización de sesiones y progreso de subida para feedback
chrome.runtime.onMessage.addListener((message) => {
    if (message && message.message === 'SESSIONS_UPDATED') {
        if (!window.__deleteInProgress) {
            loadSessionList();
        }
    }
    if (message && message.message === 'UPLOAD_STATUS') {
        const notice = document.getElementById('supabaseNotice');
        if (message.status === 'start') {
            setBusy(true, 'Procesando…');
            if (notice) { notice.style.display = 'block'; notice.textContent = 'Procesando…'; }
        } else if (message.status === 'done') {
            setBusy(false);
            if (notice) { notice.style.display = 'block'; notice.textContent = 'Subido al servidor automáticamente'; }
            loadSessionList();
        } else if (message.status === 'error') {
            setBusy(false);
            if (notice) { notice.style.display = 'block'; notice.textContent = 'Error al subir automáticamente'; }
        }
    }
});
document.addEventListener('DOMContentLoaded', initializePopup);
// Overlay de "Procesando…" para operaciones que toman tiempo
function setBusy(on, text) {
    try {
        const busy = document.getElementById('busy');
        const busyText = document.getElementById('busyText');
        const list = document.getElementById('sessionList');
        if (!window.__busyState) window.__busyState = { visible: false, shownAt: 0, hideTimer: null };
        const st = window.__busyState;
        if (typeof text === 'string' && busyText) busyText.textContent = text || 'Procesando…';
        if (on) {
            st.visible = true;
            st.shownAt = Date.now();
            if (st.hideTimer) { try { clearTimeout(st.hideTimer); } catch(_){} st.hideTimer = null; }
            if (busy) busy.style.display = 'flex';
        } else {
            const minMs = 800;
            const elapsed = Date.now() - st.shownAt;
            const wait = st.visible ? Math.max(0, minMs - elapsed) : 0;
            const hide = () => {
                if (busy) busy.style.display = 'none';
                st.visible = false;
            };
            if (wait > 0) {
                st.hideTimer = setTimeout(hide, wait);
            } else {
                hide();
            }
        }
    } catch {}
}

// Oculta el overlay respetando el tiempo mínimo y devuelve una promesa al completar
async function setBusyOffAndWait() {
    try {
        const st = window.__busyState || { visible: false, shownAt: Date.now(), hideTimer: null };
        const minMs = 800;
        const elapsed = Date.now() - (st.shownAt || Date.now());
        const wait = Math.max(0, minMs - elapsed);
        setBusy(false);
        await new Promise(resolve => setTimeout(resolve, wait + 20));
    } catch {}
}

function flashSpinner(message, ms = 800, mode = 'login') {
    try {
        if (uiAuthFlashLock) return;
        uiAuthFlashLock = true;
        const busy = document.getElementById('busy');
        if (!busy) return;
        busy.classList.remove('login','logout');
        busy.classList.add(mode === 'logout' ? 'logout' : 'login');
        const label = document.getElementById('busyText');
        const prevText = label ? label.textContent : 'Procesando…';
        const defaultMsg = mode === 'logout' ? 'Cerrando sesión…' : 'Autenticando…';
        if (label) label.textContent = message || defaultMsg;
        setBusy(true);
        setTimeout(() => {
            try { if (label) label.textContent = prevText || 'Procesando…'; } catch {}
            busy.classList.remove('login','logout');
            setBusy(false);
            uiAuthFlashLock = false;
        }, ms);
    } catch {}
}

async function renderLoginRequirement() {
    try {
        const loginBox = document.getElementById('loginRequired');
        const accountCard = document.getElementById('accountCard');
        const emailEl = document.getElementById('accountEmail');
        const nameEl = document.getElementById('accountName');
        const limitInfo = document.getElementById('limitInfo');
        const autoUploadBox = document.getElementById('autoUploadBox');
        const s = await chrome.storage.local.get(['lastPageLocalStorage','userEmail','selfName','uiPrevHasUser','uiInitialEmptySpinnerShown']);
        const last = s?.lastPageLocalStorage || null;
        const snapshotUser = last?.data?.user || null;
        const snapHasUser = !!(snapshotUser && snapshotUser.email && (snapshotUser.full_name || snapshotUser.name));
        const email = String(s?.userEmail || '').trim();
        const name = String(s?.selfName || '').trim();
        const profileHasUser = !!(email && name);
        const hasUser = snapHasUser || profileHasUser;
        const prevHadUser = !!(s && s.uiPrevHasUser);
        const initialEmptyShown = !!(s && s.uiInitialEmptySpinnerShown);
        const hasLastKey = !!(s && Object.prototype.hasOwnProperty.call(s, 'lastPageLocalStorage'));
        if (hasUser && !prevHadUser) {
            flashSpinner('Autenticando…', 800, 'login');
        }
        if (loginBox) loginBox.style.display = hasUser ? 'none' : 'block';
        if (accountCard) accountCard.style.display = hasUser ? 'block' : 'none';
        if (autoUploadBox) autoUploadBox.style.display = hasUser ? 'block' : 'none';
        const status = document.getElementById('status-message');
        if (status) status.style.display = hasUser ? '' : 'none';
        if (UI_ELEMENTS.sessionList) UI_ELEMENTS.sessionList.style.display = hasUser ? 'block' : 'none';
        if (hasUser) {
            if (emailEl) emailEl.textContent = email;
            if (nameEl) nameEl.textContent = name;
            try { await chrome.storage.local.set({ uiPrevHasUser: true }); } catch {}
        } else {
            // Mostrar spinner de cierre según reglas: transición real o primer snapshot vacío
            try {
                const isEmptySnapshot = hasLastKey && last && last.data && typeof last.data === 'object' && Object.keys(last.data).length === 0;
                if (prevHadUser === true) {
                    flashSpinner('Cerrando sesión…', 800, 'logout');
                    try { await chrome.storage.local.set({ uiPrevHasUser: false, uiInitialEmptySpinnerShown: true }); } catch {}
                } else if (isEmptySnapshot && !initialEmptyShown) {
                    flashSpinner('Cerrando sesión…', 800, 'logout');
                    try { await chrome.storage.local.set({ uiInitialEmptySpinnerShown: true }); } catch {}
                }
            } catch {}
        }
    } catch {}
}

async function initAutoUploadToggle() {
    try {
        const el = document.getElementById('autoUploadToggle');
        if (!el) return;
        const { autoUploadOnEnd } = await chrome.storage.sync.get('autoUploadOnEnd');
        el.checked = !!autoUploadOnEnd;
        el.addEventListener('change', async (e) => {
            try {
                await chrome.storage.sync.set({ autoUploadOnEnd: !!e.target.checked });
            } catch {}
        });
    } catch {}
}
