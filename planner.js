// Groq decides the big plan: what to do next. Reflexes (fight, eat, flee, sleep) stay in code
// because an API call takes seconds and a monster does not wait.
const { goals } = require('mineflayer-pathfinder');
const config = require('./config');
const U = require('./utils');
const G = require('./goals');
const C = require('./combat');
const S = require('./survival');
const groq = require('./groq');
const { log, sleep } = U;

const ENABLED = (process.env.AI_CONTROL || 'true').toLowerCase() !== 'false';
const WHAT = ['wood', 'stone', 'coal', 'iron', 'diamond', 'food'];
const ANIMALS = ['cow', 'pig', 'sheep', 'chicken'];

const TIERS = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];
function tier(bot) {
  let t = 0;
  for (const it of bot.inventory.items()) {
    const m = it.name.match(/^(wooden|stone|iron|diamond|netherite)_pickaxe$/);
    if (m) t = Math.max(t, TIERS.indexOf(m[1]) + 1);
  }
  return t;
}
const NEED_TIER = { wood: 0, food: 0, stone: 1, coal: 1, iron: 2, diamond: 3 };
const COUNT = {
  wood: (b) => U.invRe(b, /_log$/) + Math.floor(U.invRe(b, /_planks$/) / 4),
  stone: (b) => U.inv(b, 'cobblestone') + U.inv(b, 'cobbled_deepslate'),
  coal: (b) => U.inv(b, 'coal') + U.inv(b, 'charcoal'),
  iron: (b) => U.inv(b, 'raw_iron') + U.inv(b, 'iron_ore') + U.inv(b, 'iron_ingot'),
  diamond: (b) => U.inv(b, 'diamond'),
  food: (b) => S.foodCount(b),
};

const recent = []; // what I did lately, with the result
let lastPlan = 0;
let lastChat = 0;
let failStreak = 0;

const num = (v, d, lo, hi) => {
  const n = parseInt(v, 10);
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : d));
};

// the AI can only choose from this fixed menu
function clean(a) {
  const type = String((a && a.type) || 'none').toLowerCase();
  switch (type) {
    case 'auto':
      return { type, secs: num(a.secs !== undefined ? a.secs : a.count, 120, 30, 300) };
    case 'gather': {
      const w = String(a.what || '').toLowerCase();
      return WHAT.includes(w) ? { type, what: w, count: num(a.count, 8, 1, 64) } : { type: 'none' };
    }
    case 'hunt': {
      const an = String(a.animal || a.what || '').toLowerCase();
      return { type, animal: ANIMALS.includes(an) ? an : null };
    }
    case 'explore':
      return { type };
    case 'follow_owner':
      return { type, secs: num(a.secs !== undefined ? a.secs : a.count, 60, 15, 90) };
    case 'wait':
      return { type, secs: num(a.secs !== undefined ? a.secs : a.count, 10, 5, 30) };
    default:
      return { type: 'none' };
  }
}

// what the built-in progression would do right now
function defaultGoal(bot) {
  for (const g of G.GOALS) {
    if (g.name === 'ai plan' || g.name === 'owner request') continue;
    if ((bot.cool[g.name] || 0) > Date.now()) continue;
    try {
      if (g.need(bot)) return g.name;
    } catch (e) {}
  }
  return 'nothing special';
}

function stateText(bot) {
  const items = {};
  for (const it of bot.inventory.items()) items[it.name] = (items[it.name] || 0) + it.count;
  const inv =
    Object.entries(items)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 16)
      .map(([n, c]) => n + ' x' + c)
      .join(', ') || 'empty';
  const owner = U.ownerEntity(bot);
  const p = bot.entity.position;
  return (
    'health ' + Math.round(bot.health) + '/20, food ' + bot.food + '/20 (edible items: ' + S.foodCount(bot) + '), ' +
    'pickaxe tier ' + tier(bot) + ' (0 none, 1 wood, 2 stone, 3 iron, 4 diamond), ' +
    'height y=' + Math.round(p.y) + ', ' + (bot.time && bot.time.isDay ? 'day' : 'night') + ', ' +
    'owner ' + (owner ? 'visible, ' + Math.round(owner.position.distanceTo(p)) + ' blocks away' : 'not visible') + ', ' +
    'inventory: ' + inv
  );
}

