FROM node:18-alpine

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias de producción
RUN npm ci --only=production

# Copiar código fuente
COPY server.js ./
COPY public/ ./public/

# Exponer puerto
EXPOSE 8080

# Comando de inicio
CMD ["node", "server.js"]