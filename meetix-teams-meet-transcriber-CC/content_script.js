// --- Constants ---
const TIMING = {
    BUTTON_CLICK_DELAY: 400,
    RETRY_DELAY: 2000,
    MAIN_LOOP_INTERVAL: 5000,
    OBSERVER_CHECK_INTERVAL: 10000,
    TOOLTIP_DISPLAY_DURATION: 1500
};

const SELECTORS = {
    CAPTIONS_RENDERER: "[data-tid='closed-caption-v2-window-wrapper'], [data-tid='closed-captions-renderer'], [data-tid*='closed-caption']",
    CHAT_MESSAGE: '.fui-ChatMessageCompact',
    AUTHOR: '[data-tid="author"]',
    CAPTION_TEXT: '[data-tid="closed-caption-text"]',
    LEAVE_BUTTONS: [
        "button[data-tid='hangup-main-btn']",
        "button[data-tid='hangup-leave-button']",
        "button[data-tid='hangup-end-meeting-button']",
        "div#hangup-button button",
        "#hangup-button"
    ].join(','),
    MORE_BUTTON: "button[data-tid='more-button'], button[id='callingButtons-showMoreBtn']",
    MORE_BUTTON_EXPANDED: "button[data-tid='more-button'][aria-expanded='true'], button[id='callingButtons-showMoreBtn'][aria-expanded='true']",
    LANGUAGE_SPEECH_BUTTON: "div[id='LanguageSpeechMenuControl-id']",
    TURN_ON_CAPTIONS_BUTTON: "div[id='closed-captions-button']",
};

// --- State ---
const transcriptArray = [];
let capturing = false;
let meetingTitleOnStart = '';
let recordingStartTime = null;
let observer = null;
let observedElement = null;
let hasInitializedListeners = false;
let wasInMeeting = false;
let meetingObserver = null;
let captionsObserver = null;
let cachedElements = new Map();
let autoEnableInProgress = false;
let autoEnableLastAttempt = 0;
let autoEnableDebounceTimer = null;
let autoSaveTriggered = false;
let lastMeetingId = null;

// --- Attendee Tracking State ---
let backupInterval = null;

// --- Difusión en tiempo real ---
// Envía actualizaciones para que el fondo/popup puedan ver cambios al instante.
function broadcastCaptionUpdate(data) {
    try {
        runtimeSend({ message: "live_caption_update", ...data });
    } catch (error) {
        // Silent fail if no listeners
    }
}

// Envía cambios de asistentes (si se usa) al fondo.
function broadcastAttendeeUpdate(data) {
    try {
        runtimeSend({ message: "live_attendee_update", ...data });
    } catch (error) {
        // Silent fail if no listeners
    }
}

// --- Manejo de errores y registro ---
// Centralizador de errores: captura detalles y los envía al background.
// Usar ErrorHandler.wrap(fn, 'contexto') para envolver funciones async sin romper flujo.
class ErrorHandler {
    static log(error, context = '', silent = false) {
        const timestamp = new Date().toISOString();
        const errorInfo = {
            timestamp,
            context,
            message: error.message || String(error),
            stack: error.stack,
            url: window.location.href
        };
        
        console.error(`[Teams Caption Saver] ${context}:`, errorInfo);
        
        if (!silent) { runtimeSend({ message: "error_logged", error: errorInfo }); }
        
        return errorInfo;
    }
    
    static wrap(fn, context = '', fallback = null) {
        return async function(...args) {
            try {
                return await fn.apply(this, args);
            } catch (error) {
                ErrorHandler.log(error, context);
                return fallback;
            }
        };
    }
}

// --- Retry Mechanism ---
// Reintentos con backoff exponencial para operaciones frágiles de DOM o mensajería.
class RetryHandler {
    static async withRetry(fn, context = '', maxAttempts = 3, baseDelay = 1000) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                
                if (attempt === maxAttempts) {
                    ErrorHandler.log(error, `${context} - Final attempt failed`, false);
                    throw error;
                }
                
