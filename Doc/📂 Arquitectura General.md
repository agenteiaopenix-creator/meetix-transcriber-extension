📂 Arquitectura General

Una extensión Chrome MV3 se compone de varios módulos independientes con responsabilidades específicas:

manifest.json – configuración, permisos y definición global de la extensión

background.js – Service Worker, lógica central y coordinación

content.js – interacción en vivo con el DOM de Google Meet

popup.html / popup.js – interfaz visible para el usuario

icons/ – recursos gráficos

Otros archivos auxiliares (ej: .rar) no son utilizados en tiempo de ejecución

🧾 manifest.json

El manifiesto define la estructura, permisos y comportamiento principal de la extensión.

Contenido clave

Declaración de manifest_version: 3

Registro del Service Worker:

"background": { "service_worker": "background.js" }


Registro del popup:

"action": { "default_popup": "popup.html" }


Permisos:

downloads

storage

activeTab, tabs

scripting

alarms

Permisos de host (host_permissions):

https://meet.google.com/*


Inyección de scripts:

"content_scripts": [
  {
    "matches": ["https://meet.google.com/*"],
    "js": ["content.js"]
  }
]

🧠 background.js (Service Worker)

El cerebro de la extensión. Funciona por eventos y no tiene UI propia.

Funciones principales

Mantiene el estado global de la transcripción

Guarda y recupera datos desde chrome.storage.local

Orquesta la comunicación entre content.js y el popup

Gestiona exportaciones y subida a Supabase

Ejecuta descargas locales de archivos

Eventos escuchados

CAPTION_EVENT: líneas de subtítulos enviadas por content.js

MEETING_STARTED / MEETING_ENDED: ciclo de vida de la reunión

Solicitudes del popup:

GET_SESSION_INFO

GET_SESSIONS

EXPORT_AND_PUSH

EXPORT_MD

CLEAR_SESSION

Eventos del navegador:

chrome.alarms

chrome.tabs (detección de pestañas de Meet)

Acciones destacadas

Abrir el popup automáticamente

Emitir señales de estado (EXPORTING_STATUS, AUTO_UPLOAD_DONE)

Subir archivos a Supabase (uploadToSupabase)

Generar y descargar .md, .txt, .srt (downloadMD)

🧩 content.js

Corre dentro del sitio Google Meet y analiza subtítulos en tiempo real.

Responsabilidades

Observar DOM/ShadowDOM de Meet

Detectar subtítulos, limpiar ruido visual

Evitar duplicados y fusionar líneas consecutivas

Identificar hablante cuando es posible

Enviar eventos al SW:

CAPTION_EVENT

MEETING_STARTED

MEETING_ENDED

Comandos recibidos

MVP_START / MVP_STOP

MVP_EXPORT

SELF_NAME_UPDATED

Limitaciones

No puede descargar archivos → delega esta acción al Service Worker.

🖼️ popup.html

Interfaz del usuario cuando hace clic en el icono de la extensión.

Incluye:

Vista de transcripción de la sesión actual

Lista de sesiones guardadas

Campos de nombre/correo

Activación/desactivación de subida automática

Avisos de estado

Overlay #busy para mostrar spinner

🎛️ popup.js

Lógica del popup. Funciona solo cuando el popup está abierto.

Hace:

Inicializa la UI con datos del Service Worker

Solicita:

GET_SESSION_INFO

GET_SESSIONS

Ejecuta acciones:

EXPORT_AND_PUSH

EXPORT_MD

CLEAR_SESSION

Escucha señales:

EXPORTING_STATUS

AUTO_UPLOAD_DONE

Mantiene el estado de exportación sincronizado con chrome.storage.local

🎨 icons/

Contiene los iconos oficiales de la extensión en resoluciones:
16×16, 32×32, 48×48, 128×128.

No tienen lógica. Solo recursos visuales.

🗂️ meet-transcriber-CC.rar

Archivo de backup o entrega.
⚠️ No se usa en runtime
⚠️ No debe incluirse al empaquetar para la Chrome Web Store

🔄 Ciclo de Vida
Componente	Cuándo se ejecuta
manifest.json	Siempre al cargar la extensión
background.js	Solo cuando un evento lo activa
content.js	Cada vez que el usuario abre Meet
popup.js / popup.html	Solo cuando se abre el popup
🔗 Comunicación Interna
content.js → background.js

CAPTION_EVENT

MEETING_STARTED / MEETING_ENDED

DOWNLOAD_MD

popup.js ↔ background.js

GET_SESSION_INFO

GET_SESSIONS

EXPORT_AND_PUSH

EXPORT_MD

CLEAR_SESSION

Señales de UI:

EXPORTING_STATUS

AUTO_UPLOAD_DONE

Persistencia compartida

chrome.storage.local se usa para:

transcript

tiempos

configuraciones

estado del usuario

estado de UI

Permite continuidad incluso si:

el Service Worker se duerme

el popup se cierra de golpe

un mensaje se pierde

🛠️ Instalación en modo desarrollador

Ir a: chrome://extensions/

Activar Developer Mode

Click en Load unpacked

Seleccionar la carpeta del proyecto
(la que contiene manifest.json)

🚀 Empaquetar para Chrome Web Store

Asegúrate de NO incluir:

.rar

node_modules (si existiera)

archivos de backup

En chrome://extensions/ → Pack Extension

Sube el .zip generado a:
https://chrome.google.com/webstore/devconsole