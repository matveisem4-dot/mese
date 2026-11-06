/**
 * ui.js — весь слой представления:
 *  - рендеринг пузырей сообщений (markdown-подобная разметка, XSS-safe)
 *  - рендеринг списка чатов, аватаров, счётчиков непрочитанных
 *  - индикатор «печатает…»
 *  - темы (dark/light) через data-theme на <html>
 *  - Web Notifications API
 *  - emoji-панель
 *  - call overlay (создаётся динамически)
 *  - helper'ы: formatTime, escapeHtml, автоскролл, авто-высота textarea
 */

/* ============================================================
   1. Утилиты
   ============================================================ */

/** Экранирование HTML — обязательно перед любой вставкой в innerHTML. */
export function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (s) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[s]));
}

/** Время ЧЧ:ММ для мета-строки пузыря. */
export function formatTime(ts = Date.now()) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Разметка: **bold**, *italic*, `code`, ссылки. Вызывать только на уже
 *  экранированном тексте — иначе XSS. */
function renderMarkdown(safeText) {
  return safeText
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
}

/** Первые буквы имени для аватара-заглушки. */
export function initialsFromName(name = '?') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Детерминированный цвет аватара по имени/ID. */
function avatarGradient(seed = '') {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `linear-gradient(135deg, hsl(${hue},65%,55%), hsl(${(hue + 40) % 360},65%,45%))`;
}

/* ============================================================
   2. Список чатов
   ============================================================ */

/**
 * @param {Array<{id, name, type, lastMessage?, unread?, updatedAt?}>} conversations
 * @param {string|null} activeId
 * @param {(id:string)=>void} onSelect
 */
export function renderChatList(conversations, activeId, onSelect) {
  const list = document.getElementById('chat-list');
  if (!list) return;
  const tpl = document.getElementById('chat-item-tpl');
  list.innerHTML = '';

  for (const c of conversations) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = c.id;

    const avatar = node.querySelector('.avatar');
    avatar.textContent = initialsFromName(c.name || c.id);
    avatar.style.background = avatarGradient(c.id);

    node.querySelector('.chat-name').textContent = c.name || c.id.slice(0, 10);
    node.querySelector('.chat-last').textContent = c.lastMessage || '';

    const badge = node.querySelector('.chat-badge');
    if (c.unread > 0) {
      badge.textContent = c.unread > 99 ? '99+' : String(c.unread);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    if (c.id === activeId) node.classList.add('active');

    node.addEventListener('click', () => onSelect(c.id));
    list.appendChild(node);
  }
}

/** Локально обновить счётчик непрочитанных, не перерисовывая весь список. */
export function incrementUnreadBadge(chatId) {
  const item = document.querySelector(`.chat-item[data-id="${CSS.escape(chatId)}"]`);
  if (!item) return;
  const badge = item.querySelector('.chat-badge');
  const cur = parseInt(badge.textContent || '0', 10) || 0;
  badge.textContent = String(Math.min(cur + 1, 99));
  badge.classList.remove('hidden');
}

/** Сбросить непрочитанные у конкретного чата. */
export function clearUnreadBadge(chatId) {
  const item = document.querySelector(`.chat-item[data-id="${CSS.escape(chatId)}"]`);
  if (!item) return;
  const badge = item.querySelector('.chat-badge');
  badge.textContent = '';
  badge.classList.add('hidden');
}

/* ============================================================
   3. Сообщения (пузыри)
   ============================================================ */

/**
 * Рендерит одно сообщение в контейнер сообщений.
 * @param {Object} msg
 *   { id, self, text, createdAt, status?, replyTo?, edited?, file? }
 * @param {HTMLElement} container  (#messages)
 * @param {Object} [opts]
 *   onReply?(msg), onEdit?(msg), onDelete?(msg)
 */
