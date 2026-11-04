const config = require('./config');

const BASE = 'https://api.groq.com/openai/v1';
let model = null;
let lastCall = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[groq]', ...a);

function headers() {
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.groqKey };
}

// Ask Groq which models exist, so a wrong/old model name can never cause a 404 again
async function pickModel(force = false) {
  if (model && !force) return model;
  const res = await fetch(BASE + '/models', { headers: headers(), signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const t = (await res.text()).slice(0, 150);
    if (res.status === 401) throw new Error('401 invalid GROQ_API_KEY (it should start with gsk_)');
    throw new Error('models ' + res.status + ' ' + t);
  }
  const data = await res.json();
  const ids = (data.data || [])
    .map((m) => m.id)
    .filter((id) => !/whisper|guard|tts|embed|orpheus|playai|moderation/i.test(id));
  log('available models:', ids.slice(0, 20).join(', '));
  model = null;
  if (config.groqModel && ids.includes(config.groqModel)) {
    model = config.groqModel;
  } else {
    if (config.groqModel) log('model "' + config.groqModel + '" not found, choosing another');
    const prefs = [/llama-3\.3-70b/i, /llama-4/i, /llama-3\.1-8b/i, /gpt-oss/i, /llama/i, /qwen/i];
    for (const p of prefs) {
      const hit = ids.find((id) => p.test(id));
      if (hit) {
        model = hit;
        break;
      }
    }
    if (!model) model = ids[0];
  }
  if (!model) throw new Error('no usable model found');
  log('using model:', model);
  return model;
}

async function complete(messages, wantJson = true) {
  const wait = 2200 - (Date.now() - lastCall); // stay far below the free rate limit
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  let m = await pickModel();
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = { model: m, messages, temperature: 0.6, max_tokens: 350 };
    if (wantJson) body.response_format = { type: 'json_object' };
    const res = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    if (res.ok) {
      const data = await res.json();
      return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    }
    const text = (await res.text()).slice(0, 300);
    log('error', res.status, text);
    if (res.status === 401) throw new Error('401 invalid GROQ_API_KEY');
    if (res.status === 429) {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    if (res.status === 404 || (res.status === 400 && /not found|decommission|does not exist/i.test(text))) {
      m = await pickModel(true);
      continue;
    }
    if (res.status === 400 && wantJson) {
      wantJson = false; // this model may not support JSON mode
      continue;
    }
    throw new Error('Groq ' + res.status);
  }
  throw new Error('Groq failed after retries');
}

// ---------- pure helpers (no network) ----------
function parseReply(text) {
  let say = '';
  let action = { type: 'none' };
  const t = String(text || '').trim();
  try {
    const m = t.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : t);
    say = typeof j.say === 'string' ? j.say : '';
    if (j.action && typeof j.action === 'object') action = j.action;
  } catch (e) {
    say = t.replace(/[{}"]/g, '').slice(0, 180);
  }
  return { say, action };
}

const TYPES = ['none', 'follow', 'stay', 'auto', 'come', 'gather', 'give'];
const WHAT = ['wood', 'stone', 'coal', 'iron', 'diamond', 'food'];

// The AI can only pick from this fixed menu, and only the owner can trigger actions
function sanitizeAction(a, isOwner) {
  if (!isOwner || !a || typeof a !== 'object') return { type: 'none' };
  const type = String(a.type || 'none').toLowerCase();
  if (!TYPES.includes(type)) return { type: 'none' };
  const out = { type };
  if (type === 'gather') {
    const w = String(a.what || '').toLowerCase();
    if (!WHAT.includes(w)) return { type: 'none' };
    out.what = w;
  }
  if (type === 'gather' || type === 'give') {
    let c = parseInt(a.count, 10);
    if (!Number.isFinite(c)) c = type === 'gather' ? 8 : 0;
    out.count = Math.max(0, Math.min(c, 64));
  }
  if (type === 'give') {
    out.item = String(a.item || '')
      .toLowerCase()
      .replace(/[^a-z_ ]/g, '')
      .trim()
      .replace(/ /g, '_')
      .slice(0, 40);
    if (!out.item) return { type: 'none' };
  }
  return out;
}

module.exports = { pickModel, complete, parseReply, sanitizeAction };
