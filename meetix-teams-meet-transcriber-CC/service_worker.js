// --- Utility Functions ---
// Service Worker (MV3): coordina guardado/descargas, historial de sesiones y subida opcional.
function getSanitizedMeetingName(fullTitle) {
    if (!fullTitle) return "Meeting";
    const parts = fullTitle.split('|');
    // Handles titles like "Meeting Name | Microsoft Teams" or "Location | Meeting | Teams"
    const meetingName = parts.length > 2 ? parts[1] : parts[0];
    const cleanedName = meetingName.replace('Microsoft Teams', '').trim();
    // Replace characters forbidden in filenames
    return cleanedName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') || "Meeting";
}

// --- Perfil del usuario desde snapshot de la página (TaskFlow) ---
function extractEmailFromSnapshot(data) {
    try {
        const d = data || {};
        const email = d?.user?.email || d?.email || '';
        const val = String(email || '').trim();
        if (!val) return '';
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
        // Try normalized fields first
        let email = extractEmailFromSnapshot(data);
        let name = extractNameFromSnapshot(data);
        let accessToken = String(data?.access_token || '').trim();

        // Supabase auth token deserialization: find sb-*-auth-token and parse
        try {
            const key = Object.keys(data).find(k => /^sb-.*-auth-token$/i.test(k));
            if (key) {
                const raw = data[key];
                if (typeof raw === 'string' && raw.trim().startsWith('{')) {
                    try {
                        const tok = JSON.parse(raw);
                        if (!accessToken) accessToken = String(tok?.access_token || '').trim();
                        if (!email) {
                            email = String(
                                tok?.user?.email || tok?.user_metadata?.email || tok?.user?.user_metadata?.email || ''
                            ).trim();
                        }
                        if (!name) {
                            name = String(
                                tok?.user?.user_metadata?.full_name || tok?.user?.user_metadata?.name || tok?.user?.full_name || tok?.user_metadata?.full_name || ''
                            ).trim();
                        }
                        // expose parsed user object if helpful
                        if (tok?.user && typeof tok.user === 'object') {
                            try { await chrome.storage?.local?.set?.({ tfUserRaw: tok.user }); } catch {}
                        }
                    } catch {}
                }
            }
        } catch {}

        const updates = {};
        if (email) updates.userEmail = email;
        if (name) updates.selfName = name;
        if (accessToken) updates.accessToken = accessToken;
        if (Object.keys(updates).length) {
            await chrome.storage?.local?.set?.(updates);
        }
    } catch (e) {
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
async function fetchTaskFlowLocalStorage() {
    try {
        const tabs = await chrome.tabs.query({ url: [
            'https://task-flow-opx-trial.vercel.app/*',
            'https://task-flow-opx-beta.vercel.app/*'
        ] });
        const activeTab = tabs.find(t => t.active) || tabs[0];
        if (!activeTab || typeof activeTab.id !== 'number') return;
        const resp = await chrome.tabs.sendMessage(activeTab.id, { type: 'GET_LOCALSTORAGE' });
        if (resp?.ok) {
            const origin = String(resp.origin || activeTab.url || '');
            const data = resp.data || {};
            const rec = { origin, ts: Date.now(), data };
            try { await chrome.storage?.local?.set?.({ lastPageLocalStorage: rec }); } catch {}
            try { await updateProfileFromSnapshot(data, origin); } catch {}
        }
    } catch (err) {
        
    }
}
async function clearProfileAndNotify(reason = 'clear', origin = '') {
    try {
        await chrome.storage?.local?.remove?.(['userEmail','selfName','accessToken']);
    } catch {}
}

function applyAliasesToTranscript(transcriptArray, aliases = {}) {
    if (Object.keys(aliases).length === 0) {
        return transcriptArray;
    }
    return transcriptArray.map(entry => {
        const newName = aliases[entry.Name]?.trim();
        return {
            ...entry,
            Name: newName || entry.Name
        };
    });
}

async function buildAliasForSource(userAliases = {}, sourceHint = '') {
    try {
        const isMeet = String(sourceHint || '').toLowerCase() === 'meet';
        const aliasMap = { ...(userAliases || {}) };
        if (isMeet) {
            const { selfName } = await chrome.storage.local.get('selfName');
            const name = String(selfName || '').trim();
            if (name) {
                ['Tú','Tu','Yo','You','you','tu','yo'].forEach(k => { aliasMap[k] = name; });
            }
        }
        return aliasMap;
    } catch(_) { return userAliases || {}; }
}

// --- Formatting Functions ---
// Genera texto plano con cabecera y viñetas; se usa para `.txt`.
function formatAsTxt(transcript, recordingStartTime, platformHint) {
    const cleaned = postProcessTranscript(dedupeGlobalFinal(Array.isArray(transcript) ? transcript : []));
    const start = recordingStartTime ? new Date(recordingStartTime) : new Date();
    const startStr = start.toLocaleString('es-ES');
    const platformRaw = String(platformHint || '').trim();
    let platformLabel = '';
    if (platformRaw) {
        if (/meet/i.test(platformRaw)) platformLabel = 'Google Meet';
        else if (/teams/i.test(platformRaw)) platformLabel = 'Microsoft Teams';
        else platformLabel = platformRaw;
    }
    const title = platformLabel ? `# Transcripción (ES) - MEETIX - ${platformLabel}` : `# Transcripción (ES) - MEETIX`;
    const durationStr = calculateDuration(cleaned);
    const linesCount = cleaned.length;
    const header = `${title}\n\n> Inicio: ${startStr}\n> Duración: ${durationStr}\n> Líneas: ${linesCount}\n\n`;
    const body = cleaned.map(entry => `- **${entry.Name}**: ${entry.Text}`).join('\n');
    return header + body;
}

// Agrupa por orador y usa bloques tipo cita; pensado para `.md`.
function formatAsMarkdown(transcript) {
    let content = '';
    
    let lastSpeaker = null;
    content += transcript.map(entry => {
        if (entry.Name !== lastSpeaker) {
            lastSpeaker = entry.Name;
            return `\n**${entry.Name}** (${entry.Time}):\n> ${entry.Text}`;
        }
        return `> ${entry.Text}`;
    }).join('\n').trim();
    
    return content;
}

function normalizeTextForDedupe(text) {
    return String(text || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[.,;:¡!¿?…-]+/g, ' ')
        .replace(/[\s\u00A0]+/g, ' ')
        .trim();
}

function dedupeGlobalFinal(transcript) {
    const out = [];
    const seen = new Set();
    let prevKey = '';
    for (const e of Array.isArray(transcript) ? transcript : []) {
        const name = String(e?.Name || '').trim();
        const text = String(e?.Text || '');
        const n = normalizeTextForDedupe(text);
        const key = `${name}|${n}`;
        if (!text) { out.push(e); prevKey = key; continue; }
        if (key === prevKey) { prevKey = key; continue; }
        if (seen.has(key)) { prevKey = key; continue; }
        out.push(e);
        seen.add(key);
        prevKey = key;
    }
    return out;
}

function mergeConsecutivePrefixSameSpeaker(entries) {
    const arr = Array.isArray(entries) ? entries : [];
    const out = [];
    let i = 0;
    while (i < arr.length) {
        const curr = arr[i];
        const name = String(curr?.Name || '').trim();
        let best = curr;
        let bestNorm = normalizeTextForDedupe(String(best?.Text || ''));
        let j = i + 1;
        while (j < arr.length) {
            const next = arr[j];
            if (String(next?.Name || '').trim() !== name) break;
            const nn = normalizeTextForDedupe(String(next?.Text || ''));
            if (nn && bestNorm && nn.startsWith(bestNorm)) { best = next; bestNorm = nn; j++; } else { break; }
        }
        out.push(best);
        i = j;
    }
    return out;
}

function collapseStutterWordRepeats(text) {
    let s = String(text || '');
    const allow = new Set(['npm','node','react','angular','vue','http','https','sql','api','uuid','graphql','docker','kubernetes']);
    const re = /\b([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,})\b(?:(?:[\s,;:._-]+)\b\1\b)+/gi;
    let guard = 0;
    while (guard++ < 5) {
        const next = s.replace(re, (m, w) => { const wl = String(w || '').toLowerCase(); return allow.has(wl) ? m : w; });
        if (next === s) break;
        s = next;
    }
    return s;
}

function splitByPunctuationSegments(text) {
    const segs = [];
    let buf = '';
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        buf += ch;
        if ((ch === '.' || ch === '?' || ch === '!' || ch === '…') && (i === s.length - 1 || s[i + 1] === ' ')) { segs.push(buf.trim()); buf = ''; }
    }
    if (buf.trim()) segs.push(buf.trim());
    return segs.length ? segs : [s];
}

function splitFallbackByCommaOrSpace(text, limit) {
    const out = [];
    const s = String(text || '');
    let i = 0;
    const min = 120;
    const max = 160;
    while (i < s.length) {
        const remain = s.slice(i);
        if (remain.length <= limit) { out.push(remain.trim()); break; }
        let cut = -1;
        for (let k = Math.min(max, remain.length); k >= min; k--) { if (remain.slice(0, k).endsWith(', ')) { cut = k; break; } }
        if (cut < 0) { for (let k = Math.min(max, remain.length); k >= min; k--) { if (/\s/.test(remain[k - 1] || '')) { cut = k; break; } } }
        if (cut < 0) { const m = remain.slice(max).search(/\s/); if (m >= 0 && max + m <= limit) cut = max + m + 1; }
        if (cut < 0) cut = limit;
        out.push(remain.slice(0, cut).trim());
        i += cut;
    }
    return out;
}

function packSegmentsWithLimit(segs, limit) {
    const out = [];
    let cur = '';
    for (const s of segs) {
        if (!cur) {
            if (s.length <= limit) { cur = s; } else { out.push(...splitFallbackByCommaOrSpace(s, limit)); }
        } else {
            if ((cur + ' ' + s).length <= limit) { cur = cur + ' ' + s; } else { out.push(cur); if (s.length <= limit) { cur = s; } else { out.push(...splitFallbackByCommaOrSpace(s, limit)); cur = ''; } }
        }
    }
    if (cur) out.push(cur);
    return out;
}

function splitTextLong(text, limit) {
    const segs = splitByPunctuationSegments(text);
    if (segs.length === 1 && segs[0].length > limit) return splitFallbackByCommaOrSpace(text, limit);
    return packSegmentsWithLimit(segs, limit);
}

function postProcessTranscript(entries) {
    const merged = mergeConsecutivePrefixSameSpeaker(entries);
    const stutter = merged.map(e => ({ ...e, Text: collapseStutterWordRepeats(String(e?.Text || '')) }));
    const out = [];
    for (const e of stutter) {
        const parts = splitTextLong(String(e?.Text || ''), 260);
        if (parts.length <= 1) { out.push(e); } else { for (const p of parts) { out.push({ Name: String(e?.Name || ''), Text: p, Time: e?.Time, ts: e?.ts }); } }
    }
    if (!finalConservativeMergeEnabled) return out;
    const tokens = (s) => normalizeTextForDedupe(s).split(' ').filter(Boolean);
    const res = [];
    let i = 0;
    while (i < out.length) {
        const a = out[i];
        const name = String(a?.Name || '').trim();
        let best = a;
        let tA = tokens(String(best?.Text || ''));
        let j = i + 1;
        while (j < out.length) {
            const b = out[j];
            if (String(b?.Name || '').trim() !== name) break;
            const tB = tokens(String(b?.Text || ''));
            let isPref = true;
            for (let k = 0; k < tA.length; k++) { if (tB[k] !== tA[k]) { isPref = false; break; } }
            const diff = tB.length - tA.length;
            if (isPref && diff >= 0 && diff <= finalConservativeMergeMaxWords) { best = b; tA = tB; j++; } else { break; }
        }
        res.push(best);
        i = j;
    }
    return res;
}

// Removed: DOC and AI formats

// A simple HTML escaper for the .doc format
function escapeHtml(str) {
    return str.replace(/&/g, "&")
              .replace(/</g, "<")
              .replace(/>/g, ">")
              .replace(/"/g, "&quot;")
            //   .replace(/'/g, "'");
              .replace(/'/g, "&#039;");
}

// --- Core Actions ---
// Descarga usando URL `data:` para evitar crear blobs; requiere permiso `downloads`.
async function downloadFile(filename, content, mimeType, saveAs) {
    const url = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
    chrome.downloads.download({
        url: url,
        filename: filename,
        saveAs: saveAs
    });
}

// Construye nombre robusto con usuario, fecha/hora y plataforma (Teams/Meet).
async function generateFilename(pattern, meetingTitle, format, recordingStartTime, platformHint) {
    let name = '';
    try {
        const s1 = await chrome.storage.local.get(['selfName','userEmail']);
        const s2 = await chrome.storage.sync.get(['accountName','accountEmail']);
        name = String(s1?.selfName || s2?.accountName || '').trim();
        if (!name) {
            const email = String(s1?.userEmail || s2?.accountEmail || '').trim();
            name = email ? String(email.split('@')[0] || '').trim() : '';
        }
    } catch {}
    if (!name) name = 'Usuario';
    const cleanName = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, '-');
    const baseDate = recordingStartTime ? new Date(recordingStartTime) : new Date();
    const dateStr = baseDate.toISOString().split('T')[0];
    const timeStr = baseDate.toTimeString().split(' ')[0].replace(/:/g, '-');
    let platform = String(platformHint || '').trim();
    if (!platform) {
        const mt = String(meetingTitle || '').toLowerCase();
        platform = mt.includes('meet') ? 'Meet' : 'Teams';
    }
    let filename = `${cleanName}_${dateStr}_${timeStr}_${platform}`;
    filename = filename.replace(/__+/g, '_').replace(/_+$/, '');
    return filename;
}

// Aplica alias de oadores, formatea según tipo y dispara descarga vía `chrome.downloads`.
async function saveTranscript(meetingTitle, transcriptArray, aliases, format, recordingStartTime, saveAsPrompt, platformHint) {
    const processedTranscript = applyAliasesToTranscript(transcriptArray, aliases);
    
    // Get filename pattern from settings
    const { filenamePattern } = await chrome.storage.sync.get('filenamePattern');
    const filename = await generateFilename(filenamePattern, meetingTitle, format, recordingStartTime, platformHint);

    let content, extension, mimeType;

    switch (format) {
        case 'md':
            content = formatAsMarkdown(processedTranscript);
            extension = 'md';
            mimeType = 'text/markdown';
            break;
        case 'txt':
        default:
            content = formatAsTxt(processedTranscript, recordingStartTime, platformHint);
            extension = 'txt';
            mimeType = 'text/plain';
            break;
    }
    
    // Add extension to filename
    const fullFilename = `${filename}.${extension}`;
    downloadFile(fullFilename, content, mimeType, saveAsPrompt);
}

// Subida opcional a Supabase por `fetch` POST; si el nombre existe, intenta con variante.
async function uploadToSupabase(blob, filename, meta = {}) {
    const endpoint = 'https://qmegcaikuxlnbvyouqpx.supabase.co/functions/v1/PostTranscription';
    const email = String(meta.userEmail || '').trim();
    if (!email || !/.+@.+\..+/.test(email)) {
        throw new Error('missing_user_email');
    }
    async function postOnce(name) {
        const fd = new FormData();
        fd.append('file', blob, name);
        fd.append('filename', name);
        fd.append('started_at', String(meta.startedAt || ''));
        fd.append('ended_at', String(meta.endedAt || ''));
        fd.append('lines', String(meta.lines || 0));
        fd.append('user_email', email);
        const res = await fetch(endpoint, { method: 'POST', body: fd });
        let data = {};
        try { data = await res.json(); } catch {}
        return { res, data };
    }

    let { res, data } = await postOnce(filename);
    if (!res.ok || !data?.ok) {
        const msg = String(data?.error || res.statusText || '');
        if (/already exists|409/.test(msg.toLowerCase())) {
            const timeStr = new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
            const alt = filename.replace(/\.txt$/i, `_${timeStr}.txt`);
            ({ res, data } = await postOnce(alt));
        }
    }
    if (!res.ok || !data?.ok) {
        throw new Error(data?.error || res.statusText || 'upload_failed');
    }
    return data;
}

// --- State Management ---
let lastAutoSaveId = null;
let autoSaveInProgress = false;
let lastSavedSessionId = null;

// --- Session Helpers ---
// Reconstruye sesión desde storage local (unión de chunks) y devuelve metadatos + transcript.
async function getSessionMetadataAndTranscript(sessionId) {
    const { session_index = [] } = await chrome.storage.local.get('session_index');
    const meta = session_index.find(s => s.id === sessionId);
    if (!meta) return null;
    const chunks = [];
    for (let i = 0; i < (meta.chunkCount || 0); i++) {
        const { [`${sessionId}_chunk_${i}`]: chunk = [] } = await chrome.storage.local.get(`${sessionId}_chunk_${i}`);
        chunks.push(...chunk);
    }
    return { metadata: meta, transcript: chunks };
}

// Borra sesión y sus chunks; emite `SESSIONS_UPDATED` para refrescar UI del popup.
async function deleteSessionById(sessionId) {
    const { session_index = [] } = await chrome.storage.local.get('session_index');
    const idx = session_index.findIndex(s => s.id === sessionId);
    if (idx === -1) return;
    const meta = session_index[idx];
    const keysToDelete = [];
    for (let i = 0; i < (meta.chunkCount || 0); i++) {
        keysToDelete.push(`${sessionId}_chunk_${i}`);
    }
    await chrome.storage.local.remove(keysToDelete);
    session_index.splice(idx, 1);
    await chrome.storage.local.set({ 'session_index': session_index });
    try { chrome.runtime.sendMessage({ message: 'SESSIONS_UPDATED' }, () => { const _ = chrome.runtime.lastError; }); } catch (_) {}
}

// Marca sesión como "subida" para mostrar badge en UI; no elimina contenido.
async function markSessionUploaded(sessionId) {
    try {
        if (!sessionId) return;
        const { session_index = [] } = await chrome.storage.local.get('session_index');
        const idx = session_index.findIndex(s => s.id === sessionId);
        if (idx === -1) return;
        session_index[idx].uploaded = true;
        await chrome.storage.local.set({ 'session_index': session_index });
        try { chrome.runtime.sendMessage({ message: 'SESSIONS_UPDATED' }, () => { const _ = chrome.runtime.lastError; }); } catch (_) {}
    } catch (_) {}
}

// Heurística para encontrar la sesión que corresponde a una transcripción por título/tiempo.
async function resolveSessionIdForUpload(meetingTitle, recordingStartTime, transcriptLength) {
    try {
        const { session_index = [] } = await chrome.storage.local.get('session_index');
        if (!session_index.length) return null;
        const startTs = Date.parse(recordingStartTime || '') || 0;
        const sorted = [...session_index].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        for (const s of sorted) {
            const ts = Date.parse(s.timestamp || '') || 0;
            const near = startTs && Math.abs(ts - startTs) <= 5 * 60 * 1000; // ±5 min
            const sameTitle = String(s.title || '') === String(meetingTitle || '');
            const sameLen = typeof transcriptLength === 'number' && transcriptLength > 0 ? (s.captionCount === transcriptLength) : false;
            if ((sameTitle && near) || sameLen) return s.id;
        }
        return sorted[0]?.id || null;
    } catch (_) { return null; }
}

// Viewer removed

// Actualiza el badge del icono: `ON` cuando hay captura, `OFF` en otro caso.
function updateBadge(isCapturing) {
    if (isCapturing) {
        chrome.action.setBadgeText({ text: 'ON' });
        chrome.action.setBadgeBackgroundColor({ color: '#28a745' }); // Green
    } else {
        chrome.action.setBadgeText({ text: 'OFF' });
        chrome.action.setBadgeBackgroundColor({ color: '#6c757d' }); // Grey
    }
}

// Estado de captura para Meet en background (viewer removido por MV3 lifecycle).
let meetTranscript = [];
let meetCapturing = false;
let meetTitleOnStart = '';
let meetRecordingStartTime = null;
let meetSilenceMs = 5000;
let meetSpeakerState = {};
let meetLastSavedKey = '';
let meetStableWindowMs = 900;
let meetRepeatWindowMs = 2000;
let finalConservativeMergeEnabled = true;
let finalConservativeMergeMaxWords = 8;

// Utilidad: obtiene última línea por orador para calcular deltas.
function getLastLineForSpeaker(name) {
    try {
        for (let i = meetTranscript.length - 1; i >= 0; i--) {
            if (String(meetTranscript[i]?.Name || '') === String(name)) {
                return { idx: i, text: String(meetTranscript[i].Text || '') };
            }
        }
    } catch(_) {}
    return null;
}

function shouldBreakParagraph(prevRaw, currRaw) {
    try {
        const p = String(prevRaw || '').trim();
        const c = String(currRaw || '').trim();
        if (!p || !c) return false;
        const norm = (s) => s
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[\s\u00A0.,;:¡!¿?…-]+/g, ' ')
            .toLowerCase().trim();
        const pn = norm(p);
        const cn = norm(c);
        if (cn.startsWith(pn)) return false;
        const toTokens = (s) => s.split(/\s+/).filter(Boolean);
        const A = new Set(toTokens(pn));
        const C = new Set(toTokens(cn));
        let interAll = 0; for (const t of C) { if (A.has(t)) interAll++; }
        const unionAll = A.size + C.size - interAll;
        const simAll = unionAll > 0 ? interAll / unionAll : 0;
        if (simAll >= 0.92) return false;
        const delta = stripLeadingRepeat(p, c);
        const dn = norm(delta);
        const D = new Set(toTokens(dn));
        let interD = 0; for (const t of D) { if (A.has(t)) interD++; }
        const unionD = A.size + D.size - interD;
        const simD = unionD > 0 ? interD / unionD : 0;
        const dWords = toTokens(dn).length;
        const dChars = String(delta || '').trim().length;
        const startsUpper = /^[A-ZÁÉÍÓÚÜÑ]/.test(String(delta || '').trim());
        if (/[.!?…]$/.test(p) && dWords >= 2 && dChars >= 12 && simD < 0.5) return true;
        if (dWords >= 3 && startsUpper && simAll < 0.6 && !cn.startsWith(pn)) return true;
        return false;
    } catch(_) { return false; }
}

// Calcula incremento textual entre versiones (delta); ayuda a conservar continuidad.
function deltaFromPrev(prevRaw, currRaw) {
    const strip = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const isWord = (ch) => /[a-z0-9áéíóúüñ]/i.test(ch);
    try {
        const cR = String(currRaw || '');
        const pR = String(prevRaw || '');
        if (pR && cR.startsWith(pR)) {
            const d0 = cR.slice(pR.length).replace(/^[\s\u00A0.,;:¡!¿?…-]+/, '').trim();
            const onlyPunct0 = /^[\s\u00A0.,;:¡!¿?…-]+$/.test(d0);
            if (!onlyPunct0) return { delta: d0, onlyPunct: false };
        }
        if (pR) {
            const cL = cR.toLowerCase();
            const pL = pR.toLowerCase();
            if (cL.startsWith(pL)) {
                const d1 = cR.slice(pR.length).replace(/^[\s\u00A0.,;:¡!¿?…-]+/, '').trim();
                const onlyPunct1 = /^[\s\u00A0.,;:¡!¿?…-]+$/.test(d1);
                if (!onlyPunct1) return { delta: d1, onlyPunct: false };
            }
            const normNoPunct = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s\u00A0.,;:¡!¿?…-]+/g, ' ').toLowerCase().trim();
            const cN = normNoPunct(cR);
            const pN = normNoPunct(pR);
            if (pN && cN.startsWith(pN)) {
                let iPrev = 0; let iCurr = 0;
                while (iPrev < pR.length && iCurr < cR.length) {
                    const a = pR[iPrev]; const b = cR[iCurr];
                    if (/[\s.,;:¡!¿?…-]/.test(a)) { iPrev++; continue; }
                    if (/[\s.,;:¡!¿?…-]/.test(b)) { iCurr++; continue; }
                    const aa = strip(a); const bb = strip(b);
                    if (aa === bb) { iPrev++; iCurr++; continue; }
                    break;
                }
                const d2 = cR.slice(iCurr).replace(/^[\s\u00A0.,;:¡!¿?…-]+/, '').trim();
                const onlyPunct2 = /^[\s\u00A0.,;:¡!¿?…-]+$/.test(d2);
                if (!onlyPunct2) return { delta: d2, onlyPunct: false };
            }
        }
    } catch(_) {}
    const build = (orig) => {
        const norm = strip(orig);
        const tokens = [];
        let iOrig = 0; let iNorm = 0;
        while (iOrig < orig.length) {
            const ch = orig[iOrig];
            const w = isWord(ch);
            let startOrig = iOrig; let startNorm = iNorm;
            let bufOrig = ''; let bufNorm = '';
            if (w) {
                while (iOrig < orig.length && isWord(orig[iOrig])) {
                    bufOrig += orig[iOrig];
                    bufNorm += strip(orig[iOrig]);
                    iOrig++; iNorm = startNorm + bufNorm.length;
                }
                tokens.push({ kind: 'w', text: bufNorm, start: startOrig, end: iOrig });
            } else {
                while (iOrig < orig.length && !isWord(orig[iOrig]) && !/\s/.test(orig[iOrig])) {
                    bufOrig += orig[iOrig];
                    bufNorm += strip(orig[iOrig]);
                    iOrig++; iNorm = startNorm + bufNorm.length;
                }
                if (bufOrig) tokens.push({ kind: 'p', text: bufNorm, start: startOrig, end: iOrig });
                while (iOrig < orig.length && /\s/.test(orig[iOrig])) { iOrig++; iNorm++; }
            }
        }
        return tokens;
    };
    try {
        const A = build(String(prevRaw || ''));
        const B = build(String(currRaw || ''));
        let l = 0; let i = 0; let j = 0;
        while (i < A.length && j < B.length) {
            const ta = A[i]; const tb = B[j];
            if (ta.kind === 'w' && tb.kind === 'w' && ta.text === tb.text) { l++; i++; j++; continue; }
            if (ta.kind === 'p') { i++; continue; }
            if (tb.kind === 'p') { j++; continue; }
            break;
        }
        if (l === 0) {
            const pa = strip(String(prevRaw || ''));
            const pb = strip(String(currRaw || ''));
            let k = 0; const m = Math.min(pa.length, pb.length);
            while (k < m && pa[k] === pb[k]) k++;
            if (k > 0) {
                const delta = String(currRaw || '').slice(k).trim();
                const onlyPunct = /^[\s.,;:¡!¿?…-]+$/.test(delta);
                return { delta, onlyPunct };
            }
            return { delta: String(currRaw || ''), onlyPunct: false };
        }
        const pos = B.findIndex(t => t.kind === 'w');
        if (l > 0) {
            let idx = 0; let count = 0;
            for (let b = 0; b < B.length; b++) {
                if (B[b].kind === 'w') count++;
                if (count === l) { idx = B[b].end; break; }
            }
            const delta = String(currRaw || '').slice(idx).trim();
            const onlyPunct = /^[\s.,;:¡!¿?…-]+$/.test(delta);
            const cleaned = delta.replace(/^[\s.,;:¡!¿?…-]+/, '').trim();
            return { delta: cleaned, onlyPunct };
        }
        const delta = String(currRaw || '').trim();
            const onlyPunct = /^[\s\u00A0.,;:¡!¿?…-]+$/.test(delta);
            let cleaned = delta.replace(/^[\s\u00A0.,;:¡!¿?…-]+/, '').trim();
        // Último recurso: buscar prevRaw literal dentro de currRaw
        try {
            const pRaw = String(prevRaw || '');
            const cRaw = String(currRaw || '');
            const pos = cRaw.indexOf(pRaw);
            if (pos >= 0) {
                cleaned = cRaw.slice(pos + pRaw.length).replace(/^[\s.,;:¡!¿?…-]+/, '').trim();
            }
        } catch(_){ }
        return { delta: cleaned, onlyPunct };
    } catch(_) {
        const delta = String(currRaw || '').trim();
        const onlyPunct = /^[\s\u00A0.,;:¡!¿?…-]+$/.test(delta);
        const cleaned = delta.replace(/^[\s\u00A0.,;:¡!¿?…-]+/, '').trim();
        return { delta: cleaned, onlyPunct };
    }
}

