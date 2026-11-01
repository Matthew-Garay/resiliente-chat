# 🌐 Resiliente Chat - Chat Web Global e Indetectable

Una aplicación de chat web diseñada para ser difícil de bloquear y funcionar en cualquier red del mundo.

## Características

- 🔒 **Comunicación cifrada** vía WebSocket sobre TLS (WSS)
- 🌍 **Alcance global** - Diseñado para funcionar en cualquier país
- 🛡️ **Resiliente** - Difícil de detectar y bloquear por firewalls
- ⚡ **Tiempo real** - Mensajes instantáneos con WebSockets
- 💾 **Historial** - Últimos 50 mensajes al conectarse
- 👥 **Múltiples usuarios** - Chat grupal en tiempo real
- 🎨 **Interfaz moderna** - Diseño responsivo y atractivo

## Arquitectura

```
┌─────────────┐     WSS/TLS      ┌──────────────┐
│   Cliente   │ ◄───────────────► │  Servidor    │
│  (Navegador)│     Puerto 443   │  (Node.js)   │
└─────────────┘                  └──────────────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
              Región 1              Región 2              Región 3
         (América)              (Europa)              (Asia)
```

## Instalación Local

### Requisitos
- Node.js v16 o superior
- npm o yarn

### Pasos

1. **Clonar el repositorio**
   ```bash
   git clone https://github.com/tu-usuario/resiliente-chat.git
   cd resiliente-chat
   ```

2. **Instalar dependencias**
   ```bash
   npm install
   ```

3. **Configurar variables de entorno**
   ```bash
   cp .env.example .env
   # Editar .env según tus necesidades
   ```

4. **Iniciar el servidor**
   ```bash
   npm start
   # O para desarrollo:
   npm run dev
   ```

5. **Abrir en el navegador**
   ```
   http://localhost:8080
   ```

## Despliegue con Docker

```bash
# Construir la imagen
docker build -t resiliente-chat .

# Ejecutar el contenedor
docker run -p 8080:8080 resiliente-chat
```

O con Docker Compose:
```bash
docker-compose up -d
```

## Despliegue en Producción

Para hacerlo realmente resistente a bloqueos:

1. **Usa un CDN** (Cloudflare, Fastly, Akamai) para distribuir globalmente
2. **Configura HTTPS** en el puerto 443 con certificados SSL válidos
3. **Usa múltiples dominios** que apunten al mismo servicio
4. **Habilita HTTP/3/QUIC** para mayor resistencia
5. **Configura failover automático** entre regiones

## Estructura del Proyecto

```
resiliente-chat/
├── server.js           # Servidor Node.js + WebSocket
├── package.json        # Dependencias y scripts
├── .env.example        # Ejemplo de variables de entorno
├── .gitignore          # Archivos ignorados por git
├── docker-compose.yml  # Orquestación con Docker
├── Dockerfile          # Imagen Docker
└── public/
    ├── index.html      # Interfaz del chat
    ├── css/
    │   └── style.css   # Estilos CSS
    └── js/
        └── app.js      # Lógica del cliente
```

## Seguridad y Privacidad

- Toda la comunicación viaja sobre WSS (WebSocket Secure)
- No se almacenan mensajes permanentemente (solo en memoria)
- Los IPs de los clientes no se expuestan públicamente
- Se recomienda agregar encriptación de extremo a extremo (E2EE) para mayor privacidad

## Limitaciones

⚠️ **Nota importante**: Esta aplicación está diseñada para ser resistente a bloqueos básicos, pero no garantiza anonimato completo contra censura avanzada o vigilancia estatal. Para requisitos de alta seguridad, considera:

- Usar Tor o servicios onion
- Encriptación de extremo a extremo (Signal Protocol, etc.)
- Infraestructura distribuida (IPFS, libp2p)
- Rotación frecuente de dominios e IPs

## Licencia

MIT License - Ver archivo LICENSE para más detalles.

## Contribuir

Las contribuciones son bienvenidas. Por favor abre un issue o pull request.