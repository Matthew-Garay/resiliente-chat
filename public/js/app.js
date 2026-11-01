/**
 * Resiliente Chat - Cliente WebSocket
 * Lógica del frontend para el chat en tiempo real
 */

const WS_URL = window.location.protocol === 'https:' 
  ? `wss://${window.location.host}/ws` 
  : `ws://${window.location.host}/ws`;

let ws = null;
let currentUsername = `Usuario_${Math.floor(Math.random() * 10000)}`;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const usernameInput = document.getElementById('username-input');
const setUsernameBtn = document.getElementById('set-username-btn');
const messagesList = document.getElementById('messages-list');
const connectionStatus = document.getElementById('connection-status');
const statusDot = document.querySelector('.status-dot');

function connect() {
  try {
    ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
      console.log('Conectado al servidor WebSocket');
      connectionStatus.textContent = 'Conectado';
      connectionStatus.classList.add('connected');
      statusDot.classList.add('connected');
      reconnectAttempts = 0;
      
      const savedName = localStorage.getItem('resiliente_username');
      if (savedName) {
        currentUsername = savedName;
        usernameInput.value = savedName;
        sendUsernameToServer();
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch (error) {
        console.error('Error parseando mensaje:', error);
      }
    };

    ws.onclose = () => {
      console.log('Desconectado del servidor');
      connectionStatus.textContent = 'Desconectado';
      connectionStatus.classList.remove('connected');
      statusDot.classList.remove('connected');
      attemptReconnect();
    };

    ws.onerror = (error) => {
      console.error('Error WebSocket:', error);
    };
  } catch (error) {
    console.error('Error creando conexión:', error);
    attemptReconnect();
  }
}

function attemptReconnect() {
  if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts++;
    connectionStatus.textContent = `Reconectando (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`;
    setTimeout(connect, 2000 * reconnectAttempts);
  } else {
    connectionStatus.textContent = 'Conexión fallida';
  }
}

function handleMessage(data) {
  switch (data.type) {
    case 'history':
      renderHistory(data.messages);
      break;
    case 'chat_message':
      addMessage(data);
      break;
    case 'system':
      addSystemMessage(data);
      break;
    case 'typing':
      showTypingIndicator(data);
      break;
    case 'error':
      showError(data.message);
      break;
    default:
      console.log('Mensaje desconocido:', data);
  }
}

function renderHistory(messages) {
  messages.forEach(msg => {
    if (msg.type === 'chat_message') addMessage(msg, false);
    else if (msg.type === 'system') addSystemMessage(msg, false);
  });
  scrollToBottom();
}

function addMessage(data, scroll = true) {
  const messageEl = document.createElement('div');
  const isOwn = data.username === currentUsername;
  messageEl.className = `message ${isOwn ? 'own' : 'other'}`;
  const time = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  messageEl.innerHTML = `
    <div class="message-header">
      <span class="message-username" style="color: ${data.color}">${escapeHtml(data.username)}</span>
      <span class="message-timestamp">${time}</span>
    </div>
    <div class="message-content">${escapeHtml(data.message)}</div>
  `;
  messagesList.appendChild(messageEl);
  if (scroll) scrollToBottom();
}

function addSystemMessage(data, scroll = true) {
  const messageEl = document.createElement('div');
  messageEl.className = 'message system';
  const time = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  messageEl.innerHTML = `
    <div class="message-header">
      <span class="message-timestamp">${time}</span>
    </div>
    <div class="message-content">${escapeHtml(data.message)}</div>
  `;
  messagesList.appendChild(messageEl);
  if (scroll) scrollToBottom();
}

let typingTimeout;
function showTypingIndicator(data) {
  const existing = document.querySelector('.typing-indicator');
  if (existing) existing.remove();
  if (data.isTyping && data.username !== currentUsername) {
    const typingEl = document.createElement('div');
    typingEl.className = 'message typing-indicator';
    typingEl.textContent = `${data.username} está escribiendo...`;
    messagesList.appendChild(typingEl);
    scrollToBottom();
    typingTimeout = setTimeout(() => { typingEl.remove(); }, 2000);
  }
}

function sendUsernameToServer() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'set_username', username: currentUsername }));
  }
}

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'chat_message', message: text }));
  messageInput.value = '';
  messageInput.focus();
}

function changeUsername() {
  const newName = usernameInput.value.trim();
  if (!newName) return;
  currentUsername = newName;
  localStorage.setItem('resiliente_username', newName);
  sendUsernameToServer();
  const originalBtnText = setUsernameBtn.textContent;
  setUsernameBtn.textContent = '✓ Cambiado';
  setTimeout(() => { setUsernameBtn.textContent = originalBtnText; }, 1000);
}

function showError(message) {
  const errorEl = document.createElement('div');
  errorEl.className = 'message system';
  errorEl.style.color = '#ef4444';
  errorEl.textContent = `⚠️ ${message}`;
  messagesList.appendChild(errorEl);
  scrollToBottom();
}

function scrollToBottom() { messagesList.scrollTop = messagesList.scrollHeight; }

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendMessage();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'typing', isTyping: true }));
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'typing', isTyping: false }));
      }
    }, 1000);
  }
});
setUsernameBtn.addEventListener('click', changeUsername);
usernameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') changeUsername(); });

connect();

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && ws && ws.readyState === WebSocket.CLOSED) connect();
});