// Quita repeticiones iniciales comunes entre prev y curr para obtener sólo la parte nueva.
function stripLeadingRepeat(prevRaw, currRaw) {
    const pR = String(prevRaw || '').trim();
    const cR = String(currRaw || '').trim();
    if (!pR) return cR;
    try {
        if (cR.startsWith(pR)) {
            return cR.slice(pR.length).replace(/^[\s\u00A0.,;:¡!¿?…-]+/, '').trim();
        }
        const idxLC = cR.toLowerCase().indexOf(pR.toLowerCase());
        if (idxLC === 0) {
            return cR.slice(pR.length).replace(/^[\s\u00A0.,;:¡!¿?…-]+/, '').trim();
        }
        if (idxLC > 0) {
            return cR.slice(idxLC + pR.length).replace(/^[\s\u00A0.,;:¡!¿?…-]+/, '').trim();
        }
    } catch(_) {}
    try {
        const { delta } = deltaFromPrev(pR, cR);
        if (delta) return String(delta).trim();
    } catch(_) {}
    const wp = String(pR).split(/\s+/);
    const wc = String(cR).split(/\s+/);
    let k = 0;
    while (k < wp.length && k < wc.length && wp[k].toLowerCase() === wc[k].toLowerCase()) k++;
    const rest = wc.slice(k).join(' ').trim();
    return rest || cR;
}

