/**
 * app.js — точка входа и контроллер приложения.
 *
 * Связывает:
 *  - peer-manager (PeerJS: DataChannel + MediaConnection)
 *  - crypto (E2E AES-GCM)
 *  - storage (IndexedDB + localStorage)
 *  - file-transfer (чанковая передача)
 *  - call-manager (аудио/видео)
 *  - ui (рендеринг, темы, уведомления)
 *
 * Никакого собственного бэкенда: всё общение — через DataChannel.
 */

import {
  openDb, saveMessage, getMessages, upsertConversation,
  getAllConversations, saveSetting, loadSetting
} from './storage.js';
import { initPeer, connectToPeer, connections, getPeer } from './peer-manager.js';
import { encryptJson, decryptJson } from './crypto.js';
import { sendFile, createFileReceiver } from './file-transfer.js';
import { startCall, answerCall, toggleMic, toggleCamera, endCall } from './call-manager.js';
import * as ui from './ui.js';

/* ============================================================
   1. Состояние
   ============================================================ */

const state = {
  myId: localStorage.getItem('p2pmsg:peerId') || crypto.randomUUID(),
  conversations: new Map(),        // id -> conversation
  activeChat: null,                // conversation object
  replyTo: null,                   // message object | null
  searchQuery: '',
  typingDebounce: null
};
localStorage.setItem('p2pmsg:peerId', state.myId);

let db = null;                     // открытая IndexedDB

/* ============================================================
   2. Точка входа
   ============================================================ */

async function main() {
  ui.initTheme();
  db = await openDb();
  await loadConversations();

  const { peer } = await initPeer(state.myId);

  // Подключаем входящие звонки
  peer.on('call', onIncomingCall);

  // Кнопка «+» (создать чат)
  document.getElementById('new-chat-btn').onclick = promptNewChat;

  // Тема
  document.getElementById('theme-toggle').onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    ui.applyTheme(next);
  };

  // Копирование peerId по клику
  const myIdEl = document.getElementById('my-peer-id');
  myIdEl.textContent = state.myId;
  myIdEl.title = 'Нажмите, чтобы скопировать';
  myIdEl.onclick = async () => {
    try {
      await navigator.clipboard.writeText(state.myId);
      const orig = myIdEl.textContent;
      myIdEl.textContent = 'Скопировано!';
      setTimeout(() => (myIdEl.textContent = orig), 1200);
    } catch { /* clipboard может быть недоступен */ }
  };

  // Поиск по чатам
  document.getElementById('chat-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value.toLowerCase().trim();
    renderChatList();
  });

  // Кнопки в шапке чата и composer
  document.getElementById('back-btn').onclick = () => {
    ui.closeChatMobile();
    state.activeChat = null;
    document.getElementById('chat-header').classList.add('hidden');
    document.getElementById('composer').classList.add('hidden');
    renderChatList();
  };
  document.getElementById('call-btn').onclick = startVideoCall;

  // Composer: emoji, attach, send, Enter
  document.getElementById('emoji-btn').onclick = () => {
    ui.toggleEmojiPanel((emoji) => {
      const ta = document.getElementById('message-input');
      ta.value += emoji;
      ta.focus();
    });
  };
  document.getElementById('attach-btn').onclick = () => {
    document.getElementById('file-input').click();
  };
  document.getElementById('file-input').addEventListener('change', onFilePicked);

  const ta = document.getElementById('message-input');
  ui.autoGrow(ta);
  ta.addEventListener('input', onTypingInput);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSendClick();
    }
  });
  document.getElementById('send-btn').onclick = onSendClick;

  // Уведомления
  await ui.requestNotificationPermission();

  // Рендер списка
  renderChatList();

  // Автоподключение, если в URL ?peer=<id>
  const autoPeer = new URLSearchParams(location.search).get('peer');
  if (autoPeer && autoPeer !== state.myId) {
    setTimeout(() => tryAutoConnect(autoPeer.trim()), 600);
  }
}

/* ============================================================
   3. Загрузка / рендер чатов
   ============================================================ */

async function loadConversations() {
  const arr = await getAllConversations();
  for (const c of arr) state.conversations.set(c.id, c);
}

function sortedConversations() {
  return Array.from(state.conversations.values()).sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
  );
}

function renderChatList() {
  let list = sortedConversations();
  if (state.searchQuery) {
    list = list.filter(c =>
      (c.name || '').toLowerCase().includes(state.searchQuery) ||
      c.id.toLowerCase().includes(state.searchQuery)
    );
  }
  ui.renderChatList(list, state.activeChat?.id || null, selectChat);
}

