import {
  generateKeyPair, exportPublicKey, deriveSharedAesKey
} from './crypto.js';

// Хранилище активных DataConnection по peerId
export const connections = new Map(); // peerId -> { conn, aesKey, publicKeyRaw }

let peer;
let myKeyPair;

export async function initPeer(myId) {
  myKeyPair = await generateKeyPair();

  // PeerJS Cloud: сигнализация через облако PeerJS, собственный сервер не нужен[reference:3]
  peer = new Peer(myId, {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // Для симметричного NAT: бесплатный OpenRelay (см. раздел 7)
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ]
    }
  });

  peer.on('connection', (conn) => setupConnection(conn));
  peer.on('error', (err) => console.error('Peer error:', err));

  return new Promise((resolve) => {
    peer.on('open', (id) => resolve({ peer, id }));
  });
}

/**
 * Инициатор соединения.
 */
export async function connectToPeer(remotePeerId) {
  if (connections.has(remotePeerId)) return connections.get(remotePeerId);
  const conn = peer.connect(remotePeerId, { reliable: true });
  return setupConnection(conn);
}

async function setupConnection(conn) {
  const remotePeerId = conn.peer;

  return new Promise((resolve) => {
    conn.on('open', async () => {
      // 1. Отправляем свой публичный ECDH-ключ
      const myPub = await exportPublicKey(myKeyPair);
      conn.send({ type: 'pubkey', pub: Array.from(new Uint8Array(myPub)) });

      // 2. Ждём ключ собеседника и выводим AES-ключ
      const onPubKey = async (data) => {
        if (data.type === 'pubkey') {
          conn.off('data', onPubKey);
          const peerPub = new Uint8Array(data.pub).buffer;
          const aesKey = await deriveSharedAesKey(myKeyPair.privateKey, peerPub);
          const entry = { conn, aesKey, publicKeyRaw: data.pub };
          connections.set(remotePeerId, entry);
          resolve(entry);
        }
      };
      conn.on('data', onPubKey);
    });

    conn.on('close', () => {
      connections.delete(remotePeerId);
    });
  });
}

/**
 * Групповой чат: mesh-соединение.
 * Для простоты группа задаётся roomId; участники должны знать peerId друг друга.
 * В реальном приложении список участников можно получать через сигнальный слой,
 * но здесь для примера каждый участник вручную подключается к остальным.
 */
export async function joinGroup(roomId, peerIds) {
  const results = await Promise.allSettled(
    peerIds.map((pid) => connectToPeer(pid))
  );
  return results.filter(r => r.status === 'fulfilled').map(r => r.value);
}

export function getPeer() { return peer; }