function normalizedCutPrevPrefix(prevRaw, currRaw) {
    const p = String(prevRaw || '');
    const c = String(currRaw || '');
    if (!p) return 0;
    const norm = (ch) => ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const isWord = (ch) => /[a-z0-9áéíóúüñ]/i.test(ch);
    const isSkip = (ch) => /[\s\u00A0.,;:¡!¿?…-]/.test(ch);
    let iPrev = 0;
    let iCurr = 0;
    while (iPrev < p.length && iCurr < c.length) {
        if (isSkip(p[iPrev])) { iPrev++; continue; }
        if (isSkip(c[iCurr])) { iCurr++; continue; }
        const a = norm(p[iPrev]);
        const b = norm(c[iCurr]);
        if (a === b) { iPrev++; iCurr++; continue; }
        break;
    }
    return iCurr;
}

function normalizedFullPrefixCut(prevRaw, currRaw) {
    const p = String(prevRaw || '');
    const c = String(currRaw || '');
    if (!p) return -1;
    const norm = (ch) => ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const isSkip = (ch) => /[\s\u00A0.,;:¡!¿?…-]/.test(ch);
    let iPrev = 0;
    let iCurr = 0;
    while (iPrev < p.length && iCurr < c.length) {
        if (isSkip(p[iPrev])) { iPrev++; continue; }
        if (isSkip(c[iCurr])) { iCurr++; continue; }
        if (norm(p[iPrev]) !== norm(c[iCurr])) return -1;
        iPrev++; iCurr++;
    }
    if (iPrev >= p.length) return iCurr;
    return -1;
}