async function ensureConversation(peerId) {
  const existing = state.conversations.get(peerId);
  if (existing) return existing;

  const conv = {
    id: peerId,
    name: peerId.slice(0, 12),
    type: 'dm',
    peers: [peerId],
    lastMessage: '',
    unread: 0,
    updatedAt: Date.now()
  };
  state.conversations.set(peerId, conv);
  await upsertConversation(conv);
  return conv;
}

/* ============================================================
   4. Выбор чата / создание
   ============================================================ */

async function selectChat(chatId) {
  const conv = state.conversations.get(chatId);
  if (!conv) return;

  // Если это DM и соединения нет — попробуем установить
  if (conv.type === 'dm' && !connections.has(chatId)) {
    try {
      const entry = await connectToPeer(chatId);
      registerConnection(chatId, entry);
    } catch (e) {
      console.warn('Не удалось подключиться к', chatId, e);
    }
  }

  state.activeChat = conv;
  state.replyTo = null;
  conv.unread = 0;
  await upsertConversation(conv);
  ui.clearUnreadBadge(chatId);

  // Заголовок и composer
  document.getElementById('chat-title').textContent = conv.name || chatId.slice(0, 12);
  document.getElementById('chat-status').textContent =
    connections.has(chatId) ? 'в сети' : '';
  document.getElementById('chat-header').classList.remove('hidden');
  document.getElementById('composer').classList.remove('hidden');

  // Лента
  const messages = await getMessages(chatId);
  const container = document.getElementById('messages');
  ui.renderMessages(messages, container, {
    onReply: (m) => {
      state.replyTo = m;
      document.getElementById('message-input').focus();
    },
    onEdit: handleLocalEdit,
    onDelete: handleLocalDelete
  });

  // Отправить read-квитанции за все входящие
  if (conv.type === 'dm') {
    for (const m of messages) {
      if (!m.self && m.status !== 'read') {
        sendStatusUpdate(chatId, m.id, 'read');
        m.status = 'read';
        await saveMessage(m);
      }
    }
  }

  ui.openChatMobile();
  renderChatList();
}

async function promptNewChat() {
  const input = prompt(
    'Введите Peer ID собеседника\n(или "group:roomId:id1,id2" для группы):'
  );
  if (!input) return;
  const value = input.trim();

  if (value.startsWith('group:')) {
    return createGroupChat(value.slice(6));
  }

  if (value === state.myId) {
    alert('Это ваш собственный Peer ID.');
    return;
  }

  try {
    const entry = await connectToPeer(value);
    registerConnection(value, entry);
    const conv = await ensureConversation(value);
    await selectChat(conv.id);
  } catch (e) {
    alert('Не удалось подключиться: ' + e.message);
  }
}

async function tryAutoConnect(peerId) {
  if (connections.has(peerId)) return;
  try {
    const entry = await connectToPeer(peerId);
    registerConnection(peerId, entry);
    await ensureConversation(peerId);
    renderChatList();
  } catch (e) {
    console.warn('Auto-connect failed:', e);
  }
}

async function createGroupChat(payload) {
  // payload: "roomId:peer1,peer2"
  const [roomId, peersStr] = payload.split(':');
  if (!roomId || !peersStr) {
    alert('Формат: group:roomId:peer1,peer2');
    return;
  }
  const peerIds = peersStr.split(',').map(s => s.trim()).filter(Boolean);
  if (peerIds.length === 0) return;

  const conv = {
    id: roomId,
    name: roomId,
    type: 'group',
    peers: peerIds,
    lastMessage: '',
    unread: 0,
    updatedAt: Date.now()
  };
  state.conversations.set(roomId, conv);
  await upsertConversation(conv);

  for (const pid of peerIds) {
    try {
      const entry = await connectToPeer(pid);
      registerConnection(pid, entry);
    } catch (e) {
      console.warn('Не удалось подключиться к участнику', pid, e);
    }
  }
  await selectChat(roomId);
}

/* ============================================================
   5. Регистрация соединения
   ============================================================ */

function registerConnection(peerId, entry) {
  if (!entry || !entry.conn) return;
  const { conn } = entry;

  // Индивидуальный приёмник файлов для этого соединения
  const fileReceiver = createFileReceiver(async (fileInfo) => {
    await handleIncomingFile(peerId, fileInfo);
  });

  conn.on('data', (raw) => handleIncomingData(peerId, raw, fileReceiver));

  conn.on('close', () => {
    // Обновим статус в шапке, если это активный чат
    if (state.activeChat?.id === peerId) {
      document.getElementById('chat-status').textContent = '';
    }
  });

  conn.on('error', (err) => console.error(`[${peerId}] connection error:`, err));

  // Обновим шапку, если это активный чат
  if (state.activeChat?.id === peerId) {
    document.getElementById('chat-status').textContent = 'в сети';
  }
}

