# MEETIX Transcriber — Ficha para Chrome Web Store

## Descripción corta
Transcribe Google Meet leyendo subtítulos locales y exporta a Markdown con marcas de tiempo. Opcional: auto‑subida a tu backend.

## Descripción larga
MEETIX Transcriber captura los subtítulos que ya muestra Google Meet y genera una transcripción con oradores y marcas de tiempo. Funciona 100% en tu navegador: no accede al audio/video, solo al texto visible de la reunión.

- Captura de subtítulos de Meet (ES/EN).
- Detección y normalización de oradores.
- Exportación a Markdown (.md) y descarga local.
- Backlog de sesiones y re‑exportación.
- Opción de auto‑subida al finalizar (configurable).
- Interfaz simple en el popup.

### Cómo usar
1) Instala la extensión y abre tu reunión de Meet.  
2) Activa subtítulos en Meet.  
3) Pulsa “Exportar” en el popup para descargar .md, o activa “Auto‑subida al finalizar”.

### Permisos utilizados
- `downloads`: guardar el archivo de transcripción en tu equipo.  
- `storage`: preferencias y transcripción local.  
- `scripting`, `activeTab`, `tabs`: observar la pestaña de Meet y enviar/recibir mensajes de la extensión.  
- `alarms`: auto‑exportación silenciosa cuando termina la reunión.  
- `notifications` (opcional): mostrar avisos de finalización/exportación.  
- `host_permissions` para `https://meet.google.com/*`: limitar la captura a Meet.

### Privacidad
La extensión lee únicamente el texto de subtítulos visible. Consulta la [Política de Privacidad](./PRIVACY.md).

### Soporte
soporte@tu-dominio.example