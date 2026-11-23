const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const DB_PATH = require('./paths').dataPath('whatsapp_history.db');

let dbPromise = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = open({ filename: DB_PATH, driver: sqlite3.Database }).then(async (db) => {
      await db.exec('PRAGMA journal_mode = WAL;');
      await db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          sender_name TEXT,
          sender_id TEXT,
          content TEXT,
          type TEXT,
          timestamp INTEGER
        );
      `);
      await db.exec('CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, timestamp);');
      await db.exec(`
        CREATE TABLE IF NOT EXISTS chats (
          rowid INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT UNIQUE NOT NULL,
          name TEXT,
          is_group INTEGER DEFAULT 0,
          muted INTEGER DEFAULT 0,
          last_message_at INTEGER
        );
      `);
      await db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT,
          chat_name TEXT,
          message_id TEXT,
          title TEXT NOT NULL,
          date TEXT NOT NULL,
          start_time TEXT,
          end_time TEXT,
          location TEXT,
          notes TEXT,
          source_text TEXT,
          confidence REAL,
          status TEXT DEFAULT 'pending',
          dedup_key TEXT UNIQUE,
          created_at INTEGER
        );
      `);
      await db.exec('CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);');
      await db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);');
      await db.exec(`
        CREATE TABLE IF NOT EXISTS summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          hours INTEGER,
          message_count INTEGER,
          content TEXT,
          created_at INTEGER
        );
      `);
      await db.exec('CREATE INDEX IF NOT EXISTS idx_summaries_chat ON summaries(chat_id, created_at);');
      const chatCols = await db.all('PRAGMA table_info(chats)');
      if (!chatCols.some((c) => c.name === 'selected')) {
        await db.exec('ALTER TABLE chats ADD COLUMN selected INTEGER DEFAULT 0;');
      }
      if (!chatCols.some((c) => c.name === 'notes')) {
        await db.exec('ALTER TABLE chats ADD COLUMN notes TEXT;');
      }
      // Per-chat Q&A history, so follow-up questions have memory of earlier turns.
      await db.exec(`
        CREATE TABLE IF NOT EXISTS chat_qa (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER
        );
      `);
      await db.exec('CREATE INDEX IF NOT EXISTS idx_chat_qa_chat ON chat_qa(chat_id, created_at);');
      // Persisted per-person character/style profiles, refreshed nightly (or on demand).
      await db.exec(`
        CREATE TABLE IF NOT EXISTS person_profiles (
          chat_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          sender_name TEXT,
          profile_text TEXT,
          message_count INTEGER,
          first_seen INTEGER,
          last_seen INTEGER,
          updated_at INTEGER,
          PRIMARY KEY (chat_id, sender_id)
        );
      `);
      // Newer columns (added without touching existing data).
      const addColumn = async (table, column, ddl) => {
        const cols = await db.all(`PRAGMA table_info(${table})`);
        if (!cols.some((c) => c.name === column)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
      };
      await addColumn('messages', 'from_me', 'from_me INTEGER DEFAULT 0');
      await addColumn('messages', 'media_path', 'media_path TEXT');
      // listen_mode: off | text_voice | text_images_voice | all (all = + links)
      await addColumn('chats', 'listen_mode', "listen_mode TEXT DEFAULT 'text_images_voice'");
      await addColumn('summaries', 'detail', "detail TEXT DEFAULT 'short'");
      await addColumn('chats', 'is_unknown', 'is_unknown INTEGER DEFAULT 0');
      // Work chats: every event from this chat gets this prefix in its title (e.g. "שמשון").
      await addColumn('chats', 'event_prefix', 'event_prefix TEXT');
      // Image gallery: 'people' | 'other' | 'ad' (ads are not kept on disk)
      await addColumn('messages', 'image_kind', 'image_kind TEXT');
      // Baby feeding log (optional personal module)
      await db.exec(`
        CREATE TABLE IF NOT EXISTS feeds (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT,
          message_id TEXT UNIQUE,
          fed_at INTEGER NOT NULL,
          explicit INTEGER DEFAULT 0,     -- 1 = time was written in the message, 0 = message time was used
          amount TEXT,
          source TEXT DEFAULT 'auto',     -- auto | manual
          text TEXT,
          deleted INTEGER DEFAULT 0,
          created_at INTEGER
        );
      `);
      await db.exec('CREATE INDEX IF NOT EXISTS idx_feeds_time ON feeds(fed_at);');
      // kind: feed | med (medicine with its own timer); med = medicine name
      await addColumn('feeds', 'kind', "kind TEXT DEFAULT 'feed'");
      await addColumn('feeds', 'med', 'med TEXT');
      await db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          due_at INTEGER,
          status TEXT DEFAULT 'open',          -- open | done | suggested | dismissed
          origin TEXT DEFAULT 'manual',        -- manual | chat | love | unknown
          chat_id TEXT,
          chat_name TEXT,
          message_id TEXT,
          dedup_key TEXT UNIQUE,
          created_at INTEGER,
          done_at INTEGER
        );
      `);
      // Memory: what the bot learned about each group, and the owner's answers to its daily questions.
      await addColumn('chats', 'group_profile', 'group_profile TEXT');
      await addColumn('chats', 'group_profile_at', 'group_profile_at INTEGER');
      await db.exec(`
        CREATE TABLE IF NOT EXISTS daily_questions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          day TEXT,
          chat_id TEXT,
          chat_name TEXT,
          about TEXT,                         -- person | group | word | action | fact (added by hand)
          subject TEXT,
          question TEXT,                      -- null for a fact the owner added by hand
          answer TEXT,
          status TEXT DEFAULT 'open',         -- open | answered | skipped | deleted
          tg_message_id INTEGER,
          created_at INTEGER,
          answered_at INTEGER
        );
      `);
      await db.exec('CREATE INDEX IF NOT EXISTS idx_questions_status ON daily_questions(status, chat_id);');
      // People: one record per person across ALL chats (keyed by phone number), so what the bot
      // learns about someone in a group and in a private chat ends up in the same place.
      await db.exec(`
        CREATE TABLE IF NOT EXISTS people (
          id TEXT PRIMARY KEY,                -- phone digits (from sender id)
          name TEXT,
          aliases TEXT,                       -- JSON array of other names / chat names
          ids TEXT,                           -- JSON array of WhatsApp ids seen for this person
          profile TEXT,
          profile_at INTEGER,
          message_count INTEGER,
          updated_at INTEGER
        );
      `);
      await addColumn('daily_questions', 'person_id', 'person_id TEXT');
      // 1 = this chat never goes to a cloud model, only to the local one.
      await addColumn('chats', 'local_only', 'local_only INTEGER DEFAULT 0');
      // "keep images in the archive": for chats that are NOT marked, also store the picture files (30 days, with the archive)
      await addColumn('chats', 'archive_images', 'archive_images INTEGER DEFAULT 0');
      // Names of people: saved = 1 is the name from the phone's address book, 0 is the name the person chose.
      // WhatsApp sends the address book only once (while linking), so it has to be kept here.
      await db.exec('CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, saved INTEGER DEFAULT 0);');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id, timestamp);');
      // Time-block summaries: each 6-hour block of a chat is summarized once and kept (blocks.js).
      await db.exec(`
        CREATE TABLE IF NOT EXISTS chat_blocks (
          chat_id TEXT NOT NULL,
          start_ts INTEGER NOT NULL,
          end_ts INTEGER NOT NULL,
          message_count INTEGER,
          last_ts INTEGER,
          content TEXT,
          created_at INTEGER,
          PRIMARY KEY (chat_id, start_ts)
        );
      `);
      // One-time switch to per-option listening flags ("text,voice,images,links"; empty = not listening).
      // Chats you never chose explicitly become "not listening"; chats on the dashboard keep listening.
      const migrated = await db.get("SELECT value FROM settings WHERE key = 'listen_flags_v2'");
      if (!migrated) {
        await db.exec(`
          UPDATE chats SET listen_mode = CASE
            WHEN COALESCE(selected, 0) = 0 THEN ''
            WHEN listen_mode = 'off' THEN ''
            WHEN listen_mode = 'text_voice' THEN 'text,voice'
            WHEN listen_mode = 'all' THEN 'text,voice,images,links'
            ELSE 'text,voice,images' END;
        `);
        // Private chats whose name is just a phone number = numbers not saved in your phone.
        await db.exec(`UPDATE chats SET is_unknown = 1, listen_mode = 'text,voice,images'
                       WHERE is_group = 0 AND (name IS NULL OR REPLACE(REPLACE(REPLACE(name, char(8294), ''), char(8297), ''), ' ', '') GLOB '+[0-9]*');`);
        await db.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('listen_flags_v2', '1')");
      }
      // Care trackers (care.js): baby meals, a sick child's medicines, pets, plants. Any number of them.
      await db.exec(`
        CREATE TABLE IF NOT EXISTS care_trackers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,                 -- feeding | meds | pet | plant | custom
          name TEXT NOT NULL,
          person TEXT,                        -- whose it is ("נועה"), optional
          icon TEXT,
          remind INTEGER DEFAULT 1,
          chat_id TEXT,                       -- feeding: a WhatsApp chat whose messages are read as records
          config TEXT NOT NULL,               -- JSON: { items: [...], unit, track_amount, track_by, per_day }
          active INTEGER DEFAULT 1,
          sort INTEGER DEFAULT 0,
          created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS care_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tracker_id INTEGER NOT NULL,
          item TEXT NOT NULL,
          at INTEGER NOT NULL,
          amount TEXT,
          by TEXT,                            -- who did it
          note TEXT,
          source TEXT DEFAULT 'manual',       -- manual | chat
          message_id TEXT,
          merged INTEGER DEFAULT 0,           -- how many more reports were folded into this one (dedupe)
          deleted INTEGER DEFAULT 0,
          created_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_care_log ON care_log(tracker_id, at);
      `);
      // Backfill chats that only exist in older message history.
      await db.exec(`
        INSERT OR IGNORE INTO chats (chat_id, last_message_at)
        SELECT chat_id, MAX(timestamp) FROM messages GROUP BY chat_id;
      `);
      return db;
    });
  }
  return dbPromise;
}

async function withRetry(fn, retries = 3, delayMs = 250) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLocked = /SQLITE_BUSY|database is locked/i.test(err.message || '');
      if (!isLocked || attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

async function saveMessage({ id, chat_id, sender_name, sender_id, content, type, timestamp, from_me = 0, media_path = null, image_kind = null }) {
  const db = await getDb();
  return withRetry(() =>
    db.run(
      `INSERT OR IGNORE INTO messages (id, chat_id, sender_name, sender_id, content, type, timestamp, from_me, media_path, image_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, chat_id, sender_name, sender_id, content, type, timestamp, from_me ? 1 : 0, media_path, image_kind]
    )
  );
}

