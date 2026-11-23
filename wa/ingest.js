// Connects the read-only WhatsApp source to the bot's database (db.js).
// The database is passed in, so this file has no dependency on where or how it is stored.
//
//   const ingest = createIngest({ db, onLive, onDelete, onEdit, log });
//   const source = createSource({ authDir, ...ingest.handlers });
//
// Rules:
//  - Everything is written through ONE queue (history batches arrive while live messages keep coming).
//  - A history batch is one transaction (tens of thousands of single writes would take minutes).
//  - Saving is idempotent: the same message id twice is ignored (INSERT OR IGNORE in db.saveMessage).
//  - A deleted message is reported to the host (onDelete) but NOT removed from the database, which matches
//    the current bot: it only withdraws what was derived from it (e.g. a feeding entry).

const BATCH = 500;

export function createIngest({ db, onLive = () => {}, onDelete = () => {}, onEdit = () => {}, log = () => {} }) {
  let chain = Promise.resolve();
  const stats = { saved: 0, duplicates: 0, chats: 0, errors: 0, historyBatches: 0, historyDone: false, otherKinds: {} };

  // jid -> { name, saved }. A name saved in the phone's address book beats the name the person chose for themselves.
  const contactNames = new Map();
  function rememberContacts(list = []) {
    const changed = [];
    for (const c of list) {
      for (const id of [c.id, c.alt]) {
        if (!id) continue;
        const old = contactNames.get(id);
        if (old && old.saved && !c.saved) continue; // keep the saved name
        if (old && old.name === c.name && old.saved === c.saved) continue;
        contactNames.set(id, { name: c.name, saved: c.saved });
        changed.push(id);
      }
    }
    return changed;
  }

  /** Name existing direct chats (never creates a chat) - a push name only fills a chat that has no name yet. */
  async function applyContactNames(ids) {
    const raw = await db.getDb();
    for (const id of ids) {
      const c = contactNames.get(id);
      if (!c || id.endsWith('@g.us')) continue;
      if (c.saved) await raw.run('UPDATE chats SET name = ? WHERE chat_id = ?', [c.name, id]);
      else await raw.run("UPDATE chats SET name = ? WHERE chat_id = ? AND (name IS NULL OR name = '')", [c.name, id]);
    }
  }

  const enqueue = (fn) => {
    chain = chain.then(fn).catch((e) => { stats.errors += 1; log(`ingest error: ${e.message}`); });
    return chain;
  };

  async function saveOne(m) {
    const res = await db.saveMessage({
      id: m.id,
      chat_id: m.chat_id,
      sender_name: m.sender_name,
      sender_id: m.sender_id,
      content: m.content,
      type: m.type,
      timestamp: m.timestamp,
      from_me: m.from_me,
    });
    // A direct chat is named after the other person; never after ourselves (pushName of our own messages is OUR name).
    const known = m.is_group ? null : contactNames.get(m.chat_id)?.name;
    const name = m.is_group ? null : known || (!m.from_me ? m.sender_name : null);
    await db.upsertChat({ chat_id: m.chat_id, name, is_group: m.is_group, last_message_at: m.timestamp });
    if (res && res.changes === 0) stats.duplicates += 1; // the same message id was already stored
    else stats.saved += 1;
    if (m.type === 'other') stats.otherKinds[m.raw_kind || '?'] = (stats.otherKinds[m.raw_kind || '?'] || 0) + 1;
  }

  async function transaction(fn) {
    const raw = await db.getDb();
    await raw.exec('BEGIN IMMEDIATE');
    try {
      await fn();
      await raw.exec('COMMIT');
    } catch (e) {
      await raw.exec('ROLLBACK').catch(() => {});
      throw e;
    }
  }

  const handlers = {
    onMessage: (m, { live }) => enqueue(async () => {
      await saveOne(m);
      if (live) await onLive(m);
    }),

    onHistory: ({ messages, chats, contacts = [], isLatest }) => enqueue(async () => {
      stats.historyBatches += 1;
      const changed = rememberContacts(contacts); // before saving, so new chats get their names at once
      await transaction(async () => {
        for (const c of chats) {
          await db.upsertChat({ chat_id: c.chat_id, name: contactNames.get(c.chat_id)?.name || c.name, is_group: c.is_group, last_message_at: c.last_ts });
          stats.chats += 1;
        }
        for (let i = 0; i < messages.length; i += BATCH) {
          for (const m of messages.slice(i, i + BATCH)) await saveOne(m);
        }
        await applyContactNames(changed);
      });
      if (isLatest) stats.historyDone = true;
    }),

    onContacts: (list) => enqueue(async () => {
      const changed = rememberContacts(list);
      if (changed.length) await transaction(() => applyContactNames(changed));
    }),

    onDelete: (d) => enqueue(() => onDelete(d)),
    onEdit: (e) => enqueue(async () => {
      if (e.id && e.content != null) await db.updateMessageContent(e.id, e.content);
      await onEdit(e);
    }),
    log,
  };

  /** Group names are not part of the history; fetch them once (a read-only query) and store them. */
  async function fillGroupNames(socket) {
    const groups = await socket.groupFetchAllParticipating();
    return enqueue(async () => {
      await transaction(async () => {
        for (const g of Object.values(groups || {})) {
          if (g?.id && g.subject) await db.upsertChat({ chat_id: g.id, name: g.subject, is_group: true, last_message_at: 0 });
        }
      });
    });
  }

  return { handlers, fillGroupNames, stats, idle: () => chain };
}
