const { goals } = require('mineflayer-pathfinder');
const U = require('./utils');
const S = require('./survival');
const { sleep, log, ownerEntity } = U;

const IGNORE = new Set([
  'enderman', 'zombified_piglin', 'piglin', 'piglin_brute', 'iron_golem', 'wolf', 'bee', 'llama', 'polar_bear',
]);
const DANGEROUS = new Set(['warden', 'ender_dragon', 'wither']);
const EXTRA = new Set([
  'slime', 'phantom', 'magma_cube', 'drowned', 'husk', 'zombie', 'skeleton', 'creeper', 'spider',
  'cave_spider', 'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'silverfish', 'stray',
  'bogged', 'breeze', 'zombie_villager',
]);
const FOOD_ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];
const WEAPONS = [
  'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe',
];

function isThreat(bot, e) {
  if (!e || e === bot.entity || !e.position || !e.name) return false;
  if (IGNORE.has(e.name)) return false;
  return e.type === 'hostile' || e.kind === 'Hostile mobs' || EXTRA.has(e.name) || DANGEROUS.has(e.name);
}

// closest enemy near me, or near my owner (so I protect him/her)
function nearestThreat(bot, range = 16) {
  const owner = ownerEntity(bot);
  let best = null;
  let bs = Infinity;
  for (const e of Object.values(bot.entities)) {
    if (!isThreat(bot, e)) continue;
    const d = e.position.distanceTo(bot.entity.position);
    let score = Infinity;
    if (d <= range) score = d;
    else if (owner && d <= 32 && e.position.distanceTo(owner.position) <= 10) score = d + 5;
    if (score < bs) {
      bs = score;
      best = e;
    }
  }
  return best;
}

async function equipWeapon(bot) {
  for (const n of WEAPONS) {
    const it = bot.inventory.items().find((i) => i.name === n);
    if (it) {
      if (!bot.heldItem || bot.heldItem.name !== n) {
        try {
          await bot.equip(it, 'hand');
        } catch (e) {}
      }
      return;
    }
  }
}

async function backOff(bot) {
  bot.setControlState('back', true);
  await sleep(450);
  bot.setControlState('back', false);
}

// returns: 'dead' | 'lost' | 'flee' | 'timeout'
async function attackEntity(bot, target, maxMs = 20000, abortOnLowHealth = true) {
  await equipWeapon(bot);
  bot.moves.canDig = false;
  const start = Date.now();
  let last = 0;
  while (Date.now() - start < maxMs) {
    const e = bot.entities[target.id];
    if (!e || e.isValid === false) {
      bot.pathfinder.setGoal(null);
      return 'dead';
    }
    const d = bot.entity.position.distanceTo(e.position);
    if (d > 30) {
      bot.pathfinder.setGoal(null);
      return 'lost';
    }
    if (abortOnLowHealth && bot.health <= 6) {
      bot.pathfinder.setGoal(null);
      return 'flee';
    }
    if (d > 2.8) {
      const g = bot.pathfinder.goal;
      if (!g || g.entity !== e) bot.pathfinder.setGoal(new goals.GoalFollow(e, 2), true);
    } else if (bot.pathfinder.goal) {
      bot.pathfinder.setGoal(null);
    }
    if (d <= 3.2) {
      try {
        await bot.lookAt(e.position.offset(0, (e.height || 1.6) * 0.8, 0), true);
      } catch (err) {}
      const now = Date.now();
      if (now - last >= 650) {
        bot.attack(e);
        last = now;
        if (e.name === 'creeper') await backOff(bot);
      }
    }
    await sleep(80);
  }
  bot.pathfinder.setGoal(null);
  return 'timeout';
}

async function flee(bot, from, ms = 4000) {
  bot.moves.canDig = false;
  const owner = ownerEntity(bot);
  if (owner && owner.position.distanceTo(bot.entity.position) < 60) {
    bot.pathfinder.setGoal(new goals.GoalFollow(owner, 2), true);
  } else {
    const p = from.position;
    bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalNear(p.x, p.y, p.z, 20)), false);
  }
  bot.setControlState('sprint', true);
  const end = Date.now() + ms;
  while (Date.now() < end) await sleep(200);
  bot.setControlState('sprint', false);
  bot.pathfinder.setGoal(null);
}

async function handleThreat(bot, threat) {
  bot.fleeLog = (bot.fleeLog || []).filter((t) => Date.now() - t < 30000);
  if (DANGEROUS.has(threat.name)) {
    log('too dangerous:', threat.name, '- running');
    await flee(bot, threat, 5000);
    return;
  }
  const canFlee = bot.fleeLog.length < 3;
  const r = await attackEntity(bot, threat, 15000, canFlee);
  if (r === 'flee') {
    if (await S.eatGolden(bot)) return;
    bot.fleeLog.push(Date.now());
    log('low health, retreating');
    await flee(bot, threat, 4000);
  }
}

async function huntAnimal(bot, names = FOOD_ANIMALS) {
  const me = bot.entity.position;
  const target = bot.nearestEntity((e) => names.includes(e.name) && e.position.distanceTo(me) < 48);
  if (!target) return false;
  const r = await attackEntity(bot, target, 25000, false);
  await sleep(300);
  await U.collectDrops(bot, 8, 5000);
  return r === 'dead';
}

module.exports = { nearestThreat, handleThreat, attackEntity, flee, huntAnimal, equipWeapon };
