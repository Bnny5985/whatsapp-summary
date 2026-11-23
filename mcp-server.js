#!/usr/bin/env node
// MCP server (read-only) - lets Claude Desktop / Cowork ask your WhatsApp bot questions:
// search messages, latest summaries, events, tasks, the partner card, care trackers, people the bot learned.
// It only READS through the bot's local dashboard API (http://127.0.0.1:3000) - it cannot send
// WhatsApp messages, delete anything or change settings. No extra packages needed.
//
// Registered in Claude Desktop by scriptsinstall-claude-mcp.ps1.

const http = require('http');
const PORT = Number(process.env.WEB_PORT || 3000);
const VERSION = '1.0.0';

function botApi(path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path, method: data ? 'POST' : 'GET', timeout: 180000,
      headers: { Host: 'localhost', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* not json */ }
        if (res.statusCode >= 400) return reject(new Error((json && json.error) || `HTTP ${res.statusCode}`));
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('the bot did not answer in time')));
    req.on('error', (err) => reject(new Error(err.code === 'ECONNREFUSED' ? 'The WhatsApp bot is not running (start it with "WhatsApp Bot" on the desktop).' : err.message)));
    if (data) req.write(data);
    req.end();
  });
}

const fmtTime = (ts) => (ts ? new Date(ts * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '');
async function chatByName(name) {
  const chats = await botApi('/api/chats');
  const q = String(name || '').trim();
  return chats.find((c) => c.name === q) || chats.find((c) => (c.name || '').includes(q)) || null;
}

const TOOLS = [
  {
    name: 'whatsapp_search',
    description: 'Search the saved WhatsApp messages (all listened chats) for words or a name. Returns matching messages with chat, sender and time. Use for "what did X write about Y", finding lists, addresses, dates.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to look for (Hebrew or English)' }, hours: { type: 'number', description: 'How far back, in hours (default 168 = a week)' }, chat: { type: 'string', description: 'Optional: only this chat (name or part of it)' } }, required: ['query'] },
    run: async ({ query, hours = 168, chat }) => {
      const c = chat ? await chatByName(chat) : null;
      const r = await botApi(`/api/search?q=${encodeURIComponent(query)}&hours=${Number(hours) || 168}${c ? `&chat=${c.rowid}` : ''}`);
      if (!r.length) return 'No messages found.';
      return r.map((m) => `[${m.chat_name || ''}] ${fmtTime(m.timestamp)} ${m.sender_name}: ${m.content}`).join('\n');
    },
  },
  {
    name: 'whatsapp_ask',
    description: "Ask the bot a free question about the WhatsApp conversations; it answers from the saved messages and its memory (uses the bot's own model).",
    inputSchema: { type: 'object', properties: { question: { type: 'string' }, hours: { type: 'number', description: 'How far back (default 72)' }, chat: { type: 'string', description: 'Optional chat name' } }, required: ['question'] },
    run: async ({ question, hours = 72, chat }) => {
      const c = chat ? await chatByName(chat) : null;
      const r = await botApi('/api/ask', { question, hours, rowid: c ? c.rowid : undefined });
      return `${r.answer}\n\n(${r.scope || ''}${r.count ? `, ${r.count} messages` : ''}${r.provider ? `, model: ${r.provider}` : ''})`;
    },
  },
  {
    name: 'whatsapp_chats',
    description: 'List the WhatsApp chats the bot knows, with new-message counts and the latest short summary of the marked ones.',
    inputSchema: { type: 'object', properties: { only_marked: { type: 'boolean', description: 'Only chats marked ✓ on the dashboard (default true)' } } },
    run: async ({ only_marked = true }) => {
      const chats = (await botApi('/api/chats')).filter((c) => !only_marked || c.selected);
      return chats.map((c) => `${c.is_group ? '👥' : '👤'} ${c.name} — ${c.recent_count || 0} new in 24h${c.summary ? `\n   ${String(c.summary.content).replace(/\n/g, '\n   ')}` : ''}`).join('\n') || 'No chats.';
    },
  },
  {
    name: 'whatsapp_messages',
    description: 'Read the latest messages of one chat.',
    inputSchema: { type: 'object', properties: { chat: { type: 'string', description: 'Chat name or part of it' }, limit: { type: 'number', description: 'How many (default 50, max 200)' } }, required: ['chat'] },
    run: async ({ chat, limit = 50 }) => {
      const c = await chatByName(chat);
      if (!c) return `No chat named "${chat}".`;
      const msgs = await botApi(`/api/chats/${c.rowid}/messages?limit=${Math.min(Number(limit) || 50, 200)}`);
      return `${c.name}:\n` + msgs.map((m) => `${fmtTime(m.timestamp)} ${m.sender_name}: ${m.content}`).join('\n');
    },
  },
  {
    name: 'whatsapp_events',
    description: 'Upcoming events the bot found in the chats (date, time, place, calendar conflicts).',
    inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'Days ahead (default 14)' } } },
    run: async ({ days = 14 }) => {
      const evs = await botApi(`/api/events?days=${Number(days) || 14}`);
      return evs.map((e) => `${e.date} ${e.start_time || ''} ${e.title}${e.location ? ` @ ${e.location}` : ''}${e.chat_name ? ` (${e.chat_name})` : ''}${(e.conflicts || []).some((x) => x.kind === 'overlap') ? ' ⛔ conflict' : ''}`).join('\n') || 'No upcoming events.';
    },
  },
  {
    name: 'whatsapp_tasks',
    description: 'Open tasks (and tasks the bot suggested from the chats).',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const t = await botApi('/api/tasks');
      const line = (x) => `- ${x.text}${x.due_at ? ` (until ${fmtTime(x.due_at)})` : ''}${x.chat_name ? ` [${x.chat_name}]` : ''}`;
      return `Open:\n${t.open.map(line).join('\n') || '(none)'}\n\nSuggested:\n${t.suggested.map(line).join('\n') || '(none)'}`;
    },
  },
  {
    name: 'whatsapp_tslil',
    description: "The user's partner chat: what they asked for, open tasks, lists they sent, whether they are waiting for a reply.",
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const r = await botApi('/api/love');
      if (!r.configured) return 'The partner chat is not set up.';
      return [
        r.needs_reply ? `⚠ Waiting for a reply: ${r.reply_about || ''}` : 'No open reply.',
        `Wants: ${(r.wants || []).join('; ') || '-'}`,
        `Tasks: ${(r.tasks || []).map((t) => t.text).join('; ') || '-'}`,
        ...(r.lists || []).map((l) => `List "${l.title}": ${l.items.join(', ')}`),
        r.last_message ? `Last message ${fmtTime(r.last_message.timestamp)}: ${r.last_message.text}` : '',
      ].filter(Boolean).join('\n');
    },
  },
  {
    name: 'whatsapp_trackers',
    description: 'Care trackers (medicines, baby meals, pets, plants): what is due next and what was logged today.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const { trackers } = await botApi('/api/care');
      if (!trackers.length) return 'No trackers set up.';
      return trackers.map((t) => `## ${t.name}${t.person ? ` (${t.person})` : ''}\n` + t.items.map((i) =>
        `• ${i.name}${i.dose ? ` ${i.dose}` : ''}: ${i.finished ? 'course finished' : `next ${i.next_time || '-'}${i.overdue ? ' (due now)' : ''}`}, last ${i.last_time || 'no record'}`).join('\n')).join('\n\n');
    },
  },
  {
    name: 'whatsapp_people',
    description: 'What the bot learned about people across all chats (profiles and remembered facts).',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Optional: only this person' } } },
    run: async ({ name }) => {
      const m = await botApi('/api/memory');
      const people = (m.people || []).filter((p) => !name || [p.name, ...(p.aliases || [])].some((n) => String(n || '').includes(name)));
      return people.map((p) => `## ${p.name || p.id}\n${p.profile || '(no profile yet)'}\n${(p.facts || []).map((f) => `• ${f.answer}`).join('\n')}`).join('\n\n') || 'Nothing learned yet.';
    },
  },
];

// ---------- MCP over stdio (newline-delimited JSON-RPC) ----------
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notifications
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'whatsapp-bot', version: VERSION },
        instructions: 'Read-only access to the user\'s WhatsApp summary bot (Hebrew chats). Use whatsapp_search for facts, whatsapp_tslil for his partner, whatsapp_tasks / whatsapp_events for to-dos and dates.',
      } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
    if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
      try {
        const text = await tool.run(params.arguments || {});
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text).slice(0, 60000) }] } });
      } catch (err) {
        return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] } });
      }
    }
    if (method === 'resources/list') return send({ jsonrpc: '2.0', id, result: { resources: [] } });
    if (method === 'prompts/list') return send({ jsonrpc: '2.0', id, result: { prompts: [] } });
    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    return send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
