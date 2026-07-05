// API foto — riceve immagini compresse lato client e le salva nel repo
import crypto from 'crypto';

const GH_TOKEN = process.env.GH_TOKEN;
const SECRET = process.env.SESSION_SECRET;
const REPO = process.env.GH_REPO || 'MatteoMarcellin9/jotunheimen2026';
const MAX_B64 = 1800000; // ~1.3 MB binari

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

async function ghPutRaw(path, base64Content, message) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { ...GH_HEADERS(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: base64Content, branch: 'main' })
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`GH PUT ${path}: ${r.status} ${t.slice(0, 200)}`); }
  return r.json();
}

async function ghPutJson(path, obj, sha, message) {
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!GH_TOKEN || !SECRET) return res.status(500).json({ error: 'Configurazione incompleta su Vercel.' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const memberId = verifyToken(body.token);
    if (!memberId) return res.status(401).json({ error: 'Sessione scaduta, rifai il login.' });

    const { action } = body;

    if (action === 'upload') {
      const { lat, lng, caption, dataUrl, nick } = body;
      if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'posizione mancante' });
      if (!dataUrl || !dataUrl.startsWith('data:image/jpeg;base64,')) return res.status(400).json({ error: 'immagine non valida (serve JPEG)' });
      const b64 = dataUrl.split(',')[1];
      if (!b64 || b64.length > MAX_B64) return res.status(400).json({ error: 'immagine troppo grande (max ~1.3 MB)' });

      const ts = Date.now();
      const filename = `${ts}_${memberId}.jpg`;
      const filePath = `public/photos/${filename}`;

      // 1) salva il file immagine
      await ghPutRaw(filePath, b64, `Foto di ${nick || memberId}`);

      // 2) aggiorna photos.json (con retry su conflitto)
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { content, sha } = await ghGet('data/photos.json');
          content.push({
            id: ts.toString(36),
            member: memberId,
            nick: String(nick || memberId),
            lat, lng,
            caption: String(caption || '').slice(0, 300),
            file: `/photos/${filename}`,
            ts
          });
          await ghPutJson('data/photos.json', content, sha, `${nick || memberId}: nuova foto`);
          return res.status(200).json({ ok: true, photos: content });
        } catch (e) {
          lastErr = e;
          await new Promise(r => setTimeout(r, 300 + attempt * 400));
        }
      }
      throw lastErr;
    }

    if (action === 'delete') {
      const { photoId } = body;
      // rimuove solo la voce dal registro (il file resta nel repo, non è un problema)
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { content, sha } = await ghGet('data/photos.json');
          const i = content.findIndex(p => p.id === photoId && p.member === memberId);
          if (i === -1) return res.status(404).json({ error: 'foto non trovata o non tua' });
          content.splice(i, 1);
          await ghPutJson('data/photos.json', content, sha, `${memberId}: rimossa foto`);
          return res.status(200).json({ ok: true, photos: content });
        } catch (e) {
          lastErr = e;
          await new Promise(r => setTimeout(r, 300 + attempt * 400));
        }
      }
      throw lastErr;
    }

    return res.status(400).json({ error: 'azione non valida' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
}