export function renderMessage(msg, container, opts = {}) {
  const el = document.createElement('div');
  el.className = `bubble ${msg.self ? 'outgoing' : 'incoming'}`;
  el.dataset.id = msg.id;

  // --- цитата ---
  let replyHtml = '';
  if (msg.replyTo) {
    replyHtml = `<blockquote>${escapeHtml(
      (msg.replyTo.author ? msg.replyTo.author + ': ' : '') +
        (msg.replyTo.text || '').slice(0, 200)
    )}</blockquote>`;
  }

  // --- вложение (файл/картинка) ---
  let fileHtml = '';
  if (msg.file) {
    const f = msg.file;
    const src = f.url || (f.blob ? URL.createObjectURL(f.blob) : '');
    if (f.mime?.startsWith('image/') && src) {
      fileHtml = `<div class="attachment">
        <img src="${src}" alt="${escapeHtml(f.name || '')}"
             style="max-width:260px;border-radius:8px;display:block" />
      </div>`;
    } else if (f.mime?.startsWith('audio/') && src) {
      fileHtml = `<div class="attachment"><audio controls src="${src}"></audio></div>`;
    } else if (f.mime?.startsWith('video/') && src) {
      fileHtml = `<div class="attachment">
        <video controls src="${src}" style="max-width:280px;border-radius:8px"></video>
      </div>`;
    } else if (src) {
      fileHtml = `<div class="attachment">
        <a href="${src}" download="${escapeHtml(f.name || 'file')}">
          📎 ${escapeHtml(f.name || 'файл')}
        </a>
      </div>`;
    }
  }

  // --- текст ---
  const safe = escapeHtml(msg.text || '');
  const html = renderMarkdown(safe);

  // --- статус ---
  const statusIcon = ({
    sending: '⏳',
    sent: '✓',
    delivered: '✓✓',
    read: '✓✓'
  })[msg.status] || '';

  const statusClass = msg.status === 'read' ? 'status read' : 'status';

  el.innerHTML = `
    ${replyHtml}
    ${fileHtml}
    <div class="text">${html}${msg.edited ? ' <span class="muted">(ред.)</span>' : ''}</div>
    <div class="meta">
      <span>${formatTime(msg.createdAt)}</span>
      ${msg.self ? `<span class="${statusClass}">${statusIcon}</span>` : ''}
    </div>
  `;

  // --- контекстное меню: ответ / редактировать / удалить ---
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const actions = [];
    if (opts.onReply) actions.push(['Ответить', () => opts.onReply(msg)]);
    if (msg.self && opts.onEdit) actions.push(['Редактировать', () => opts.onEdit(msg)]);
    if (msg.self && opts.onDelete) actions.push(['Удалить', () => opts.onDelete(msg)]);
    showContextMenu(e.clientX, e.clientY, actions);
  });

  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

/** Найти DOM-узел сообщения по id (для обновления статуса/текста). */
export function findMessageNode(id) {
  return document.querySelector(`.bubble[data-id="${CSS.escape(id)}"]`);
}

/** Обновить статус (✓ / ✓✓ / прочитано). */
export function updateMessageStatus(id, status) {
  const node = findMessageNode(id);
  if (!node) return;
  const st = node.querySelector('.status');
  if (!st) return;
  const icon = ({ sending: '⏳', sent: '✓', delivered: '✓✓', read: '✓✓' })[status] || '';
  st.textContent = icon;
  st.classList.toggle('read', status === 'read');
}

/** Обновить текст после редактирования. */
export function updateMessageText(id, newText) {
  const node = findMessageNode(id);
  if (!node) return;
  const safe = escapeHtml(newText);
  node.querySelector('.text').innerHTML =
    `${renderMarkdown(safe)} <span class="muted">(ред.)</span>`;
}

/** Удалить сообщение из DOM. */
export function removeMessage(id) {
  const node = findMessageNode(id);
  if (node) node.remove();
}

/** Полная перерисовка ленты сообщений (при смене чата). */
export function renderMessages(messages, container, opts) {
  container.innerHTML = '';
  for (const m of messages) renderMessage(m, container, opts);
  container.scrollTop = container.scrollHeight;
}

/* ============================================================
   4. Индикатор «печатает…»
   ============================================================ */

const typingTimers = new Map();

/** Показать «печатает…» на 3 секунды; повторный вызов продлевает. */
export function showTyping(peerId, displayName = '') {
  let bar = document.getElementById('typing-indicator');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'typing-indicator';
    bar.className = 'typing-indicator';
    document.getElementById('chat-panel')?.appendChild(bar);
  }
  bar.textContent = `${displayName || peerId.slice(0, 8)} печатает…`;
  bar.classList.remove('hidden');

  clearTimeout(typingTimers.get(peerId));
  typingTimers.set(peerId, setTimeout(() => {
    bar.classList.add('hidden');
    typingTimers.delete(peerId);
  }, 3000));
}

/* ============================================================
   5. Темы
   ============================================================ */

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('p2pmsg:theme', theme); } catch {}
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

export function initTheme() {
  let theme = 'dark';
  try { theme = localStorage.getItem('p2pmsg:theme') || 'dark'; } catch {}
  applyTheme(theme);
}

/* ============================================================
   6. Web Notifications
   ============================================================ */

export async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'default') {
    try { return await Notification.requestPermission(); } catch { return 'denied'; }
  }
  return Notification.permission;
}

