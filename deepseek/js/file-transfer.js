const CHUNK_SIZE = 16 * 1024; // 16 KiB — безопасно для SCTP DataChannel

/**
 * Отправка файла через DataConnection с прогрессом.
 * Протокол: { type:'file-meta', id, name, mime, size, chunks }
 *           { type:'file-chunk', id, index, data: ArrayBuffer }
 *           { type:'file-end', id }
 */
export async function sendFile(conn, file, onProgress) {
  const id = crypto.randomUUID();
  const total = Math.ceil(file.size / CHUNK_SIZE);
  conn.send({
    type: 'file-meta',
    id,
    name: file.name,
    mime: file.type,
    size: file.size,
    chunks: total
  });

  for (let i = 0; i < total; i++) {
    const start = i * CHUNK_SIZE;
    const blob = file.slice(start, start + CHUNK_SIZE);
    const buffer = await blob.arrayBuffer();
    conn.send({ type: 'file-chunk', id, index: i, data: buffer });
    if (onProgress) onProgress((i + 1) / total);
    // Небольшая пауза, чтобы не переполнить буфер DataChannel
    if (i % 32 === 31) await new Promise(r => setTimeout(r, 0));
  }
  conn.send({ type: 'file-end', id });
}

/**
 * Приёмник накапливает чанки и собирает Blob.
 */
export function createFileReceiver(onFileReady) {
  const incoming = new Map(); // id -> { meta, chunks: [], received }

  return (data) => {
    if (data.type === 'file-meta') {
      incoming.set(data.id, {
        meta: data,
        chunks: new Array(data.chunks),
        received: 0
      });
    } else if (data.type === 'file-chunk') {
      const entry = incoming.get(data.id);
      if (!entry) return;
      entry.chunks[data.index] = data.data;
      entry.received++;
      // Можно обновлять прогресс-бар
    } else if (data.type === 'file-end') {
      const entry = incoming.get(data.id);
      if (!entry) return;
      const blob = new Blob(entry.chunks, { type: entry.meta.mime });
      onFileReady({ ...entry.meta, blob });
      incoming.delete(data.id);
    }
  };
}