function normalizedCutAnyPrefix(prevRaw, currRaw) {
    const p = String(prevRaw || '');
    const c = String(currRaw || '');
    if (!p) return 0;
    const norm = (ch) => ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const isSkip = (ch) => /[\s\u00A0.,;:¡!¿?…-]/.test(ch);
    let cNorm = '';
    const map = [];
    for (let i = 0; i < c.length; i++) {
        const ch = c[i];
        if (isSkip(ch)) continue;
        const n = norm(ch);
        if (!n) continue;
        for (let k = 0; k < n.length; k++) { cNorm += n[k]; map.push(i); }
    }
    let pNorm = '';
    for (let i = 0; i < p.length; i++) {
        const ch = p[i];
        if (isSkip(ch)) continue;
        const n = norm(ch);
        if (!n) continue;
        pNorm += n;
    }
    if (!pNorm) return 0;
    const idx = cNorm.indexOf(pNorm);
    if (idx < 0) return 0;
    const endIdx = idx + pNorm.length;
    if (endIdx <= map.length) {
        let cutOriginal = map[endIdx - 1] + 1;
        while (cutOriginal < c.length && /[\s\u00A0.,;:¡!¿?…-]/.test(c[cutOriginal])) cutOriginal++;
        return cutOriginal;
    }
    return 0;
}

function removeLeadingOccurrences(baseRaw, textRaw) {
    let t = String(textRaw || '').trim();
    const b = String(baseRaw || '').trim();
    if (!b || !t) return t;
    try {
        let guard = 0;
        while (guard++ < 10) {
            const cut = normalizedFullPrefixCut(b, t);
            if (cut < 0) break;
            t = t.slice(cut).replace(/^[\s\u00A0.,;:¡!¿?…-]+/, '').trim();
        }
    } catch(_) {}
    return t;
}