function systemPrompt(bot) {
  return (
    'You are the brain of ' + bot.username + ', a Minecraft companion who plays together with its owner ' +
    (config.owner || '(none)') + '. You decide what to do next. ' +
    'Reflexes (fighting nearby monsters, eating, sleeping, running away) already happen automatically, you choose the bigger plan.\n' +
    'Goals: stay alive, help your owner, get stronger (wooden tools, stone tools, iron gear, then diamonds), keep some food.\n' +
    'Pick exactly ONE action:\n' +
    '- auto (secs 30-300): let the built-in progression run. It crafts tools, mines, smelts, cooks and makes a bed by itself. Good default.\n' +
    '- gather (what: wood|stone|coal|iron|diamond|food, count 1-64)\n' +
    '- hunt (animal: cow|pig|sheep|chicken)\n' +
    '- explore: walk to a new area to find resources\n' +
    '- follow_owner (secs 15-90): stay near the owner and help\n' +
    '- wait (secs 5-30)\n' +
    'Rules: pickaxe tier needed: stone and coal need 1, iron needs 2, diamond needs 3. Never choose gather for something your pickaxe cannot mine. ' +
    'Do not repeat an action that just failed. If the owner is nearby, sometimes choose follow_owner. ' +
    'Use "say" only when it is really worth telling the owner something (short, same language the owner uses, no emojis), otherwise leave it empty.\n' +
    'Reply ONLY with JSON: {"thought":"<short reason>","say":"<optional chat message or empty>","action":{"type":"auto|gather|hunt|explore|follow_owner|wait","what":"...","animal":"...","count":<number>,"secs":<number>}}'
  );
}

async function followFor(bot, ms) {
  if (!U.ownerEntity(bot)) return 'failed: owner not visible';
  const end = Date.now() + ms;
  bot.currentGoal = 'AI: staying with owner';
  bot.moves.canDig = false;
  while (Date.now() < end && !bot._stopped) {
    const o = U.ownerEntity(bot);
    if (!o) break;
    if (C.nearestThreat(bot, 16) || bot.mode !== 'auto' || bot.directive) break;
    if (bot.food <= 14 || bot.health <= 10) break; // let the brain eat/heal
    const g = bot.pathfinder.goal;
    if (!g || g.entity !== o) bot.pathfinder.setGoal(new goals.GoalFollow(o, 3), true);
    await sleep(500);
  }
  bot.pathfinder.setGoal(null);
  return 'ok: stayed with owner';
}

async function execute(bot, act) {
  switch (act.type) {
    case 'auto':
      bot.planPauseUntil = Date.now() + act.secs * 1000;
      return 'ok: built-in progression for ' + act.secs + 's';
    case 'gather':
      if (tier(bot) < NEED_TIER[act.what]) return 'refused: pickaxe too weak for ' + act.what;
      bot.directive = {
        type: act.what,
        target: COUNT[act.what](bot) + act.count,
        until: Date.now() + 8 * 60 * 1000,
        fails: 0,
      };
      return 'started gathering ' + act.count + ' ' + act.what;
    case 'hunt': {
      const ok = await C.huntAnimal(bot, act.animal ? [act.animal] : undefined);
      return ok ? 'ok: hunted an animal' : 'failed: no animal found nearby';
    }
    case 'explore': {
      const ok = await G.wander(bot, 40);
      return ok ? 'ok: explored' : 'failed: path blocked';
    }
    case 'follow_owner':
      return await followFor(bot, act.secs * 1000);
    case 'wait':
      await sleep(act.secs * 1000);
      return 'ok: waited';
    default:
      bot.planPauseUntil = Date.now() + 15000;
      return 'no action chosen';
  }
}

async function planStep(bot) {
  if (Date.now() - lastPlan < 4000) {
    await sleep(1000);
    return true;
  }
  lastPlan = Date.now();
  bot.currentGoal = 'AI: thinking';

  const user =
    'Current state: ' + stateText(bot) + '\n' +
    'Built-in progression would do next: ' + defaultGoal(bot) + '\n' +
    'My recent actions: ' + (recent.length ? recent.slice(-6).join(' | ') : 'none yet') + '\n' +
    'Decide the next action.';

  let raw;
  try {
    raw = await groq.complete([
      { role: 'system', content: systemPrompt(bot) },
      { role: 'user', content: user },
    ]);
  } catch (e) {
    log('planner error:', e.message);
    bot.planPauseUntil = Date.now() + 30000; // built-in progression takes over for a while
    return true;
  }

  const parsed = groq.parseReply(raw);
  const act = clean(parsed.action);
  log('PLAN:', JSON.stringify(act), parsed.say ? '| say: ' + parsed.say : '');
  if (parsed.say && Date.now() - lastChat > 20000) {
    lastChat = Date.now();
    U.say(bot, parsed.say.slice(0, 180));
  }

  const result = await execute(bot, act);
  recent.push(act.type + (act.what ? ' ' + act.what : '') + ' -> ' + result);
  while (recent.length > 8) recent.shift();

  // two failures in a row: hand over to the built-in progression for a while
  if (/^(refused|failed)/.test(result)) {
    failStreak++;
    if (failStreak >= 2) {
      failStreak = 0;
      bot.planPauseUntil = Date.now() + 90000;
    }
  } else {
    failStreak = 0;
  }
  return true;
}

function need(b) {
  if (b.mode !== 'auto' || b.directive) return false;
  if (Date.now() < (b.planPauseUntil || 0)) return false;
  if (b.food <= 8 && S.foodCount(b) === 0) return false; // starving: let the survival goal hunt first
  return true;
}

if (ENABLED && config.groqKey && !G.GOALS.some((g) => g.name === 'ai plan')) {
  G.GOALS.unshift({ name: 'ai plan', need, run: planStep });
  log('AI control is ON: Groq decides the plan.');
}

module.exports = { planStep, clean };
