(() => {
  let running = false;
  let t0 = 0;
  const events = []; // { timeStr, speaker, text }
  // Nombre propio del usuario local (persistido en storage)
  let selfName = "";
  (async () => {
    try {
      const s = await chrome.storage?.local?.get?.('selfName');
      const nm = (s && s.selfName) ? String(s.selfName).trim() : '';
      if (nm) selfName = nm;
    } catch {}
  })();
  // Estado "solo": si no aparece otro orador por un tiempo
  let lastOtherSpeakerAt = 0;
  const SOLO_WINDOW_MS = 15000; // 15s sin otros oradores => solo
  function isSoloRecent() { return (Date.now() - lastOtherSpeakerAt) > SOLO_WINDOW_MS; }

  // Helper para enviar mensajes sin generar "Unchecked runtime.lastError"
  function sendMessageSafe(msg) {
    try {
      chrome.runtime?.sendMessage?.(msg, () => {
        const err = chrome.runtime?.lastError;
        if (err) { /* ignorar: receptor puede no estar listo */ }
      });
    } catch {}
  }

  // --- Puente page → content → background ---
  // Permite capturar mensajes enviados desde la propia página (window.postMessage)
  // y reenviarlos al Service Worker. Valida mismo origen por seguridad.
  function readLocalStorageSafe() {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (typeof k === 'string') out[k] = localStorage.getItem(k);
      }
    } catch {}
    return out;
  }

  try {
    window.addEventListener('message', (event) => {
      try {
        if (event.source !== window) return; // solo mensajes del mismo contexto
        const origin = String(event.origin || '');
        const sameOrigin = origin === String(location.origin || '');
        if (!sameOrigin) return; // rechazar cross‑origin
        const data = event.data;
        if (!data || (data.source !== 'MEETIX_PAGE' && data.__meetix !== true)) return;
        const type = String(data.type || '');
        if (type === 'LOCALSTORAGE_DATA') {
          sendMessageSafe({ type: 'LOCALSTORAGE_DATA', origin, payload: data.payload || {} });
        } else if (type === 'GET_LOCALSTORAGE') {
          const payload = readLocalStorageSafe();
          sendMessageSafe({ type: 'LOCALSTORAGE_DATA', origin, payload });
        }
      } catch {}
    });
  } catch {}

  function setSelfNameLocal(name) {
    const nm = String(name || "").trim();
    if (!nm) return;
    // Evitar usar etiquetas de sistema como nombre propio
    if (/^(tu\s+reunión\s+es\s+segura|detalles\s+de\s+la\s+reunión|fijado\s+para\s+ti|los\s+usuarios\s+se\s+han\s+unido\s+por\s+tel[é|e]fono)$/i.test(nm)) return;
    // Evitar códigos de reunión (zun-wuox-oeu)
    if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(nm)) return;
    // Limpiar sufijos tipo (Tu presentación)
    const cleaned = nm.replace(/\s*\((tu|tú|you)?\s*presentaci[óo]n\)\s*$/i, '').trim();
    if (!cleaned || /^(tu|tú|you)$/i.test(cleaned)) return;
    // Si ya existe nombre, sólo permitir corrección cuando estamos solos
    if (selfName && !isSoloRecent()) return;
    selfName = cleaned;
    try {
      chrome.storage?.local?.set?.({ selfName: cleaned });
      // Notificar al SW para refrescar caché
      sendMessageSafe({ type: 'SELF_NAME_UPDATED' });
    } catch {}
  }

  // Setter verificado: usar sólo cuando la fuente indica explícitamente "(Tú)/(You)".
  // No aplica la restricción de estar solo; permite corregir selfName incorrecto.
  function setSelfNameVerified(name) {
    const nm = String(name || '').trim();
    if (!nm) return;
    if (/^(tu\s+reunión\s+es\s+segura|detalles\s+de\s+la\s+reunión|fijado\s+para\s+ti|los\s+usuarios\s+se\s+han\s+unido\s+por\s+tel[é|e]fono)$/i.test(nm)) return;
    if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(nm)) return;
    const cleaned = nm.replace(/\s*\((tu|tú|you)?\s*presentaci[óo]n\)\s*$/i, '').trim();
    if (!cleaned || /^(tu|tú|you)$/i.test(cleaned)) return;
    selfName = cleaned;
    try {
      chrome.storage?.local?.set?.({ selfName: cleaned });
      sendMessageSafe({ type: 'SELF_NAME_UPDATED' });
    } catch {}
  }

  const pad = n => String(n).padStart(2, "0");
  const fmtHMS = ms => {
    const s = Math.floor(ms / 1000);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  };

  // --- Deep observer: observa DOM + Shadow DOM y reintenta enganchar nuevos roots ---
  const activeObservers = new Set();
  let reattachTimer = null;
  let meetingEndSignaled = false;

  function checkMeetingEndedMarkers() {
    try {
      if (meetingEndSignaled) return;
      const txt = String(document.body?.innerText || '').toLowerCase();
      const markers = [
        'has abandonado la reunión',
        'has salido de la reunión',
        'has abandonado la llamada',
        'has salido de la llamada',
        'abandonaste la llamada',
        'finalizaste la llamada',
        'dejaste la llamada',
        'se volverá a mostrar la pantalla de inicio',
        'volviendo a la pantalla de inicio',
        'you left the meeting',
        "you've left the meeting",
        'left the call',
        'end call',
        'returning to the home screen'
      ];
      const ended = markers.some(m => txt.includes(m));
      if (ended) {
        meetingEndSignaled = true;
        try { chrome.runtime.sendMessage({ type: 'MEETING_ENDED' }); } catch {}
      }
    } catch {}
  }

  // Intento genérico de descubrir el nombre propio desde la lista de participantes
  function guessSelfNameFromParticipants() {
    try {
      // Buscar elementos con aria-label que incluyan "(Tú)" / "(You)"
      const els = Array.from(document.querySelectorAll('[aria-label]'));
      for (const el of els) {
        const al = String(el.getAttribute('aria-label') || '').trim();
        if (!al) continue;
        const mTu = al.match(/^(.+?)\s*\((tu|tú|you)\)\s*$/i);
        if (mTu && mTu[1]) {
          const nm = mTu[1].trim();
          if (nm && !/^(tu|tú|you)$/i.test(nm)) {
            setSelfNameVerified(nm);
            return;
          }
        }
      }
      // Fallback: nombre visible con etiqueta notranslate seguido de "(Tú)"
      const spanTu = Array.from(document.querySelectorAll('span.notranslate'))
        .map(s => String(s.textContent || '').trim())
        .find(t => /(\(\s*(tu|tú|you)\s*\))$/i.test(t));
      if (spanTu) {
        const nm = spanTu.replace(/\(\s*(tu|tú|you)\s*\)$/i, '').trim();
        if (nm) setSelfNameVerified(nm);
      }
    } catch {}
  }

  // --- Filtros configurables y clasificación de texto ---
  const filterConfig = {
    includeSpeech: true,
    includeActions: false,
    excludeDeviceState: true,   // excluir cámara/micrófono activado/desactivado
    excludeSystemInfo: true,    // excluir banners y mensajes informativos generales
    includeHandActions: true    // levantar/bajar la mano (puedes poner false si no quieres)
  };

  // --- Detección profesional de fuentes de subtítulos ---
  // Evita hardcodear frases o clases. Clasifica por señales (features):
  // frecuencia de cambios, morfología del texto y posición en viewport.
  const captionCandidates = new Map(); // el -> { changes: number[], lastText: string }
  const lastSpeakerByEl = new Map();   // el -> { speaker: string, ts: number }
  const pendingByEl = new Map();       // el -> { speaker: string, buffer: string, emittedCount: number, lastUpdate: number, timer: any }
  const turnsBySpeaker = new Map();    // speaker -> { text: string, startedAt: number, lastUpdate: number, timer: any }
  let currentSpeaker = "";            // orador activo del turno actual
  let lastSpeakerGlobal = "";         // último orador visto explícitamente (badge/aria)

  const nowMs = () => Date.now();
  const tokenize = (s) => s.trim().split(/\s+/);
  const hasDigits = (s) => /[0-9]/.test(s);
  const isTitlecaseWord = (w) => /^[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+$/.test(w);
  const mostlyLowercase = (s) => {
    const lower = (s.match(/[a-záéíóúüñ]/g) || []).length;
    const upper = (s.match(/[A-ZÁÉÍÓÚÜÑ]/g) || []).length;
    return lower >= upper;
  };

  function isAriaLive(el) {
    let e = el;
    for (let i = 0; i < 5 && e; i++) {
      const ariaLive = e.getAttribute?.("aria-live");
      const role = e.getAttribute?.("role");
      if (ariaLive || role === "alert") return true;
      e = e.parentElement;
    }
    return false;
  }

  function updateCandidate(el, text) {
    const stats = captionCandidates.get(el) || { changes: [], lastText: "" };
    const ts = nowMs();
    stats.changes.push(ts);
    // mantener solo cambios recientes (10s)
    stats.changes = stats.changes.filter(t => ts - t <= 10000);
    stats.lastText = text;
    captionCandidates.set(el, stats);
  }

  function speechScore(s) {
    const len = s.length;
    const letters = (s.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length;
    const nonLetters = len - letters;
    const letterRatio = letters / Math.max(1, len);
    const words = tokenize(s);
    const wordCount = words.length;
    const hasVowel = /[aeiouáéíóúü]/i.test(s);
    const upper = (s.match(/[A-ZÁÉÍÓÚÜÑ]/g) || []).length;
    const lower = (s.match(/[a-záéíóúüñ]/g) || []).length;
    const mostlyLower = lower >= upper;
    const punctuation = (s.match(/[.,!?¡¿;:]/g) || []).length;

    let score = 0;
    if (wordCount >= 2) score += 2;
    if (letterRatio > 0.6) score += 1;
    if (hasVowel) score += 1;
    if (mostlyLower) score += 1;
    if (punctuation >= 1 && punctuation <= 4) score += 1;
    if (nonLetters / Math.max(1, len) > 0.4) score -= 2; // demasiados símbolos/menús
    return score;
  }

  function isCaptionSource(el, text) {
    const stats = captionCandidates.get(el);
    const recentChanges = stats ? stats.changes.length : 0;
    let score = speechScore(text);
    if (isAriaLive(el)) score += 2;
    // frecuencia de actualizaciones recientes
    if (recentChanges >= 1) score += Math.min(2, recentChanges);
    // ubicación aproximada: subtítulos suelen estar en el tercio inferior y centrados
    try {
      const r = el.getBoundingClientRect?.();
      if (r && r.height > 0 && r.width > 0) {
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const W = window.innerWidth;
        const H = window.innerHeight;
        if (cy > H * 0.55) score += 1;
        if (Math.abs(cx - W / 2) < W * 0.3) score += 1;
      }
    } catch {}

    return score >= 3;
  }

  // Utilidades genéricas para extracción de orador (no dependientes de frases específicas)
  // (utilidades anteriores movidas arriba: tokenize, hasDigits, isTitlecaseWord, mostlyLowercase)

  function classifyText(s) {
    const S = s.toLowerCase();
    const hasWord = (w) => S.includes(w);
    const reAny = (arr) => arr.some(r => r.test(s));
    const hasIconToken = /\b[a-z]+(?:_[a-z]+)+\b/.test(s); // nombres de iconos tipo material: keyboard_arrow_up, more_vert
    const iconWordRE = /^(people|chat|devices|language|circle|settings|mood|info|apps|arrow_downward|keyboard_arrow_up|format_size|closed_caption|closed_caption_off|visual_effects|frame_person|back_hand|front_hand|call_end|videocam|videocam_off|computer_arrow_up|lock_person)(\b|$)/i;

    // Dispositivo (cámara/micrófono): estado on/off, mute/unmute
    const devicePatterns = [
      /(cámara|camara|micrófono|microfono|mic)\s+está\s+(activad[oa]|desactivad[oa])/i,
      /(activar|desactivar)\s+(cámara|camara|micrófono|microfono|mic)/i,
      /\b(mute|mutear|silenciar|desmutear|reactivar)\b/i,
      // Inicio/preparación/estado listo
      /(cámara|camara|micrófono|microfono|mic)\s+(se\s+está\s+iniciando|está\s+iniciándose|iniciando|preparando|configurando|arrancando)/i,
      /(cámara|camara|micrófono|microfono|mic)\s+está\s+(lista|listo|iniciad[oa]|preparad[oa])/i,
      /(auriculares|headset|altavoz|altavoces)\b/i
    ];

    // Sistema/Info (banners, permisos, enlaces, marketing, UI de Meet)

    // Acciones (no dispositivo): levantar/bajar mano, invitar, unirse/abandonar como acción
    const actionPatterns = [
      /\b(levantado|bajado)\s+la\s+mano\b/i,
      /\b(levantando)\s+la\s+mano\b/i,
      /\b(invitar|invita|añadir|agregar)\b/i,
      /\b(unirse|unido|salir|abandonar|finalizar|unirme\s+ahora|unirse\s+ahora|admitir\s+a\s+todos|admitir)\b/i,
      /\b(compartir\s+pantalla|reacción|reacciones|opciones|ajustes|configuración|herramientas)\b/i,
      /\bfijar\s+(?:a\s+.*|tu\s+presentaci[óo]n)\s+a\s+tu\s+pantalla\s+principal\b/i,
      /\btraer\s+aqu[ií]\s+la\s+llamada\b/i,
      /\bactivar\s+pantalla\s+completa\b/i,
      /\bmostrar\s+mi\s+pantalla\s+de\s+todos\s+modos\b/i,
      /\bdejar\s+de\s+presentar\b/i,
      /\bcambiar\s+ajuste\s+de\s+imagen\s+en\s+imagen\s+autom[áa]tica\b/i
    ];

    const systemPatterns = [
      // mensajes típicos y permisos
      /\bte has unido\b/i,
      /\bhas salido\b/i,
      /\breunión está lista\b/i,
      /\best[áa]\s+en\s+esta\s+llamada\b/i,
      /\bsubt[íi]tulos?\s+autom[áa]ticos?\s+(activados|desactivados)\b/i,
      /\bsubt[íi]tulos?\s+(activados|desactivados)\b/i,
      /\bla\s+presentaci[óo]n\s+est[áa]\s+empezando\b/i,
      /\best[áa]s\s+presentando\b/i,
      /\bcopiar enlace\b/i,
      /\bañadir a alguien\b/i,
      /\bpermiso\b/i,
      /\benlace de reunión\b/i,
      /\benlace de la reunión copiado\b/i,
      /\bno puedes activar el micrófono(?:\s+de\s+otra\s+persona)?\b/i,
      /\bno\s+puedes\s+activar\s+el\s+audio\s+de\s+la\s+presentaci[óo]n\b/i,
      // banners/marketing y anuncios del sistema
      /\b(google\s+workspace|plan\s+premium|ver\s+plan)\b/i,
      /\b(la\s+llamada\s+finalizará\s+pronto)\b/i,
      /\b(es\s+posible\s+que\s+los\s+demás\s+sigan\s+viendo\s+tu\s+vídeo\s+completo)\b/i,
      /\b(detalles\s+de\s+la\s+reunión|herramientas\s+de\s+la\s+reunión|más\s+acciones)\b/i,
      /\b(otras\s+formas\s+de\s+unirse)\b/i,
      /\b(más\s+opciones|español\s*\(méxico\)|tono\s+de\s+piel|tamaño\s+de\s+fuente|color\s+del\s+texto|abrir\s+ajustes\s+de\s+subtítulos|activar\s+subtítulos|desactivar\s+subtítulos)\b/i,
      /\b(personas|chatear\s+con\s+todos|controles\s+del\s+anfitrión)\b/i,
      /\b(ctrl|mayús|shift|alt)\b/i,
      /\b(buscando\s+a\s+otros\s+participantes\s+en\s+la\s+llamada)\b/i,
      /\b(aquí\s+no\s+hay\s+nadie\s+más)\b/i,
      /\b(encuadrar|fondos\s+y\s+efectos)\b/i,
      /\b(los\s+usuarios\s+se\s+han\s+unido\s+por\s+tel[ée]fono)\b/i,
      /\b(imagen\s+en\s+imagen|picture\s*[- ]*in\s*[- ]*picture|pip\b)\b/i,
      /\bfijado\s+para\s+ti\b/i
    ];

    if (reAny(devicePatterns)) return { category: 'device' };
    if (hasIconToken || iconWordRE.test(s) || reAny(systemPatterns)) return { category: 'system' };
    if (reAny(actionPatterns)) return { category: 'action' };
    return { category: 'speech' };
  }

  function isInUIControl(el) {
    // Restringimos la detección a controles claramente interactivos para evitar falsos positivos
    const roles = new Set(["button","menuitem","tab","switch","checkbox","radio","combobox","textbox","search","menu","menubar","dialog"]);
    const tags = new Set(["BUTTON","A","LABEL","INPUT","SELECT","TEXTAREA"]);
    let e = el;
    for (let i = 0; i < 6 && e; i++) {
      const role = e.getAttribute?.("role");
      if (role && roles.has(String(role).toLowerCase())) return true;
      const tag = e.tagName;
      if (tag && tags.has(tag)) return true;
      if (e.getAttribute?.("contenteditable") === "true") return true;
      e = e.parentElement;
    }
    return false;
  }

  // Extrae el orador desde el DOM (badge del nombre). En distintas variantes de Meet
  // el nombre aparece con clases ofuscadas como NWpYId o NWpY1d. Cubrimos ambas.
  function getSpeakerFromDOM(node) {
    const isBadLabel = (label) => {
      const s = String(label || "").trim();
      if (!s) return true;
      // Filtrar etiquetas genéricas de UI de subtítulos
      if (/^(subtitulos|subtítulos|captions|closed captions|subtitles|cc)$/i.test(s)) return true;
      // Evitar textos demasiado largos o con dígitos
      if (/[0-9]/.test(s)) return true;
      return false;
    };
    const pick = (el) => {
      try {
        // Nombre visible junto al avatar o badge
        const s = el?.querySelector?.('span.NWpYId, div.NWpYId, span.NWpY1d, div.NWpY1d, [class*="NWpY1d"], [class*="NWpYId"], span.notranslate');
        const t = s?.textContent?.trim();
        if (t && !isBadLabel(t)) return t;
        // Tooltips tipo "ucc-*" suelen contener el nombre
        const tt = el?.querySelector?.('[id^="ucc-"]');
        const ttText = tt?.textContent?.trim();
        if (ttText && !isBadLabel(ttText)) return ttText;
        // Algunos layouts ponen el nombre como alt del avatar
        const img = el?.querySelector?.('img[alt]');
        const alt = img?.getAttribute?.('alt');
        if (alt && alt.trim() && !isBadLabel(alt)) return alt.trim();
        // O como aria-label en el contenedor
        const al = el?.getAttribute?.('aria-label');
        if (al && al.trim() && !isBadLabel(al)) {
          // Tomar primeras 1-3 palabras en TitleCase como candidato de nombre
          const m = al.trim().match(/^[A-ZÁÉÍÓÚÜÑ][^,;:\-]+/);
          if (m) return m[0].trim();
        }
      } catch {}
      return null;
    };
    let e = node;
    for (let i = 0; i < 6 && e; i++) {
      const found = pick(e);
      if (found) return found;
      let sib = e.previousElementSibling;
      for (let j = 0; j < 3 && sib; j++) {
        const f = pick(sib);
        if (f) return f;
        sib = sib.previousElementSibling;
      }
      // También probar siguientes hermanos por si el layout varía
      let nsib = e.nextElementSibling;
      for (let j = 0; j < 3 && nsib; j++) {
        const f2 = pick(nsib);
        if (f2) return f2;
        nsib = nsib.nextElementSibling;
      }
      e = e.parentElement;
    }
    // Fallback geométrico: elegir el span.NWpYId más cercano por posición
    try {
      const rect = node.getBoundingClientRect?.();
      if (rect) {
        const spans = Array.from(document.querySelectorAll('span.NWpYId, div.NWpYId, span.NWpY1d, div.NWpY1d, [class*="NWpY1d"], [class*="NWpYId"], img[alt]'));
        let best = null, bestDist = Infinity;
        const cx = rect.left + rect.width/2;
        const cy = rect.top;
        for (const s of spans) {
          const r = s.getBoundingClientRect?.();
          if (!r || r.width === 0 || r.height === 0) continue;
          // Preferir nombres por encima del bloque de subtítulos y cercanos en X
          const dx = Math.abs((r.left + r.width/2) - cx);
          const dy = Math.abs(r.bottom - cy);
          const score = dy + dx*0.2; // prioriza vertical
          if (score < bestDist && r.bottom <= cy + 220) { // rango más amplio
            bestDist = score;
            const cand = (s.getAttribute?.('alt') || s.textContent || '').trim();
            if (!isBadLabel(cand)) best = cand;
          }
        }
        if (best) return best;
      }
    } catch {}
    return null;
  }

  function parseCaptionNode(node) {
    // Captura texto del nodo o de sus hijos
    let raw = (node.innerText || node.textContent || "").trim();
    // Inserta espacio si un token de icono está pegado al texto
    raw = raw.replace(/([a-z]+_[a-z]+)(?=[A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/g, "$1 ");
    raw = raw.replace(/\s+/g, " ");
    if (!raw) return null;
    // Evitar líneas de una sola palabra muy cortas típicas de UI o pronombres sueltos
    if (/^(people|chat|devices|language|circle|settings|mood|info|apps|arrow_downward|keyboard_arrow_up|format_size|closed_caption|closed_caption_off|visual_effects|frame_person|back_hand|front_hand|call_end|videocam|videocam_off|computer_arrow_up|lock_person)$/i.test(raw)) return null;
    if (/^(tú|tu|yo|you)$/i.test(raw)) return null;
    // Evitar código de reunión como zun-wuox-oeu
    if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(raw)) return null;
    // Evitar badges con sólo nombre(s) o nombres duplicados
    const parts = raw.split(/\s+/);
    const onlyNames = parts.every(w => /^[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+$/.test(w));
    if (onlyNames && parts.length <= 3) return null;
    // Doble nombre y apellido repetidos ("Facu Valdez Facu Valdez")
    if (/^([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+\s+[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+)\s+\1$/.test(raw)) return null;
    updateCandidate(node, raw);

    // Filtrar ruido: CSS, tokens de UI, etc.
    const isLikelyCaptionText = (s) => {
      const len = s.length;
      if (len < 2 || len > 500) return false;
      // Evitar bloques de CSS / clases / variables
      if (s.startsWith(".") || s.includes("{") || s.includes("}") || s.includes("var(--") || s.includes("gm3-")) return false;
      // Mucho ; suele ser CSS
      const semi = (s.match(/;/g) || []).length;
      if (semi >= 2) return false;
      // Debe contener letras
      if (!/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(s)) return false;
      // Evitar URLs largas
      if (/https?:\/\//i.test(s)) return false;
      return true;
    };
    if (!isLikelyCaptionText(raw)) return null;

    // Ignorar nodos que están dentro de controles UI (menús, botones, toolbars)
    if (isInUIControl(node)) return null;

    // Clasificar contenido y aplicar política de filtros
    const { category } = classifyText(raw);
    if (category === 'device' && filterConfig.excludeDeviceState) return null;
    if (category === 'system' && filterConfig.excludeSystemInfo) return null;
    if (category === 'action' && !filterConfig.includeActions) return null;
    if (category === 'speech' && !filterConfig.includeSpeech) return null;

    // Fuente válida si el nodo es visible y el texto parece discurso;
    // preferimos aria-live pero no lo exigimos para no perder subtítulos en contenedores no estándar.
    const rect = node.getBoundingClientRect?.();
    const visible = rect && rect.width > 0 && rect.height > 0;
    // Permitir nodos ocultados por nosotros (cc-hidden) para que no ocupen pantalla pero sigan siendo capturados
    function isOurHidden(el) {
      let e = el;
      for (let i = 0; i < 6 && e; i++) {
        if (e.classList?.contains('cc-hidden') || e.dataset?.ccHidden === '1') return true;
        e = e.parentElement;
      }
      return false;
    }
    if (!visible && !isOurHidden(node)) return null;
    if (!(isAriaLive(node) || isCaptionSource(node, raw) || speechScore(raw) >= 4)) return null;
    // Intenta obtener el orador desde el DOM
    let speaker = getSpeakerFromDOM(node);
    let text = raw;
    // Filtrar texto de UI específico
    if (/^más\s+acciones$/i.test(text)) return null;

    // Heurística "Nombre: texto" sólo si no conseguimos orador vía DOM
    const i = raw.indexOf(":");
    if (!speaker && i > 0 && i < 50) {
      speaker = raw.slice(0, i).trim();
      text = raw.slice(i + 1).trim();
    } else if (!speaker) {
      // Extracción genérica "Nombre Texto" (sin ':') totalmente basada en features,
      // sin listas de palabras ni frases. Considera como posible orador una secuencia
      // inicial de 1-3 palabras en Titlecase, sin dígitos, cuyo resto parezca discurso.
      const words = tokenize(raw);
      if (words.length >= 2) {
        const maxCand = Math.min(2, words.length - 1); // nombres suelen ser 1-2 palabras
        let candWords = [];
        for (let k = 0; k < maxCand; k++) {
          const w = words[k];
          if (isTitlecaseWord(w) && !hasDigits(w)) candWords.push(w);
          else break;
        }
        if (candWords.length > 0) {
          const cand = candWords.join(" ");
          const rest = words.slice(candWords.length).join(" ");
          const restWords = tokenize(rest);
          const repeated = candWords.length === 1 && restWords[0] && restWords[0].toLowerCase() === candWords[0].toLowerCase();
          const badSingle = /^(no|si|sí|hola|tú|tu|yo|you|vale|bueno|gracias)$/i.test(candWords[0] || "");
          const allowSingleWord = candWords.length === 1 && speechScore(rest) >= 3 && !badSingle && (candWords[0].length >= 3);
          // Evitar que saludos/marcadores figuren como oradores
          const badFirst = /^(hola|buenos|buenas|cómo|como|mucho|mucha|muchas|muchos)$/i.test(candWords[0] || "");
          if (((restWords.length >= 2) || allowSingleWord) && mostlyLowercase(rest) && !repeated) {
            // No inferimos orador desde el texto para evitar falsos positivos como "Mucho".
            speaker = undefined;
            text = raw.trim();
          }
      }
    }
    }
    if (!text || text.length < 2) return null;
    if (!speaker) {
      const mem = lastSpeakerByEl.get(node);
      if (mem && nowMs() - mem.ts < 10000) speaker = mem.speaker;
    } else {
      lastSpeakerByEl.set(node, { speaker, ts: nowMs() });
    }
    return { speaker: speaker || "", text };
  }

  function emitLine(speaker, text, whenMs) {
    // Normaliza el orador "Tú"
    const spRaw = String(speaker || "").trim();
    let sp = speaker || "";
    if (/^(tu|tú|you)$/i.test(sp)) {
      // Intento inmediato de aprender el nombre desde el mosaico local si aún no lo tenemos
      if (!selfName) {
        
      }
      const nm = String(selfName || "").trim();
      sp = nm || "Tú";
    }
    // Filtrar speakers de UI no humanos
    if (/^logotipo\s+de\s+meet$/i.test(String(sp))) return;
    if (/^panel\s+lateral$/i.test(String(sp))) return;
    if (/^fijado\s+para\s+ti$/i.test(String(sp))) return;
    if (/^los\s+usuarios\s+se\s+han\s+unido\s+por\s+tel[eé]fono$/i.test(String(sp))) return;
    if (/^detalles\s+de\s+la\s+reunión$/i.test(String(sp))) return;
    if (/\b(activar|desactivar)\s+subt[íi]tulos\b/i.test(String(sp))) return;
    if (/^hay\s+un\s+problema\s+con\s+la\s+c[aá]mara/i.test(String(sp))) return;
    // Código de reunión como orador (ej. tgx-cfyv-owp) => ruido
    if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(String(sp))) return;
    // Filtro de ruido del UI (p. ej., "Detalles de la reunión")
    const lower = String(text || "").toLowerCase();
    const isCountdown = (/^quedan\s+\d+\s+(segundos|minutos)\b/i.test(lower) || /\b\d+\s+(seconds|minutes)\s+left\b/i.test(lower) || /^faltan\s+\d+\s+(segundos|minutos)\b/i.test(lower));
    const colors = ["blanco","negro","azul","verde","rojo","amarillo","cian","magenta"];
    let colorHits = 0; for (const c of colors) { if (lower.includes(c)) colorHits++; }
    const colorNoise = lower.includes("circlecolor") || lower.includes("texto predeterminado") || lower.includes("color predeterminado") || colorHits >= 4;
    // Ruido específico de ayuda de presentación/ventanas
    const uiHints = [
      'efecto espejo infinito',
      'no compartas la pantalla completa',
      'ventana del navegador entera',
      'comparte una sola pestaña',
      'ventana diferente',
      'tu presentación se ha añadido a la pantalla principal',
      'tu presentación está en la pantalla principal',
      'presentación se ha añadido a la pantalla principal',
      'presentación está en la pantalla principal',
      'tu llamada de meet está en otra ventana'
    ];
    const isUiHint = uiHints.some(p => lower.includes(p));
    // Si es ruido de paleta/colores, descartar SIEMPRE
    if (colorNoise) {
      // Evitar aprender desde etiquetas genéricas; usar sólo fuentes confiables
      try {
        // Participantes con (Tú)
        try { guessSelfNameFromParticipants(); } catch {}
        // Mosaico local cuando estamos solos
        if (!selfName && isSoloRecent()) {
          const roots = getLocalTileRoots();
          for (const r of roots) {
            const nm = extractLocalNameFromTile(r);
            if (nm && !/^(tu|tú|you)$/i.test(nm)) { setSelfNameVerified(nm); break; }
          }
        }
      } catch {}
      return;
    }
    // Mensaje de sistema: pantalla de inicio en X segundos (descartar siempre + señal)
    if (lower.includes('se volverá a mostrar la pantalla de inicio')) { try { chrome.runtime.sendMessage({ type: 'MEETING_ENDED' }); } catch {} return; }
    const uiNoiseText = (
      lower.includes("detalles de la reunión") ||
      lower.includes("meeting details") ||
      lower.includes("está en esta llamada") ||
      lower.includes("esta en esta llamada") ||
      lower.includes("enlace de la reunión copiado") ||
      lower.includes("no puedes activar el micrófono") ||
      lower.includes("hay un problema con la cámara") ||
      lower.includes("hay un problema con la camara") ||
      lower.includes("mostrar más información") ||
      lower.includes("mostrar mas informacion") ||
      lower.includes("subtítulos automáticos desactivados") ||
      lower.includes("subtitulos automaticos desactivados") ||
      lower.includes("subtítulos automáticos activados") ||
      lower.includes("subtitulos automaticos activados") ||
      lower.includes("subtítulos desactivados") ||
      lower.includes("subtitulos desactivados") ||
      lower.includes("subtítulos activados") ||
      lower.includes("subtitulos activados") ||
      lower.includes("no hay nadie más en esta reunión") ||
      lower.includes("has abandonado la reunión") ||
      lower.includes("valora la calidad del audio") ||
      /* 'tu reunión es segura' se maneja abajo */
      lower.includes("se volverá a mostrar la pantalla de inicio") ||
      colorNoise || isUiHint
    );
    // Descarta SIEMPRE mensajes de sistema específicos
    if (lower.trim() === 'detalles de la reunión') return;
    if (isCountdown) return;
    if (lower.includes('has abandonado la reunión')) { try { chrome.runtime.sendMessage({ type: 'MEETING_ENDED' }); } catch {} return; }
    if (lower.includes('has salido de la reunión')) { try { chrome.runtime.sendMessage({ type: 'MEETING_ENDED' }); } catch {} return; }
    if (lower.includes('valora la calidad del audio')) { try { chrome.runtime.sendMessage({ type: 'MEETING_ENDED' }); } catch {} return; }
    if (lower.includes('has salido de la reunión')) { try { chrome.runtime.sendMessage({ type: 'MEETING_ENDED' }); } catch {} return; }
    if (lower.includes('you left the meeting')) { try { chrome.runtime.sendMessage({ type: 'MEETING_ENDED' }); } catch {} return; }
    if (lower.includes('returning to the home screen')) { try { chrome.runtime.sendMessage({ type: 'MEETING_ENDED' }); } catch {} return; }
    // Descarta el bloque de ayuda si no parece discurso humano
    if (uiNoiseText && speechScore(String(text || '')) < 3) {
      return; // No emitir líneas de UI si no parecen discurso
    }
    // Si el speaker es "Tu reunión es segura" pero el texto es contenido, reasignar al selfName conocido
    if (/^tu\s+reunión\s+es\s+segura$/i.test(spRaw)) {
      try {
        if (!selfName) {
          // Intento adicional: lista de participantes con (Tú)
          try { guessSelfNameFromParticipants(); } catch {}
          const span = document.querySelector('span.notranslate');
          const t1 = span?.textContent?.trim();
          if (t1 && !/^(tu|tú|you)$/i.test(t1)) setSelfNameVerified(t1);
        }
        const nm = String(selfName || "").trim();
        if (nm) sp = nm;
      } catch {}
    }
    // Quitar nombre del orador al inicio del texto si viene pegado
    try {
      const tNorm = String(text || '').trim();
      const spNorm = String(sp || '').trim();
      if (spNorm && tNorm.toLowerCase().startsWith(spNorm.toLowerCase())) {
        text = tNorm.slice(spNorm.length).trim();
        // Eliminar puntuación inicial como ':' '-' '—' y espacios
        text = String(text).replace(/^[:\-—\s]+/, '').trim();
        if (!text) return;
        // Si lo que queda es sólo '(Tu presentación)' / '(Presentación)', ignorar
        const tLower = String(text || '').toLowerCase();
        if (/^\(\s*(tu|tú)?\s*presentaci[óo]n\s*\)$/i.test(text) || /^\(\s*(your)?\s*presentation\s*\)$/i.test(text)) {
          return;
        }
        // Token genérico de UI
        if (/^keep$/i.test(text)) return;
      }
      // Si el texto es exactamente el nombre del orador (eco), descartar
      try {
        const tEq = String(text || '').trim().toLowerCase();
        const spEq = String(sp || '').trim().toLowerCase();
        if (tEq && spEq && tEq === spEq) return;
      } catch {}
      // Limpieza de prefijo 'Tú' cuando el orador es local (Meet suele anteponerlo)
      try {
        const isLocal = !!selfName && String(sp || '').toLowerCase() === String(selfName || '').toLowerCase();
        if (isLocal) {
          const tFix = String(text || '').replace(/^(?:t[úu]|you)(?:\s*)/i, '').trim();
          if (tFix && tFix !== text) text = tFix;
        }
      } catch {}
    } catch {}
    const timeStr = fmtHMS(whenMs - t0);
    const last = events[events.length - 1];
    const norm = (s) => String(s || "").replace(/[\s]+/g, " ").replace(/[，、]/g, ",").trim();
    const bb = norm(text);
    if (last && (last.speaker || "") === sp) {
      const aa = norm(last.text);
      // Mismo contenido exacto => dedup
      if (aa === bb) {
        try {
          chrome.runtime.sendMessage({
            type: "CAPTION_EVENT",
            payload: { speaker: sp, text, ts: whenMs }
          });
        } catch {}
        console.log("[CC] dedup", timeStr, sp, "→", text);
        return;
      }
      // Nuevo texto extiende al anterior => coalesce localmente
      if (aa.length < bb.length && bb.startsWith(aa)) {
        last.text = text;
        last.timeStr = timeStr;
        try {
          chrome.runtime.sendMessage({
            type: "CAPTION_EVENT",
            payload: { speaker: sp, text, ts: whenMs }
          });
        } catch {}
        console.log("[CC] coalesced", timeStr, sp, "→", text);
        return;
      }
    }
    const item = { timeStr, speaker: sp, text };
    // Si el orador no es el local, marcar presencia reciente de otro orador
    try {
      const isSelf = (
        (!!selfName && String(sp || '').toLowerCase() === selfName.toLowerCase()) ||
        /^(tu|tú|you)$/i.test(String(spRaw || '')) ||
        /^tu\s+reunión\s+es\s+segura$/i.test(String(spRaw || ''))
      );
      if (!isSelf) lastOtherSpeakerAt = Date.now();
    } catch {}
    events.push(item);
    try {
      chrome.runtime.sendMessage({
        type: "CAPTION_EVENT",
        payload: { speaker: sp, text, ts: whenMs }
      });
    } catch {}
    console.log("[CC]", timeStr, sp, "→", text);
  }

  function flushTurn(speaker, when) {
    const seg = turnsBySpeaker.get(speaker);
    if (!seg || !seg.text) return;
    emitLine(speaker || "", seg.text, when || seg.lastUpdate || Date.now());
    try { clearTimeout(seg.timer); } catch {}
    turnsBySpeaker.delete(speaker);
  }

  function flushAllTurns() {
    try {
      for (const [sp, seg] of Array.from(turnsBySpeaker.entries())) {
        if (seg?.text) emitLine(sp || "", seg.text, seg.lastUpdate || Date.now());
        try { clearTimeout(seg?.timer); } catch {}
        turnsBySpeaker.delete(sp);
      }
      currentSpeaker = "";
    } catch (err) {
      console.warn("[Meet Transcriber] flushAllTurns error:", err);
    }
  }

  function processCaption(el, parsed) {
    // Usa memoria de orador si no viene en esta actualización
    let speaker = parsed.speaker;
    if (!speaker) {
      const mem = lastSpeakerByEl.get(el);
      if (mem && mem.speaker && nowMs() - mem.ts < 10000) speaker = mem.speaker;
    } else {
      lastSpeakerByEl.set(el, { speaker, ts: nowMs() });
      lastSpeakerGlobal = speaker;
    }

    const now = Date.now();
    const text = parsed.text;
    // Determinar orador final: si no hay explícito, intentar DOM y luego memoria global
    if (!speaker) {
      speaker = lastSpeakerGlobal || currentSpeaker || "";
    }

    // Si el orador es "Tú" y aún no tenemos nombre propio, intentar aprenderlo
    if (/^(tu|tú|you)$/i.test(String(speaker || "")) && !selfName) {
      // Aprender sólo desde fuentes confiables: participantes con (Tú) y mosaico local
      try { guessSelfNameFromParticipants(); } catch {}
      if (!selfName) {
        try {
          const roots = getLocalTileRoots();
          for (const r of roots) {
            const nm = extractLocalNameFromTile(r);
            if (nm && !/^(tu|tú|you)$/i.test(nm)) { setSelfNameVerified(nm); speaker = nm; break; }
          }
        } catch {}
      }
    }

    // Estabilización de orador para evitar alternancias falsas
    const prevSeg = currentSpeaker ? turnsBySpeaker.get(currentSpeaker) : null;
    const norm = (s) => String(s || "").replace(/[\s]+/g, " ").trim();
    const prevText = norm(prevSeg?.text || "");
    const nextText = norm(text);
    // Si el texto nuevo es continuación/variación del actual y el cambio de orador ocurre muy cerca en el tiempo,
    // asumimos que sigue siendo el mismo turno (evita alternancias A/B por badges cercanos)
    const closeInTime = prevSeg ? (now - (prevSeg.lastUpdate || prevSeg.startedAt || now)) < 1800 : false;
    const looksLikeSameTurn = prevText && (nextText.startsWith(prevText) || prevText.startsWith(nextText));
    if (currentSpeaker && speaker !== currentSpeaker && (closeInTime && looksLikeSameTurn)) {
      speaker = currentSpeaker; // mantener el turno con el mismo orador
    }

    // Cambio de orador real: emitir turno previo y empezar uno nuevo
    if (currentSpeaker && speaker !== currentSpeaker) {
      flushTurn(currentSpeaker, now);
    }
    currentSpeaker = speaker;

    // Actualizar/crear turno del orador actual
    const seg = turnsBySpeaker.get(speaker) || { text: "", startedAt: now, lastUpdate: now, timer: null };
    // Coalesce: conservar el texto más largo si uno es prefijo del otro
    const normTurn = (s) => String(s || "").replace(/[\s]+/g, " ").trim();
    const prev = normTurn(seg.text);
    const next = normTurn(text);
    if (!prev) {
      seg.text = text;
    } else if (prev === next) {
      seg.text = text;
    } else if (prev.length < next.length && next.startsWith(prev)) {
      seg.text = text; // extensión natural
    } else if (next.length < prev.length && prev.startsWith(next)) {
      // actualización parcial (recorte): conservar el más largo
      // no cambiamos seg.text
    } else {
      // Diferente sin prefijo: preferir el más largo
      seg.text = prev.length >= next.length ? seg.text : text;
    }
    seg.lastUpdate = now;
    // No cerramos por silencio: sólo cerramos cuando cambia el orador
    turnsBySpeaker.set(speaker, seg);
  }

  function handleMutations(muts) {
    for (const m of muts) {
      if (m.type === "characterData") {
        const el = m.target?.parentElement;
        if (!el) continue;
        const parsed = parseCaptionNode(el);
        if (!parsed) continue;
        try {
          processCaption(el, parsed);
        } catch (err) {
          console.warn("[Meet Transcriber] processCaption error (characterData):", err);
        }
        continue;
      }

      if (m.type === "childList") {
        m.addedNodes.forEach(n => {
          if (n instanceof Text) {
            const el = n.parentElement;
            if (!el) return;
            const parsed = parseCaptionNode(el);
            if (!parsed) return;
            try {
              processCaption(el, parsed);
            } catch (err) {
              console.warn("[Meet Transcriber] processCaption error (Text node):", err);
            }
            return;
          }
          if (n instanceof HTMLElement) {
            // Si el nodo nuevo trae ShadowRoot, observarlo también
            if (n.shadowRoot) attachDeepObserver(n.shadowRoot);
            // Intentar parsear directamente
            const parsed = parseCaptionNode(n);
            if (parsed && parsed.text) {
              try {
                processCaption(n, parsed);
              } catch (err) {
                console.warn("[Meet Transcriber] processCaption error (HTMLElement):", err);
              }
            }
          }
        });
      }
    }
  }

  function attachDeepObserver(root) {
    // Evita duplicar el mismo root
    if (activeObservers.has(root)) return;
    const obs = new MutationObserver(handleMutations);
    obs.observe(root, {
      childList: true,
      subtree: true,
      characterData: true
    });
    activeObservers.add(root);

    // Recorre hijos y engancha shadowRoots existentes
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    let node = root.host ? root.host : walker.currentNode;
    while (node) {
      if (node.shadowRoot) attachDeepObserver(node.shadowRoot);
      node = walker.nextNode();
    }
  }

  function startDeepObservers() {
    // Limpia anteriores
    stopDeepObservers();

    // 1) Identificar raíces con ARIA live donde suelen aparecer subtítulos
    const roots = new Set();
    const candidates = document.querySelectorAll('[aria-live], [role="alert"]');
    candidates.forEach(el => {
      roots.add(el);
      if (el.shadowRoot) roots.add(el.shadowRoot);
    });
    // Siempre observamos el documento entero además de los candidatos.
    // Esto asegura que no nos perdamos subtítulos cuando Meet cambia su estructura.
    roots.add(document);
    for (const r of roots) attachDeepObserver(r);

    // 2) Cualquier shadowRoot ya montado en la página (solo si es candidato)
    const all = document.querySelectorAll('[aria-live], [role="alert"]');
    all.forEach(el => { if (el.shadowRoot) attachDeepObserver(el.shadowRoot); });

    // 3) Reintentá cada 2s (por si el usuario activa CC más tarde)
    // Detectar cambios de URL (nueva reunión) para notificar MEETING_STARTED
    let lastMeetingCode = '';
    reattachTimer = setInterval(() => {
      const all2 = document.querySelectorAll('[aria-live], [role="alert"]');
      all2.forEach(el => { if (el.shadowRoot) attachDeepObserver(el.shadowRoot); });
      try { ensureCaptionsOn(); } catch {}
      try { hideCaptionsOverlay(); } catch {}
      try { checkMeetingEndedMarkers(); } catch {}
      try { watchLeaveButtons(); } catch {}
      try { if (!selfName) guessSelfNameFromParticipants(); } catch {}
      // Nueva reunión si cambia el código en la URL
      try {
        const m = String(location.pathname || '');
        const codeMatch = m.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\b|$)/i);
        const code = codeMatch ? codeMatch[1] : '';
        if (code && code !== lastMeetingCode) {
          lastMeetingCode = code;
          sendMessageSafe({ type: 'MEETING_STARTED' });
        }
      } catch {}
    }, 2000);

    console.log("[MVP] Deep observers activos:", activeObservers.size);
    // Observadores específicos para el mosaico/local: detectar nombre propio del usuario
    try { startLocalTileObservers(); } catch {}
    // Intento temprano de aprender el nombre propio sin esperar a cambios
    try {
      
    } catch {}
    
    try { ensureCaptionsOn(); } catch {}
    try { hideCaptionsOverlay(); } catch {}
  }

  function stopDeepObservers() {
    activeObservers.forEach(root => {
      // No podemos “disconnect” desde root; necesitamos los MutationObserver.
      // Así que guardamos los observers en el Set en vez del root.
    });
  }

  // Guardamos los MutationObserver en vez de roots:
  (function patchActiveObserversToStoreObservers() {
    const _add = activeObservers.add.bind(activeObservers);
    activeObservers.clear(); // empezar limpio
    attachDeepObserver = (function (orig) {
      return function (root) {
        // Re-definimos para que guarde el observer real
        for (const item of activeObservers) {
          if (item.root === root) return; // ya observado
        }
        const obs = new MutationObserver(handleMutations);
        obs.observe(root, { childList: true, subtree: true, characterData: true });
        activeObservers.add({ root, obs });

        // Recorrer hijos
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
        let node = root.host ? root.host : walker.currentNode;
        while (node) {
          if (node.shadowRoot) attachDeepObserver(node.shadowRoot);
          node = walker.nextNode();
        }
      };
    })(attachDeepObserver);

    stopDeepObservers = function () {
      for (const item of activeObservers) {
        try { item.obs.disconnect(); } catch {}
        try { if (item.scanTimer) clearInterval(item.scanTimer); } catch {}
      }
      activeObservers.clear();
      if (reattachTimer) { clearInterval(reattachTimer); reattachTimer = null; }
    };
  })();

  // Detectar clic en el botón de abandonar la llamada y notificar fin de reunión
  function watchLeaveButtons() {
    try {
      if (meetingEndSignaled) return;
      const sel = [
        'button[aria-label*="Abandonar"]',
        'button[aria-label*="Salir de la llamada"]',
        'button[aria-label*="Finalizar llamada"]',
        'button[aria-label*="Dejar la llamada"]',
        'button[aria-label*="Leave call"]',
        'button[aria-label*="End call"]',
        'button[aria-label*="Hang up"]'
      ];
      const btns = [];
      // Buscar en documento principal
      sel.forEach(s => { document.querySelectorAll(s).forEach(b => btns.push(b)); });
      // Buscar también dentro de shadow roots observados
      try {
        for (const item of activeObservers) {
          const root = item && item.root;
          if (!root || !root.querySelectorAll) continue;
          sel.forEach(s => { root.querySelectorAll(s).forEach(b => btns.push(b)); });
        }
      } catch {}
      btns.forEach(b => {
        if (b.__meetixLeaveHooked) return;
        b.__meetixLeaveHooked = true;
        b.addEventListener('click', () => {
          try {
            meetingEndSignaled = true;
            chrome.runtime.sendMessage({ type: 'MEETING_ENDED' });
          } catch {}
        });
      });
    } catch {}
  }

  // Fallback control: intentar activar CC por tecla 'c' sólo una vez
  let ccKeyTried = false;
  let ccLastEnableAt = 0; // permitir reintentos controlados si el usuario desactiva CC
  function isVisible(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect?.();
    const sizeOk = rect && rect.width > 0 && rect.height > 0;
    return sizeOk && cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function tryActivateByKeyC() {
    if (ccKeyTried) return false;
    ccKeyTried = true;
    try {
      const evDown = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true });
      const evUp = new KeyboardEvent('keyup', { key: 'c', code: 'KeyC', bubbles: true });
      (document.body || document).dispatchEvent(evDown);
      (document.body || document).dispatchEvent(evUp);
      window.dispatchEvent(evDown);
      window.dispatchEvent(evUp);
      console.log("[CC] Intento activar subtítulos por tecla 'c'");
      return true;
    } catch {
      return false;
    }
  }

  // Activación automática de Subtítulos (CC)
  function ensureCaptionsOn() {
    try {
      const btns = Array.from(document.querySelectorAll('button[aria-label], div[role="button"][aria-label]'));
      let btnOn = null; let btnOff = null;
      for (const b of btns) {
        const label = String(b.getAttribute('aria-label') || '').toLowerCase();
        if (!label) continue;
        const isOff = /desactivar\s+subt[íi]tulos(?:\s+autom[áa]ticos)?/.test(label) || /turn\s+off\s+captions|disable\s+captions/.test(label);
        const isOn  = /activar\s+subt[íi]tulos(?:\s+autom[áa]ticos)?/.test(label) || /turn\s+on\s+captions|enable\s+captions|show\s+captions|start\s+captions/.test(label) || (/subt[íi]tulos/.test(label) && /activar|encender|mostrar/.test(label));
        if (isOff && isVisible(b) && !btnOff) btnOff = b;
        if (isOn  && isVisible(b) && !btnOn)  btnOn  = b;
      }
      // Si hay botón visible de Desactivar (o detección positiva de overlay/regiones), no tocar
      if (btnOff || isCaptionsOn()) return;
      // Intentar activar por botón con rate‑limit (reintenta si el usuario apagó CC)
      const now = Date.now();
      if (btnOn && (now - ccLastEnableAt) > 4000) {
        btnOn.click();
        ccLastEnableAt = now;
        console.log('[CC] Subtítulos activados automáticamente');
        return;
      }
      // Fallback controlado: usar tecla 'c' sólo una vez si no encontramos botones
      tryActivateByKeyC();
    } catch {}
  }

  // Ocultar visualmente el overlay de subtítulos pero mantenerlo activo
  function hideCaptionsOverlay() {
    try {
      // Inyectar estilo fuerte para ocultar sin romper layout de captura
      const styleId = 'meet-cc-hide-style';
      let st = document.getElementById(styleId);
      if (!st) {
        st = document.createElement('style');
        st.id = styleId;
        // Ocultación segura: colapsa banda sin posicionamientos agresivos
        st.textContent = `
          .cc-hidden{visibility:hidden !important; opacity:0 !important; pointer-events:none !important}
          .cc-overlay-collapsed{height:0 !important; min-height:0 !important; max-height:0 !important; padding:0 !important; margin:0 !important; overflow:hidden !important; visibility:hidden !important; opacity:0 !important; pointer-events:none !important; background:transparent !important; border:0 !important}
          /* Colapso explícito para ancestros reportados */
          div[jscontroller="hVzhab"].G03iKb.hlKvuf,
          div[jscontroller="D1hTje"],
          div.a4cQT.P9KVBf { height:0 !important; min-height:0 !important; max-height:0 !important; padding:0 !important; margin:0 !important; overflow:hidden !important; visibility:hidden !important; opacity:0 !important; pointer-events:none !important; background:transparent !important; border:0 !important }
        `;
        document.head.appendChild(st);
      }

      // Solo colapsar overlay si los subtítulos YA están activos (evita romper activación automática)
      let captionsOn = false;
      try {
        const btns = Array.from(document.querySelectorAll('button[aria-label], div[role="button"][aria-label]'));
        for (const b of btns) {
          const label = String(b.getAttribute('aria-label') || '').toLowerCase();
          if (/desactivar\s+subt[íi]tulos(?:\s+autom[áa]ticos)?/.test(label) || /turn\s+off\s+captions|disable\s+captions/.test(label)) { captionsOn = true; break; }
        }
      } catch {}
      if (!captionsOn) return;

      const targets = new Set();
      // Overlay directo por clase conocida
      document.querySelectorAll('div.vNKgIf.UDinHf').forEach(el => targets.add(el));
      // Regiones aria dentro del contenedor de subtítulos
      document.querySelectorAll('div[jsname="dsyhDe"].iOzk7').forEach(parent => {
        parent.querySelectorAll('[role="region"][aria-label], [aria-live][aria-label]').forEach(el => {
          const al = String(el.getAttribute('aria-label') || '').toLowerCase();
          if (al.includes('subtítul') || al.includes('subtit') || al.includes('captions') || al.includes('subtitle')) {
            targets.add(el);
          }
        });
      });
      // Detectar banda contenedora que reserva altura
      const overlays = Array.from(targets);
      const bands = new Set();
      for (const ov of overlays) {
        let p = ov.parentElement; let hops = 0;
        while (p && hops < 8) {
          try {
            const cs = getComputedStyle(p);
            const cls = String(p.className || '');
            const condPos = /fixed|absolute/i.test(cs.position);
            const condClass = /P9KVBf/.test(cls);
            const h = (p.clientHeight || 0);
            const w = (p.clientWidth || 0);
            const condSize = h > 10 && h <= 200 && w > 300;
            const condCtrl = /D1hTje/.test(String(p.getAttribute('jscontroller') || ''));
            if ((condPos || condClass || condCtrl) && condSize) { bands.add(p); break; }
          } catch {}
          p = p.parentElement; hops++;
        }
      }
      bands.forEach(el => targets.add(el));
      // Candidatos a la "banda" que reserva altura: solo si contienen overlay/aria-live
      const bandCandidates = Array.from(document.querySelectorAll('div[jscontroller="D1hTje"] div[class*="P9KVBf"]'))
        .filter(el => el.querySelector('div[jsname="dsyhDe"], div.vNKgIf.UDinHf, [role="region"][aria-label], [aria-live][aria-label]'));
      // También contenedores mdnBv que envuelven la banda (altura moderada)
      const bandMdnBv = Array.from(document.querySelectorAll('div[jscontroller="mdnBv"]'))
        .filter(el => el.querySelector('div[jsname="dsyhDe"], div.vNKgIf.UDinHf, [role="region"][aria-label], [aria-live][aria-label]') && (el.clientHeight || 0) > 10 && (el.clientHeight || 0) <= 240);
      bandMdnBv.forEach(el => bandCandidates.push(el));
      // Contenedor superior de la banda (observado en tu layout): hVzhab
      const bandHV = Array.from(document.querySelectorAll('div[jscontroller="hVzhab"]'))
        .filter(el => el.querySelector('div[jsname="dsyhDe"], div.vNKgIf.UDinHf, [role="region"][aria-label], [aria-live][aria-label]') && (el.clientHeight || 0) > 10 && (el.clientHeight || 0) <= 300);
      bandHV.forEach(el => bandCandidates.push(el));
      bandCandidates.forEach(el => targets.add(el));
      // Además aplicar colapso directamente a los 3 ancestros reportados
      ['div[jscontroller="hVzhab"].G03iKb.hlKvuf','div[jscontroller="D1hTje"]','div.a4cQT.P9KVBf']
        .forEach(sel => document.querySelectorAll(sel).forEach(el => targets.add(el)));
      // No ocultar barras de herramientas/controles
      const skipRoles = new Set(['toolbar','menu','dialog','button']);
      const markHidden = (el) => {
        try {
          // overlay/regiones: ocultas
          if (el.matches('div.vNKgIf.UDinHf, [role="region"],[aria-live]')) {
            el.classList?.add('cc-hidden');
          }
          // banda contenedora: colapsada (sin empujar contenido)
          el.classList?.add('cc-overlay-collapsed');
          el.dataset.ccHidden = '1';
          // No tocar ancestros ni aplicar estilos invasivos
        } catch {}
      };
      for (const el of Array.from(targets)) {
        const role = String(el.getAttribute('role') || '').toLowerCase();
        if (skipRoles.has(role)) continue;
        let p = el.parentElement; let hasToolbarAncestor = false; let k = 0;
        while (p && k < 6) { const r = String(p.getAttribute?.('role') || '').toLowerCase(); if (skipRoles.has(r)) { hasToolbarAncestor = true; break; } p = p.parentElement; k++; }
        if (hasToolbarAncestor) continue;
        markHidden(el);
      }
      if (targets.size) console.log('[CC] Overlay de subtítulos ocultado (manteniendo activo). elementos=', targets.size);
    } catch {}
  }

  // --- Heurísticas sólo para el local (mosaico propio) ---
  function getLocalTileRoots() {
    // Padre: class "aGWPv picrje"
    return Array.from(document.querySelectorAll('div.aGWPv.picrje'));
  }
  function extractLocalNameFromTile(rootTile) {
    try {
      const span = rootTile.querySelector('span.notranslate');
      const t1 = span?.textContent?.trim();
      if (t1) return t1;
      const tt = rootTile.querySelector('[id^="ucc-"]');
      const t2 = tt?.textContent?.trim();
      if (t2) return t2;
      const img = rootTile.querySelector('img[alt]');
      const alt = img?.getAttribute?.('alt');
      if (alt && alt.trim()) return alt.trim();
    } catch {}
    return null;
  }
  function startLocalTileObservers() {
    const seen = new WeakSet();
    const attach = (rootTile) => {
      if (!rootTile || seen.has(rootTile)) return;
      seen.add(rootTile);
      const indicator = rootTile.querySelector('div.qg7mD.r6DyN.xm86Be.JBY0Kc.eXUaib.KXY1yb');
      if (!indicator) return;
      const check = () => {
        const active = !!indicator.classList?.contains('BlxGDf');
        if (active) {
          const nm = extractLocalNameFromTile(rootTile);
          if (nm && !/^(tu|tú|you)$/i.test(nm)) {
            setSelfNameVerified(nm);
          }
        }
      };
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === 'attributes' && m.attributeName === 'class') check();
        }
      });
      obs.observe(indicator, { attributes: true, attributeFilter: ['class'] });
      // Comprobación inicial por si ya está activo
      check();
      activeObservers.add({ obs });
    };

    const scan = () => {
      const roots = getLocalTileRoots();
      for (const r of roots) attach(r);
    };
    scan();
    const scanTimer = setInterval(scan, 2000);
    // Guardar el timer para poder limpiarlo en stopDeepObservers
    activeObservers.add({ obs: { disconnect() {} }, scanTimer });
    console.log('[LOCAL] Observadores del mosaico propio activos');
  }

  function buildMarkdown() {
    const header =
      `# Transcripción — Google Meet (ES)\n\n` +
      `> Inicio: ${new Date(t0).toLocaleString("es-AR")}\n` +
      `> Líneas: ${events.length}\n\n`;
    const body = events.map(e => {
      let spk = (e.speaker || '').trim();
      if (/^(tu|tú|you)$/i.test(spk)) {
        const nm = String(selfName || '').trim();
        spk = nm || 'Tú';
      } else {
        spk = spk || 'Tú';
      }
      const sp = `**${spk}**`;
      return `- ${sp}: ${e.text}`;
    }).join("\n");
    return header + body + "\n";
  }

  async function exportMD() {
    // Asegura que se emitan los turnos abiertos antes de exportar
    flushAllTurns();
    if (!events.length) {
      alert("Sin datos para exportar");
      return;
    }
    const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g, "-");
    const filename = `meet-transcript-${stamp}.md`;
    const content = buildMarkdown();
    const res = await chrome.runtime.sendMessage({ type: "DOWNLOAD_MD", filename, content });
    console.log("[MVP] Export MD →", res);
  }

  function start() {
    if (running) return;
    running = true;
    t0 = Date.now();
    events.length = 0;
    // Cargar nombre propio si existe
    try {
      chrome.storage?.local?.get?.("selfName", (data) => {
        const nm = (data && data.selfName) ? String(data.selfName).trim() : "";
        if (nm) selfName = nm;
      });
    } catch {}
    startDeepObservers();
    console.log("[MVP] Captura iniciada (deep).");
  }

  function stop() {
    if (!running) return;
    // Antes de detener, emitir turnos abiertos
    try { flushAllTurns(); } catch {}
    stopDeepObservers();
    running = false;
    console.log("[MVP] Captura detenida. Líneas:", events.length);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "MVP_START") start();
    if (msg?.type === "MVP_STOP") stop();
    if (msg?.type === "MVP_EXPORT") exportMD();
    // Solicitud directa desde popup/background para leer localStorage de la página
    if (msg?.type === 'GET_LOCALSTORAGE') {
      try {
        const data = readLocalStorageSafe();
        sendResponse?.({ ok: true, data });
      } catch (err) {
        sendResponse?.({ ok: false, error: String(err) });
      }
      return true;
    }
    if (msg?.type === "SELF_NAME_UPDATED") {
      try {
        chrome.storage?.local?.get?.("selfName", (data) => {
          const nm = (data && data.selfName) ? String(data.selfName).trim() : "";
          selfName = nm || "";
          sendResponse?.({ ok: true });
        });
      } catch {
        sendResponse?.({ ok: false });
      }
      return true;
    }
    if (msg?.type === "MVP_GET_EVENTS") {
      try {
        flushAllTurns();
        const list = events.map(e => ({ speaker: e.speaker || "", text: e.text }));
        sendResponse?.({ ok: true, events: list });
      } catch (err) {
        sendResponse?.({ ok: false, error: String(err) });
      }
      return true; // async compatibility
    }
  });

  console.log("[MVP] content.js inyectado");
  // Auto-start: activa los observers apenas se inyecta el content script
  // Esto asegura que CAPTION_EVENT comience a publicarse sin depender del popup.
  try {
    const isMeet = String(location.hostname || '') === 'meet.google.com';
    if (isMeet) {
      start();
      // Señalar inicio de reunión si hay código en la URL
      try {
        const m = String(location.pathname || '');
        if (/\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\b|$)/i.test(m)) {
          chrome.runtime.sendMessage({ type: 'MEETING_STARTED' });
        }
      } catch {}
    }
  } catch {}
})();
  // Verifica si los subtítulos están activos por presencia de overlay/regiones
  function isCaptionsOn() {
    try {
      const ov = document.querySelector('div.vNKgIf.UDinHf');
      if (ov) return true;
      const regions = document.querySelectorAll('[role="region"][aria-label], [aria-live][aria-label]');
      for (const el of regions) {
        const al = String(el.getAttribute('aria-label') || '').toLowerCase();
        if (al.includes('subtítul') || al.includes('subtit') || al.includes('captions') || al.includes('subtitle')) return true;
      }
    } catch {}
    return false;
  }
