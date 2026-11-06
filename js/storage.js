const DB_NAME = 'p2p-messenger';
const DB_VERSION = 1;
let db;

export async function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('conversations')) {
        const conv = d.createObjectStore('conversations', { keyPath: 'id' });
        conv.createIndex('updatedAt', 'updatedAt');
      }
      if (!d.objectStoreNames.contains('messages')) {
        const msg = d.createObjectStore('messages', { keyPath: 'id' });
        msg.createIndex('conversationId', 'conversationId');
        msg.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

export async function saveMessage(msg) {
  const tx = db.transaction('messages', 'readwrite');
  tx.objectStore('messages').put(msg);
  return txDone(tx);
}

export async function getMessages(conversationId, limit = 200) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readonly');
    const idx = tx.objectStore('messages').index('conversationId');
    const req = idx.getAll(IDBKeyRange.only(conversationId));
    req.onsuccess = () => {
      const all = req.result.sort((a, b) => a.createdAt - b.createdAt);
      resolve(all.slice(-limit));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function upsertConversation(conv) {
  const tx = db.transaction('conversations', 'readwrite');
  tx.objectStore('conversations').put({ ...conv, updatedAt: Date.now() });
  return txDone(tx);
}

export async function getAllConversations() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('conversations', 'readonly');
    const req = tx.objectStore('conversations').getAll();
    req.onsuccess = () => resolve(
      req.result.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    );
    req.onerror = () => reject(req.error);
  });
}

export function saveSetting(key, value) {
  localStorage.setItem(`p2pmsg:${key}`, JSON.stringify(value));
}
export function loadSetting(key, fallback) {
  const raw = localStorage.getItem(`p2pmsg:${key}`);
  return raw ? JSON.parse(raw) : fallback;
}

function txDone(tx) {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}