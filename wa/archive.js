// Rolling archive for chats the user has NOT marked.
//
// Two local files, two jobs:
//   archive.db  - every message of every unmarked chat, kept for `retentionDays` (default 30), then deleted.
//                 No summaries, no transcripts: only the message itself plus a small "download ticket" so a voice
//                 note or image can still be fetched later. Chats with the "keep images" option on also get the image
//                 FILE stored (under mediaDir); it is deleted together with its row.
//   the work DB - chats the user marked: kept for good, with summaries (that is the engine's own database).
//
// Why an archive at all: WhatsApp sends the old history only once, when the phone is linked. When the user marks a
// chat later, the last 24 hours are copied from here into the work DB (see promote()).
//
// The module does not know which SQLite library is used: it gets an already opened handle with run/all/exec.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_RETENTION_DAYS = 30;

const safe = (s) => String(s).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);

const COLUMNS = ['id', 'chat_id', 'sender_id', 'sender_name', 'content', 'type', 'timestamp', 'from_me', 'is_group', 'has_media', 'mimetype', 'media_ref'];

export function createArchive({ db, mediaDir = null, retentionDays = DEFAULT_RETENTION_DAYS, now = () => Math.floor(Date.now() / 1000), log = () => {} }) {
  let chain = Promise.resolve(); // one write at a time, in order (a transaction must not be interleaved)
  const queued = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
  const cutoff = () => now() - retentionDays * 86400;
  const fileOf = (row) => (mediaDir && row?.media_path ? path.join(mediaDir, row.media_path) : null);
  const unlink = (rows) => { for (const r of rows) { const f = fileOf(r); if (f) fs.rm(f, { force: true }, () => {}); } };

  const toRow = (m, mediaRef) => [
    m.id, m.chat_id, m.sender_id || null, m.sender_name || null, m.content ?? '', m.type || 'other', Number(m.timestamp) || 0,
    m.from_me ? 1 : 0, m.is_group ? 1 : 0, m.has_media ? 1 : 0, m.mimetype || null, mediaRef || null,
  ];
  const INSERT = `INSERT OR IGNORE INTO archive (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`;

  const ready = (async () => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS archive (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        content TEXT,
        type TEXT,
        timestamp INTEGER NOT NULL,
        from_me INTEGER DEFAULT 0,
        is_group INTEGER DEFAULT 0,
        has_media INTEGER DEFAULT 0,
        mimetype TEXT,
        media_ref TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_archive_chat_ts ON archive(chat_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_archive_ts ON archive(timestamp);
    `);
    const cols = await db.all('PRAGMA table_info(archive)');
    if (!cols.some((c) => c.name === 'media_path')) await db.exec('ALTER TABLE archive ADD COLUMN media_path TEXT;'); // archives made before image storage existed
  })();

  return {
    retentionDays,

    /** Store one message. Messages older than the retention window are not kept at all. Returns true when stored. */
    save: (m, mediaRef = null) => queued(async () => {
      await ready;
      if (!m?.id || !m.chat_id || (Number(m.timestamp) || 0) < cutoff()) return false;
      return (await db.run(INSERT, toRow(m, mediaRef))).changes > 0;
    }),

    /** Store many in one transaction (a history batch). items: [{ msg, mediaRef }]. Returns how many were new. */
    saveMany: (items) => queued(async () => {
      await ready;
      const min = cutoff();
      let added = 0;
      await db.exec('BEGIN');
      try {
        for (const { msg, mediaRef } of items) {
          if (!msg?.id || !msg.chat_id || (Number(msg.timestamp) || 0) < min) continue;
          added += (await db.run(INSERT, toRow(msg, mediaRef))).changes;
        }
        await db.exec('COMMIT');
      } catch (e) {
        await db.exec('ROLLBACK').catch(() => {});
        throw e;
      }
      return added;
    }),

    /** The sender deleted it for everyone: it must not linger here either. */
    remove: (id) => queued(async () => {
      await ready;
      unlink(await db.all('SELECT media_path FROM archive WHERE id = ? AND media_path IS NOT NULL', [id]));
      return (await db.run('DELETE FROM archive WHERE id = ?', [id])).changes;
    }),

    /** Store the image file of an archived message (only for chats with "keep images" on). Returns the stored path or null. */
    attachFile: (row, buffer, ext = 'jpg') => queued(async () => {
      await ready;
      if (!mediaDir || !buffer?.length) return null;
      const rel = path.join(safe(row.chat_id), `${safe(row.id)}.${safe(ext)}`);
      if ((await db.get('SELECT 1 AS x FROM archive WHERE id = ?', [row.id])) === undefined) return null; // the message itself was not kept (too old / deleted meanwhile)
      await fs.promises.mkdir(path.dirname(path.join(mediaDir, rel)), { recursive: true });
      await fs.promises.writeFile(path.join(mediaDir, rel), buffer);
      await db.run('UPDATE archive SET media_path = ? WHERE id = ?', [rel, row.id]);
      return rel;
    }),
    fileOf,

    /** Messages of one chat since a time, oldest first. */
    recent: async (chat_id, sinceTs) => { await ready; return db.all('SELECT * FROM archive WHERE chat_id = ? AND timestamp >= ? ORDER BY timestamp ASC', [chat_id, sinceTs]); },

    /** Delete everything past the retention window. Returns the number of deleted messages. */
    purge: () => queued(async () => {
      await ready;
      unlink(await db.all('SELECT media_path FROM archive WHERE timestamp < ? AND media_path IS NOT NULL', [cutoff()]));
      return (await db.run('DELETE FROM archive WHERE timestamp < ?', [cutoff()])).changes;
    }),

    /** "Delete all my data" for the archive. */
    clear: () => queued(async () => {
      await ready;
      unlink(await db.all('SELECT media_path FROM archive WHERE media_path IS NOT NULL'));
      return (await db.run('DELETE FROM archive')).changes;
    }),

    stats: async () => {
      await ready;
      const r = await db.get('SELECT COUNT(*) AS messages, COUNT(DISTINCT chat_id) AS chats, MIN(timestamp) AS oldest, COUNT(media_path) AS images FROM archive');
      return { messages: r.messages, chats: r.chats, oldest: r.oldest || null, images: r.images, retentionDays };
    },

    /**
     * A chat was just marked: hand its last `hours` hours (default 24) to `handle(row)`, oldest first, so the work DB
     * gets them. The rows stay in the archive until the retention window removes them. Returns how many were handed over.
     */
    promote: async (chat_id, handle, { hours = 24 } = {}) => {
      const rows = await (async () => { await ready; return db.all('SELECT * FROM archive WHERE chat_id = ? AND timestamp >= ? ORDER BY timestamp ASC', [chat_id, now() - hours * 3600]); })();
      let n = 0;
      for (const row of rows) {
        try { await handle(row); n++; } catch (e) { log(`archive promote: ${e.message}`); }
      }
      return n;
    },

    /** Test helper / shutdown: wait for pending writes. */
    idle: () => chain,
  };
}

/** An archive row in the shape normalizeMessage() produces. */
export function rowToMessage(r) {
  return {
    id: r.id, chat_id: r.chat_id, sender_id: r.sender_id, sender_name: r.sender_name, content: r.content, type: r.type,
    timestamp: r.timestamp, from_me: r.from_me, is_group: !!r.is_group, has_media: !!r.has_media, mimetype: r.mimetype,
  };
}
