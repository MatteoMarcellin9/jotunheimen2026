// API agente "Modifiche IA" — chiamato da uno scheduler esterno (GitHub Actions) 4 volte al giorno.
// Legge le richieste in coda, chiede a Claude di interpretarle in una delle categorie sicure
// supportate, e applica la modifica direttamente sul repo. Qualunque richiesta che non rientri
// nelle categorie previste viene marcata "manuale" e NON tocca il codice: resta in attesa di
// un intervento diretto in chat. L'agente non ha nessun percorso di codice che scriva su
// api/*.js, data/members.json o vercel.json — non è una questione di permessi negati a runtime,
// è che quelle azioni semplicemente non esistono in questo file.

const GH_TOKEN = process.env.GH_TOKEN;
const AGENT_SECRET = process.env.AGENT_CRON_SECRET;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const REPO = process.env.GH_REPO || 'MatteoMarcellin9/jotunheimen2026';

const GH_HEADERS = () => ({
  'Authorization': `token ${GH_TOKEN}`,
  'User-Agent': 'jotunheimen2026-agent',
  'Accept': 'application/vnd.github+json'
});

async function ghGet(path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=main`, { headers: GH_HEADERS() });
  if (!r.ok) throw new Error(`GH GET ${path}: ${r.status}`);
  const d = await r.json();
  return { text: Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf-8'), sha: d.sha, raw: d };
}
async function ghGetJson(path) {
  const { text, sha } = await ghGet(path);
  return { content: JSON.parse(text), sha };
}
async function ghPutText(path, text, sha, message) {
  const body = { message, content: Buffer.from(text, 'utf-8').toString('base64'), branch: 'main' };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT', headers: { ...GH_HEADERS(), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`GH PUT ${path}: ${r.status} ${t.slice(0, 200)}`); }
  return r.json();
}

// scrittura con retry su conflitto SHA (rilegge fresco prima di ogni tentativo)
async function mutateJson(path, fn, message) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { content, sha } = await ghGetJson(path);
    const changed = fn(content);
    if (changed === false) return content;
    try { await ghPutText(path, JSON.stringify(content, null, 1), sha, message); return content; }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 300 + attempt * 400)); }
  }
  throw lastErr;
}
async function mutateText(path, mutateFn, message) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { text, sha } = await ghGet(path);
    const newText = mutateFn(text);
    if (newText === null) return { applied: false };
    try { await ghPutText(path, newText, sha, message); return { applied: true }; }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 300 + attempt * 400)); }
  }
  throw lastErr;
}

// ---------- derivazione colori (l'agente non inventa 4 hex scoordinati: ne calcola 1 e deriva il resto) ----------
function hexToHsl(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}
function hslToHex(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1/6) return p + (q-p)*6*t; if (t < 1/2) return q; if (t < 2/3) return p + (q-p)*(2/3-t)*6; return p; };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1/3);
  }
  const toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}
function derivePalette(baseHex) {
  const [h, s] = hexToHsl(baseHex);
  const sat = Math.min(55, Math.max(28, s));
  return {
    navy: hslToHex(h, sat + 8, 28),
    blue: hslToHex(h, sat + 4, 42),
    sky: hslToHex(h, sat, 54),
    skyLight: hslToHex(h, Math.min(sat, 35), 94)
  };
}
function replaceRootVars(fileText, pal) {
  return fileText.replace(
    /--navy:#[0-9a-fA-F]{6};\s*--blue:#[0-9a-fA-F]{6};\s*--sky:#[0-9a-fA-F]{6};\s*--sky-light:#[0-9a-fA-F]{6};/,
    `--navy:${pal.navy}; --blue:${pal.blue}; --sky:${pal.sky}; --sky-light:${pal.skyLight};`
  );
}

// ---------- verifica strutturale extra (difesa in profondità, non l'unica barriera) ----------
const BLOCK_PATTERNS = /codice di accesso|password|credenzial|elimina tutt|cancella tutt|reset.*codic|members\.json|api\/auth|hash|admin\b.*rimuov/i;

// ---------- chiamata a Claude ----------
async function callClaude(system, user) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: user }, { role: 'assistant', content: '{' }]
    })
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`Anthropic API ${r.status}: ${t.slice(0, 200)}`); }
  const data = await r.json();
  const text = '{' + (data.content?.[0]?.text || '');
  return JSON.parse(text);
}

const SYSTEM_PROMPT = `Interpreti richieste di modifica per il sito di gruppo di un trekking in Norvegia (Jotunheimen 2026).
Rispondi SOLO con un oggetto JSON valido, nient'altro (niente markdown, niente prosa). Schema:

{"action": "recolor" | "edit_text" | "checklist_item" | "todo_item" | "unsupported", ...campi specifici}

- "recolor": {"action":"recolor","base_hex":"#RRGGBB"} — un solo colore di base che rappresenti l'intento (es. "fai il sito rosso" -> un rosso equilibrato, non acceso).
- "edit_text": {"action":"edit_text","file":"gruppo"|"index","old_str":"...","new_str":"..."} — old_str DEVE essere una sotto-stringa ESATTA e UNICA presente nel file fornito, copiata carattere per carattere. Usa questa azione solo per piccole modifiche testuali di contenuto (non stile, non struttura). Se non trovi un punto esatto e sicuro da modificare, usa "unsupported".
- "checklist_item": {"action":"checklist_item","category":"nome categoria esistente più simile","item":"testo voce","list":"req"|"opt"} — per aggiungere una voce alla checklist personale.
- "todo_item": {"action":"todo_item","category":"nome categoria esistente più simile","item":"testo voce"} — per aggiungere una voce alla lista "da fare prima di partire".
- "unsupported": {"action":"unsupported","reason":"breve spiegazione in italiano"} — usa SEMPRE questo se la richiesta tocca autenticazione, codici di accesso, dati personali, cancellazioni, configurazione di deploy, o qualunque cosa ambigua o rischiosa, o se semplicemente non rientra bene nelle categorie sopra.

Non inventare mai contenuto non richiesto. Sii conservativo: nel dubbio, "unsupported".`;

export default async function handler(req, res) {
  const auth = req.headers['authorization'] || '';
  if (!AGENT_SECRET || auth !== `Bearer ${AGENT_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!GH_TOKEN || !ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'Configurazione incompleta: mancano GH_TOKEN o ANTHROPIC_API_KEY su Vercel.' });
  }

  const results = { processed: 0, done: 0, rejected: 0, error: 0, manual: 0 };

  try {
    const { content: requests } = await ghGetJson('data/ai_requests.json');
    const pending = requests.filter(r => r.status === 'pending');
    if (!pending.length) return res.status(200).json({ ok: true, ...results, note: 'nessuna richiesta in attesa' });

    // carica una volta i due file HTML come contesto per edit_text
    const [gruppoFile, indexFile] = await Promise.all([ghGet('public/gruppo.html'), ghGet('public/index.html')]);
    const fileText = { gruppo: gruppoFile.text, index: indexFile.text };

    for (const reqItem of pending) {
      results.processed++;
      let outcome = { status: 'error', summary: 'Errore imprevisto.' };

      try {
        if (BLOCK_PATTERNS.test(reqItem.text)) {
          outcome = { status: 'rejected', summary: 'Richiesta bloccata: riguarda autenticazione, credenziali o cancellazioni — serve un intervento diretto in chat con Claude.' };
        } else {
          const plan = await callClaude(SYSTEM_PROMPT,
            `Richiesta di ${reqItem.nick}: "${reqItem.text}"\n\n` +
            `--- Contenuto attuale di public/gruppo.html (per edit_text, cerca qui una sotto-stringa esatta) ---\n${fileText.gruppo.slice(0, 60000)}`
          );

          if (plan.action === 'recolor') {
            const pal = derivePalette(plan.base_hex);
            const r1 = await mutateText('public/gruppo.html', t => replaceRootVars(t, pal), `Modifiche IA: ricolora sito (richiesta di ${reqItem.nick})`);
            const r2 = await mutateText('public/index.html', t => replaceRootVars(t, pal), `Modifiche IA: ricolora sito (richiesta di ${reqItem.nick})`);
            outcome = (r1.applied || r2.applied)
              ? { status: 'done', summary: `Palette aggiornata (base ${plan.base_hex}).` }
              : { status: 'error', summary: 'Non sono riuscito a individuare le variabili colore nel file.' };

          } else if (plan.action === 'edit_text') {
            const target = plan.file === 'index' ? 'public/index.html' : 'public/gruppo.html';
            const r = await mutateText(target, t => {
              const count = t.split(plan.old_str).length - 1;
              if (count !== 1) return null;
              return t.split(plan.old_str).join(plan.new_str);
            }, `Modifiche IA: modifica testo (richiesta di ${reqItem.nick})`);
            outcome = r.applied
              ? { status: 'done', summary: 'Testo aggiornato.' }
              : { status: 'error', summary: 'Il punto esatto da modificare non è stato trovato in modo univoco nel file.' };

          } else if (plan.action === 'checklist_item' || plan.action === 'todo_item') {
            const isChecklist = plan.action === 'checklist_item';
            const arrName = isChecklist ? 'CHECKLIST' : 'TODO';
            const listKey = isChecklist ? (plan.list === 'opt' ? 'opt' : 'req') : 'items';
            const r = await mutateText('public/gruppo.html', t => {
              const catRegex = new RegExp(`(cat:'${escapeReg(plan.category)}'[\\s\\S]*?${listKey}:\\[)([^\\]]*)(\\])`);
              if (!catRegex.test(t)) return null;
              return t.replace(catRegex, (m, pre, list, post) => {
                const sep = list.trim().length ? ',' : '';
                return `${pre}${list}${sep}'${escapeJsString(plan.item)}'${post}`;
              });
            }, `Modifiche IA: aggiunta voce ${arrName} (richiesta di ${reqItem.nick})`);
            outcome = r.applied
              ? { status: 'done', summary: `Aggiunta "${plan.item}" a ${plan.category}.` }
              : { status: 'error', summary: `Categoria "${plan.category}" non trovata esattamente — riprova specificando meglio il nome.` };

          } else {
            outcome = { status: 'manual', summary: plan.reason || 'Richiesta fuori dalle categorie gestite in autonomia: serve chiederlo a Claude in chat.' };
          }
        }
      } catch (e) {
        outcome = { status: 'error', summary: String(e.message || e).slice(0, 200) };
      }

      results[outcome.status === 'manual' ? 'manual' : outcome.status]++;
      // salva subito lo stato di QUESTA richiesta (SHA fresco ogni volta, per non perdere gli esiti precedenti del batch)
      await mutateJson('data/ai_requests.json', list => {
        const item = list.find(x => x.id === reqItem.id);
        if (!item) return false;
        item.status = outcome.status;
        item.summary = outcome.summary;
        item.resolvedTs = Date.now();
      }, `Modifiche IA: esito richiesta di ${reqItem.nick}`);
    }

    return res.status(200).json({ ok: true, ...results });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 300), ...results });
  }
}

function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function escapeJsString(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
