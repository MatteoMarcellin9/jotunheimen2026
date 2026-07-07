// API agente "Modifiche IA" — chiamato dallo scheduler esterno (GitHub Actions) come rete di
// sicurezza, 4 volte al giorno. Elabora tutte le richieste rimaste in coda: normalmente saranno
// poche o nessuna, perché la maggior parte viene già gestita all'istante da api/data.js appena
// la richiesta viene inviata (vedi azione 'addAiRequest'). Questo passaggio esiste per recuperare
// eventuali richieste che l'innesco immediato non fosse riuscito a completare (es. un errore
// temporaneo dell'API, o un timeout).

import { ghGetJson, processOneRequest, saveRequestOutcome } from './_lib/agentCore.js';

const AGENT_SECRET = process.env.AGENT_CRON_SECRET;
const GH_TOKEN = process.env.GH_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

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

    for (const reqItem of pending) {
      results.processed++;
      const outcome = await processOneRequest(reqItem);
      results[outcome.status]++;
      await saveRequestOutcome(reqItem.id, outcome);
    }

    return res.status(200).json({ ok: true, ...results });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 300), ...results });
  }
}
