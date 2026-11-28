# Cambios

## 2.1.0 — 2026-11-27

### Añadido
- **Contraseña opcional por sala.** La clave final se deriva del enlace y la contraseña (PBKDF2-SHA256, 600 000 iteraciones). El enlace solo lleva la marca `p=1`. Un "hola" cifrado confirma si la contraseña coincide; si no, se avisa y se ofrece **Probar otra contraseña**, sin expulsar a nadie.
- **Código de verificación** de 4 palabras para comparar en persona o por llamada.
- **Ver una vez:** el mensaje o la imagen llegan tapados y se borran 10 s después de abrirlos.
- **Imágenes cifradas:** se recomprimen en el navegador (sin EXIF ni GPS), se muestran desde memoria y se liberan al borrarse.
- **Contador de mensajes nuevos** en el título de la pestaña cuando está en segundo plano (solo un número, nunca el contenido).
- **App instalable** (manifiesto e iconos, sin service worker para no dejar copias en caché).
- `npm run publicar`: publica el chat en internet con un túnel gratuito de Cloudflare.
- `render.yaml` para desplegar en Render.
- Pruebas en navegador real (`npm run test:e2e`, 22 escenarios con varias personas).
- CI en GitHub Actions: tests en Node 22 y 24, pruebas en Chromium y prueba de la imagen Docker (sin root, solo lectura, healthcheck).

### Cambiado
- Servidor: tramas de hasta 400 KB para imágenes y anti-spam también por bytes.
- Antes de cambiar de sala por un enlace nuevo en la misma pestaña se pide confirmación.

### Corregido
- Al detener el servidor (Ctrl+C o un nuevo despliegue) podía quedarse colgado esperando a que los navegadores soltaran sus conexiones HTTP. Ahora las cierra todas.

### Accesibilidad
- Auditoría WCAG 2.2 AA (axe-core) sin problemas en todas las pantallas, en tema claro y oscuro.
- Contraste mínimo de 4.5:1 en textos secundarios y en todos los colores de nombre.
- Región principal y encabezado en la sala; los lectores de pantalla anuncian los mensajes nuevos pero no las cuentas atrás.

## 2.0.0 — 2026-11-22

- Reescritura completa como chat efímero con cifrado de extremo a extremo: salas privadas por enlace, mensajes que se autodestruyen, sin historial ni logs, confirmación de envío, anti-spam, límite por IP, HTTPS para la red local y nueva interfaz.
