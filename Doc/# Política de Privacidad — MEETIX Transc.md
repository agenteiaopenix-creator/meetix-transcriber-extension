# Política de Privacidad — MEETIX Transcriber

Última actualización: 2025-12-10

MEETIX Transcriber es una extensión de Chrome que lee subtítulos locales de Google Meet y permite exportar o subir la transcripción. Esta política describe qué datos se procesan y cómo se manejan.

## Qué datos procesa
- Texto de subtítulos visibles en la pestaña de Google Meet (orador, fragmento, marca de tiempo).
- Preferencias locales: nombre propio (`selfName`), estado de auto‑subida al finalizar, correo del usuario (si lo proporcionas para subir).
- No accede a audio, video ni a contenido fuera de la pestaña de Meet.

## Dónde se almacenan
- En tu navegador, usando `chrome.storage.local`. Puedes limpiar la transcripción y preferencias desde el popup.
- Opcionalmente, si activas la **auto‑subida**, la transcripción se envía a un backend (p. ej., Supabase) mediante HTTPS. El endpoint y los parámetros se muestran/configuran desde la extensión.

## Uso de datos
- El texto de la transcripción se usa únicamente para exportar o subir según tu acción/ajuste. No se vende ni se comparte con terceros no necesarios para el servicio.
- Si se sube al backend, ese servicio puede almacenar los datos para consulta/exportación posterior.

## Retención
- En el navegador: hasta que cierres la reunión o limpies la transcripción.
- En el backend: según tu política; solicita eliminación escribiendo al contacto abajo.

## Seguridad
- Transferencias al backend se realizan por HTTPS.
- Recomendamos usar cuentas y claves seguras en el backend.

## Tus derechos
- Puedes desactivar la auto‑subida, limpiar datos locales o solicitar eliminación en el backend.
- Para consultas o eliminación: contacto: soporte@tu-dominio.example

## Cambios
Actualizaremos esta política ante cambios funcionales sustanciales. Mantendremos la fecha de “Última actualización”.