async function handleIncomingData(peerId, raw, fileReceiver) {
  // --- файлы ---
  if (raw.type === 'file-meta' || raw.type === 'file-chunk' || raw.type === 'file-end') {
    fileReceiver(raw);
    return;
  }

  // --- «печатает…» ---
  if (raw.type === 'typing') {
    if (raw.active) {
      const conv = state.conversations.get(peerId);
      ui.showTyping(peerId, conv?.name || peerId.slice(0, 8));
    }
    return;
  }

  // --- статусы (delivered / read) ---
  if (raw.type === 'status') {
    ui.updateMessageStatus(raw.messageId, raw.status);
    await patchMessageInDb(raw.messageId, { status: raw.status });
    return;
  }

  // --- зашифрованные полезные нагрузки ---
  if (raw.iv && raw.ct) {
    const entry = connections.get(peerId);
    if (!entry) return;
    let data;
    try {
      data = await decryptJson(entry.aesKey, raw);
    } catch (e) {
      console.error('Decrypt failed:', e);
      return;
    }

    if (data.type === 'edit') return handleRemoteEdit(peerId, data);
    if (data.type === 'delete') return handleRemoteDelete(peerId, data);
    return handleIncomingMessage(peerId, data);
  }
}

/* ============================================================
   6. Приём / отправка сообщений
   ============================================================ */

async function handleIncomingMessage(peerId, data) {
  // Определяем беседу: DM — peerId, группа — из data.conversationId
  const conversationId = data.conversationId || peerId;

  const msg = {
    id: data.id || crypto.randomUUID(),
    conversationId,
    self: false,
    senderId: peerId,
    text: data.text || '',
    createdAt: data.createdAt || Date.now(),
    status: 'delivered',
    replyTo: data.replyTo || null,
    edited: false,
    file: null
  };

  await saveMessage(msg);

  // Убедимся, что беседа существует (для DM)
  if (conversationId === peerId) {
    await ensureConversation(peerId);
  }

  // Обновляем метаданные беседы
  const conv = state.conversations.get(conversationId);
  if (conv) {
    conv.lastMessage = msg.text.slice(0, 100);
    conv.updatedAt = Date.now();
    await upsertConversation(conv);
  }

  // Отображение
  if (state.activeChat?.id === conversationId) {
    ui.renderMessage(msg, document.getElementById('messages'), {
      onReply: (m) => (state.replyTo = m),
      onEdit: handleLocalEdit,
      onDelete: handleLocalDelete
    });
    // Сразу отмечаем прочитанным
    if (conversationId === peerId) sendStatusUpdate(peerId, msg.id, 'read');
  } else {
    conv && (conv.unread = (conv.unread || 0) + 1);
    if (conv) await upsertConversation(conv);
    ui.incrementUnreadBadge(conversationId);
    ui.notify(conv?.name || peerId.slice(0, 12), msg.text.slice(0, 80));
    ui.playIncomingBeep();
    if (conversationId === peerId) sendStatusUpdate(peerId, msg.id, 'delivered');
  }

  renderChatList();
}

async function onSendClick() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text) return;

  await sendTextMessage(text);
  input.value = '';
  input.style.height = 'auto';
}

async function sendTextMessage(text) {
  const chat = state.activeChat;
  if (!chat) return;

  const id = crypto.randomUUID();
  const msg = {
    id,
    conversationId: chat.id,
    self: true,
    senderId: state.myId,
    text,
    createdAt: Date.now(),
    status: 'sending',
    replyTo: state.replyTo
      ? { id: state.replyTo.id, text: state.replyTo.text, author: state.replyTo.senderId }
      : null,
    edited: false,
    file: null
  };

  await saveMessage(msg);

  // Отрисовка
  if (state.activeChat?.id === chat.id) {
    ui.renderMessage(msg, document.getElementById('messages'), {
      onReply: (m) => (state.replyTo = m),
      onEdit: handleLocalEdit,
      onDelete: handleLocalDelete
    });
  }

  // Метаданные беседы
  chat.lastMessage = text.slice(0, 100);
  chat.updatedAt = Date.now();
  await upsertConversation(chat);

  // Формируем payload
  const payload = {
    id,
    text,
    createdAt: msg.createdAt,
    replyTo: msg.replyTo,
    conversationId: chat.type === 'group' ? chat.id : undefined
  };

  // Отправляем всем адресатам
  const peerIds = chat.type === 'group' ? chat.peers : [chat.id];
  let sentToAny = false;
  for (const pid of peerIds) {
    const entry = connections.get(pid);
    if (!entry) continue;
    try {
      const encrypted = await encryptJson(entry.aesKey, payload);
      entry.conn.send(encrypted);
      sentToAny = true;
    } catch (e) {
      console.error(`Send to ${pid} failed:`, e);
    }
  }

  // Статус «отправлено», если хоть один канал принял
  msg.status = sentToAny ? 'sent' : 'error';
  await patchMessageInDb(id, { status: msg.status });
  ui.updateMessageStatus(id, msg.status);

  state.replyTo = null;
  renderChatList();
}

