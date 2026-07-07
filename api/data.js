// API dati — legge/scrive i file JSON in data/ usando GitHub come database
import crypto from 'crypto';

const GH_TOKEN = process.env.GH_TOKEN;
const SECRET = process.env.SESSION_SECRET;
const REPO = process.env.GH_REPO || 'MatteoMarcellin9/jotunheimen2026';

const GH_HEADERS = () => ({
  'Authorization': `token ${GH_TOKEN}`,
  'User-Agent': 'jotunheimen2026',
  'Accept': 'application/vnd.github+json'
});

async function ghGet(path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=main`, { headers: GH_HEADERS() });
  if (!r.ok) throw new Error(`GH GET ${path}: ${r.status}`);
  const d = await r.json();
  const content = JSON.parse(Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf-8'));
  return { content, sha: d.sha };
}

async function ghPut(path, obj, sha, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(obj, null, 1), 'utf-8').toString('base64'),
    branch: 'main'
  };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { ...GH_HEADERS(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`GH PUT ${path}: ${r.status} ${t.slice(0, 200)}`); }
  return r.json();
}

// mutazione con retry su conflitto SHA
async function mutate(path, fn, message) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { content, sha } = await ghGet(path);
    const result = fn(content);
    if (result === false) return content; // nessuna modifica
    try {
      await ghPut(path, content, sha, message);
      return content;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 300 + attempt * 400));
    }
  }
  throw lastErr;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  const check = crypto.createHmac('sha256', SECRET).update(`${id}.${exp}`).digest('hex');
  if (check !== sig) return null;
  if (Date.now() > Number(exp)) return null;
  return id;
}

function newId() {
  return Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!GH_TOKEN || !SECRET) return res.status(500).json({ error: 'Configurazione incompleta: mancano GH_TOKEN / SESSION_SECRET su Vercel.' });

  try {
    // ============ GET ============
    if (req.method === 'GET') {
      const type = req.query.type || 'public';

      if (type === 'public') {
        const [photos, checkins] = await Promise.all([
          ghGet('data/photos.json'), ghGet('data/checkins.json')
        ]);
        return res.status(200).json({
          photos: photos.content,
          checkins: checkins.content
        });
      }

      if (type === 'state') {
        const id = verifyToken(req.query.token);
        if (!id) return res.status(401).json({ error: 'Sessione scaduta, rifai il login.' });
        const [choices, checklist, meals, comments, photos, checkins, members, todos, aiRequests] = await Promise.all([
          ghGet('data/choices.json'), ghGet('data/checklist.json'), ghGet('data/meals.json'),
          ghGet('data/comments.json'), ghGet('data/photos.json'), ghGet('data/checkins.json'),
          ghGet('data/members.json'), ghGet('data/todos.json'), ghGet('data/ai_requests.json')
        ]);
        return res.status(200).json({
          choices: choices.content,
          checklist: checklist.content,
          meals: meals.content,
          comments: comments.content,
          photos: photos.content,
          checkins: checkins.content,
          todos: todos.content,
          aiRequests: aiRequests.content,
          members: members.content.members.map(m => ({ id: m.id, nick: m.nick, name: m.name, admin: !!m.admin }))
        });
      }

      return res.status(400).json({ error: 'type non valido' });
    }

    // ============ POST ============
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const memberId = verifyToken(body.token);
    if (!memberId) return res.status(401).json({ error: 'Sessione scaduta, rifai il login.' });
    const { action } = body;
    const nick = String(body.nick || memberId);
    const now = Date.now();

    if (action === 'setChoice') {
      const { choiceId, value } = body;
      if (!choiceId || typeof value !== 'string' || value.length > 200) return res.status(400).json({ error: 'dati non validi' });
      const updated = await mutate('data/choices.json', c => {
        if (!c[memberId]) c[memberId] = {};
        c[memberId][choiceId] = { value, ts: now };
      }, `${nick}: scelta ${choiceId}`);
      return res.status(200).json({ ok: true, choices: updated });
    }

    if (action === 'setChecklist') {
      const { items } = body;
      if (!items || typeof items !== 'object') return res.status(400).json({ error: 'dati non validi' });
      const clean = {};
      for (const k of Object.keys(items)) {
        if (typeof k === 'string' && k.length < 60 && items[k] === true) clean[k] = true;
      }
      const updated = await mutate('data/checklist.json', c => {
        c[memberId] = clean;
      }, `${nick}: checklist aggiornata`);
      return res.status(200).json({ ok: true, checklist: updated });
    }

    if (action === 'setTodos') {
      const { todos } = body;
      if (!todos || typeof todos !== 'object') return res.status(400).json({ error: 'dati non validi' });
      // lista CONDIVISA: sovrascrive lo stato globale con la versione del client (last-write-wins)
      const clean = {};
      for (const k of Object.keys(todos)) {
        if (typeof k === 'string' && k.length < 60 && todos[k] && todos[k].done) {
          clean[k] = { done: true, nick: String(todos[k].nick || '').slice(0, 30), ts: Number(todos[k].ts) || now };
        }
      }
      const updated = await mutate('data/todos.json', c => {
        Object.keys(c).forEach(k => delete c[k]);
        Object.assign(c, clean);
      }, `${nick}: to-do aggiornati`);
      return res.status(200).json({ ok: true, todos: updated });
    }

    if (action === 'addAiRequest') {
      const { text } = body;
      if (!text || typeof text !== 'string' || !text.trim() || text.length > 600) {
        return res.status(400).json({ error: 'Scrivi una richiesta valida (max 600 caratteri).' });
      }
      const updated = await mutate('data/ai_requests.json', c => {
        c.push({ id: newId(), member: memberId, nick, text: text.trim(), status: 'pending', ts: now });
      }, `${nick}: nuova richiesta modifiche IA`);
      return res.status(200).json({ ok: true, aiRequests: updated });
    }

    if (action === 'addMealPost') {
      const { slotId, text } = body;
      if (!slotId || !text || String(text).length > 1000) return res.status(400).json({ error: 'testo mancante o troppo lungo' });
      const updated = await mutate('data/meals.json', c => {
        const slot = (c.slots || []).find(s => s.id === slotId);
        if (!slot) throw new Error('slot non trovato');
        slot.posts.push({ id: newId(), member: memberId, nick, text: String(text).trim(), ts: now });
      }, `${nick}: post pasto ${slotId}`);
      return res.status(200).json({ ok: true, meals: updated });
    }

    if (action === 'delMealPost') {
      const { slotId, postId } = body;
      const updated = await mutate('data/meals.json', c => {
        const slot = (c.slots || []).find(s => s.id === slotId);
        if (!slot) return false;
        const i = slot.posts.findIndex(p => p.id === postId && p.member === memberId);
        if (i === -1) return false;
        slot.posts.splice(i, 1);
      }, `${nick}: rimosso post pasto`);
      return res.status(200).json({ ok: true, meals: updated });
    }

    if (action === 'addComment') {
      const { lat, lng, text } = body;
      if (typeof lat !== 'number' || typeof lng !== 'number' || !text || String(text).length > 600) {
        return res.status(400).json({ error: 'dati non validi' });
      }
      const updated = await mutate('data/comments.json', c => {
        c.push({ id: newId(), member: memberId, nick, lat, lng, text: String(text).trim(), ts: now });
      }, `${nick}: commento sulla mappa`);
      return res.status(200).json({ ok: true, comments: updated });
    }

    if (action === 'delComment') {
      const { commentId } = body;
      const updated = await mutate('data/comments.json', c => {
        const i = c.findIndex(x => x.id === commentId && x.member === memberId);
        if (i === -1) return false;
        c.splice(i, 1);
      }, `${nick}: rimosso commento`);
      return res.status(200).json({ ok: true, comments: updated });
    }

    if (action === 'addCheckin') {
      const { lat, lng, note } = body;
      if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'posizione non valida' });
      const updated = await mutate('data/checkins.json', c => {
        c.push({ id: newId(), member: memberId, nick, lat, lng, note: String(note || '').slice(0, 200), ts: now });
      }, `${nick}: check-in posizione`);
      return res.status(200).json({ ok: true, checkins: updated });
    }

    if (action === 'delCheckin') {
      const { checkinId } = body;
      const updated = await mutate('data/checkins.json', c => {
        const i = c.findIndex(x => x.id === checkinId && x.member === memberId);
        if (i === -1) return false;
        c.splice(i, 1);
      }, `${nick}: rimosso check-in`);
      return res.status(200).json({ ok: true, checkins: updated });
    }

    return res.status(400).json({ error: 'azione non valida' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
}
