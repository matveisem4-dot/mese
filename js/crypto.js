// ECDH (P-256) → deriveBits → HKDF → AES-256-GCM.
// Ключи никогда не покидают браузер; сигнальный сервер их не видит.

const ALGO = { name: 'ECDH', namedCurve: 'P-256' };
const AES = { name: 'AES-GCM', length: 256 };

export async function generateKeyPair() {
  return crypto.subtle.generateKey(ALGO, true, ['deriveKey', 'deriveBits']);
}

export async function exportPublicKey(keyPair) {
  return crypto.subtle.exportKey('raw', keyPair.publicKey);
}

export async function deriveSharedAesKey(privateKey, peerPublicKeyRaw) {
  const peerPublicKey = await crypto.subtle.importKey(
    'raw', peerPublicKeyRaw, ALGO, true, []
  );

  // 1. ECDH даёт общий секрет (bits)
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256
  );

  // 2. HKDF превращает биты в равномерный AES-ключ
  const hkdfKey = await crypto.subtle.importKey(
    'raw', sharedBits, 'HKDF', false, ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(16),          // можно передать случайную соль
      info: new TextEncoder().encode('p2p-messenger-v1')
    },
    hkdfKey,
    AES,
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptJson(aesKey, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    plaintext
  );
  return { iv: Array.from(iv), ct: arrayBufferToBase64(ciphertext) };
}

export async function decryptJson(aesKey, payload) {
  const iv = new Uint8Array(payload.iv);
  const ct = base64ToArrayBuffer(payload.ct);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    ct
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function arrayBufferToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}