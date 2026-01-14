(function () {
  const host = String(location.hostname || '');
  // --- TaskFlow session bridge ---
  try {
    const isTaskFlow = /task-flow-opx-(trial|beta)\.vercel\.app$/i.test(host);
    if (isTaskFlow) {
      /**
       * Lee localStorage de forma segura y devuelve un objeto plano
       * con todas las claves y valores disponibles sin lanzar errores.
       */
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
      /**
       * Construye un snapshot del estado de localStorage, intentando
       * parsear posibles datos de usuario comunes y adjuntando el origin.
       */
      function buildSnapshot() {
        const payload = readLocalStorageSafe();
        // Intento de estructurar usuario si existe JSON en alguna clave común
        try {
          const rawUser = payload.user || payload.currentUser || payload.profile || '';
          if (rawUser) {
            try {
              const obj = JSON.parse(rawUser);
              if (obj && typeof obj === 'object') payload.user = obj;
            } catch {}
          }
        } catch {}
        return { origin: location.origin, payload };
      }
      /**
       * Envía el snapshot de localStorage al background mediante runtime messaging
       * para facilitar el bridge con TaskFlow.
       */
      const sendSnapshot = () => {
        try {
          const snap = buildSnapshot();
          chrome.runtime?.sendMessage?.({ type: 'LOCALSTORAGE_DATA', origin: snap.origin, payload: snap.payload }, () => { const _ = chrome.runtime?.lastError; });
        } catch {}
      };
      try { sendSnapshot(); } catch {}
      try {
        let lastSentAt = 0;
        const int = setInterval(() => {
          try {
            if ((Date.now() - lastSentAt) > 1500) {
              sendSnapshot();
              lastSentAt = Date.now();
            }
          } catch {}
        }, 2000);
        window.addEventListener('unload', () => clearInterval(int));
      } catch {}
      try {
        /**
         * Listener RPC: responde a 'GET_LOCALSTORAGE' devolviendo el snapshot
         * actual de localStorage para el documento TaskFlow.
         */
        chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
          if (msg && (msg.type === 'GET_LOCALSTORAGE' || msg.message === 'GET_LOCALSTORAGE')) {
            try {
              const snap = buildSnapshot();
              sendResponse?.({ ok: true, origin: snap.origin, data: snap.payload });
            } catch (err) {
              sendResponse?.({ ok: false, error: String(err) });
            }
            return true;
          }
        });
      } catch {}

      // --- UI Enhancements for AI-generated questions (non-intrusive) ---
      function ensureAiBadgeStyle() {
        const styleId = 'tf-ai-badge-style';
        if (document.getElementById(styleId)) return;
        const st = document.createElement('style');
        st.id = styleId;
        st.textContent = `
          .tf-ai-badge-icon{display:inline-flex;align-items:center;margin-right:6px}
          .tf-ai-badge-icon svg{width:14px;height:14px;vertical-align:middle}
          .tf-ai-readonly{pointer-events:auto}
          .tf-ai-readonly[readonly]{background-color:#f8f9fa}
          .tf-ai-readonly[contenteditable="false"]{outline:none}
        `;
        document.head.appendChild(st);
      }

      function addIconToAiBadge(el) {
        if (!el || el.__tfAiIconAdded) return;
        const txt = String(el.textContent || '').trim();
        if (!/creada\s+con\s+ia/i.test(txt)) return;
        ensureAiBadgeStyle();
        const icon = document.createElement('span');
        icon.className = 'tf-ai-badge-icon';
        icon.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.09 6.26L20 9.27l-5 3.64 1.91 6.09L12 16.9l-4.91 2.1L9 12.91l-5-3.64 5.91-1.01L12 2z"/></svg>';
        try { el.prepend(icon); el.__tfAiIconAdded = true; } catch {}
      }

      function isAiCard(el) {
        if (!el) return false;
        try {
          const badge = el.querySelector?.('*');
          const txt = String(badge?.textContent || el.textContent || '').toLowerCase();
          return /creada\s+con\s+ia/.test(txt);
        } catch { return false; }
      }

      function disableAiContent(root) {
        if (!root) return;
        try {
          // lock text areas and contenteditable, keep selects enabled
          root.querySelectorAll('textarea').forEach(t => { try { t.readOnly = true; t.classList.add('tf-ai-readonly'); t.setAttribute('aria-readonly','true'); } catch{} });
          root.querySelectorAll('input[type="text"], input[type="search"], input:not([type])').forEach(i => { try { i.readOnly = true; i.classList.add('tf-ai-readonly'); i.setAttribute('aria-readonly','true'); } catch{} });
          root.querySelectorAll('[contenteditable="true"]').forEach(c => { try { c.setAttribute('contenteditable','false'); c.classList.add('tf-ai-readonly'); } catch{} });
        } catch {}
      }

      function normalizeTimeSelects(root) {
        if (!root) return;
        try {
          const blocks = root.querySelectorAll('*');
          blocks.forEach(el => {
            const text = String(el.textContent || '').trim().toLowerCase();
            // Lectura select: convert option labels to "N segundos"
            if (text.startsWith('lectura')) {
              const sel = el.nextElementSibling?.querySelector?.('select') || el.parentElement?.querySelector?.('select');
              if (sel) {
                Array.from(sel.options || []).forEach(opt => {
                  const v = Number(opt.value || opt.text);
                  if (!isNaN(v) && v > 0) opt.text = `${v} segundos`;
                });
              }
            }
            // Respuesta select: convert option labels to "N minutos"
            if (text.startsWith('respuesta')) {
              const sel2 = el.nextElementSibling?.querySelector?.('select') || el.parentElement?.querySelector?.('select');
              if (sel2) {
                Array.from(sel2.options || []).forEach(opt => {
                  const v = Number(opt.value || opt.text);
                  if (!isNaN(v) && v > 0) opt.text = `${v} minutos`;
                });
              }
            }
          });
        } catch {}
      }

      function enhanceTaskFlowUIOnce() {
        try {
          // Add icons to badges
          document.querySelectorAll('span,div').forEach(el => { try { const t = String(el.textContent || '').trim(); if (/^creada\s+con\s+ia$/i.test(t)) addIconToAiBadge(el); } catch {} });
          // For each card with the AI badge, lock its content but keep selects active
          const cards = Array.from(document.querySelectorAll('div,section,article')).filter(isAiCard);
          cards.forEach(card => { disableAiContent(card); normalizeTimeSelects(card); });
        } catch {}
      }
      try { enhanceTaskFlowUIOnce(); } catch {}
      try {
        const obs = new MutationObserver(() => { try { enhanceTaskFlowUIOnce(); } catch {} });
        obs.observe(document.documentElement, { childList: true, subtree: true });
      } catch {}
    }
  } catch {}

  // --- Meet capture logic ---
  let capturing = false;
  let meetingEnded = false;
  const activeObservers = new Set();
  let reattachTimer = null;

  /**
   * Envía un mensaje al background con manejo silencioso de lastError
   * para evitar excepciones en contextos donde el receiver no esté.
   */
  function sendMessageSafe(msg) {
    try { chrome.runtime.sendMessage(msg, () => { const _ = chrome.runtime.lastError; }); } catch (_) {}
  }

  /**
   * Detecta si los subtítulos de Google Meet están activos inspeccionando
   * el overlay de CC y regiones aria-live relacionadas.
   */
  function isCaptionsOn() {
    try {
      const ov = document.querySelector('div.vNKgIf.UDinHf');
      if (ov) return true;
      const regions = document.querySelectorAll('[role="region"][aria-label], [aria-live][aria-label]');
      for (const el of regions) {
        const al = String(el.getAttribute('aria-label') || '').toLowerCase();
        if (al.includes('subtítul') || al.includes('subtit') || al.includes('captions') || al.includes('subtitle')) return true;
      }
    } catch (_) {}
    return false;
  }

  /**
   * Intenta activar los subtítulos enviando el atajo de teclado 'C'.
   * Útil cuando el botón no es detectable.
   */
  function tryActivateByKeyC() {
    try {
      const evDown = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true });
      const evUp = new KeyboardEvent('keyup', { key: 'c', code: 'KeyC', bubbles: true });
      (document.body || document).dispatchEvent(evDown);
      (document.body || document).dispatchEvent(evUp);
      window.dispatchEvent(evDown);
      window.dispatchEvent(evUp);
      return true;
    } catch (_) { return false; }
  }

  let ccLastEnableAt = 0;
  /**
   * Enciende los subtítulos si están apagados:
   * busca el botón de “Activar subtítulos” y hace clic,
   * esperando unos segundos para no insistir demasiado.
   * Si no encuentra el botón, prueba con la tecla C.
   */
  function ensureCaptionsOn() {
    try {
      const btns = Array.from(document.querySelectorAll('button[aria-label], div[role="button"][aria-label], span[role="button"][aria-label], div[role="button"][data-tooltip]'));
      let btnOn = null, btnOff = null;
      for (const b of btns) {
        const label = String(b.getAttribute('aria-label') || b.getAttribute('data-tooltip') || '').toLowerCase();
        if (!label) continue;
        const isOff = /desactivar\s+subt[íi]tulos(?:\s+autom[áa]ticos)?/.test(label) || /turn\s+off\s+(live\s+)?captions|disable\s+(live\s+)?captions|stop\s+(live\s+)?captions/.test(label);
        const isOn  = /activar\s+subt[íi]tulos(?:\s+autom[áa]ticos)?/.test(label)
          || /turn\s+on\s+(live\s+)?captions|enable\s+(live\s+)?captions|show\s+(live\s+)?captions|start\s+(live\s+)?captions|closed\s+captions/.test(label)
          || (/subt[íi]tulos/.test(label) && /activar|encender|mostrar|iniciar/.test(label));
        if (isOff && !btnOff) btnOff = b;
        if (isOn  && !btnOn)  btnOn  = b;
      }
      if (btnOff || isCaptionsOn()) return;
      const now = Date.now();
      if (btnOn && (now - ccLastEnableAt) > 4000) {
        btnOn.click();
        ccLastEnableAt = now;
        return;
      }
      try { window.focus(); } catch {}
      tryActivateByKeyC();
    } catch (_) {}
  }

  /**
   * Oculta visualmente el overlay/banda negra de subtítulos sin desactivar
   * la funcionalidad, aplicando clases y estilos en regiones CC.
   */
  function hideCaptionsOverlay() {
    try {
      const styleId = 'meet-cc-hide-style';
      let st = document.getElementById(styleId);
      if (!st) {
        st = document.createElement('style');
        st.id = styleId;
        st.textContent = `
          .cc-hidden{opacity:0 !important; color:transparent !important; pointer-events:none !important; background:transparent !important}
          .cc-overlay-collapsed{opacity:0 !important; color:transparent !important; pointer-events:none !important; background:transparent !important}
          div[jscontroller="hVzhab"].G03iKb.hlKvuf,
          div[jscontroller="D1hTje"],
          div.a4cQT.P9KVBf { opacity:0 !important; color:transparent !important; pointer-events:none !important; background:transparent !important }
        `;
        document.head.appendChild(st);
      }
      // Sólo ocultar si los subtítulos están activos
      if (!isCaptionsOn()) return;
      const targets = new Set();
      document.querySelectorAll('div.vNKgIf.UDinHf').forEach(el => targets.add(el));
      document.querySelectorAll('div[jsname="dsyhDe"].iOzk7').forEach(parent => {
        parent.querySelectorAll('[role="region"][aria-label], [aria-live][aria-label]').forEach(el => {
          const al = String(el.getAttribute('aria-label') || '').toLowerCase();
          if (al.includes('subtítul') || al.includes('subtit') || al.includes('captions') || al.includes('subtitle')) {
            targets.add(el);
          }
        });
      });
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
          } catch (_) {}
          p = p.parentElement; hops++;
        }
      }
      bands.forEach(el => targets.add(el));
      ['div[jscontroller="hVzhab"].G03iKb.hlKvuf','div[jscontroller="D1hTje"]','div.a4cQT.P9KVBf']
        .forEach(sel => document.querySelectorAll(sel).forEach(el => targets.add(el)));
      const skipRoles = new Set(['toolbar','menu','dialog','button']);
      for (const el of Array.from(targets)) {
        const role = String(el.getAttribute('role') || '').toLowerCase();
        if (skipRoles.has(role)) continue;
        if (el.matches('div.vNKgIf.UDinHf, [role="region"],[aria-live]')) {
          el.classList?.add('cc-hidden');
        }
        el.classList?.add('cc-overlay-collapsed');
        el.dataset.ccHidden = '1';
      }
    } catch (_) {}
  }

  function showCaptionsOverlay() {
    try {
      const selectors = [
        'div.vNKgIf.UDinHf',
        '[role="region"][aria-label]',
        '[aria-live][aria-label]',
        'div[jscontroller="hVzhab"].G03iKb.hlKvuf',
        'div[jscontroller="D1hTje"]',
        'div.a4cQT.P9KVBf'
      ];
      const all = [];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => all.push(el));
      });
      for (const el of all) {
        el.classList?.remove('cc-hidden');
        el.classList?.remove('cc-overlay-collapsed');
        if (el.dataset) delete el.dataset.ccHidden;
      }
    } catch (_) {}
  }

  /**
   * Determina si un elemento o sus ancestros cercanos usan aria-live/alert,
   * indicador típico de regiones con contenido dinámico como subtítulos.
   */
  function isAriaLive(el) {
    let e = el;
    for (let i = 0; i < 5 && e; i++) {
      const ariaLive = e.getAttribute?.('aria-live');
      const role = e.getAttribute?.('role');
      if (ariaLive || role === 'alert') return true;
      e = e.parentElement;
    }
    return false;
  }
  const captionCandidates = new Map();
  /**
   * Actualiza heurísticas por elemento candidato a subtítulo: cambios recientes
   * y último texto observado para mejorar la detección de fuente.
   */
  function updateCandidate(el, text) {
    const stats = captionCandidates.get(el) || { changes: [], lastText: '' };
    const ts = Date.now();
    stats.changes.push(ts);
    stats.changes = stats.changes.filter(t => ts - t <= 10000);
    stats.lastText = text;
    captionCandidates.set(el, stats);
  }
  /**
   * Calcula una puntuación simple de "parece habla" según longitud,
   * ratio de letras, mayúsculas/minúsculas y puntuación.
   */
  function speechScore(s) {
    const len = s.length;
    const letters = (s.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length;
    const nonLetters = len - letters;
    const letterRatio = letters / Math.max(1, len);
    const words = s.trim().split(/\s+/);
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
    if (nonLetters / Math.max(1, len) > 0.4) score -= 2;
    return score;
  }
  /**
   * Decide si un nodo es fuente válida de subtítulos combinando contexto
   * (overlay/regiones CC), cambios recientes y posición en pantalla.
   */
  function isCaptionSource(el, text) {
    const stats = captionCandidates.get(el);
    const recentChanges = stats ? stats.changes.length : 0;
    let score = speechScore(text);
    // Context boost: overlay/aria-live region
    const inOverlay = !!el.closest('div.vNKgIf.UDinHf');
    let inCaptionRegion = false;
    const region = el.closest('[role="region"][aria-label], [aria-live][aria-label]');
    if (region) {
      const al = String(region.getAttribute('aria-label') || '').toLowerCase();
      inCaptionRegion = al.includes('subtítul') || al.includes('subtit') || al.includes('captions') || al.includes('subtitle');
    }
    if (inOverlay || inCaptionRegion) return true;
    if (isAriaLive(el)) score += 2;
    if (recentChanges >= 1) score += Math.min(2, recentChanges);
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
    } catch (_) {}
    return score >= 2;
  }

  /**
   * Filtra elementos de control UI (botones, inputs, etc.) para no
   * tratarlos como contenido de subtítulos.
   */
  function isInUIControl(el) {
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

  /**
   * Clasifica una cadena como 'speech', 'system', 'device' o 'action'
   * para descartar ruido y eventos de interfaz.
   */
  function classifyText(s) {
    const S = s.toLowerCase();
    const reAny = (arr) => arr.some(r => r.test(s));
    const hasIconToken = /\b[a-z]+(?:_[a-z]+)+\b/.test(s);
    const iconWordRE = /^(people|chat|devices|language|circle|settings|mood|info|apps|arrow_downward|keyboard_arrow_up|format_size|closed_caption|closed_caption_off|visual_effects|frame_person|back_hand|front_hand|call_end|videocam|videocam_off|computer_arrow_up|lock_person)(\b|$)/i;

    const devicePatterns = [
      /(cámara|camara|micrófono|microfono|mic)\s+está\s+(activad[oa]|desactivad[oa])/i,
      /(activar|desactivar)\s+(cámara|camara|micrófono|microfono|mic)/i,
      /\b(mute|mutear|silenciar|desmutear|reactivar)\b/i
    ];

    const actionPatterns = [
      /\b(levantado|bajado)\s+la\s+mano\b/i,
      /\b(levantando)\s+la\s+mano\b/i,
      /\b(invitar|invita|añadir|agregar)\b/i,
      /\b(unirse|unido|salir|abandonar|finalizar|unirme\s+ahora|unirse\s+ahora|admitir\s+a\s+todos|admitir)\b/i,
      /\b(compartir\s+pantalla|reacción|reacciones|opciones|ajustes|configuración|herramientas)\b/i
    ];

    const systemPatterns = [
      /\btu\s+reunión\s+es\s+segura\b/i,
      /\bir\s+a\s+los\s+subt[íi]tulos\s+m[aá]s\s+recientes\b/i,
      /\bir\s+al\s+final\b/i,
      /\bte\s+has\s+unido\b/i,
      /\bhas\s+salido\b/i,
      /\bdetalles\s+de\s+la\s+reunión\b/i,
      /\bsubt[íi]tulos?\s+(activados|desactivados)\b/i,
      hasIconToken || iconWordRE
    ];

    if (reAny(devicePatterns)) return { category: 'device' };
    if (hasIconToken || iconWordRE.test(s) || reAny(systemPatterns)) return { category: 'system' };
    if (reAny(actionPatterns)) return { category: 'action' };
    return { category: 'speech' };
  }

  /**
   * Determina si una etiqueta/nombre es inválido para usar como orador,
   * evitando valores genéricos, numéricos o meramente técnicos.
   */
  function isBadLabel(label) {
    const s = String(label || '').trim();
    if (!s) return true;
    if (/^(subtitulos|subtítulos|captions|closed captions|subtitles|cc)$/i.test(s)) return true;
    if (/[0-9]/.test(s)) return true;
    return false;
  }
  /**
   * Intenta inferir el nombre del orador inspeccionando vecinos y ancestros,
   * usando selectores de Meet y heurística de proximidad espacial.
   */
  function getSpeakerFromDOM(node) {
    const pick = (el) => {
      try {
        const s = el?.querySelector?.('span.NWpYId, div.NWpYId, span.NWpY1d, div.NWpY1d, [class*="NWpY1d"], [class*="NWpYId"], span.notranslate');
        const t = s?.textContent?.trim();
        if (t && !isBadLabel(t)) return t;
        const tt = el?.querySelector?.('[id^="ucc-"]');
        const ttText = tt?.textContent?.trim();
        if (ttText && !isBadLabel(ttText)) return ttText;
        const img = el?.querySelector?.('img[alt]');
        const alt = img?.getAttribute?.('alt');
        if (alt && alt.trim() && !isBadLabel(alt)) return alt.trim();
        const al = el?.getAttribute?.('aria-label');
        if (al && al.trim() && !isBadLabel(al)) {
          const m = al.trim().match(/^[A-ZÁÉÍÓÚÜÑ][^,;:\-]+/);
          if (m) return m[0].trim();
        }
      } catch (_) {}
      return null;
    };
    let e = node;
    for (let i = 0; i < 6 && e; i++) {
      const found = pick(e);
      if (found) return found;
      let sib = e.previousElementSibling;
      for (let j = 0; j < 3 && sib; j++) {
        const f = pick(sib);
        if (f) return f; sib = sib.previousElementSibling;
      }
      let nsib = e.nextElementSibling;
      for (let j = 0; j < 3 && nsib; j++) {
        const f2 = pick(nsib);
        if (f2) return f2; nsib = nsib.nextElementSibling;
      }
      e = e.parentElement;
    }
    try {
      const rect = node.getBoundingClientRect?.();
      if (rect) {
        const spans = Array.from(document.querySelectorAll('span.NWpYId, div.NWpYId, span.NWpY1d, div.NWpY1d, [class*="NWpY1d"], [class*="NWpYId"], img[alt]'));
        let best = null, bestDist = Infinity;
        const cx = rect.left + rect.width/2; const cy = rect.top;
        for (const s of spans) {
          const r = s.getBoundingClientRect?.();
          if (!r || r.width === 0 || r.height === 0) continue;
          const dx = Math.abs((r.left + r.width/2) - cx);
          const dy = Math.abs(r.bottom - cy);
          const score = dy + dx*0.2;
          if (score < bestDist && r.bottom <= cy + 220) {
            bestDist = score;
            const cand = (s.getAttribute?.('alt') || s.textContent || '').trim();
            if (!isBadLabel(cand)) best = cand;
          }
        }
        if (best) return best;
      }
    } catch (_) {}
    return null;
  }

  /**
   * Extrae y limpia texto de un nodo candidato a subtítulo, filtrando
   * ruido de CSS/UI y tokens de iconos.
   */
  function parseCaptionNode(node) {
    let raw = (node.innerText || node.textContent || '').trim();
    raw = raw.replace(/([a-z]+_[a-z]+)(?=[A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/g, '$1 ').replace(/\s+/g, ' ');
    if (!raw) return null;
    // CSS/text noise filter
    const isCss = /[{}]/.test(raw) || /::(before|after)/i.test(raw) || /@keyframes/i.test(raw) || /(position|transform|transition|font|border|margin|padding|height|width|opacity|z-index)\s*:/i.test(raw) || /\bVfPpkd-[A-Za-z0-9_-]+/i.test(raw);
    if (isCss) return null;
    if (/^(people|chat|devices|language|circle|settings|mood|info|apps|arrow_downward|keyboard_arrow_up|format_size|closed_caption|closed_caption_off|visual_effects|frame_person|back_hand|front_hand|call_end|videocam|videocam_off|computer_arrow_up|lock_person)$/i.test(raw)) return null;
    if (/^(tú|tu|yo|you)$/i.test(raw)) return null;
    if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(raw)) return null;
    const parts = raw.split(/\s+/);
    const onlyNames = parts.every(w => /^[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+$/.test(w));
    if (onlyNames && parts.length <= 3) return null;
    return raw;
  }

  /**
   * Pipeline principal por nodo: valida contexto, limpia texto,
   * clasifica y envía CAPTION_EVENT al background con speaker y ts.
   */
  function processNodeForCaption(el) {
    // Skip style/script-like tags early
    const tag = String(el?.tagName || '').toUpperCase();
    if (['STYLE','SCRIPT','NOSCRIPT','TEMPLATE','LINK'].includes(tag)) return;
    // Limit to CC regions/overlay context
    const inOverlay = !!el.closest('div.vNKgIf.UDinHf');
    const region = el.closest('[role="region"][aria-label], [aria-live][aria-label]');
    let inCaptionRegion = false;
    if (region) {
      const al = String(region.getAttribute('aria-label') || '').toLowerCase();
      inCaptionRegion = al.includes('subtítul') || al.includes('subtit') || al.includes('captions') || al.includes('subtitle');
    }
    const inContext = inOverlay || inCaptionRegion || !!el.closest('div[jsname="dsyhDe"], div[jscontroller="D1hTje"]');
    if (!inContext) return;
    if (isInUIControl(el)) return;
    const text = parseCaptionNode(el);
    if (!text) return;
    let cleaned = text.replace(/^\s*(tú|tu|yo|you)\s*[:,-]?\s+/i, '');
    cleaned = cleaned.replace(/^(tú|tu|yo|you)(?=[A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/i, '');
    cleaned = cleaned.trim();
    if (!cleaned) return;
    const cat = classifyText(text);
    if (!cat || cat.category !== 'speech') return;
    updateCandidate(el, cleaned);
    if (!isCaptionSource(el, cleaned)) return;
    let speaker = getSpeakerFromDOM(el) || 'Tú';
    if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(String(speaker))) speaker = 'Tú';
    const sp = String(speaker || '').trim();
    if (sp) {
      const esc = sp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re1 = new RegExp('^\n?\s*' + esc + '\s*[:,-]?\s*', 'i');
      let g = 0;
      while (g++ < 2 && re1.test(cleaned)) cleaned = cleaned.replace(re1, '').trim();
      const re2 = new RegExp('^\s*' + esc + '\s*' + esc + '\s*', 'i');
      if (re2.test(cleaned)) cleaned = cleaned.replace(re2, '').trim();
    }
    if (!cleaned) return;
    sendMessageSafe({ message: 'CAPTION_EVENT', payload: { speaker, text: cleaned, ts: Date.now() } });
  }

  // Priorizar observadores en regiones aria-live para acelerar captura
  const seenPriorityRoots = new WeakSet();
  /**
   * Asegura observadores en raíces prioritarias (aria-live, overlay CC,
   * contenedor de CC) y en sus shadow roots si existen.
   */
  function attachPriorityObservers() {
    const sels = [
      '[aria-live]',
      '[role="region"][aria-label]',
      'div.vNKgIf.UDinHf',
      'div[jsname="dsyhDe"]'
    ];
    for (const s of sels) {
      document.querySelectorAll(s).forEach(el => {
        try {
          if (!seenPriorityRoots.has(el)) {
            attachObserver(el);
            seenPriorityRoots.add(el);
            if (el.shadowRoot) attachObserver(el.shadowRoot);
          }
        } catch (_) {}
      });
    }
  }

  /**
   * Adjunta un MutationObserver profundo a una raíz dada para detectar
   * cambios de texto/nodos y encadenar processNodeForCaption.
   */
  function attachObserver(root) {
    if (!root) return;
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'characterData') {
          const el = m.target?.parentElement; if (el) processNodeForCaption(el);
        }
        if (m.type === 'childList') {
          m.addedNodes.forEach((n) => {
            if (n instanceof Text) { const el = n.parentElement; if (el) processNodeForCaption(el); return; }
            if (n instanceof HTMLElement) { processNodeForCaption(n); if (n.shadowRoot) attachObserver(n.shadowRoot); }
          });
        }
      }
    });
    try { obs.observe(root, { childList: true, subtree: true, characterData: true }); } catch (_) {}
    activeObservers.add({ obs, root });
  }

  /**
   * Inicia observadores en documento y raíces shadow, y programa
   * reataches periódicos para nuevas raíces y regiones prioritarias.
   */
  function startDeepObservers() {
    // Limpia anteriores
    for (const item of activeObservers) { try { item.obs.disconnect(); } catch (_) {} }
    activeObservers.clear();
    attachObserver(document);
    attachPriorityObservers();
    // Adjuntar a posibles raíces shadow iniciales
    document.querySelectorAll('*').forEach(el => { try { if (el.shadowRoot) attachObserver(el.shadowRoot); } catch (_) {} });
    // Reintentar adjuntar a nuevas raíces cada 2s
    if (reattachTimer) { clearInterval(reattachTimer); }
    reattachTimer = setInterval(() => {
      document.querySelectorAll('*').forEach(el => { try { if (el.shadowRoot) attachObserver(el.shadowRoot); } catch (_) {} });
      attachPriorityObservers();
    }, 2000);
  }

  /**
   * Detiene y limpia todos los observadores activos y el timer
   * de reatach periódico.
   */
  function stopDeepObservers() {
    for (const item of activeObservers) { try { item.obs.disconnect(); } catch (_) {} }
    activeObservers.clear();
    if (reattachTimer) { clearInterval(reattachTimer); reattachTimer = null; }
  }

  /**
   * Escucha botones de "Salir/Finalizar" para marcar fin de reunión
   * y enviar MEETING_ENDED cuando se hace clic.
   */
  function watchLeaveButtons() {
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
    sel.forEach(s => { document.querySelectorAll(s).forEach(b => btns.push(b)); });
    btns.forEach(b => {
      if (b.__meetixLeaveHooked) return;
      b.__meetixLeaveHooked = true;
      b.addEventListener('click', () => {
        try { meetingEnded = true; sendMessageSafe({ message: 'MEETING_ENDED' }); } catch (_) {}
      });
    });
  }

  let endedMarkerTimer = null;
  /**
   * Revisa textos globales en la página que indican fin de reunión y
   * emite MEETING_ENDED si se detectan frases conocidas.
   */
  function checkMeetingEndedMarkers() {
    try {
      if (meetingEnded) return;
      const txt = String(document.body?.innerText || '').toLowerCase();
      const markers = [
        'has abandonado la reunión','has salido de la reunión','has abandonado la llamada','has salido de la llamada','abandonaste la llamada','finalizaste la llamada','dejaste la llamada','you left the meeting',"you've left the meeting",'left the call','end call'
      ];
      const ended = markers.some(m => txt.includes(m));
      if (ended) { meetingEnded = true; sendMessageSafe({ message: 'MEETING_ENDED' }); }
    } catch (_) {}
  }

  /**
   * Punto de arranque: inicia observers, intenta activar CC, oculta overlay,
   * y prepara detección del fin de la reunión y reintentos.
   */
  function getPageMeetingTitle() {
    try {
      const path = String(location.pathname || '');
      const m = path.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
      const code = m ? m[1] : '';
      if (code) return `Google Meet | ${code}`;
      const dt = String(document.title || '').trim();
      const cleaned = dt.replace(/\s*-\s*Meet\s*$/i, '').replace(/^\s*Meet\s*-\s*/i, '').trim();
      return cleaned || 'Google Meet';
    } catch (_) { return 'Google Meet'; }
  }

  function init() {
    if (capturing) return; capturing = true;
    sendMessageSafe({ message: 'MEETING_STARTED', meetingTitle: getPageMeetingTitle() });
    startDeepObservers();
    ensureCaptionsOn();
    let tries = 0; const t = setInterval(() => { if (meetingEnded || isCaptionsOn() || ++tries > 80) { clearInterval(t); return; } ensureCaptionsOn(); }, 750);
    try { setInterval(() => { if (!meetingEnded && !isCaptionsOn()) ensureCaptionsOn(); }, 4000); } catch {}
    try {
      chrome.storage.sync.get(['keepMeetCaptionsVisible'], (s) => {
        const keep = (s && Object.prototype.hasOwnProperty.call(s, 'keepMeetCaptionsVisible')) ? !!s.keepMeetCaptionsVisible : true;
        if (keep) showCaptionsOverlay(); else hideCaptionsOverlay();
      });
    } catch {}
    try {
      setInterval(() => {
        try {
          chrome.storage.sync.get(['keepMeetCaptionsVisible'], (s) => {
            const keep = (s && Object.prototype.hasOwnProperty.call(s, 'keepMeetCaptionsVisible')) ? !!s.keepMeetCaptionsVisible : true;
            if (keep) showCaptionsOverlay(); else hideCaptionsOverlay();
          });
        } catch {}
      }, 2000);
    } catch {}
    // Detectar fin por botones y por pantalla final
    watchLeaveButtons();
    if (endedMarkerTimer) { clearInterval(endedMarkerTimer); }
    endedMarkerTimer = setInterval(checkMeetingEndedMarkers, 2000);
    window.addEventListener('beforeunload', () => { try { stopDeepObservers(); } catch (_) {} try { sendMessageSafe({ message: 'MEETING_ENDED' }); } catch(_){} });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { try { ensureCaptionsOn(); } catch(_){} } });
    window.addEventListener('pageshow', () => { try { ensureCaptionsOn(); } catch(_){} });
  }
  try {
    const isMeet = String(location.hostname || '') === 'meet.google.com';
    if (isMeet) { init(); }
  } catch (_) {}
})();
