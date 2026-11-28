# Resiliente Chat

[![Tests](https://github.com/Matthew-Garay/resiliente-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/Matthew-Garay/resiliente-chat/actions/workflows/ci.yml)

Chat privado que no deja rastro. Creas una sala, compartes el enlace y habláis. Los mensajes y las imágenes van cifrados de extremo a extremo y se borran solos.

## Qué puedes hacer

- **Salas privadas por enlace.** Solo quien tiene el enlace puede entrar.
- **Contraseña opcional.** No va en el enlace: hace falta el enlace **y** la contraseña para leer la sala.
- **Mensajes que se borran solos** a los 30 s, 1 min, 5 min o 1 h.
- **Ver una vez.** El mensaje llega tapado; al tocarlo se ve 10 segundos y desaparece.
- **Imágenes cifradas.** Se recomprimen en tu navegador, lo que elimina los metadatos (GPS, modelo de cámara), y se borran igual que los mensajes.
- **Código de verificación.** Cuatro palabras para comparar en persona o por llamada y confirmar que tenéis la misma sala.
- **Aviso discreto de mensajes nuevos:** con la pestaña en segundo plano, el título muestra cuántos llegaron, nunca su contenido.
- **Instalable** en el móvil o el ordenador como una app (PWA).
- **Accesible:** cumple WCAG 2.2 AA (contraste, teclado, lectores de pantalla) en tema claro y oscuro.

## Cómo funciona

1. **Crear sala privada** genera en tu navegador un identificador de sala y una clave AES-256.
2. Ambos viajan en el fragmento del enlace (`https://tu-dominio/#r=<sala>&k=<clave>`). El navegador **nunca envía la parte después de `#` al servidor**.
3. Con contraseña, la clave final se deriva del enlace y la contraseña con PBKDF2-SHA256 (600 000 iteraciones). El enlace solo lleva la marca `&p=1`.
4. Todo (texto, imágenes, nombre y temporizador) se cifra en el navegador con AES-GCM antes de salir. El servidor solo reenvía texto cifrado a quienes están en la sala.
5. Al entrar, tu navegador envía un "hola" cifrado. Quien lo puede descifrar responde: así sabes si tu contraseña es correcta sin que el servidor la vea nunca.
6. **Salir y borrar** elimina los mensajes, las imágenes, la clave y el enlace de la pestaña.

```
Navegador A                    Servidor                     Navegador B
cifra con la clave ──► { iv, ct } (no puede leerlo) ──► descifra con la clave
```

## Qué no guarda nada

| Dónde | Qué queda |
|---|---|
| Servidor | Nada en disco. En memoria solo las conexiones abiertas por sala y un contador por IP; la sala desaparece cuando sale la última persona. No hay historial: quien entra tarde no ve mensajes anteriores. |
| Logs | Solo las líneas de arranque. No se registran IPs, salas ni mensajes. |
| Navegador | Sin cookies, `localStorage` ni caché. El enlace (nunca la contraseña) se guarda en `sessionStorage` para sobrevivir a una recarga y se borra al cerrar la pestaña o pulsar **Salir y borrar**. Las imágenes solo existen en memoria y se liberan al borrarse. |
| Red | Sin fuentes, scripts ni recursos de terceros. Respuestas con `Cache-Control: no-store` y `Referrer-Policy: no-referrer`. |

## Límites honestos

- **Quien tenga el enlace (y la contraseña, si la hay) puede leer la sala.** Compártelos por canales de confianza, y mejor por canales distintos.
- **El enlace queda en el historial del navegador** de quien lo abre. Usa una ventana privada si eso te preocupa.
- Nadie puede impedir una captura de pantalla o una foto del monitor, tampoco con "ver una vez".
- El servidor sabe **cuándo** y **desde qué IP** se conecta alguien, aunque no lo registra. Para ocultar la IP, usa Tor o una VPN.
- El temporizador lo aplica cada navegador. Un cliente modificado podría guardar lo que recibe.
- Si nadie más está en la sala, el mensaje no lo recibe nadie: no se guarda para después.
- El código de verificación confirma que tenéis el mismo enlace y contraseña, no quién está al otro lado.

## Ejecutar en local

Requisitos: Node.js 22.9 o superior.

```bash
git clone https://github.com/Matthew-Garay/resiliente-chat.git
cd resiliente-chat
npm install
npm start
```

Abre <http://localhost:8080>, pulsa **Crear sala privada** y abre el enlace copiado en otra ventana.

## Usar en tu red local (Wi-Fi de casa, oficina, escuela)

El navegador solo permite cifrar en páginas `https://` (o en `localhost`). Para que otros dispositivos de tu red puedan usar el chat:

```bash
npm run cert   # crea certs/ con un certificado para localhost y las IPs de este equipo
npm start      # detecta certs/ y arranca en HTTPS (puerto 8443)
```

Al arrancar verás la dirección para los demás, por ejemplo `https://192.168.1.74:8443`. La primera vez, cada navegador mostrará un aviso porque el certificado es autofirmado: pulsa **Avanzado** y luego **Continuar**. Si cambia la IP del equipo, vuelve a ejecutar `npm run cert`.

Si alguien abre la página por `http://` desde otro dispositivo, verá un aviso que le explica que debe usar `https://`. En Windows, la primera vez que arranques el servidor, permite el acceso de Node.js en el aviso del Firewall.

## Publicar en internet

### Rápido, desde tu equipo (gratis, sin cuenta)

```bash
winget install --id Cloudflare.cloudflared   # solo la primera vez (macOS: brew install cloudflared)
npm run publicar
```

Verás una dirección como `https://algo-aleatorio.trycloudflare.com` con HTTPS válido (sin avisos). Funciona mientras la ventana esté abierta; al cerrarla (Ctrl+C) deja de existir. El servidor solo escucha en `127.0.0.1`, así que nadie puede entrar salvo por el túnel.

### Permanente, en Render (gratis)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Matthew-Garay/resiliente-chat)

El archivo [`render.yaml`](render.yaml) ya trae la configuración. En el plan gratuito el servidor se duerme tras 15 minutos sin uso y tarda unos segundos en despertar.

### Con Docker en tu propio servidor

```bash
docker compose up -d --build
```

El contenedor se ejecuta sin root, con sistema de archivos de solo lectura y sin logs. Ponlo detrás de un proxy HTTPS:

```
chat.tu-dominio.com {
    reverse_proxy 127.0.0.1:8080
    log {
        output discard
    }
}
```

Con Nginx, reenvía el WebSocket y la cabecera del dominio:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    access_log off;
}
```

Detrás de un proxy arranca con `TRUST_PROXY=true` para que el límite por IP use la IP real de cada visitante. Desactiva los logs de acceso del proxy para no guardar IPs.

## Configuración

Variables de entorno (o archivo `.env`, ver `.env.example`):

| Variable | Por defecto | Para qué sirve |
|---|---|---|
| `PORT` | `8080` (`8443` con HTTPS) | Puerto de escucha |
| `HOST` | `0.0.0.0` | Dirección de escucha |
| `TLS_CERT` / `TLS_KEY` | `certs/cert.pem` / `certs/key.pem` | Certificado y clave para servir HTTPS directamente |
| `TLS` | vacío | `off` para servir HTTP aunque exista `certs/` (detrás de un proxy) |
| `ALLOWED_ORIGINS` | vacío | Orígenes que pueden abrir el WebSocket, separados por comas. Vacío = solo el mismo dominio. |
| `MAX_ROOM_SIZE` | `50` | Personas máximas por sala |
| `MAX_ROOMS` | `1000` | Salas simultáneas máximas |
| `MAX_CONNECTIONS_PER_IP` | `20` | Conexiones simultáneas por IP (evita que una sola persona llene el servidor) |
| `TRUST_PROXY` | `false` | `true` si hay un proxy delante: usa `X-Forwarded-For` y `X-Forwarded-Host` |

Límites fijos: textos de hasta 2000 caracteres, imágenes de hasta 200 KB tras comprimirlas, 400 KB por trama y 10 segundos para entrar en una sala tras conectar. Anti-spam por conexión: ráfagas de 10 tramas y luego 2 por segundo, y ~1,6 MB de ráfaga y luego 200 KB por segundo (tras 30 excesos seguidos se corta la conexión). Si el servidor rechaza un mensaje, quien lo envió lo ve marcado como **No enviado**.

## Tests

```bash
npm test           # cifrado, servidor y HTTPS
npm run test:e2e   # navegador real: varias personas usando el chat
```

Las pruebas en navegador usan Chrome si está instalado; si no, ejecuta antes `npx playwright-core install chromium`.

Cubren el cifrado (ida y vuelta, otra clave, otra sala, mensaje alterado, enlaces, contraseña y código de verificación), el servidor (reenvío por sala y confirmación, sin historial, presencia, borrado de salas vacías, validación, tamaños, sala llena, anti-spam por tramas y por bytes, límite por IP, proxy y origen) y HTTPS. Las de navegador recorren 22 escenarios con varias personas: entrar, mensajes que caducan, contador en el título, recarga, otra clave, enlaces dañados, anti-spam, salir y borrar, reconexión, contraseña buena y mala, código, ver una vez e imágenes. Todo se ejecuta en cada push con GitHub Actions, junto con una prueba de la imagen Docker.

Historial de versiones en [CHANGELOG.md](CHANGELOG.md).

## Estructura

```
server.js              Arranque, HTTPS opcional y configuración por variables de entorno
scripts/               Certificado para la red local (npm run cert) y túnel público (npm run publicar)
src/server.js          HTTP + WebSocket: salas en memoria y reenvío de texto cifrado
src/rate-limiter.js    Límite anti-spam
public/index.html      Interfaz
public/css/style.css   Estilos (tema claro y oscuro)
public/js/crypto.js    Cifrado AES-GCM, contraseña, código de verificación y enlaces
public/js/images.js    Compresión de imágenes sin metadatos
public/js/app.js       Lógica del cliente: salas, mensajes, ver una vez y autodestrucción
public/manifest.webmanifest, public/icons/   App instalable (PWA)
render.yaml            Despliegue en Render
test/                  Tests con node:test
e2e/                   Pruebas en navegador real (Playwright)
```

## Licencia

MIT. Ver [LICENSE](LICENSE).
