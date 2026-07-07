// Libreria condivisa dell'agente "Modifiche IA".
// Usata sia da api/ai-agent.js (chiamato dal cron esterno 4x/giorno, elabora tutte le richieste
// in coda) sia da api/data.js (innesco immediato: elabora subito la singola richiesta appena
// inviata). Tenere la logica in un solo posto evita di doverla mantenere doppia.
//
// Design in due fasi per contenere i costi:
//  Fase 1 "classifica" — chiamata leggera, senza contenuto dei file: decide la categoria.
//  Fase 2 "edita" — chiamata con il file completo come contesto, SOLO se la fase 1 ha deciso
//  che serve un edit_text. Le altre categorie (colore, checklist, to-do, non gestibile) non
//  pagano mai il costo del contesto pesante.

const GH_TOKEN = process.env.GH_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const REPO = process.env.GH_REPO || 'MatteoMarcellin9/jotunheimen2026';
const MODEL = 'claude-sonnet-4-6';

const GH_HEADERS = () => ({
  'Authorization': `token ${GH_TOKEN}`,
  'User-Agent': 'jotunheimen2026-agent',
  'Accept': 'application/vnd.github+json'
});

export async function ghGet(path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=main`, { headers: GH_HEADERS() });
  if (!r.ok) throw new Error(`GH GET ${path}: ${r.status}`);
  const d = await r.json();
  return { text: Buffer.from(d.content.replace(/\n/g, ''), 'base64').toString('utf-8'), sha: d.sha };
}
export async function ghGetJson(path) {
  const { text, sha } = await ghGet(path);
  return { content: JSON.parse(text), sha };
}
export async function ghPutText(path, text, sha, message) {
  const body = { message, content: Buffer.from(text, 'utf-8').toString('base64'), branch: 'main' };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT', headers: { ...GH_HEADERS(), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`GH PUT ${path}: ${r.status} ${t.slice(0, 200)}`); }
  return r.json();
}
export async function mutateJson(path, fn, message) {
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
export async function mutateText(path, mutateFn, message) {
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

// ---------- derivazione colori (un solo hex di base -> palette coerente a 4 livelli) ----------
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
export function derivePalette(baseHex) {
  const [h, s] = hexToHsl(baseHex);
  const sat = Math.min(55, Math.max(28, s));
  return {
    navy: hslToHex(h, sat + 8, 28),
    blue: hslToHex(h, sat + 4, 42),
    sky: hslToHex(h, sat, 54),
    skyLight: hslToHex(h, Math.min(sat, 35), 94)
  };
}
export function replaceRootVars(fileText, pal) {
  return fileText.replace(
    /--navy:#[0-9a-fA-F]{6};\s*--blue:#[0-9a-fA-F]{6};\s*--sky:#[0-9a-fA-F]{6};\s*--sky-light:#[0-9a-fA-F]{6};/,
    `--navy:${pal.navy}; --blue:${pal.blue}; --sky:${pal.sky}; --sky-light:${pal.skyLight};`
  );
}

// ---------- difesa in profondità: blocco per parola chiave, oltre all'allowlist strutturale ----------
export const BLOCK_PATTERNS = /codice di accesso|password|credenzial|elimina tutt|cancella tutt|reset.*codic|members\.json|api\/auth|hash\b|token\b/i;

// ---------- estrazione JSON robusta: conta le parentesi graffe invece di "dal primo all'ultimo" ----------
export function extractJson(rawText) {
  let text = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const startIdx = text.indexOf('{');
  if (startIdx === -1) throw new Error('Nessun oggetto JSON nella risposta del modello.');
  let depth = 0, inStr = false, esc = false, endIdx = -1;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  if (endIdx === -1) throw new Error('JSON non bilanciato nella risposta del modello.');
  return JSON.parse(text.slice(startIdx, endIdx + 1));
}

// ---------- chiamata a Claude ----------
async function callClaude(system, user, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens || 400, system, messages: [{ role: 'user', content: user }] })
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`Anthropic API ${r.status}: ${t.slice(0, 200)}`); }
  const data = await r.json();
  return extractJson(data.content?.[0]?.text || '');
}

// ---------- FASE 1: classificazione leggera (nessun file allegato) ----------
const CLASSIFY_PROMPT = `Classifichi richieste di modifica per il sito di gruppo di un trekking in Norvegia (Jotunheimen 2026).
Rispondi SOLO con un oggetto JSON valido, nient'altro: niente markdown, niente backtick, niente testo prima o dopo. La risposta intera deve iniziare con { e finire con }. Schema possibile:

{"action": "recolor" | "checklist_item" | "todo_item" | "text_edit" | "unsupported", ...campi}

- "recolor": {"action":"recolor","base_hex":"#RRGGBB"} — un solo colore di base equilibrato che rappresenti l'intento (es. "fai il sito rosso" -> un rosso non acceso).
- "checklist_item": {"action":"checklist_item","category":"nome categoria esistente più simile","item":"testo voce","list":"req"|"opt"}.
- "todo_item": {"action":"todo_item","category":"nome categoria esistente più simile","item":"testo voce"}.
- "text_edit": {"action":"text_edit","file":"gruppo"|"index","hint":"breve descrizione di cosa cercare/cambiare, in italiano"} — per piccoli cambi di testo/contenuto (es. rinominare qualcosa, correggere una frase). Non provare a indovinare il testo esatto qui: verrà recuperato in un secondo passaggio con il file davanti.
- "unsupported": {"action":"unsupported","reason":"breve spiegazione in italiano"} — usa SEMPRE questo se la richiesta tocca autenticazione, codici di accesso, dati personali sensibili, cancellazioni, configurazione di deploy, struttura/funzionalità nuove complesse, o qualunque cosa ambigua o rischiosa.

Sii conservativo: nel dubbio, "unsupported".`;

// ---------- FASE 2: editing con il file come contesto (solo per text_edit) ----------
const EDIT_PROMPT = `Devi produrre una modifica di testo precisa per un file HTML di un sito. Rispondi SOLO con un oggetto JSON valido, nient'altro. Schema:

{"old_str":"...","new_str":"..."} oppure {"unsupported":true,"reason":"..."}

old_str DEVE essere una sotto-stringa ESATTA e UNICA presente nel file fornito, copiata carattere per carattere (compresi spazi, apici, maiuscole). Se non trovi un punto esatto, sicuro e univoco da modificare, rispondi con {"unsupported":true,"reason":"..."}.`;

function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function escapeJsString(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

// ---------- elabora UNA richiesta e restituisce {status, summary} — non tocca ai_requests.json ----------
export async function processOneRequest(reqItem) {
  if (BLOCK_PATTERNS.test(reqItem.text)) {
    return { status: 'rejected', summary: 'Richiesta bloccata: riguarda autenticazione, credenziali o cancellazioni — serve un intervento diretto in chat con Claude.' };
  }

  let plan;
  try {
    plan = await callClaude(CLASSIFY_PROMPT, `Richiesta di ${reqItem.nick}: "${reqItem.text}"`, 250);
  } catch (e) {
    return { status: 'error', summary: `Errore di classificazione: ${String(e.message || e).slice(0, 150)}` };
  }

  try {
    if (plan.action === 'recolor') {
      const pal = derivePalette(plan.base_hex);
      const r1 = await mutateText('public/gruppo.html', t => replaceRootVars(t, pal), `Modifiche IA: ricolora sito (richiesta di ${reqItem.nick})`);
      const r2 = await mutateText('public/index.html', t => replaceRootVars(t, pal), `Modifiche IA: ricolora sito (richiesta di ${reqItem.nick})`);
      return (r1.applied || r2.applied)
        ? { status: 'done', summary: `Palette aggiornata (base ${plan.base_hex}).` }
        : { status: 'error', summary: 'Non sono riuscito a individuare le variabili colore nel file.' };
    }

    if (plan.action === 'checklist_item' || plan.action === 'todo_item') {
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
      return r.applied
        ? { status: 'done', summary: `Aggiunta "${plan.item}" a ${plan.category}.` }
        : { status: 'error', summary: `Categoria "${plan.category}" non trovata esattamente — riprova specificando meglio il nome.` };
    }

    if (plan.action === 'text_edit') {
      const target = plan.file === 'index' ? 'public/index.html' : 'public/gruppo.html';
      const { text: fileText } = await ghGet(target);
      let editPlan;
      try {
        editPlan = await callClaude(EDIT_PROMPT,
          `Richiesta originale di ${reqItem.nick}: "${reqItem.text}"\nIndicazione: ${plan.hint || ''}\n\n--- Contenuto del file ${target} ---\n${fileText}`,
          800);
      } catch (e) {
        return { status: 'error', summary: `Errore nella modifica del testo: ${String(e.message || e).slice(0, 150)}` };
      }
      if (editPlan.unsupported || !editPlan.old_str || !editPlan.new_str) {
        return { status: 'manual', summary: editPlan.reason || 'Non ho trovato un punto sicuro e univoco da modificare: serve chiederlo a Claude in chat.' };
      }
      const r = await mutateText(target, t => {
        const count = t.split(editPlan.old_str).length - 1;
        if (count !== 1) return null;
        return t.split(editPlan.old_str).join(editPlan.new_str);
      }, `Modifiche IA: modifica testo (richiesta di ${reqItem.nick})`);
      return r.applied
        ? { status: 'done', summary: 'Testo aggiornato.' }
        : { status: 'error', summary: 'Il punto esatto da modificare non è stato trovato in modo univoco nel file (potrebbe essere cambiato nel frattempo).' };
    }

    return { status: 'manual', summary: plan.reason || 'Richiesta fuori dalle categorie gestite in autonomia: serve chiederlo a Claude in chat.' };
  } catch (e) {
    return { status: 'error', summary: String(e.message || e).slice(0, 200) };
  }
}

// ---------- salva l'esito di UNA richiesta in data/ai_requests.json (SHA fresco ad ogni tentativo) ----------
export async function saveRequestOutcome(id, outcome) {
  return mutateJson('data/ai_requests.json', list => {
    const item = list.find(x => x.id === id);
    if (!item) return false;
    item.status = outcome.status;
    item.summary = outcome.summary;
    item.resolvedTs = Date.now();
  }, `Modifiche IA: esito richiesta ${id}`);
}