export function notify(title, body, opts = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, {
      body,
      icon: opts.icon || './favicon.ico',
      tag: opts.tag,
      silent: opts.silent ?? false
    });
  } catch { /* некоторые браузеры требуют ServiceWorker */ }
}

/** Короткий звук «дзынь» через WebAudio — без внешних файлов. */
export function playIncomingBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  } catch { /* без звука, если политика браузера запрещает */ }
}

/* ============================================================
   7. Emoji-панель
   ============================================================ */

const EMOJIS = [
  '😀','😁','😂','🤣','😊','😍','😘','😎','🤔','😴',
  '😢','😭','😡','👍','👎','🙏','👏','💪','🔥','❤️',
  '💔','✨','🎉','🎁','☕','🍕','⚡','💯','✅','❌',
  '🚀','🌙','☀️','⭐','📎','📷','📞','💬','🔒','🔑'
];

export function toggleEmojiPanel(onPick) {
  let panel = document.getElementById('emoji-panel');
  if (panel) { panel.remove(); return; }

  panel = document.createElement('div');
  panel.id = 'emoji-panel';
  panel.className = 'emoji-panel';
  for (const e of EMOJIS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    b.addEventListener('click', () => { onPick(e); panel.remove(); });
    panel.appendChild(b);
  }

  const composer = document.getElementById('composer');
  composer?.appendChild(panel);

  const close = (ev) => {
    if (!panel.contains(ev.target) && ev.target.id !== 'emoji-btn') {
      panel.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

/* ============================================================
   8. Контекстное меню (для reply/edit/delete)
   ============================================================ */

function showContextMenu(x, y, actions) {
  document.querySelector('.ctx-menu')?.remove();
  if (!actions.length) return;

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.cssText = `
    position:fixed; left:${x}px; top:${y}px; z-index:200;
    background:var(--bg-elevated); color:var(--text);
    border-radius:8px; box-shadow:var(--shadow);
    padding:4px; min-width:160px; font-size:0.9em;
  `;
  for (const [label, fn] of actions) {
    const item = document.createElement('button');
    item.textContent = label;
    item.style.cssText = `
      display:block; width:100%; text-align:left;
      padding:8px 12px; border-radius:6px; background:transparent;
    `;
    item.onmouseenter = () => item.style.background = 'var(--bg-hover)';
    item.onmouseleave = () => item.style.background = 'transparent';
    item.onclick = () => { menu.remove(); fn(); };
    menu.appendChild(item);
  }
  document.body.appendChild(menu);

  const close = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

/* ============================================================
   9. Call overlay (динамический)
   ============================================================ */

/**
 * Создать (или вернуть существующий) оверлей звонка.
 * Возвращает { overlay, remoteVideo, localVideo, controls }.
 */
export function ensureCallOverlay() {
  let overlay = document.getElementById('call-overlay');
  if (overlay) {
    return {
      overlay,
      remoteVideo: overlay.querySelector('#remote-video'),
      localVideo: overlay.querySelector('#local-video'),
      toggleMicBtn: overlay.querySelector('#toggle-mic'),
      toggleCamBtn: overlay.querySelector('#toggle-cam'),
      hangupBtn: overlay.querySelector('#hangup')
    };
  }

  overlay = document.createElement('div');
  overlay.id = 'call-overlay';
  overlay.innerHTML = `
    <video id="remote-video" autoplay playsinline></video>
    <video id="local-video" autoplay playsinline muted></video>
    <div class="call-controls">
      <button id="toggle-mic" type="button" title="Микрофон">🎤</button>
      <button id="toggle-cam" type="button" title="Камера">📷</button>
      <button id="hangup" type="button" class="hangup" title="Завершить">📵</button>
    </div>
  `;
  document.body.appendChild(overlay);

  return {
    overlay,
    remoteVideo: overlay.querySelector('#remote-video'),
    localVideo: overlay.querySelector('#local-video'),
    toggleMicBtn: overlay.querySelector('#toggle-mic'),
    toggleCamBtn: overlay.querySelector('#toggle-cam'),
    hangupBtn: overlay.querySelector('#hangup')
  };
}

export function hideCallOverlay() {
  document.getElementById('call-overlay')?.remove();
}

/* ============================================================
   10. Автовысота textarea (для composer)
   ============================================================ */

export function autoGrow(textarea, maxHeight = 140) {
  const resize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
  };
  textarea.addEventListener('input', resize);
  resize();
}

/* ============================================================
   11. Переключение мобильного режима «список ↔ чат»
   ============================================================ */

export function openChatMobile() {
  document.getElementById('app')?.classList.add('chat-open');
}
export function closeChatMobile() {
  document.getElementById('app')?.classList.remove('chat-open');
}