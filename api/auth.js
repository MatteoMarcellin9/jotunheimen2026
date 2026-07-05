// API di autenticazione — login con codice personale + rigenerazione (admin)
import crypto from 'crypto';

const GH_TOKEN = process.env.GH_TOKEN;
const SECRET = process.env.SESSION_SECRET;
const REPO = process.env.GH_REPO || 'MatteoMarcellin9/jotunheimen2026';
const MEMBERS_PATH = 'data/members.json';
const TOKEN_DAYS = 90;

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

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

export function makeToken(memberId) {
  const exp = Date.now() + TOKEN_DAYS * 86400000;
  const payload = `${memberId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  if (sign(`${id}.${exp}`) !== sig) return null;
  if (Date.now() > Number(exp)) return null;
  return id;
}

function genCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let raw = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) raw += A[bytes[i] % A.length];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function hashCode(salt, code) {
  return crypto.createHash('sha256').update(salt + code).digest('hex');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!GH_TOKEN || !SECRET) return res.status(500).json({ error: 'Configurazione incompleta: mancano le variabili GH_TOKEN / SESSION_SECRET su Vercel.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { action } = body || {};

  try {
    if (action === 'login') {
      const { member, code } = body;
      const { content } = await ghGet(MEMBERS_PATH);
      const m = content.members.find(x => x.id === member);
      if (!m) return res.status(401).json({ error: 'Membro non trovato.' });
      const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const formatted = clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : String(code || '').toUpperCase().trim();
      if (hashCode(m.salt, formatted) !== m.hash) return res.status(401).json({ error: 'Codice errato.' });
      return res.status(200).json({
        token: makeToken(m.id),
        me: { id: m.id, nick: m.nick, name: m.name, admin: !!m.admin }
      });
    }

    if (action === 'verify') {
      const id = verifyToken(body.token);
      if (!id) return res.status(401).json({ error: 'Sessione scaduta, rifai il login.' });
      const { content } = await ghGet(MEMBERS_PATH);
      const m = content.members.find(x => x.id === id);
      if (!m) return res.status(401).json({ error: 'Membro non trovato.' });
      return res.status(200).json({ me: { id: m.id, nick: m.nick, name: m.name, admin: !!m.admin } });
    }

    if (action === 'regenerate') {
      const id = verifyToken(body.token);
      if (!id) return res.status(401).json({ error: 'Sessione scaduta.' });
      const { target } = body;
      // fino a 2 tentativi per gestire SHA conflict
      for (let attempt = 0; attempt < 2; attempt++) {
        const { content, sha } = await ghGet(MEMBERS_PATH);
        const caller = content.members.find(x => x.id === id);
        if (!caller || !caller.admin) return res.status(403).json({ error: 'Solo gli admin possono rigenerare i codici.' });
        const t = content.members.find(x => x.id === target);
        if (!t) return res.status(404).json({ error: 'Membro target non trovato.' });
        const newCode = genCode();
        t.salt = crypto.randomBytes(8).toString('hex');
        t.hash = hashCode(t.salt, newCode);
        try {
          await ghPut(MEMBERS_PATH, content, sha, `Rigenera codice per ${t.nick}`);
          return res.status(200).json({ code: newCode, nick: t.nick });
        } catch (e) {
          if (attempt === 1) throw e;
        }
      }
    }

    if (action === 'resetChoices') {
      const id = verifyToken(body.token);
      if (!id) return res.status(401).json({ error: 'Sessione scaduta.' });
      const { target } = body;
      // verifica admin dal file membri
      const mem = await ghGet(MEMBERS_PATH);
      const caller = mem.content.members.find(x => x.id === id);
      if (!caller || !caller.admin) return res.status(403).json({ error: 'Solo gli admin possono resettare le scelte.' });
      const t = mem.content.members.find(x => x.id === target);
      if (!t) return res.status(404).json({ error: 'Membro target non trovato.' });
      // cancella le scelte del target da choices.json (con retry su conflitto SHA)
      const CHOICES_PATH = 'data/choices.json';
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${CHOICES_PATH}?ref=main`, { headers: GH_HEADERS() });
        if (!r.ok) throw new Error(`GH GET choices: ${r.status}`);
        const d = await r.json();
        const choices = JSON.parse(Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf-8'));
        if (!choices[target]) return res.status(200).json({ ok: true, nick: t.nick, alreadyEmpty: true });
        delete choices[target];
        const body2 = {
          message: `Reset scelte di ${t.nick}`,
          content: Buffer.from(JSON.stringify(choices, null, 1), 'utf-8').toString('base64'),
          sha: d.sha, branch: 'main'
        };
        const pr = await fetch(`https://api.github.com/repos/${REPO}/contents/${CHOICES_PATH}`, {
          method: 'PUT', headers: { ...GH_HEADERS(), 'Content-Type': 'application/json' }, body: JSON.stringify(body2)
        });
        if (pr.ok) return res.status(200).json({ ok: true, nick: t.nick });
        if (attempt === 2) { const tx = await pr.text(); throw new Error(`GH PUT choices: ${pr.status} ${tx.slice(0,150)}`); }
        await new Promise(r => setTimeout(r, 300 + attempt * 400));
      }
    }

    return res.status(400).json({ error: 'Azione non valida.' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
}