/* ============================================================
   7. Редактирование / удаление
   ============================================================ */

async function handleLocalEdit(msg) {
  const next = prompt('Изменить сообщение:', msg.text);
  if (next === null || next.trim() === '' || next === msg.text) return;

  await patchMessageInDb(msg.id, { text: next, edited: true });
  ui.updateMessageText(msg.id, next);

  const entry = connections.get(msg.conversationId);
  if (!entry) return;
  const payload = { type: 'edit', messageId: msg.id, text: next };
  const enc = await encryptJson(entry.aesKey, payload);
  entry.conn.send(enc);
}

async function handleRemoteEdit(peerId, data) {
  await patchMessageInDb(data.messageId, { text: data.text, edited: true });
  ui.updateMessageText(data.messageId, data.text);
}

async function handleLocalDelete(msg) {
  if (!confirm('Удалить сообщение?')) return;
  await deleteMessageInDb(msg.id);
  ui.removeMessage(msg.id);

  const entry = connections.get(msg.conversationId);
  if (!entry) return;
  const payload = { type: 'delete', messageId: msg.id };
  const enc = await encryptJson(entry.aesKey, payload);
  entry.conn.send(enc);
}

async function handleRemoteDelete(peerId, data) {
  await deleteMessageInDb(data.messageId);
  ui.removeMessage(data.messageId);
}

/* ============================================================
   8. Файлы
   ============================================================ */

async function onFilePicked(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!state.activeChat) return;
  for (const file of files) await sendFileAsMessage(file);
}

async function sendFileAsMessage(file) {
  const chat = state.activeChat;
  const id = crypto.randomUUID();
  const msg = {
    id,
    conversationId: chat.id,
    self: true,
    senderId: state.myId,
    text: '',
    createdAt: Date.now(),
    status: 'sending',
    replyTo: null,
    edited: false,
    file: {
      name: file.name,
      mime: file.type,
      size: file.size,
      blob: file
    }
  };

  await saveMessage(msg);
  ui.renderMessage(msg, document.getElementById('messages'));
  if (state.activeChat?.id === chat.id) {
    ui.renderMessage(msg, document.getElementById('messages'));
  }

  // Отправляем каждому пиру в беседе
  const peerIds = chat.type === 'group' ? chat.peers : [chat.id];
  let sentToAny = false;
  for (const pid of peerIds) {
    const entry = connections.get(pid);
    if (!entry) continue;
    try {
      await sendFile(entry.conn, file, () => {
        /* при желании — обновлять прогресс-бар */
      });
      sentToAny = true;
    } catch (e) {
      console.error(`File send to ${pid} failed:`, e);
    }
  }

  msg.status = sentToAny ? 'sent' : 'error';
  await patchMessageInDb(id, { status: msg.status });
  ui.updateMessageStatus(id, msg.status);
}

async function handleIncomingFile(peerId, fileInfo) {
  // Определяем беседу
  let conversationId = peerId;
  for (const [id, conv] of state.conversations) {
    if (conv.type === 'group' && conv.peers?.includes(peerId)) {
      conversationId = id;
      break;
    }
  }

  const msg = {
    id: crypto.randomUUID(),
    conversationId,
    self: false,
    senderId: peerId,
    text: '',
    createdAt: Date.now(),
    status: 'delivered',
    replyTo: null,
    edited: false,
    file: {
      name: fileInfo.name,
      mime: fileInfo.mime,
      size: fileInfo.size,
      blob: fileInfo.blob
    }
  };

  await saveMessage(msg);

  if (state.activeChat?.id === conversationId) {
    ui.renderMessage(msg, document.getElementById('messages'));
  } else {
    const conv = state.conversations.get(conversationId);
    if (conv) {
      conv.unread = (conv.unread || 0) + 1;
      await upsertConversation(conv);
    }
    ui.incrementUnreadBadge(conversationId);
    ui.notify(conv?.name || peerId.slice(0, 12), `📎 ${fileInfo.name || 'файл'}`);
  }

  renderChatList();
}