async function updateMessageContent(id, content) {
  const db = await getDb();
  return withRetry(() => db.run('UPDATE messages SET content = ? WHERE id = ?', [content, id]));
}

async function getMessageById(id) {
  const db = await getDb();
  return withRetry(() => db.get('SELECT * FROM messages WHERE id = ?', [id]));
}

async function getRecentMessages(chat_id, limit = 50) {
  const db = await getDb();
  const rows = await withRetry(() =>
    db.all(
      `SELECT * FROM (
         SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?
       ) ORDER BY timestamp ASC`,
      [chat_id, limit]
    )
  );
  return rows;
}


// ---------- chats ----------

// New chats start as "not listening" - except private chats with numbers that aren't saved in
// your phone (is_unknown), which are listened to automatically.
async function upsertChat({ chat_id, name, is_group, last_message_at, is_unknown = null }) {
  const db = await getDb();
  const unknown = is_unknown === null ? null : is_unknown ? 1 : 0;
  return withRetry(() =>
    db.run(
      `INSERT INTO chats (chat_id, name, is_group, last_message_at, is_unknown, listen_mode) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         name = COALESCE(excluded.name, chats.name),
         is_group = excluded.is_group,
         is_unknown = COALESCE(?, chats.is_unknown),
         last_message_at = MAX(COALESCE(chats.last_message_at, 0), excluded.last_message_at)`,
      [chat_id, name || null, is_group ? 1 : 0, last_message_at || 0, unknown || 0, unknown ? 'text,voice,images' : '', unknown]
    )
  );
}