                const delayTime = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
                console.log(`[Teams Caption Saver] ${context} - Attempt ${attempt} failed, retrying in ${delayTime}ms:`, error.message || error);
                await delay(delayTime);
            }
        }
        
        throw lastError;
    }
}

// --- Utility Functions ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const getCleanTranscript = () => transcriptArray.map(({ key, ...rest }) => rest);

// --- DOM Element Caching ---
// Cachea selectores unos segundos para reducir querySelector y evitar referencias obsoletas.
function getCachedElement(selector, expiry = 5000) {
    const now = Date.now();
    const cached = cachedElements.get(selector);
    
    if (cached && (now - cached.timestamp) < expiry && document.contains(cached.element)) {
        return cached.element;
    }
    
    const element = document.querySelector(selector);
    if (element) {
        cachedElements.set(selector, { element, timestamp: now });
    }
    return element;
}

function clearElementCache() {
    cachedElements.clear();
}

// Detecta si estás "en reunión" buscando controles de finalizar llamada.
const isUserInMeeting = () => getCachedElement(SELECTORS.LEAVE_BUTTONS) !== null;

// --- Core Logic ---
// Pipeline: detecta elementos de subtítulos, asigna ID estable, actualiza transcript y difunde cambios.
const processCaptionUpdates = ErrorHandler.wrap(function() {
    const closedCaptionsContainer = getCachedElement(SELECTORS.CAPTIONS_RENDERER);
    if (!closedCaptionsContainer) return;

    const transcriptElements = closedCaptionsContainer.querySelectorAll(SELECTORS.CHAT_MESSAGE);

    transcriptElements.forEach(element => {
        try {
            const authorElement = element.querySelector(SELECTORS.AUTHOR);
            const textElement = element.querySelector(SELECTORS.CAPTION_TEXT);

            if (!authorElement || !textElement) return;

            const name = authorElement.innerText.trim();
            const text = textElement.innerText.trim();
            if (text.length === 0) return;

            let captionId = element.getAttribute('data-caption-id');
            if (!captionId) {
                captionId = `caption_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
                element.setAttribute('data-caption-id', captionId);
            }

            const existingIndex = transcriptArray.findIndex(entry => entry.key === captionId);
            const time = new Date().toLocaleTimeString();
            const tsNow = Date.now();

            if (existingIndex !== -1) {
                // Update existing entry if text has changed
                if (transcriptArray[existingIndex].Text !== text) {
                    transcriptArray[existingIndex].Text = text;
                    transcriptArray[existingIndex].Time = time;
                    transcriptArray[existingIndex].ts = tsNow;
                    try {
                        const recTime = recordingStartTime ? recordingStartTime.toISOString() : null;
                        chrome.storage.local.set({
                            transcriptBackup: {
                                transcript: transcriptArray,
                                meetingTitle: meetingTitleOnStart,
                                recordingStartTime: recTime,
                                lastBackup: new Date().toISOString()
                            }
                        });
                    } catch (_) {}
                    // Broadcast update to viewer
                    broadcastCaptionUpdate({
                        type: 'update',
                        caption: transcriptArray[existingIndex]
                    });
                }
            } else {
                // Add new entry
                const newCaption = { Name: name, Text: text, Time: time, key: captionId, ts: tsNow };
                transcriptArray.push(newCaption);
                try {
                    const recTime = recordingStartTime ? recordingStartTime.toISOString() : null;
                    chrome.storage.local.set({
                        transcriptBackup: {
                            transcript: transcriptArray,
                            meetingTitle: meetingTitleOnStart,
                            recordingStartTime: recTime,
                            lastBackup: new Date().toISOString()
                        }
                    });
                } catch (_) {}
                // Broadcast new caption to viewer
                broadcastCaptionUpdate({
                    type: 'new',
                    caption: newCaption
                });
            }
        } catch (error) {
            ErrorHandler.log(error, 'Processing individual caption element', true);
        }
    });
}, 'Caption updates processing');

// --- Attendee Tracking Functions ---
// Removed: attendee tracking and roster scraping

// --- Event-Driven Meeting Detection ---
let meetingStateDebounceTimer = null;
let captionsStateDebounceTimer = null;

// Observa cambios generales del DOM para detectar entrar/salir de la reunión (con debounce).
function setupMeetingObserver() {
    if (meetingObserver) return;
    
    meetingObserver = new MutationObserver(() => {
        // Debounce meeting state changes to prevent excessive calls
        if (meetingStateDebounceTimer) {
            clearTimeout(meetingStateDebounceTimer);
        }
        meetingStateDebounceTimer = setTimeout(() => {
            handleMeetingStateChange();
        }, 1000);
    });
    
    meetingObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributeFilter: ['data-tid']
    });
}

// Observa cambios en el DOM relacionados a subtítulos para iniciar/detener captura (con debounce).
function setupCaptionsObserver() {
    if (captionsObserver) return;
    
    captionsObserver = new MutationObserver(() => {
        // Debounce captions state changes to prevent excessive calls
        if (captionsStateDebounceTimer) {
            clearTimeout(captionsStateDebounceTimer);
        }
        captionsStateDebounceTimer = setTimeout(() => {
            handleCaptionsStateChange();
        }, 1500);
    });
    
    captionsObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributeFilter: ['data-tid']
    });
}

// Gestiona transiciones de reunión (In/Out) y dispara auto-guardado seguro.
const handleMeetingStateChange = ErrorHandler.wrap(async function() {
    const nowInMeeting = isUserInMeeting();
    
    if (wasInMeeting && !nowInMeeting) {
        console.log("Meeting transition detected: In -> Out. Checking for auto-save.");
        
        // Send meeting ended signal to viewer
        try {
            runtimeSend({ message: "meeting_ended" });
        } catch (error) {
            // Silent fail if no listeners
        }
        
        // Generate a unique meeting session ID
        const currentMeetingId = `${meetingTitleOnStart}_${recordingStartTime?.toISOString() || Date.now()}`;
        
        // Prevent duplicate auto-saves for the same meeting session
        if (autoSaveTriggered && lastMeetingId === currentMeetingId) {
            console.log("Auto-save already triggered for this meeting session, skipping...");
            clearElementCache();
            wasInMeeting = nowInMeeting;
            return;
        }
        
        try {
            const { autoSaveOnEnd, autoUploadOnEnd } = await chrome.storage.sync.get(['autoSaveOnEnd','autoUploadOnEnd']);
            if ((autoSaveOnEnd || autoUploadOnEnd) && transcriptArray.length > 0) {
                console.log("Auto-save is ON and transcript has data. Triggering save.");
                
                // Mark auto-save as triggered before sending message
                autoSaveTriggered = true;
                lastMeetingId = currentMeetingId;
                
                // Send save message without retry (let service worker handle retries if needed)
                runtimeSend({ message: "save_on_leave", transcriptArray: getCleanTranscript(), meetingTitle: meetingTitleOnStart, recordingStartTime: recordingStartTime ? recordingStartTime.toISOString() : new Date().toISOString() });
                
                console.log("Auto-save message sent successfully.");
            }
        } catch (error) {
            ErrorHandler.log(error, 'Auto-save on meeting end', false);
            // Reset auto-save state on error so it can be retried
            autoSaveTriggered = false;
        }
        
        clearElementCache();
    }
    
    wasInMeeting = nowInMeeting;
    
    if (!nowInMeeting) {
        stopCaptureSession();
        return;
    } else if (!wasInMeeting && nowInMeeting) {
        // Reset auto-save state when joining a new meeting
        console.log("Meeting transition detected: Out -> In. Resetting auto-save state.");
        autoSaveTriggered = false;
        lastMeetingId = null;
    }
    
    handleCaptionsStateChange();
}, 'Meeting state change handler');

// Inicia/detiene captura en función de la presencia del contenedor de subtítulos; intenta auto-habilitar.
const handleCaptionsStateChange = ErrorHandler.wrap(async function() {
    if (!isUserInMeeting()) return;
    
    const captionsContainer = getCachedElement(SELECTORS.CAPTIONS_RENDERER);
    if (captionsContainer) {
        startCaptureSession();
    } else {
        stopCaptureSession();
        // Always try to enable captions when not detected
        debouncedAutoEnableCaptions();
    }
}, 'Captions state change handler');

// Reatacha el MutationObserver si cambia el contenedor de subtítulos y ejecuta un escaneo inicial.
function ensureObserverIsActive() {
    if (!capturing) return;

    const captionContainer = getCachedElement(SELECTORS.CAPTIONS_RENDERER);
    
    // If the container doesn't exist or has changed, re-initialize the observer
    if (!captionContainer || captionContainer !== observedElement) {
        if (observer) {
            observer.disconnect();
        }

        if (captionContainer) {
            observer = new MutationObserver(processCaptionUpdates);
            observer.observe(captionContainer, {
                childList: true,
                subtree: true,
                characterData: true,
            });
            observedElement = captionContainer;
            processCaptionUpdates(); // Initial scan
        } else {
            observedElement = null;
        }
    }
}

// Inicializa nueva sesión de captura y backup periódico; resetea estado de la reunión.
async function startCaptureSession() {
    
    if (capturing) return;

    console.log("New caption session detected. Starting capture.");
    try {
        const data = await chrome.storage.local.get('transcriptBackup');
        const b = data && data.transcriptBackup ? data.transcriptBackup : null;
        const bt = Array.isArray(b?.transcript) ? b.transcript : [];
        const bTitle = String(b?.meetingTitle || '');
        const sameTitle = bTitle && bTitle === document.title;
        if (bt.length && sameTitle) {
            transcriptArray.length = 0;
            bt.forEach(x => transcriptArray.push(x));
            if (b?.recordingStartTime) {
                try { recordingStartTime = new Date(b.recordingStartTime); } catch (_) {}
            }
        } else {
            transcriptArray.length = 0;
        }
    } catch (_) { transcriptArray.length = 0; }
    chrome.storage.session.remove('speakerAliases');

    capturing = true;
    meetingTitleOnStart = document.title;
    recordingStartTime = new Date();
    
    console.log(`Capture started. Title: "${meetingTitleOnStart}", Time: ${recordingStartTime.toLocaleString()}`);
    
    // Start periodic backup
    startPeriodicBackup();
    
    runtimeSend({ message: "update_badge_status", capturing: true });
    
    ensureObserverIsActive();
}

// Respalda transcript a chrome.storage.local cada 30s para resiliencia ante cierres inesperados.
function startPeriodicBackup() {
    // Clear any existing backup interval
    if (backupInterval) {
        clearInterval(backupInterval);
    }
    
    // Backup transcript every 30 seconds
    backupInterval = setInterval(async () => {
        if (transcriptArray.length > 0) {
            try {
                await chrome.storage.local.set({
                    transcriptBackup: {
                        transcript: transcriptArray,
                        meetingTitle: meetingTitleOnStart,
                        recordingStartTime: recordingStartTime ? recordingStartTime.toISOString() : null,
                        lastBackup: new Date().toISOString()
                    }
                });
                console.log(`[Teams Caption Saver] Backup saved: ${transcriptArray.length} entries`);
            } catch (error) {
                console.error("[Teams Caption Saver] Backup failed:", error);
            }
        }
    }, 30000); // 30 seconds
}

// Detiene captura, realiza respaldo final, guarda en historial y actualiza badge.
function stopCaptureSession() {
    if (!capturing) return;

    console.log("Captions turned off or meeting ended. Capture stopped. Data preserved.");
    capturing = false;
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    observedElement = null;
    
    // Stop periodic backup
    if (backupInterval) {
        clearInterval(backupInterval);
        backupInterval = null;
    }
    
    // Final backup before stopping
    if (transcriptArray.length > 0) {
        chrome.storage.local.set({
            transcriptBackup: {
                transcript: transcriptArray,
                meetingTitle: meetingTitleOnStart,
                recordingStartTime: recordingStartTime ? recordingStartTime.toISOString() : null,
                lastBackup: new Date().toISOString()
            }
        });
        
        // Save to session history when meeting ends (even if < 5 minutes)
        saveToSessionHistory();
    }
    
    // Attendee tracking removed
    
    runtimeSend({ message: "update_badge_status", capturing: false });
}

// Save current transcript to session history
async function saveToSessionHistory() {
    if (transcriptArray.length === 0) return;
    
    try {
        // Use message passing to save session (content scripts can't import modules)
        runtimeSend({ message: "save_session_history", transcriptArray: transcriptArray, meetingTitle: meetingTitleOnStart || 'Untitled Meeting' });
        
        console.log('[Teams Caption Saver] Session saved to history');
    } catch (error) {
        console.log('[Teams Caption Saver] Could not save to session history:', error);
    }
}

// --- Automated Features ---
// Navega el menú "Más" en Teams para habilitar subtítulos en vivo con tiempos y validaciones.
async function attemptAutoEnableCaptions() {
    // Prevent multiple simultaneous auto-enable attempts
    if (autoEnableInProgress) {
        console.log("Auto-enable already in progress, skipping...");
        return;
    }
    
    // Prevent too frequent attempts (min 3 seconds between attempts)
    const now = Date.now();
    if (now - autoEnableLastAttempt < 3000) {
        console.log("Auto-enable attempted too recently, skipping...");
        return;
    }
    
    autoEnableInProgress = true;
    autoEnableLastAttempt = now;
    
    try {
        console.log("Starting auto-enable captions attempt...");
        
        const moreButton = getCachedElement(SELECTORS.MORE_BUTTON);
        if (!moreButton) {
            console.error("Auto-enable FAILED: Could not find 'More' button.");
            return;
        }
        
        // Check if More menu is already expanded
        const expandedMoreButton = getCachedElement(SELECTORS.MORE_BUTTON_EXPANDED);
        if (!expandedMoreButton) {
            console.log("Clicking More button...");
            moreButton.click();
            await delay(TIMING.BUTTON_CLICK_DELAY);
        } else {
            console.log("More menu already expanded, proceeding...");
        }

        const langAndSpeechButton = getCachedElement(SELECTORS.LANGUAGE_SPEECH_BUTTON);
        if (!langAndSpeechButton) {
            console.error("Auto-enable FAILED: Could not find 'Language and speech' menu item.");
            // Close the More menu if we opened it
            const currentExpandedButton = getCachedElement(SELECTORS.MORE_BUTTON_EXPANDED);
            if (currentExpandedButton) {
                currentExpandedButton.click();
            }
            return;
        }
        
        console.log("Clicking Language and speech...");
        langAndSpeechButton.click();
        await delay(TIMING.BUTTON_CLICK_DELAY);

        const turnOnCaptionsButton = getCachedElement(SELECTORS.TURN_ON_CAPTIONS_BUTTON);
        if (turnOnCaptionsButton) {
            console.log("Clicking Turn on live captions...");
            turnOnCaptionsButton.click();
            await delay(TIMING.BUTTON_CLICK_DELAY);
        } else {
            console.error("Auto-enable FAILED: Could not find 'Turn on live captions' button.");
        }

        // Attempt to close the 'More' menu
        const finalExpandedButton = getCachedElement(SELECTORS.MORE_BUTTON_EXPANDED);
        if (finalExpandedButton) {
            console.log("Closing More menu...");
            finalExpandedButton.click();
        }
        
        console.log("Auto-enable captions attempt completed.");
    } catch (e) {
        console.error("Error during auto-enable captions attempt:", e);
    } finally {
        autoEnableInProgress = false;
    }
}

// Debounce de 500ms para evitar spam al intentar habilitar subtítulos automáticamente.
function debouncedAutoEnableCaptions() {
    if (autoEnableDebounceTimer) {
        clearTimeout(autoEnableDebounceTimer);
    }
    
    autoEnableDebounceTimer = setTimeout(() => {
        attemptAutoEnableCaptions();
    }, 500); // más rápido para habilitar subtítulos antes
}

// --- Event-Driven Initialization ---
// Arranca observadores y chequeos periódicos; realiza una verificación inicial del estado.
function initializeEventDrivenSystem() {
    if (hasInitializedListeners) return;
    
    console.log("Initializing event-driven caption system...");
    
    // Set up observers for meeting state changes
    setupMeetingObserver();
    setupCaptionsObserver();
    
    // Periodically check observer status (much less frequent than before)
    setInterval(ensureObserverIsActive, TIMING.OBSERVER_CHECK_INTERVAL);
    
    // Initial state check
    handleMeetingStateChange();
    
    hasInitializedListeners = true;
}

// --- Memory Leak Prevention ---
// Limpia observadores y timers para prevenir fugas de memoria; resetea caché y flags.
function cleanupObservers() {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    if (meetingObserver) {
        meetingObserver.disconnect();
        meetingObserver = null;
    }
    if (captionsObserver) {
        captionsObserver.disconnect();
        captionsObserver = null;
    }
    
    // Clear all debounce timers
    if (meetingStateDebounceTimer) {
        clearTimeout(meetingStateDebounceTimer);
        meetingStateDebounceTimer = null;
    }
    if (captionsStateDebounceTimer) {
        clearTimeout(captionsStateDebounceTimer);
        captionsStateDebounceTimer = null;
    }
    if (autoEnableDebounceTimer) {
        clearTimeout(autoEnableDebounceTimer);
        autoEnableDebounceTimer = null;
    }
    
    // Reset auto-enable state
    autoEnableInProgress = false;
    
    clearElementCache();
}

// Cleanup on page unload
// Limpieza cuando la pestaña se está cerrando.
window.addEventListener('beforeunload', cleanupObservers);

// Initialize the system
initializeEventDrivenSystem();

// --- Message Handling ---
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    switch (request.message) {
        case 'viewer_ready':
            // Viewer is ready to receive live updates
            sendResponse({
                streaming: capturing,
                captionCount: transcriptArray.length
            });
            return true;
            
        case 'get_status':
            (async () => {
                sendResponse({
                    capturing: capturing,
                    captionCount: transcriptArray.length,
                    isInMeeting: isUserInMeeting()
                });
            })();
            return true; // Will respond asynchronously

        case 'return_transcript':
            if (transcriptArray.length > 0) {
                (async () => {
                    runtimeSend({ message: "download_captions", transcriptArray: getCleanTranscript(), meetingTitle: meetingTitleOnStart, format: request.format, recordingStartTime: recordingStartTime ? recordingStartTime.toISOString() : new Date().toISOString(), source: 'teams' });
                })();
            } else {
                alert("No captions were captured. Please ensure captions are turned on in the meeting.");
            }
            break;

        case 'get_transcript_for_copying':
            sendResponse({ transcriptArray: getCleanTranscript() });
            break;

        case 'get_captions_for_viewing':
            if (transcriptArray.length > 0) {
                runtimeSend({ message: "display_captions", transcriptArray: getCleanTranscript() });
            } else {
                alert("No captions were captured. Please ensure captions are turned on in the meeting.");
            }
            break;

        case 'get_unique_speakers':
            const speakers = [...new Set(transcriptArray.map(item => item.Name))];
            sendResponse({ speakers });
            break;
            
        // attendee report removed
        
        default:
            console.log("Unhandled message received in content script:", request.message);
            break;
    }

    return true; // Indicates an asynchronous response may be sent.
});

console.log("Teams Captions Saver content script is running.");
function runtimeSend(msg) {
    try {
        chrome.runtime.sendMessage(msg, () => { const _ = chrome.runtime.lastError; });
    } catch (_) {}
}