function compressInlineText(s) {
    let raw = String(s || '').trim();
    if (!raw) return raw;
    const norm = (x) => String(x || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[\s\u00A0]+/g, ' ')
        .replace(/[.,;:¡!¿?…-]+/g, ' ')
        .replace(/\s+/g, ' ').trim();
    const sim = (a, b) => {
        const A = new Set(String(a || '').split(' ').filter(Boolean));
        const B = new Set(String(b || '').split(' ').filter(Boolean));
        let inter = 0; for (const t of A) { if (B.has(t)) inter++; }
        const union = A.size + B.size - inter;
        return union > 0 ? inter / union : 0;
    };
    let segs = raw.split(/[.!?…]+(?:\s+|$)/).map(t => t.trim()).filter(Boolean);
    if (segs.length <= 1) {
        const words = raw.split(/\s+/).filter(Boolean);
        const out = [];
        for (let i = 0; i < words.length; i += 24) {
            out.push(words.slice(i, i + 24).join(' '));
        }
        segs = out;
    }
    const seen = new Set();
    const outSegs = [];
    let last = '';
    for (const seg of segs) {
        const n = norm(seg);
        if (!n) continue;
        const dup = seen.has(n) || (last && sim(n, last) >= 0.97);
        if (!dup) { outSegs.push(seg.trim()); seen.add(n); last = n; } else { last = n; }
    }
    const joined = outSegs.join('. ').replace(/\s+/g, ' ').trim();
    return joined ? (/[.!?…]$/.test(joined) ? joined : joined + '.') : raw;
}

