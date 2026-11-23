# Resiliente Chat

Chat privado que no deja rastro. Creas una sala, compartes el enlace y habláis. Los mensajes van cifrados de extremo a extremo y se borran solos cuando se acaba su tiempo.

## Cómo funciona

1. **Crear sala privada** genera en tu navegador un identificador de sala y una clave AES-256.
2. Ambos viajan en el fragmento del enlace (`https://tu-dominio/#r=<sala>&k=<clave>`). El navegador **nunca envía la parte después de `#` al servidor**.
3. Cada mensaje (texto, nombre y temporizador) se cifra en el navegador con AES-GCM antes de salir. El servidor solo reenvía texto cifrado a quienes están en la sala.
4. Cada mensaje se elimina de la pantalla y de la memoria cuando se acaba su tiempo: 30 s, 1 min, 5 min o 1 h.
5. **Salir y borrar** elimina los mensajes, la clave y el enlace de la pestaña.

```
Navegador A                    Servidor                     Navegador B
cifra con la clave ──► { iv, ct } (no puede leerlo) ──► descifra con la clave
```

## Qué no guarda nada

| Dónde | Qué queda |
|---|---|
| Servidor | Nada en disco. En memoria solo la lista de conexiones abiertas por sala; la sala desaparece cuando sale la última persona. No hay historial: quien entra tarde no ve mensajes anteriores. |
| Logs | Una sola línea al arrancar. No se registran IPs, salas ni mensajes. |
| Navegador | Sin cookies ni `localStorage`. El enlace se guarda en `sessionStorage` para sobrevivir a una recarga y se borra al cerrar la pestaña o pulsar **Salir y borrar**. La clave se quita de la barra de direcciones al entrar. |
| Red | Sin fuentes, scripts ni recursos de terceros. Respuestas con `Cache-Control: no-store` y `Referrer-Policy: no-referrer`. |

## Límites honestos

- **Quien tenga el enlace puede leer la sala.** Compártelo solo por un canal de confianza.
- **El enlace queda en el historial del navegador** de quien lo abre (la entrada de la visita original). Usa una ventana privada si eso te preocupa.
- Nadie puede impedir una captura de pantalla o una foto del monitor.
- El servidor sabe **cuándo** y **desde qué IP** se conecta alguien, aunque no lo registra. Para ocultar la IP, usa Tor o una VPN.
- El temporizador lo aplica cada navegador. Un cliente modificado podría guardar los mensajes que recibe.
- Si nadie más está en la sala, el mensaje no lo recibe nadie: no se guarda para después.

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

El navegador solo permite cifrar en páginas `https://` (o en `localhost`). Por eso, para que otros dispositivos de tu red puedan usar el chat:

```bash
npm run cert   # crea certs/ con un certificado para localhost y las IPs de este equipo
npm start      # detecta certs/ y arranca en HTTPS (puerto 8443)
```

Al arrancar verás la dirección para los demás, por ejemplo `https://192.168.1.74:8443`. La primera vez, cada navegador mostrará un aviso porque el certificado es autofirmado: pulsa **Avanzado** y luego **Continuar**. Si cambia la IP del equipo, vuelve a ejecutar `npm run cert`.

Si alguien abre la página por `http://` desde otro dispositivo, verá un aviso que le explica que debe usar `https://`.

En Windows, la primera vez que arranques el servidor, permite el acceso de Node.js en el aviso del Firewall.

Para usar un certificado propio, define `TLS_CERT` y `TLS_KEY` con las rutas a los archivos PEM.

## Despliegue con Docker

```bash
docker compose up -d --build
```

El contenedor se ejecuta sin root, con sistema de archivos de solo lectura y sin logs.

## Producción

Pon el servidor detrás de un proxy con HTTPS (Caddy, Nginx o Cloudflare) que reenvíe también los WebSocket en `/ws`. Con Caddy basta con:

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

En ambos casos arranca el servidor con `TRUST_PROXY=true` para que el límite por IP use la IP real de cada visitante y no la del proxy. Desactiva los logs de acceso del proxy para no guardar IPs.

## Configuración

Variables de entorno (o archivo `.env`, ver `.env.example`):

| Variable | Por defecto | Para qué sirve |
|---|---|---|
| `PORT` | `8080` (`8443` con HTTPS) | Puerto de escucha |
| `TLS_CERT` / `TLS_KEY` | `certs/cert.pem` / `certs/key.pem` | Certificado y clave para servir HTTPS directamente |
| `HOST` | `0.0.0.0` | Dirección de escucha |
| `ALLOWED_ORIGINS` | vacío | Orígenes que pueden abrir el WebSocket, separados por comas. Vacío = solo el mismo dominio. |
| `MAX_ROOM_SIZE` | `50` | Personas máximas por sala |
| `MAX_ROOMS` | `1000` | Salas simultáneas máximas |
| `MAX_CONNECTIONS_PER_IP` | `20` | Conexiones simultáneas por IP (evita que una sola persona llene el servidor) |
| `TRUST_PROXY` | `false` | `true` si hay un proxy delante: usa `X-Forwarded-For` y `X-Forwarded-Host` |

Límites fijos: mensajes de hasta 2000 caracteres, 20 KB por trama, 10 segundos para entrar en una sala tras conectar y un límite anti-spam de ráfagas de 10 tramas y luego 2 por segundo (tras 30 excesos seguidos se corta la conexión). Si el servidor rechaza un mensaje, quien lo envió lo ve marcado como **No enviado**.

## Tests

```bash
npm test
```

Cubren el cifrado (ida y vuelta, otra clave, otra sala, mensaje alterado, enlaces) y el servidor (reenvío por sala y confirmación, sin historial, presencia, borrado de salas vacías, validación, tamaño máximo, sala llena, anti-spam, límite por IP, proxy y origen).

## Estructura

```
server.js            Arranque, HTTPS opcional y configuración por variables de entorno
scripts/             Generador de certificado para la red local (npm run cert)
src/server.js        HTTP + WebSocket: salas en memoria y reenvío de texto cifrado
src/rate-limiter.js  Límite anti-spam
public/index.html    Interfaz
public/css/style.css Estilos (tema claro y oscuro)
public/js/crypto.js  Cifrado AES-GCM y enlaces de invitación
public/js/app.js     Lógica del cliente: salas, mensajes y autodestrucción
test/                Tests con node:test
```

## Licencia

MIT. Ver [LICENSE](LICENSE).