/* ============================================================
   9. Индикатор «печатает…» (отправка)
   ============================================================ */

function onTypingInput() {
  const chat = state.activeChat;
  if (!chat) return;

  const peerIds = chat.type === 'group' ? chat.peers : [chat.id];
  const active = true;
  for (const pid of peerIds) {
    const entry = connections.get(pid);
    if (entry) try { entry.conn.send({ type: 'typing', active }); } catch {}
  }

  clearTimeout(state.typingDebounce);
  state.typingDebounce = setTimeout(() => {
    for (const pid of peerIds) {
      const entry = connections.get(pid);
      if (entry) try { entry.conn.send({ type: 'typing', active: false }); } catch {}
    }
  }, 2000);
}

/* ============================================================
   10. Read / delivered
   ============================================================ */

function sendStatusUpdate(peerId, messageId, status) {
  const entry = connections.get(peerId);
  if (!entry) return;
  try {
    entry.conn.send({ type: 'status', messageId, status });
  } catch (e) {
    console.error('Status send failed:', e);
  }
}

/* ============================================================
   11. Звонки
   ============================================================ */

async function startVideoCall() {
  const chat = state.activeChat;
  if (!chat || chat.type !== 'dm') {
    alert('Звонки доступны только в личных чатах.');
    return;
  }

  const uiRefs = ui.ensureCallOverlay();

  try {
    const { call, localStream } = await startCall(chat.id, true);
    uiRefs.localVideo.srcObject = localStream;

    call.on('stream', (stream) => { uiRefs.remoteVideo.srcObject = stream; });
    call.on('close', () => { endCall(); ui.hideCallOverlay(); });

    uiRefs.hangupBtn.onclick = () => { endCall(); ui.hideCallOverlay(); };
    uiRefs.toggleMicBtn.onclick = () => {
      const enabled = !uiRefs.toggleMicBtn.classList.contains('active');
      toggleMic(enabled);
      uiRefs.toggleMicBtn.classList.toggle('active', enabled);
    };
    uiRefs.toggleCamBtn.onclick = () => {
      const enabled = !uiRefs.toggleCamBtn.classList.contains('active');
      toggleCamera(enabled);
      uiRefs.toggleCamBtn.classList.toggle('active', enabled);
    };
  } catch (e) {
    alert('Не удалось начать звонок: ' + e.message);
    ui.hideCallOverlay();
  }
}

async function onIncomingCall(call) {
  if (!confirm(`Входящий звонок от ${call.peer}. Принять?`)) {
    try { call.close(); } catch {}
    return;
  }

  const uiRefs = ui.ensureCallOverlay();
  try {
    const { localStream } = await answerCall(call, true);
    uiRefs.localVideo.srcObject = localStream;

    call.on('stream', (stream) => { uiRefs.remoteVideo.srcObject = stream; });
    call.on('close', () => { endCall(); ui.hideCallOverlay(); });

    uiRefs.hangupBtn.onclick = () => { endCall(); ui.hideCallOverlay(); };
    uiRefs.toggleMicBtn.onclick = () => {
      const enabled = !uiRefs.toggleMicBtn.classList.contains('active');
      toggleMic(enabled);
      uiRefs.toggleMicBtn.classList.toggle('active', enabled);
    };
    uiRefs.toggleCamBtn.onclick = () => {
      const enabled = !uiRefs.toggleCamBtn.classList.contains('active');
      toggleCamera(enabled);
      uiRefs.toggleCamBtn.classList.toggle('active', enabled);
    };
  } catch (e) {
    alert('Не удалось принять звонок: ' + e.message);
    ui.hideCallOverlay();
  }
}

/* ============================================================
   12. Хелперы для IndexedDB (точечные апдейты)
   ============================================================ */

function patchMessageInDb(id, patch) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    const store = tx.objectStore('messages');
    const req = store.get(id);
    req.onsuccess = () => {
      const existing = req.result;
      if (existing) store.put({ ...existing, ...patch });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function deleteMessageInDb(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    tx.objectStore('messages').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ============================================================
   13. Погнали
   ============================================================ */

main().catch((err) => {
  console.error('Fatal:', err);
  alert('Ошибка запуска: ' + err.message);
});