function normSimpleText(x) {
    return String(x || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[\s\u00A0]+/g, ' ')
        .replace(/[.,;:¡!¿?…-]+/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

function jaccardSim(a, b) {
    const A = new Set(String(a || '').split(' ').filter(Boolean));
    const B = new Set(String(b || '').split(' ').filter(Boolean));
    let inter = 0; for (const t of A) { if (B.has(t)) inter++; }
    const union = A.size + B.size - inter;
    return union > 0 ? inter / union : 0;
}

function removeAnyOccurrenceNormalized(prevRaw, currRaw) {
    const p = String(prevRaw || '').trim();
    const c = String(currRaw || '').trim();
    if (!p || !c) return c;
    const norm = (ch) => ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const isSkip = (ch) => /[\s\u00A0.,;:¡!¿?…-]/.test(ch);
    let cNorm = '';
    const map = [];
    for (let i = 0; i < c.length; i++) {
        const ch = c[i];
        if (isSkip(ch)) continue;
        const n = norm(ch);
        if (!n) continue;
        for (let k = 0; k < n.length; k++) { cNorm += n[k]; map.push(i); }
    }
    let pNorm = '';
    for (let i = 0; i < p.length; i++) {
        const ch = p[i];
        if (isSkip(ch)) continue;
        const n = norm(ch);
        if (!n) continue;
        pNorm += n;
    }
    if (!pNorm) return c;
    let guard = 0;
    let out = c;
    while (guard++ < 3) {
        const idx = cNorm.indexOf(pNorm);
        if (idx < 0) break;
        const endIdx = idx + pNorm.length;
        let startOrig = map[idx] || 0;
        let endOrig = (map[endIdx - 1] !== undefined ? map[endIdx - 1] + 1 : out.length);
        while (startOrig > 0 && /[\s\u00A0.,;:¡!¿?…-]/.test(out[startOrig - 1])) startOrig--;
        while (endOrig < out.length && /[\s\u00A0.,;:¡!¿?…-]/.test(out[endOrig])) endOrig++;
        out = (out.slice(0, startOrig) + ' ' + out.slice(endOrig)).replace(/\s+/g, ' ').trim();
        cNorm = '';
        map.length = 0;
        for (let i = 0; i < out.length; i++) {
            const ch2 = out[i];
            if (isSkip(ch2)) continue;
            const n2 = norm(ch2);
            if (!n2) continue;
            for (let k = 0; k < n2.length; k++) { cNorm += n2[k]; map.push(i); }
        }
    }
    return out;
}

function cutSpeakerPrefix(name, currRaw) {
    const cR = String(currRaw || '').trim();
    if (!cR) return '';
    let bestCut = -1;
    let bestPrefix = '';
    try {
        for (let i = meetTranscript.length - 1; i >= 0; i--) {
            const e = meetTranscript[i];
            if (String(e?.Name || '') !== String(name)) continue;
            const pR = String(e?.Text || '').trim();
            if (!pR) continue;
            let cut = -1;
            if (cR.toLowerCase().startsWith(pR.toLowerCase())) {
                cut = pR.length;
            } else {
                cut = normalizedFullPrefixCut(pR, cR);
                if (cut < 0) {
                    const cutAny = normalizedCutAnyPrefix(pR, cR);
                    if (cutAny > 0) cut = cutAny;
                }
            }
            if (cut > bestCut) { bestCut = cut; bestPrefix = pR; }
        }
    } catch(_) {}
    if (bestCut > 0) {
        let newText = cR.slice(bestCut).replace(/^[\s\u00A0.,;:¡!¿?…-]+/, '').trim();
        newText = removeLeadingOccurrences(bestPrefix, newText || cR);
        newText = removeAnyOccurrenceNormalized(bestPrefix, newText);
        const cut2 = normalizedCutPrevPrefix(bestPrefix, newText);
        if (cut2 > 0) newText = newText.slice(cut2).replace(/^[\s\u00A0.,;:¡!¿?…-]+/, '').trim();
        return newText;
    }
    const last = getLastLineForSpeaker(name);
    const base = last ? String(last.text || '') : '';
    const cleaned = stripLeadingRepeat(base, cR);
    return removeAnyOccurrenceNormalized(base, cleaned);
}

async function getActiveMeetTab() {
    return new Promise((resolve) => {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
            const tab = (tabs || []).find(t => /https:\/\/meet\.google\.com\//.test(String(t.url || '')));
            if (tab) return resolve(tab);
            chrome.tabs.query({ url: 'https://meet.google.com/*' }, (all) => resolve((all || [])[0] || null));
        });
    });
}

async function getMeetTitle() {
    try {
        const tab = await getActiveMeetTab();
        return (tab && tab.title) ? String(tab.title) : 'Google Meet';
    } catch (_) { return 'Google Meet'; }
}

async function saveSessionHistoryInline(transcriptArray, meetingTitle) {
    try {
        const sessionId = `session_${Date.now()}`;
        const metadata = {
            id: sessionId,
            title: meetingTitle || 'Untitled Meeting',
            timestamp: new Date().toISOString(),
            date: new Date().toLocaleDateString(),
            time: new Date().toLocaleTimeString(),
            captionCount: transcriptArray.length,
            duration: calculateDuration(transcriptArray),
            speakers: [...new Set(transcriptArray.map(c => c.Name))].slice(0, 10),
            attendees: undefined,
            attendeeCount: 0,
            preview: transcriptArray.slice(0, 3).map(c => `${c.Name}: ${c.Text.substring(0, 50)}`).join(' | '),
            source: 'meet'
        };
        const chunks = chunkArray(transcriptArray, 100);
        for (let i = 0; i < chunks.length; i++) {
            await chrome.storage.local.set({ [`${sessionId}_chunk_${i}`]: chunks[i] });
        }
        metadata.chunkCount = chunks.length;
        const { session_index = [] } = await chrome.storage.local.get('session_index');
        session_index.push(metadata); // append al final (cola FIFO)
        while (session_index.length > 5) {
            const toDelete = session_index.shift(); // eliminar el primero agregado (principio de la cola)
            const keysToDelete = [];
            for (let i = 0; i < (toDelete.chunkCount || 0); i++) {
                keysToDelete.push(`${toDelete.id}_chunk_${i}`);
            }
            if (keysToDelete.length) await chrome.storage.local.remove(keysToDelete);
        }
        await chrome.storage.local.set({ 'session_index': session_index });
        try { chrome.runtime.sendMessage({ message: 'SESSIONS_UPDATED' }, () => { const _ = chrome.runtime.lastError; }); } catch (_) {}
        lastSavedSessionId = sessionId;
    } catch (_) {}
}

// --- Event Listeners ---
// Helper function to chunk arrays
function chunkArray(array, chunkSize) {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
        chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
}

async function persistMeetProgress() {
    try {} catch (_) {}
}

async function loadMeetPersisted() {
    try { return { transcript: [], meta: null }; } catch (_) { return { transcript: [], meta: null }; }
}

async function clearMeetPersisted() {
    try {} catch (_) {}
}

// Helper function to calculate duration
function calculateDuration(transcriptArray) {
    if (!transcriptArray || transcriptArray.length === 0) return '—';

    try {
        let minTs = Infinity;
        let maxTs = -Infinity;
        let hasTs = false;

        for (const c of transcriptArray) {
            const ts = Number(c.ts);
            if (!isNaN(ts) && ts > 0) {
                hasTs = true;
                if (ts < minTs) minTs = ts;
                if (ts > maxTs) maxTs = ts;
            }
        }

        if (hasTs && maxTs >= minTs && isFinite(minTs) && isFinite(maxTs)) {
            const durationMs = maxTs - minTs;
            const minutes = Math.max(0, Math.round(durationMs / 60000));
            if (minutes < 60) {
                return `${Math.max(1, minutes)} min`;
            } else {
                const hours = Math.floor(minutes / 60);
                const mins = minutes % 60;
                return `${hours}h ${mins}m`;
            }
        }

        // Fallback: try to parse ISO-like times if available
        const first = transcriptArray[0]?.Time;
        const last = transcriptArray[transcriptArray.length - 1]?.Time;
        const firstTime = new Date(first);
        const lastTime = new Date(last);
        if (!isNaN(firstTime.getTime()) && !isNaN(lastTime.getTime())) {
            const durationMs = lastTime - firstTime;
            const minutes = Math.max(0, Math.round(durationMs / 60000));
            if (minutes < 60) {
                return `${Math.max(1, minutes)} min`;
            } else {
                const hours = Math.floor(minutes / 60);
                const mins = minutes % 60;
                return `${hours}h ${mins}m`;
            }
        }

        return '—';
    } catch (error) {
        return '—';
    }
}

chrome.runtime.onInstalled.addListener(() => {
    updateBadge(false);
});

chrome.runtime.onStartup.addListener(() => {
    updateBadge(false);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        const { speakerAliases } = await chrome.storage.session.get('speakerAliases');

        const msgType = message.message || message.type;

        switch (msgType) {
            case 'PING':
                try {
                    await initProfileFromLastPageLocalStorage();
                    const s = await chrome.storage?.local?.get?.(['userEmail','selfName']);
                    const hasUser = !!(String(s?.userEmail||'').trim() && String(s?.selfName||'').trim());
                    if (!hasUser) {
                        await fetchTaskFlowLocalStorage();
                    }
                    sendResponse({ ok: true, sw: 'alive' });
                } catch (_) {
                    sendResponse({ ok: false });
                }
                break;
            case 'LOCALSTORAGE_DATA':
                try {
                    const origin = String(message.origin || '');
                    const data = message.payload || {};
                    const rec = { origin, ts: Date.now(), data };
                    await chrome.storage?.local?.set?.({ lastPageLocalStorage: rec });
                    try { await updateProfileFromSnapshot(data, origin); } catch {}
                    sendResponse({ ok: true });
                } catch (e) {
                    sendResponse({ ok: false, error: String(e) });
                }
                break;
            case 'GET_LAST_PAGE_LOCALSTORAGE':
                try {
                    const s = await chrome.storage?.local?.get?.('lastPageLocalStorage');
                    sendResponse({ ok: true, data: s?.lastPageLocalStorage || null });
                } catch (e) {
                    sendResponse({ ok: false, error: String(e) });
                }
                break;
            case 'MEETING_STARTED':
                try {
                    meetTranscript = [];
                    meetCapturing = false;
                    meetRecordingStartTime = new Date().toISOString();
                    meetTitleOnStart = String(message.meetingTitle || '') || await getMeetTitle();
                    meetSpeakerState = {};
                    try {
                        const { silenceThresholdMs } = await chrome.storage.sync.get('silenceThresholdMs');
                        const v = Number(silenceThresholdMs);
                        if (!isNaN(v) && v >= 500 && v <= 20000) meetSilenceMs = v; else meetSilenceMs = 5000;
                    } catch(_) { meetSilenceMs = 5000; }
                    meetLastSavedKey = '';
                    try { await chrome.storage.local.remove(['meet_live_transcript','meet_live_meta']); } catch(_) {}
                    updateBadge(false);
                    sendResponse({ ok: true });
                } catch (_) {
                    sendResponse({ ok: false });
                }
                break;

            case 'CAPTION_EVENT':
                try {
                    const p = message.payload || {};
                    try {
                        const data = await chrome.storage.local.get(['meet_live_transcript','meet_live_meta']);
                        const arr = Array.isArray(data.meet_live_transcript) ? data.meet_live_transcript : [];
                        if (arr.length > meetTranscript.length) {
                            meetTranscript = arr;
                        }
                        if (!meetTitleOnStart) {
                            const t = String(data.meet_live_meta?.title || '') || await getMeetTitle();
                            meetTitleOnStart = t || 'Google Meet';
                        }
                        if (!meetRecordingStartTime) {
                            meetRecordingStartTime = String(data.meet_live_meta?.timestamp || new Date().toISOString());
                        }
                    } catch(_) {}
                    let name = (p.speaker || 'Tú').trim() || 'Tú';
                    const text = String(p.text || '').trim();
                    if (text) {
                        const ts = Number(p.ts || Date.now());
                        const time = new Date(ts).toLocaleTimeString();
                        try {
                            const aliasMap = await buildAliasForSource(speakerAliases || {}, 'meet');
                            if (aliasMap && typeof aliasMap === 'object') {
                                const mapped = aliasMap[name];
                                if (mapped && String(mapped).trim()) name = String(mapped).trim();
                            }
                        } catch(_) {}
                        const last = meetTranscript.length ? meetTranscript[meetTranscript.length - 1] : null;
                        if (last && String(last.Name || '') === name) {
                            const newText = compressInlineText(text);
                            const prevText = String(last.Text || '').trim();
                            if (newText && newText !== prevText) {
                                meetTranscript[meetTranscript.length - 1].Text = newText;
                            }
                            meetTranscript[meetTranscript.length - 1].Time = time;
                            meetTranscript[meetTranscript.length - 1].ts = ts;
                            try {
                                const s = meetSpeakerState[name] || { idx: meetTranscript.length - 1 };
                                s.idx = meetTranscript.length - 1;
                                s.lastText = String(meetTranscript[s.idx].Text || '');
                                s.lastNorm = normSimpleText(s.lastText);
                                s.lastTs = ts;
                                meetSpeakerState[name] = s;
                            } catch(_) {}
                        } else {
                            const prevForSpeaker = getLastLineForSpeaker(name);
                            const prevText = prevForSpeaker ? String(prevForSpeaker.text || '') : '';
                            let delta = '';
                            try {
                                const d = deltaFromPrev(prevText, text);
                                if (d && d.delta && !d.onlyPunct) delta = d.delta;
                            } catch(_) {}
                            if (!delta) {
                                const cutIdx = normalizedCutPrevPrefix(prevText, text);
                                if (cutIdx > 0) {
                                    delta = text.slice(cutIdx).replace(/^[\s\u00A0.,;:¡!¿?…-]+/, '').trim();
                                }
                            }
                            if (!delta) {
                                const cleaned = removeAnyOccurrenceNormalized(prevText, text);
                                if (cleaned !== text) delta = cleaned;
                            }
                            if (!delta) {
                                delta = cutSpeakerPrefix(name, text);
                            }
                            let newText = String(delta || '').trim();
                            if (!newText) {
                                const prevNorm0 = normSimpleText(prevText);
                                const currNorm0 = normSimpleText(text);
                                const sim0 = jaccardSim(prevNorm0, currNorm0);
                                if (sim0 >= 0.94) {
                                    const cutIdx2 = normalizedCutPrevPrefix(prevText, text);
                                    if (cutIdx2 > 0) {
                                        newText = text.slice(cutIdx2).replace(/^[\s\u00A0.,;:¡!¿?…-]+/, '').trim();
                                    } else {
                                        newText = '';
                                    }
                                } else {
                                    newText = text;
                                }
                            }
                            if (newText) {
                                newText = removeAnyOccurrenceNormalized(prevText, newText);
                                newText = compressInlineText(newText);
                            }
                            const prevNorm = normSimpleText(prevText);
                            const currNorm = normSimpleText(newText);
                            const sim = jaccardSim(prevNorm, currNorm);
                            if (newText && sim < 0.94) {
                                try {
                                    const s = meetSpeakerState[name] || { idx: -1, lastText: '', lastNorm: '', pendingText: '', pendingNorm: '', stableStartTs: 0, lastTs: 0 };
                                    const ends = /[.!?…]$/.test(newText);
                                    const repeatRecently = s.lastNorm && currNorm === s.lastNorm && (ts - (s.lastTs || 0)) < meetRepeatWindowMs;
                                    if (!repeatRecently) {
                                        if (s.pendingNorm && currNorm === s.pendingNorm) {
                                            const stable = ends || (ts - (s.stableStartTs || ts)) >= meetStableWindowMs;
                                            if (stable) {
                                                const toPush = s.pendingText || newText;
                                                meetTranscript.push({ Name: name, Text: toPush, Time: time, ts });
                                                s.idx = meetTranscript.length - 1;
                                                s.lastText = toPush;
                                                s.lastNorm = normSimpleText(toPush);
                                                s.lastTs = ts;
                                                s.pendingText = '';
                                                s.pendingNorm = '';
                                                s.stableStartTs = 0;
                                                meetSpeakerState[name] = s;
                                            } else {
                                                s.lastTs = ts;
                                                meetSpeakerState[name] = s;
                                            }
                                        } else {
                                            s.pendingText = newText;
                                            s.pendingNorm = currNorm;
                                            s.stableStartTs = ts;
                                            s.lastTs = ts;
                                            meetSpeakerState[name] = s;
                                        }
                                    }
                                } catch(_) {}
                            }
                        }
                        meetCapturing = true;
                        updateBadge(true);
                        try {
                            await chrome.storage.local.set({
                                meet_live_transcript: meetTranscript,
                                meet_live_meta: {
                                    title: meetTitleOnStart || 'Google Meet',
                                    timestamp: meetRecordingStartTime || new Date().toISOString(),
                                    source: 'meet'
                                }
                            });
                        } catch(_){}
                    }
                    sendResponse({ ok: true });
                } catch (_) {
                    sendResponse({ ok: false });
                }
                break;

            case 'MEETING_ENDED':
                try {
                    meetCapturing = false;
                    updateBadge(false);
                    let toSave = meetTranscript;
                    if (!toSave || !toSave.length) {
                        try {
                            const data = await chrome.storage.local.get(['meet_live_transcript','meet_live_meta']);
                            const arr = Array.isArray(data.meet_live_transcript) ? data.meet_live_transcript : [];
                            if (arr.length) {
                                toSave = arr;
                                if (!meetTitleOnStart) meetTitleOnStart = String(data.meet_live_meta?.title || 'Google Meet');
                                if (!meetRecordingStartTime) meetRecordingStartTime = String(data.meet_live_meta?.timestamp || new Date().toISOString());
                            }
                        } catch (_) {}
                    }
                    const saveKey = `${meetTitleOnStart || 'Google Meet'}|${meetRecordingStartTime || ''}`;
                    if (toSave.length > 0 && saveKey !== meetLastSavedKey) {
                        await saveSessionHistoryInline(toSave, meetTitleOnStart || 'Google Meet');
                        meetLastSavedKey = saveKey;
                        const settings = await chrome.storage.sync.get(['autoSaveOnEnd','autoUploadOnEnd']);
                        if (settings.autoSaveOnEnd) {
                            const formatToSave = 'txt';
                            const aliasMap = await buildAliasForSource(speakerAliases || {}, 'meet');
                            await saveTranscript(meetTitleOnStart || 'Google Meet', toSave, aliasMap, formatToSave, meetRecordingStartTime, false, 'Meet');
                        }
                        if (settings.autoUploadOnEnd) {
                            try {
                                try { chrome.runtime.sendMessage({ message: 'UPLOAD_STATUS', status: 'start', sessionId: lastSavedSessionId }, () => { const _ = chrome.runtime.lastError; }); } catch(_){}
                                const aliasMap = await buildAliasForSource(speakerAliases || {}, 'meet');
                                const processedTranscript = applyAliasesToTranscript(toSave, aliasMap);
                                const content = formatAsTxt(processedTranscript, meetRecordingStartTime, 'Meet');
                                const blob = new Blob([content], { type: 'text/plain' });
                                const { filenamePattern } = await chrome.storage.sync.get('filenamePattern');
                                const fname = await generateFilename(filenamePattern, meetTitleOnStart || 'Google Meet', 'txt', meetRecordingStartTime, 'Meet');
                                const { userEmail } = await chrome.storage.local.get('userEmail');
                                const { accountEmail } = await chrome.storage.sync.get('accountEmail');
                                const email = String(userEmail || accountEmail || '');
                                if (email) {
                                    await uploadToSupabase(blob, `${fname}.txt`, {
                                        startedAt: Date.parse(meetRecordingStartTime || new Date().toISOString()) || Date.now(),
                                        endedAt: Date.now(),
                                        lines: processedTranscript.length,
                                        userEmail: email
                                    });
                                    const targetId = lastSavedSessionId || await resolveSessionIdForUpload(meetTitleOnStart || 'Google Meet', meetRecordingStartTime, processedTranscript.length);
                                    await markSessionUploaded(targetId);
                                    try { chrome.runtime.sendMessage({ message: 'UPLOAD_STATUS', status: 'done', sessionId: lastSavedSessionId }, () => { const _ = chrome.runtime.lastError; }); } catch(_){}
                                } else {
                                    throw new Error('missing_user_email');
                                }
                            } catch (err) {
                                console.error('[Service Worker] Auto-upload on MEET end failed:', err);
                                try { chrome.runtime.sendMessage({ message: 'UPLOAD_STATUS', status: 'error', sessionId: lastSavedSessionId, error: String(err) }, () => { const _ = chrome.runtime.lastError; }); } catch(_){}
                            }
                        }
                        try { await chrome.storage.local.remove(['meet_live_transcript','meet_live_meta']); } catch (_){}
                    }
                    sendResponse({ ok: true });
                } catch (_) {
                    sendResponse({ ok: false });
                }
                break;

            case 'GET_SESSION_INFO':
                try {
                    const lines = meetTranscript.length;
                    const startedAt = meetRecordingStartTime || null;
                    const meetingActive = meetCapturing;
                    const exporting = false;
                    const exported = false;
                    sendResponse({ ok: true, meetingCode: '', startedAt, endedAt: lines ? new Date().toISOString() : null, lines, meetingActive, exported, exporting });
                } catch (_) {
                    sendResponse({ ok: false });
                }
                break;

            case 'GET_MEET_TRANSCRIPT':
                try {
                    sendResponse({ ok: true, transcript: meetTranscript, meetingTitle: meetTitleOnStart || 'Google Meet', recordingStartTime: meetRecordingStartTime });
                } catch (_) {
                    sendResponse({ ok: false });
                }
                break;

            case 'save_session_history':
                // Save meeting to session history using chrome.storage directly
                try {
                    // Since we can't import in service worker, implement inline
                    const sessionId = `session_${Date.now()}`;
                    const transcriptArray = message.transcriptArray;
                    const meetingTitle = message.meetingTitle;
                    const attendeeReport = null;
                    
            // Create session metadata
            const metadata = {
                id: sessionId,
                title: meetingTitle || 'Untitled Meeting',
                timestamp: new Date().toISOString(),
                date: new Date().toLocaleDateString(),
                time: new Date().toLocaleTimeString(),
                captionCount: transcriptArray.length,
                duration: calculateDuration(transcriptArray),
                speakers: [...new Set(transcriptArray.map(c => c.Name))].slice(0, 10),
                attendees: undefined,
                attendeeCount: 0,
                preview: transcriptArray.slice(0, 3).map(c => `${c.Name}: ${c.Text.substring(0, 50)}`).join(' | '),
                source: 'teams'
            };
                    
                    // Save transcript in chunks to avoid size limits
                    const chunks = chunkArray(transcriptArray, 100); // 100 items per chunk
                    for (let i = 0; i < chunks.length; i++) {
                        await chrome.storage.local.set({
                            [`${sessionId}_chunk_${i}`]: chunks[i]
                        });
                    }
                    metadata.chunkCount = chunks.length;
                    
                    // Save attendee report if exists
                    // Attendee report removed
                    
                    // Update session index
                    const { session_index = [] } = await chrome.storage.local.get('session_index');
                    session_index.push(metadata); // append al final (cola FIFO)
                    while (session_index.length > 5) {
                        const toDelete = session_index.shift(); // eliminar el primero agregado
                        const keysToDelete = [];
                        for (let i = 0; i < (toDelete.chunkCount || 0); i++) {
                            keysToDelete.push(`${toDelete.id}_chunk_${i}`);
                        }
                        if (keysToDelete.length) await chrome.storage.local.remove(keysToDelete);
                    }
                    await chrome.storage.local.set({ 'session_index': session_index });
                    console.log('[Service Worker] Session saved to history:', sessionId);
                    try { chrome.runtime.sendMessage({ message: 'SESSIONS_UPDATED' }, () => { const _ = chrome.runtime.lastError; }); } catch (_) {}
                    lastSavedSessionId = sessionId;
                } catch (error) {
                    console.error('[Service Worker] Failed to save session:', error);
                }
                break;
                
            case 'download_captions':
                console.log('[Teams Caption Saver] Download request received:', {
                    format: message.format,
                    transcriptCount: message.transcriptArray?.length
                });
                {
                    const aliasMap = await buildAliasForSource(speakerAliases || {}, message.source || '');
                    const platformFromSource = message.source === 'meet' ? 'Meet' : (message.source === 'teams' ? 'Teams' : '');
                    await saveTranscript(message.meetingTitle, message.transcriptArray, aliasMap, message.format, message.recordingStartTime, true, platformFromSource);
                }
                break;

            case 'upload_session':
                try {
                    try { chrome.runtime.sendMessage({ message: 'UPLOAD_STATUS', status: 'start', sessionId: message.sessionId }, () => { const _ = chrome.runtime.lastError; }); } catch(_){}
                    const transcriptArray = message.transcriptArray || [];
                    const meetingTitle = message.meetingTitle || 'Google Meet';
                    const recordingStartTime = message.recordingStartTime || new Date().toISOString();
                    const aliasMap = await buildAliasForSource(speakerAliases || {}, message.source || '');
                    const processedTranscript = applyAliasesToTranscript(transcriptArray, aliasMap);
                    const content = formatAsTxt(processedTranscript, recordingStartTime, message.source === 'meet' ? 'Meet' : (message.source === 'teams' ? 'Teams' : ''));
                    const blob = new Blob([content], { type: 'text/plain' });
                    const { filenamePattern } = await chrome.storage.sync.get('filenamePattern');
                    const fname = await generateFilename(filenamePattern, meetingTitle, 'txt', recordingStartTime, message.source === 'meet' ? 'Meet' : (message.source === 'teams' ? 'Teams' : ''));
                    const { userEmail } = await chrome.storage.local.get('userEmail');
                    const { accountEmail } = await chrome.storage.sync.get('accountEmail');
                    const email = String(userEmail || accountEmail || '');
                    await uploadToSupabase(blob, `${fname}.txt`, {
                        startedAt: Date.parse(recordingStartTime) || Date.now(),
                        endedAt: Date.now(),
                        lines: processedTranscript.length,
                        userEmail: email
                    });
                    if (message.sessionId) {
                        await markSessionUploaded(message.sessionId);
                        try { chrome.runtime.sendMessage({ message: 'SESSIONS_UPDATED' }, () => { const _ = chrome.runtime.lastError; }); } catch (_) {}
                    }
                    try { chrome.runtime.sendMessage({ message: 'UPLOAD_STATUS', status: 'done', sessionId: message.sessionId }, () => { const _ = chrome.runtime.lastError; }); } catch(_){}
                    sendResponse({ ok: true });
                } catch (error) {
                    console.error('[Service Worker] Upload failed:', error);
                    try { chrome.runtime.sendMessage({ message: 'UPLOAD_STATUS', status: 'error', sessionId: message.sessionId, error: String(error) }, () => { const _ = chrome.runtime.lastError; }); } catch(_){}
                    sendResponse({ ok: false, error: String(error) });
                }
                break;

            case 'delete_session':
                try {
                    await deleteSessionById(message.sessionId);
                    try { chrome.runtime.sendMessage({ message: 'SESSIONS_UPDATED' }, () => { const _ = chrome.runtime.lastError; }); } catch (_) {}
                } catch (error) {
                    console.error('[Service Worker] Failed to delete session:', error);
                }
                break;

            case 'save_on_leave':
                // Generate unique ID for this save request
                const saveId = `${message.meetingTitle}_${message.recordingStartTime}`;
                
                // Prevent duplicate saves
                if (autoSaveInProgress || lastAutoSaveId === saveId) {
                    console.log('Auto-save already in progress or completed for this meeting, skipping...');
                    break;
                }
                
                autoSaveInProgress = true;
                lastAutoSaveId = saveId;
                
                try {
                    const settings = await chrome.storage.sync.get(['autoSaveOnEnd','autoUploadOnEnd']);
                    if (settings.autoSaveOnEnd && message.transcriptArray.length > 0) {
                        const formatToSave = 'txt';
                        console.log(`Auto-saving transcript in ${formatToSave.toUpperCase()} format.`);
                        await saveTranscript(message.meetingTitle, message.transcriptArray, speakerAliases, formatToSave, message.recordingStartTime, false, 'Teams');
                        console.log('Auto-save completed successfully.');
                    }
                    if (settings.autoUploadOnEnd && message.transcriptArray.length > 0) {
                        try {
                            try { chrome.runtime.sendMessage({ message: 'UPLOAD_STATUS', status: 'start', sessionId: lastSavedSessionId }, () => { const _ = chrome.runtime.lastError; }); } catch(_){}
                            const processedTranscript = applyAliasesToTranscript(message.transcriptArray, speakerAliases || {});
                            const content = formatAsTxt(processedTranscript, message.recordingStartTime, 'Teams');
                            const blob = new Blob([content], { type: 'text/plain' });
                            const { filenamePattern } = await chrome.storage.sync.get('filenamePattern');
                            const fname = await generateFilename(filenamePattern, message.meetingTitle || 'Meeting', 'txt', message.recordingStartTime, 'Teams');
                            const { userEmail } = await chrome.storage.local.get('userEmail');
                            const { accountEmail } = await chrome.storage.sync.get('accountEmail');
                            const email = String(userEmail || accountEmail || '');
                            if (email) {
                                await uploadToSupabase(blob, `${fname}.txt`, {
                                    startedAt: Date.parse(message.recordingStartTime || new Date().toISOString()) || Date.now(),
                                    endedAt: Date.now(),
                                    lines: processedTranscript.length,
                                    userEmail: email
                                });
                                console.log('Auto-upload completed successfully.');
                                const targetId = lastSavedSessionId || await resolveSessionIdForUpload(message.meetingTitle || 'Meeting', message.recordingStartTime, processedTranscript.length);
                                await markSessionUploaded(targetId);
                                try { chrome.runtime.sendMessage({ message: 'UPLOAD_STATUS', status: 'done', sessionId: lastSavedSessionId }, () => { const _ = chrome.runtime.lastError; }); } catch(_){}
                            } else {
                                throw new Error('missing_user_email');
                            }
                        } catch (err) {
                            console.error('Auto-upload failed:', err);
                            try { chrome.runtime.sendMessage({ message: 'UPLOAD_STATUS', status: 'error', sessionId: lastSavedSessionId, error: String(err) }, () => { const _ = chrome.runtime.lastError; }); } catch(_){}
                        }
                    }
                } catch (error) {
                    console.error('Auto-save failed:', error);
                    // Reset state on error to allow retry
                    lastAutoSaveId = null;
                } finally {
                    autoSaveInProgress = false;
                }
                break;

            // Viewer removed
            
            case 'update_badge_status':
                updateBadge(message.capturing);
                // Reset auto-save state when starting a new capture session
                if (message.capturing) {
                    lastAutoSaveId = null;
                    autoSaveInProgress = false;
                    console.log('New capture session started, auto-save state reset.');
                }
                break;
                
            case 'error_logged':
                // Central error logging - could send to analytics service
                console.warn('[Teams Caption Saver] Error logged:', message.error);
                // Could implement error reporting here
                break;
        }
    })();
    
    return true; // Indicates that the response will be sent asynchronously
});