async function getChatByRowid(rowid) {
  const db = await getDb();
  return withRetry(() => db.get('SELECT * FROM chats WHERE rowid = ?', [rowid]));
}

async function getChat(chat_id) {
  const db = await getDb();
  return withRetry(() => db.get('SELECT * FROM chats WHERE chat_id = ?', [chat_id]));
}

async function listRecentChats(limit = 12) {
  const db = await getDb();
  return withRetry(() =>
    db.all("SELECT * FROM chats WHERE COALESCE(listen_mode, '') != '' ORDER BY last_message_at DESC LIMIT ?", [limit])
  );
}

async function setChatMuted(rowid, muted) {
  const db = await getDb();
  return withRetry(() => db.run('UPDATE chats SET muted = ? WHERE rowid = ?', [muted ? 1 : 0, rowid]));
}

async function setChatNotes(rowid, notes) {
  const db = await getDb();
  return withRetry(() => db.run('UPDATE chats SET notes = ? WHERE rowid = ?', [notes || null, rowid]));
}

// ---------- per-chat Q&A memory ----------

async function addChatQa(chat_id, role, content) {
  const db = await getDb();
  return withRetry(() =>
    db.run(
      'INSERT INTO chat_qa (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)',
      [chat_id, role, content, Math.floor(Date.now() / 1000)]
    )
  );
}

async function getChatQa(chat_id, limit = 30) {
  const db = await getDb();
  const rows = await withRetry(() =>
    db.all(
      `SELECT * FROM (
         SELECT * FROM chat_qa WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?
       ) ORDER BY created_at ASC`,
      [chat_id, limit]
    )
  );
  return rows;
}

// ---------- person profiles (learned nightly or on demand) ----------

async function upsertPersonProfile({ chat_id, sender_id, sender_name, profile_text, message_count, first_seen, last_seen }) {
  const db = await getDb();
  return withRetry(() =>
    db.run(
      `INSERT INTO person_profiles (chat_id, sender_id, sender_name, profile_text, message_count, first_seen, last_seen, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, sender_id) DO UPDATE SET
         sender_name = excluded.sender_name,
         profile_text = excluded.profile_text,
         message_count = excluded.message_count,
         first_seen = excluded.first_seen,
         last_seen = excluded.last_seen,
         updated_at = excluded.updated_at`,
      [chat_id, sender_id, sender_name, profile_text, message_count, first_seen, last_seen, Math.floor(Date.now() / 1000)]
    )
  );
}

async function getPersonProfiles(chat_id) {
  const db = await getDb();
  return withRetry(() =>
    db.all('SELECT * FROM person_profiles WHERE chat_id = ? ORDER BY message_count DESC', [chat_id])
  );
}

// Active senders in a chat, optionally since a timestamp (0 = all time), for member profiling.
async function getSenderStats(chat_id, sinceTs = 0, limit = 8) {
  const db = await getDb();
  return withRetry(() =>
    db.all(
      `SELECT sender_id, sender_name, COUNT(*) AS count,
              MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen
       FROM messages
       WHERE chat_id = ? AND timestamp >= ? AND COALESCE(from_me, 0) = 0
       GROUP BY sender_id
       ORDER BY count DESC
       LIMIT ?`,
      [chat_id, sinceTs, limit]
    )
  );
}

// Sample of one sender's own messages in a chat, oldest-first, for quote-grounded profiling.
async function getMessagesBySender(chat_id, sender_id, sinceTs = 0, limit = 40) {
  const db = await getDb();
  return withRetry(() =>
    db.all(
      `SELECT * FROM (
         SELECT * FROM messages WHERE chat_id = ? AND sender_id = ? AND timestamp >= ?
         ORDER BY timestamp DESC LIMIT ?
       ) ORDER BY timestamp ASC`,
      [chat_id, sender_id, sinceTs, limit]
    )
  );
}

async function getMessagesSince(chat_id, sinceTs, limit = 300) {
  const db = await getDb();
  return withRetry(() =>
    db.all(
      `SELECT * FROM (
         SELECT * FROM messages WHERE chat_id = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?
       ) ORDER BY timestamp ASC`,
      [chat_id, sinceTs, limit]
    )
  );
}

async function getActiveChatsSince(sinceTs, minMessages = 3) {
  const db = await getDb();
  return withRetry(() =>
    db.all(
      `SELECT m.chat_id, COUNT(*) AS count, c.name, c.rowid AS chat_rowid, COALESCE(c.muted, 0) AS muted,
              COALESCE(c.is_unknown, 0) AS is_unknown, c.is_group, c.notes, c.group_profile, c.event_prefix, COALESCE(c.local_only, 0) AS local_only
       FROM messages m LEFT JOIN chats c ON c.chat_id = m.chat_id
       WHERE m.timestamp >= ?
       GROUP BY m.chat_id
       HAVING count >= ?
       ORDER BY count DESC`,
      [sinceTs, minMessages]
    )
  );
}

// ---------- events ----------

