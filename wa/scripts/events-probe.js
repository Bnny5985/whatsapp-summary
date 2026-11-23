// Diagnostic: prints only the KIND of every event WhatsApp delivers (never text, names or numbers).
//   node scripts/events-probe.js [--seconds=240]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSource } from '../source.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const authDir = process.env.WA_AUTH_DIR || path.resolve(here, '..', '.auth-live');
const seconds = Number(process.argv.find((a) => a.startsWith('--seconds='))?.split('=')[1] || 240);
const t = () => new Date().toTimeString().slice(0, 8);
const kind = (id) => (id.endsWith('@g.us') ? 'group' : id.endsWith('@lid') ? 'direct-lid' : 'direct');

const source = createSource({
  authDir,
  onState: (s, i) => console.log(t(), 'state', s, i?.code || ''),
  onMessage: (m, { live }) => console.log(t(), live ? 'LIVE   ' : 'APPEND ', 'msg', kind(m.chat_id), 'type=' + m.type, 'from_me=' + m.from_me, 'age_s=' + (Math.floor(Date.now() / 1000) - m.timestamp)),
  onDelete: (d) => console.log(t(), 'DELETE', kind(d.chat_id)),
  onEdit: (e) => console.log(t(), 'EDIT  ', kind(e.chat_id)),
  onCall: () => console.log(t(), 'CALL'),
  onHistory: (h) => console.log(t(), 'history batch', h.messages.length),
});
await source.start();
setTimeout(() => { source.stop(); process.exit(0); }, seconds * 1000);