async function insertEvent(ev) {
  const db = await getDb();
  const result = await withRetry(() =>
    db.run(
      `INSERT OR IGNORE INTO events
         (chat_id, chat_name, message_id, title, date, start_time, end_time, location, notes,
          source_text, confidence, status, dedup_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        ev.chat_id, ev.chat_name, ev.message_id, ev.title, ev.date, ev.start_time || null,
        ev.end_time || null, ev.location || null, ev.notes || null, ev.source_text || null,
        ev.confidence ?? null, ev.dedup_key, Math.floor(Date.now() / 1000),
      ]
    )
  );
  if (!result.changes) return null;
  return getEvent(result.lastID);
}

async function findSimilarEvent(chat_id, date, start_time) {
  const db = await getDb();
  return withRetry(() =>
    db.get(
      `SELECT * FROM events WHERE chat_id = ? AND date = ? AND COALESCE(start_time, '') = COALESCE(?, '')`,
      [chat_id, date, start_time || null]
    )
  );
}

async function getEvent(id) {
  const db = await getDb();
  return withRetry(() => db.get('SELECT * FROM events WHERE id = ?', [id]));
}

async function setEventStatus(id, status) {
  const db = await getDb();
  return withRetry(() => db.run('UPDATE events SET status = ? WHERE id = ?', [status, id]));
}

async function getEventsBetween(fromDate, toDate, { includeIgnored = false } = {}) {
  const db = await getDb();
  return withRetry(() =>
    db.all(
      `SELECT * FROM events WHERE date >= ? AND date <= ? ${includeIgnored ? '' : "AND status != 'ignored'"}
       ORDER BY date ASC, COALESCE(start_time, '00:00') ASC`,
      [fromDate, toDate]
    )
  );
}

async function getPendingEvents(fromDate) {
  const db = await getDb();
  return withRetry(() =>
    db.all(
      `SELECT * FROM events WHERE status = 'pending' AND date >= ?
       ORDER BY date ASC, COALESCE(start_time, '00:00') ASC LIMIT 30`,
      [fromDate]
    )
  );
}

// ---------- settings ----------

async function getSetting(key) {
  const db = await getDb();
  const row = await withRetry(() => db.get('SELECT value FROM settings WHERE key = ?', [key]));
  return row ? row.value : null;
}

async function setSetting(key, value) {
  const db = await getDb();
  return withRetry(() =>
    db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, String(value)]
    )
  );
}

// ---------- UI helpers: selection + stored summaries ----------

async function setChatSelected(rowid, selected) {
  const db = await getDb();
  return withRetry(() => db.run('UPDATE chats SET selected = ? WHERE rowid = ?', [selected ? 1 : 0, rowid]));
}

async function listChatsWithStats(sinceTs) {
  const db = await getDb();
  return withRetry(() =>
    db.all(
      `SELECT c.rowid, c.chat_id, c.name, c.is_group, c.muted, COALESCE(c.selected, 0) AS selected, c.last_message_at,
              COALESCE(c.listen_mode, '') AS listen_mode, COALESCE(c.is_unknown, 0) AS is_unknown, c.event_prefix,
              c.group_profile, c.group_profile_at, COALESCE(c.local_only, 0) AS local_only, COALESCE(c.archive_images, 0) AS archive_images,
              (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id AND m.timestamp >= ?) AS recent_count,
              (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id) AS total_count
       FROM chats c
       ORDER BY c.last_message_at DESC`,
      [sinceTs]
    )
  );
}

async function getSelectedChats() {
  const db = await getDb();
  return withRetry(() => db.all('SELECT rowid, * FROM chats WHERE selected = 1 ORDER BY last_message_at DESC'));
}

// ---------- time blocks ----------
async function getMessagesBetween(chat_id, fromTs, toTs, limit = 5000) {
  const db = await getDb();
  return withRetry(() =>
    db.all('SELECT * FROM messages WHERE chat_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp ASC LIMIT ?', [chat_id, fromTs, toTs, limit])
  );
}
async function getBlock(chat_id, start_ts) {
  const db = await getDb();
  return withRetry(() => db.get('SELECT * FROM chat_blocks WHERE chat_id = ? AND start_ts = ?', [chat_id, start_ts]));
}
async function saveBlock({ chat_id, start_ts, end_ts, message_count, last_ts, content }) {
  const db = await getDb();
  return withRetry(() =>
    db.run(
      `INSERT INTO chat_blocks (chat_id, start_ts, end_ts, message_count, last_ts, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, start_ts) DO UPDATE SET end_ts = excluded.end_ts, message_count = excluded.message_count, last_ts = excluded.last_ts, content = excluded.content, created_at = excluded.created_at`,
      [chat_id, start_ts, end_ts, message_count, last_ts, content, Math.floor(Date.now() / 1000)]
    )
  );
}
async function listBlocks(chat_id, fromTs, toTs) {
  const db = await getDb();
  return withRetry(() =>
    db.all('SELECT * FROM chat_blocks WHERE chat_id = ? AND start_ts >= ? AND start_ts < ? ORDER BY start_ts ASC', [chat_id, fromTs, toTs])
  );
}
// Message count + newest message per block, for blocks of `size` seconds starting at `origin`.
async function blockStats(chat_id, fromTs, toTs, origin, size) {
  const db = await getDb();
  return withRetry(() =>
    db.all(
      `SELECT CAST((timestamp - ?) / ? AS INTEGER) AS idx, COUNT(*) AS n, MAX(timestamp) AS last_ts FROM messages
       WHERE chat_id = ? AND timestamp >= ? AND timestamp < ? GROUP BY idx ORDER BY idx`,
      [origin, size, chat_id, fromTs, toTs]
    )
  );
}

async function saveSummary({ chat_id, hours, message_count, content, detail = 'short' }) {
  const db = await getDb();
  return withRetry(() =>
    db.run(
      'INSERT INTO summaries (chat_id, hours, message_count, content, created_at, detail) VALUES (?, ?, ?, ?, ?, ?)',
      [chat_id, hours, message_count, content, Math.floor(Date.now() / 1000), detail]
    )
  );
}

// A chat becomes "marked" when it goes from listening to nothing to listening to something. The hook (set by index.js)
// then pulls the last 24 hours of that chat out of the rolling archive.
let markHook = null;
function setMarkHook(fn) { markHook = fn; }
async function setChatListenMode(rowid, mode) {
  const db = await getDb();
  const before = markHook ? await db.get('SELECT chat_id, listen_mode FROM chats WHERE rowid = ?', [rowid]).catch(() => null) : null;
  const res = await withRetry(() => db.run('UPDATE chats SET listen_mode = ? WHERE rowid = ?', [mode, rowid]));
  if (before && !String(before.listen_mode || '').trim() && String(mode || '').trim()) {
    Promise.resolve().then(() => markHook(before.chat_id)).catch(() => {});
  }
  return res;
}

async function findChatByNamePattern(patterns) {
  const db = await getDb();
  for (const p of patterns) {
    const row = await withRetry(() =>
      db.get("SELECT rowid, * FROM chats WHERE is_group = 0 AND name LIKE ? ORDER BY last_message_at DESC LIMIT 1", [`%${p}%`])
    );
    if (row) return row;
  }
  return null;
}

const EVENT_EDITABLE = ['title', 'date', 'start_time', 'end_time', 'location', 'notes'];

async function updateEvent(id, fields) {
  const db = await getDb();
  const keys = EVENT_EDITABLE.filter((k) => k in fields);
  if (!keys.length) return;
  const sql = `UPDATE events SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  return withRetry(() => db.run(sql, [...keys.map((k) => (fields[k] === '' ? null : fields[k])), id]));
}

async function getLatestSummary(chat_id) {
  const db = await getDb();
  return withRetry(() =>
    db.get('SELECT * FROM summaries WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1', [chat_id])
  );
}

// ---------- tasks ----------

async function addTask({ text, due_at = null, status = 'open', origin = 'manual', chat_id = null, chat_name = null, message_id = null, dedup_key = null }) {
  const db = await getDb();
  const r = await withRetry(() =>
    db.run(
      `INSERT OR IGNORE INTO tasks (text, due_at, status, origin, chat_id, chat_name, message_id, dedup_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [text, due_at, status, origin, chat_id, chat_name, message_id, dedup_key, Math.floor(Date.now() / 1000)]
    )
  );
  return r.changes ? r.lastID : null;
}

async function listTasks(statuses = ['open', 'suggested']) {
  const db = await getDb();
  return withRetry(() =>
    db.all(
      `SELECT * FROM tasks WHERE status IN (${statuses.map(() => '?').join(',')})
       ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, created_at DESC LIMIT 200`,
      statuses
    )
  );
}

async function updateTask(id, fields) {
  const db = await getDb();
  const allowed = ['text', 'due_at', 'status'].filter((k) => k in fields);
  if (!allowed.length) return;
  const extra = fields.status === 'done' ? ', done_at = ?' : '';
  const params = [...allowed.map((k) => fields[k]), ...(extra ? [Math.floor(Date.now() / 1000)] : []), id];
  return withRetry(() => db.run(`UPDATE tasks SET ${allowed.map((k) => `${k} = ?`).join(', ')}${extra} WHERE id = ?`, params));
}

async function listUnknownChats() {
  const db = await getDb();
  return withRetry(() => db.all("SELECT rowid, * FROM chats WHERE is_unknown = 1 AND COALESCE(listen_mode, '') != '' ORDER BY last_message_at DESC"));
}

// ---------- work chats ----------

async function setChatEventPrefix(rowid, prefix) {
  const db = await getDb();
  return withRetry(() => db.run('UPDATE chats SET event_prefix = ? WHERE rowid = ?', [prefix || null, rowid]));
}

async function findAnyChatByName(pattern) {
  const db = await getDb();
  return withRetry(() => db.get('SELECT rowid, * FROM chats WHERE name LIKE ? ORDER BY last_message_at DESC LIMIT 1', [`%${pattern}%`]));
}

async function getEventsForChatFrom(chat_id, fromDate) {
  const db = await getDb();
  return withRetry(() => db.all('SELECT * FROM events WHERE chat_id = ? AND date >= ? ORDER BY date, start_time', [chat_id, fromDate]));
}

async function countMessages(chat_id) {
  const db = await getDb();
  const r = await withRetry(() => db.get('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?', [chat_id]));
  return r ? r.n : 0;
}

// chat_id null = the newest message of any chat.
async function getLastMessageTs(chat_id) {
  const db = await getDb();
  const r = await withRetry(() => (chat_id === null
    ? db.get('SELECT MAX(timestamp) AS ts FROM messages')
    : db.get('SELECT MAX(timestamp) AS ts FROM messages WHERE chat_id = ?', [chat_id])));
  return r?.ts || 0;
}

/** A consistent copy of the whole database into `file`, while it stays in use. */
async function backupTo(file) {
  const db = await getDb();
  await db.run('VACUUM INTO ?', [file]);
}

async function listListeningChats() {
  const db = await getDb();
  return withRetry(() => db.all("SELECT rowid, * FROM chats WHERE COALESCE(listen_mode, '') != '' ORDER BY last_message_at DESC"));
}

// ---------- gallery ----------

async function listGallery({ kind = null, chat_id = null, before = null, limit = 60 } = {}) {
  const db = await getDb();
  const where = ["m.type = 'image'", 'm.media_path IS NOT NULL', "COALESCE(m.image_kind, '') != 'ad'"];
  const params = [];
  if (kind === 'people' || kind === 'other') { where.push('m.image_kind = ?'); params.push(kind); }
  if (chat_id) { where.push('m.chat_id = ?'); params.push(chat_id); }
  if (before) { where.push('m.timestamp < ?'); params.push(before); }
  params.push(Math.min(Number(limit) || 60, 200));
  return withRetry(() =>
    db.all(
      `SELECT m.id, m.chat_id, c.name AS chat_name, c.rowid AS chat_rowid, m.sender_name, m.content, m.timestamp,
              m.media_path, m.image_kind, m.from_me
       FROM messages m LEFT JOIN chats c ON c.chat_id = m.chat_id
       WHERE ${where.join(' AND ')} ORDER BY m.timestamp DESC LIMIT ?`,
      params
    )
  );
}

async function galleryCounts() {
  const db = await getDb();
  return withRetry(() =>
    db.all(
      `SELECT COALESCE(image_kind, 'unsorted') AS kind, COUNT(*) AS n FROM messages
       WHERE type = 'image' AND media_path IS NOT NULL GROUP BY COALESCE(image_kind, 'unsorted')`
    )
  );
}

async function listUnclassifiedImages(limit = 100) {
  const db = await getDb();
  return withRetry(() =>
    db.all("SELECT * FROM messages WHERE type = 'image' AND media_path IS NOT NULL AND image_kind IS NULL ORDER BY timestamp DESC LIMIT ?", [limit])
  );
}

async function setImageKind(id, kind, { dropMedia = false } = {}) {
  const db = await getDb();
  return withRetry(() =>
    db.run(`UPDATE messages SET image_kind = ?${dropMedia ? ', media_path = NULL' : ''} WHERE id = ?`, [kind, id])
  );
}

// ---------- care trackers (care.js) ----------

const trackerRow = (r) => (r ? { ...r, config: JSON.parse(r.config || '{}') } : null);
async function listTrackers({ all = false } = {}) {
  const db = await getDb();
  return (await withRetry(() => db.all(`SELECT * FROM care_trackers ${all ? '' : 'WHERE active = 1'} ORDER BY sort, id`))).map(trackerRow);
}
async function getTracker(id) {
  const db = await getDb();
  return trackerRow(await withRetry(() => db.get('SELECT * FROM care_trackers WHERE id = ?', [id])));
}
async function saveTracker(t) {
  const db = await getDb();
  const cols = [t.kind, t.name, t.person, t.icon, t.remind ? 1 : 0, t.chat_id, JSON.stringify(t.config)];
  if (t.id) {
    await withRetry(() => db.run('UPDATE care_trackers SET kind=?, name=?, person=?, icon=?, remind=?, chat_id=?, config=? WHERE id=?', [...cols, t.id]));
    return t.id;
  }
  const r = await withRetry(() => db.run('INSERT INTO care_trackers (kind, name, person, icon, remind, chat_id, config, sort, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [...cols, Date.now() % 1e9, Math.floor(Date.now() / 1000)]));
  return r.lastID;
}
async function deleteTracker(id) {
  const db = await getDb();
  await withRetry(() => db.run('UPDATE care_trackers SET active = 0 WHERE id = ?', [id]));
}
async function setTrackerOrder(ids) {
  const db = await getDb();
  for (let i = 0; i < ids.length; i++) await withRetry(() => db.run('UPDATE care_trackers SET sort = ? WHERE id = ?', [i, ids[i]]));
}
async function listCareLog(tracker_id, sinceTs) {
  const db = await getDb();
  return withRetry(() => db.all('SELECT * FROM care_log WHERE tracker_id = ? AND at >= ? AND deleted = 0 ORDER BY at', [tracker_id, sinceTs]));
}
async function addCareLog({ tracker_id, item, at, amount = null, by = null, note = null, source = 'manual', message_id = null }) {
  const db = await getDb();
  const r = await withRetry(() => db.run('INSERT INTO care_log (tracker_id, item, at, amount, by, note, source, message_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [tracker_id, item, at, amount, by, note, source, message_id, Math.floor(Date.now() / 1000)]));
  return r.lastID;
}
/** A second report of the same event: keep one record, fill in what it was missing, count the merge. */
async function mergeCareLog(id, { amount = null, by = null }) {
  const db = await getDb();
  await withRetry(() => db.run('UPDATE care_log SET merged = merged + 1, amount = COALESCE(amount, ?), by = COALESCE(by, ?) WHERE id = ?', [amount, by, id]));
}
async function deleteCareLog(id) {
  const db = await getDb();
  await withRetry(() => db.run('UPDATE care_log SET deleted = 1 WHERE id = ?', [id]));
}
async function careLogByMessage(message_id) {
  const db = await getDb();
  return withRetry(() => db.all('SELECT * FROM care_log WHERE message_id = ? OR message_id LIKE ?', [message_id, `${message_id}#%`]));
}

// ---------- feeding log ----------


async function listFeeds(sinceTs) {
  const db = await getDb();
  return withRetry(() => db.all('SELECT * FROM feeds WHERE deleted = 0 AND fed_at >= ? ORDER BY fed_at ASC', [sinceTs]));
}




// ---------- people (cross-chat) ----------

const personKey = (id) => String(id || '').split('@')[0].replace(/\D/g, '') || null;

async function upsertPerson({ id, name = null, aliases = [], ids = [], message_count = null }) {
  const key = personKey(id);
  if (!key) return null;
  const db = await getDb();
  const cur = await db.get('SELECT * FROM people WHERE id = ?', [key]);
  const merge = (json, add) => JSON.stringify([...new Set([...(JSON.parse(json || '[]')), ...add.filter(Boolean).map(String)])].slice(0, 20));
  const now = Math.floor(Date.now() / 1000);
  if (!cur) {
    await withRetry(() => db.run('INSERT INTO people (id, name, aliases, ids, message_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [key, name, merge('[]', aliases), merge('[]', ids), message_count, now]));
  } else {
    await withRetry(() => db.run('UPDATE people SET name = COALESCE(?, name), aliases = ?, ids = ?, message_count = COALESCE(?, message_count), updated_at = ? WHERE id = ?',
      [name, merge(cur.aliases, aliases), merge(cur.ids, ids), message_count, now, key]));
  }
  return key;
}

async function getPerson(id) {
  const db = await getDb();
  return withRetry(() => db.get('SELECT * FROM people WHERE id = ?', [personKey(id)]));
}

async function setPersonProfile(id, profile) {
  const db = await getDb();
  return withRetry(() => db.run('UPDATE people SET profile = ?, profile_at = ? WHERE id = ?', [profile, Math.floor(Date.now() / 1000), personKey(id)]));
}

async function listPeople(limit = 100) {
  const db = await getDb();
  return withRetry(() => db.all('SELECT * FROM people ORDER BY COALESCE(profile_at, 0) DESC, message_count DESC LIMIT ?', [limit]));
}

// Most active people (not me) in the given chats since sinceTs.
async function topSenders(chatIds, sinceTs, limit = 15) {
  if (!chatIds.length) return [];
  const db = await getDb();
  return withRetry(() => db.all(
    `SELECT sender_id, MAX(sender_name) AS sender_name, COUNT(*) AS count FROM messages
     WHERE COALESCE(from_me, 0) = 0 AND sender_id IS NOT NULL AND timestamp >= ?
       AND chat_id IN (${chatIds.map(() => '?').join(',')})
     GROUP BY sender_id ORDER BY count DESC LIMIT ?`, [sinceTs, ...chatIds, limit]));
}

// All messages a person wrote, in every chat (any of their WhatsApp ids).
async function getMessagesByPerson(ids, sinceTs, limit = 200) {
  if (!ids.length) return [];
  const db = await getDb();
  return withRetry(() => db.all(
    `SELECT * FROM (
       SELECT m.*, c.name AS chat_name, c.is_group FROM messages m LEFT JOIN chats c ON c.chat_id = m.chat_id
       WHERE m.sender_id IN (${ids.map(() => '?').join(',')}) AND m.timestamp >= ? AND COALESCE(m.from_me, 0) = 0
       ORDER BY m.timestamp DESC LIMIT ?
     ) ORDER BY timestamp ASC`, [...ids, sinceTs, limit]));
}

async function listPersonFacts(person_id, limit = 30) {
  const db = await getDb();
  return withRetry(() => db.all("SELECT * FROM daily_questions WHERE person_id = ? AND status = 'answered' ORDER BY id DESC LIMIT ?", [personKey(person_id), limit]));
}

// ---------- memory (group character + daily questions / facts) ----------

async function setGroupProfile(chat_id, text) {
  const db = await getDb();
  return withRetry(() => db.run('UPDATE chats SET group_profile = ?, group_profile_at = ? WHERE chat_id = ?', [text, Math.floor(Date.now() / 1000), chat_id]));
}

async function addQuestion({ day, chat_id = null, chat_name = null, about = 'group', subject = null, question = null, person_id = null }) {
  const db = await getDb();
  const r = await withRetry(() =>
    db.run('INSERT INTO daily_questions (day, chat_id, chat_name, about, subject, question, status, created_at, person_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [day, chat_id, chat_name, about, subject, question, 'open', Math.floor(Date.now() / 1000), person_id])
  );
  return r.lastID;
}

async function getQuestion(id) {
  const db = await getDb();
  return withRetry(() => db.get('SELECT * FROM daily_questions WHERE id = ?', [id]));
}

async function getQuestionByTelegramId(tg_message_id) {
  const db = await getDb();
  return withRetry(() => db.get('SELECT * FROM daily_questions WHERE tg_message_id = ?', [tg_message_id]));
}

// status: 'open' | 'answered' | ... | null (= everything except deleted)
async function listQuestions({ status = 'open', chat_id, limit = 50, noPerson = false } = {}) {
  const db = await getDb();
  const where = [];
  const args = [];
  if (noPerson) where.push('person_id IS NULL');
  if (status) { where.push('status = ?'); args.push(status); } else where.push("status != 'deleted'");
  if (chat_id !== undefined) { where.push(chat_id === null ? 'chat_id IS NULL' : 'chat_id = ?'); if (chat_id !== null) args.push(chat_id); }
  return withRetry(() => db.all(`SELECT * FROM daily_questions WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, [...args, limit]));
}

// Answered questions + hand-written facts = what the bot "knows". chat_id null = general facts.
async function listMemoryFacts({ chat_id, limit = 30, noPerson = false } = {}) {
  return listQuestions({ status: 'answered', chat_id, limit, noPerson });
}

async function updateQuestion(id, fields) {
  const db = await getDb();
  const keys = ['answer', 'status', 'answered_at', 'tg_message_id', 'subject', 'person_id'].filter((k) => k in fields);
  if (!keys.length) return;
  return withRetry(() => db.run(`UPDATE daily_questions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => fields[k]), id]));
}

async function setChatLocalOnly(rowid, on) {
  const db = await getDb();
  return withRetry(() => db.run('UPDATE chats SET local_only = ? WHERE rowid = ?', [on ? 1 : 0, rowid]));
}

// Store names and put them on the matching private chats: a saved name always wins, a chosen name only fills an empty one.
async function upsertContacts(list) {
  const db = await getDb();
  let renamed = 0;
  for (const c of list) {
    if (!c?.id || !c.name) continue;
    await withRetry(() => db.run(
      `INSERT INTO contacts (id, name, saved) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, saved = excluded.saved WHERE excluded.saved >= contacts.saved`,
      [c.id, c.name, c.saved ? 1 : 0]));
    const r = await withRetry(() => db.run(
      `UPDATE chats SET name = ? WHERE chat_id = ? AND COALESCE(is_group, 0) = 0 AND COALESCE(name, '') != ?
         AND (? = 1 OR COALESCE(name, '') = '' OR name = chat_id)`,
      [c.name, c.id, c.name, c.saved ? 1 : 0]));
    renamed += r.changes || 0;
  }
  return renamed;
}
/** People to pick from (partner picker): names saved in the phone first, then private chats. Search by any part of the name or number. */
async function searchPeople(q = '', limit = 30) {
  const db = await getDb();
  const term = String(q || '').trim();
  const like = `%${term.replace(/[%_]/g, '')}%`;
  const digits = term.replace(/[^0-9]/g, '');
  const rows = await withRetry(() => db.all(
    `SELECT id, name, saved, 1 AS src FROM contacts WHERE id LIKE '%@s.whatsapp.net' AND (name LIKE ? ${digits.length >= 3 ? 'OR id LIKE ?' : ''})
     UNION ALL
     SELECT chat_id AS id, name, 0 AS saved, 2 AS src FROM chats WHERE COALESCE(is_group, 0) = 0 AND chat_id NOT LIKE '%@g.us'
       AND (name LIKE ? ${digits.length >= 3 ? 'OR chat_id LIKE ?' : ''})
     ORDER BY saved DESC, src, name LIMIT ?`,
    [like, ...(digits.length >= 3 ? [`%${digits}%`] : []), like, ...(digits.length >= 3 ? [`%${digits}%`] : []), limit * 3]
  ));
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = String(r.id).split('@')[0];
    if (seen.has(key) || !r.name || r.name === r.id) continue;
    seen.add(key);
    out.push({ id: r.id.replace(/@c\.us$/, '@s.whatsapp.net'), name: r.name, saved: Boolean(r.saved), phone: key });
    if (out.length >= limit) break;
  }
  return out;
}

async function listContacts() {
  const db = await getDb();
  return withRetry(() => db.all('SELECT id, name, saved FROM contacts'));
}
// Private chats that still have no name get one from what we already know.
async function nameChatsFromContacts() {
  const db = await getDb();
  return withRetry(() => db.run(
    `UPDATE chats SET name = (SELECT name FROM contacts WHERE contacts.id = chats.chat_id)
     WHERE COALESCE(is_group, 0) = 0 AND (COALESCE(name, '') = '' OR name = chat_id) AND chat_id IN (SELECT id FROM contacts)`));
}
async function setChatArchiveImages(rowid, on) {
  const db = await getDb();
  return withRetry(() => db.run('UPDATE chats SET archive_images = ? WHERE rowid = ?', [on ? 1 : 0, rowid]));
}

// Free-text search over saved messages (all words ranked; newest first among equals).
async function searchMessages(query, { sinceTs = 0, chat_id = null, limit = 60 } = {}) {
  const words = String(query || '').split(/\s+/).map((w) => w.replace(/^[והשבלמכ](?=[\u0590-\u05FF]{3,})/, '')).filter((w) => w.length >= 2).slice(0, 6);
  if (!words.length) return [];
  const db = await getDb();
  const score = words.map(() => "(CASE WHEN m.content LIKE ? OR m.sender_name LIKE ? THEN 1 ELSE 0 END)").join(' + ');
  const args = [];
  words.forEach((w) => args.push(`%${w}%`, `%${w}%`));
  const where = ['m.timestamp >= ?'];
  const wargs = [sinceTs];
  if (chat_id) { where.push('m.chat_id = ?'); wargs.push(chat_id); }
  return withRetry(() => db.all(
    `SELECT * FROM (SELECT m.id, m.chat_id, m.sender_name, m.content, m.timestamp, m.from_me, c.name AS chat_name, (${score}) AS score
       FROM messages m LEFT JOIN chats c ON c.chat_id = m.chat_id WHERE ${where.join(' AND ')})
     WHERE score > 0 ORDER BY score DESC, timestamp DESC LIMIT ?`, [...args, ...wargs, Math.min(limit, 200)]));
}

// Voice messages saved before transcription was available (or while the voice server was down).
async function listUntranscribedVoices(sinceTs, limit = 30) {
  const db = await getDb();
  return withRetry(() => db.all(
    `SELECT m.*, c.name AS chat_name FROM messages m LEFT JOIN chats c ON c.chat_id = m.chat_id
     WHERE m.type = 'voice' AND m.media_path IS NOT NULL AND m.content LIKE '🎙️ [%' AND m.timestamp >= ?
     ORDER BY m.timestamp DESC LIMIT ?`, [sinceTs, limit]));
}

module.exports = {
  searchPeople, backupTo,
  listTrackers, getTracker, saveTracker, deleteTracker, setTrackerOrder, listCareLog, addCareLog, mergeCareLog, deleteCareLog, careLogByMessage,
  setMarkHook,
  setChatArchiveImages,
  upsertContacts,
  listContacts,
  nameChatsFromContacts,
  getMessagesBetween,
  getBlock,
  saveBlock,
  listBlocks,
  blockStats,
  listUntranscribedVoices,
  searchMessages,
  setChatLocalOnly,
  personKey,
  upsertPerson,
  getPerson,
  setPersonProfile,
  listPeople,
  topSenders,
  getMessagesByPerson,
  listPersonFacts,
  setGroupProfile,
  addQuestion,
  getQuestion,
  getQuestionByTelegramId,
  listQuestions,
  listMemoryFacts,
  updateQuestion,
  getDb,
  saveMessage,
  getRecentMessages,
  upsertChat,
  getChat,
  getChatByRowid,
  listRecentChats,
  setChatMuted,
  setChatNotes,
  getMessagesSince,
  getSenderStats,
  getMessagesBySender,
  getActiveChatsSince,
  insertEvent,
  findSimilarEvent,
  getEvent,
  setEventStatus,
  getEventsBetween,
  getPendingEvents,
  getSetting,
  setSetting,
  setChatSelected,
  listChatsWithStats,
  getSelectedChats,
  saveSummary,
  getLatestSummary,
  updateMessageContent,
  getMessageById,
  setChatListenMode,
  findChatByNamePattern,
  updateEvent,
  addTask,
  listTasks,
  updateTask,
  listUnknownChats,
  setChatEventPrefix,
  findAnyChatByName,
  getEventsForChatFrom,
  countMessages,
  getLastMessageTs,
  listGallery,
  galleryCounts,
  listUnclassifiedImages,
  setImageKind,
  listFeeds,
  listListeningChats,
  addChatQa,
  getChatQa,
  upsertPersonProfile,
  getPersonProfiles,
};
