const { goals } = require('mineflayer-pathfinder');
const U = require('./utils');
const { log, goto, sleep, findItem } = U;

const BAD_FOOD = new Set([
  'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit',
  'suspicious_stew', 'enchanted_golden_apple', 'golden_apple',
]);

function foodCount(bot) {
  let n = 0;
  for (const it of bot.inventory.items()) {
    if (bot.registry.foods[it.type] && !BAD_FOOD.has(it.name)) n += it.count;
  }
  return n;
}

function bestFood(bot, allowBad) {
  let best = null;
  let bs = -1;
  for (const it of bot.inventory.items()) {
    const f = bot.registry.foods[it.type];
    if (!f) continue;
    if (!allowBad && BAD_FOOD.has(it.name)) continue;
    if (it.name === 'golden_apple' || it.name === 'enchanted_golden_apple') continue;
    const s = f.foodPoints + f.saturation / 10;
    if (s > bs) {
      bs = s;
      best = it;
    }
  }
  return best;
}

async function eatIfNeeded(bot) {
  const hungry = bot.food <= 14 || (bot.food < 20 && bot.health < 18);
  if (!hungry || bot.food >= 20) return false;
  const f = bestFood(bot, false) || (bot.food <= 6 ? bestFood(bot, true) : null);
  if (!f) return false;
  try {
    await bot.equip(f, 'hand');
    await bot.consume();
    return true;
  } catch (e) {
    return false;
  }
}

async function eatGolden(bot) {
  const it = findItem(bot, /^(enchanted_)?golden_apple$/);
  if (!it) return false;
  try {
    await bot.equip(it, 'hand');
    await bot.consume();
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- armor ----------
const MATS = ['leather', 'golden', 'chainmail', 'iron', 'diamond', 'netherite'];
const ARMOR_SLOTS = { head: '_helmet', torso: '_chestplate', legs: '_leggings', feet: '_boots' };
const armorScore = (it) => (it ? MATS.findIndex((m) => it.name.startsWith(m + '_')) : -1);

async function autoArmor(bot) {
  for (const [dest, suffix] of Object.entries(ARMOR_SLOTS)) {
    const cur = bot.inventory.slots[bot.getEquipmentDestSlot(dest)];
    let best = cur;
    let bs = armorScore(cur);
    for (const it of bot.inventory.items()) {
      if (!it.name.endsWith(suffix)) continue;
      const s = armorScore(it);
      if (s > bs) {
        best = it;
        bs = s;
      }
    }
    if (best && best !== cur) {
      try {
        await bot.equip(best, dest);
      } catch (e) {}
    }
  }
  const shield = bot.inventory.items().find((i) => i.name === 'shield');
  if (shield && !bot.inventory.slots[45]) {
    try {
      await bot.equip(shield, 'off-hand');
    } catch (e) {}
  }
}

// ---------- junk ----------
const JUNK = new Set([
  'dirt', 'gravel', 'andesite', 'diorite', 'granite', 'tuff', 'flint', 'sand', 'netherrack',
  'rotten_flesh', 'spider_eye', 'poisonous_potato', 'wheat_seeds',
]);

async function tossJunk(bot) {
  if (bot.inventory.emptySlotCount() > 4) return;
  for (const it of bot.inventory.items()) {
    try {
      if (JUNK.has(it.name)) {
        await bot.toss(it.type, null, it.count);
      } else if ((it.name === 'cobblestone' || it.name === 'cobbled_deepslate') && it.count > 128) {
        await bot.toss(it.type, null, it.count - 64);
      }
    } catch (e) {}
  }
}

// ---------- water ----------
function swimFix(bot) {
  const low =
    bot.entity.isInWater && typeof bot.oxygenLevel === 'number' && bot.oxygenLevel <= 8;
  if (low) {
    bot.setControlState('jump', true);
    bot._swimJump = true;
  } else if (bot._swimJump) {
    bot.setControlState('jump', false);
    bot._swimJump = false;
  }
}

// ---------- sleeping ----------
async function trySleep(bot) {
  if (bot.isSleeping || bot.time.isDay) return false;
  if (Date.now() < (bot.sleepCool || 0)) return false;
  let bed = bot.findBlock({ matching: (b) => b.name.endsWith('_bed'), maxDistance: 24 });
  if (!bed) {
    const item = findItem(bot, /_bed$/);
    if (!item) return false;
    bed = await U.placeNear(bot, item.name, true);
    if (!bed) {
      bot.sleepCool = Date.now() + 60000;
      return false;
    }
    bot.placedBed = bed.position.clone();
  }
  bot.currentGoal = 'sleep';
  await goto(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), 20000);
  try {
    await bot.sleep(bed);
    log('sleeping...');
  } catch (e) {
    log('cannot sleep:', e.message);
    bot.sleepCool = Date.now() + 60000;
  }
  return true;
}

// pick our bed back up in the morning
async function reclaimBed(bot) {
  if (!bot.placedBed || !bot.time.isDay || bot.isSleeping) return;
  const pos = bot.placedBed;
  bot.placedBed = null;
  const b = bot.blockAt(pos);
  if (b && b.name.endsWith('_bed')) {
    await goto(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 2), 15000);
    await U.digBlock(bot, b);
    await sleep(200);
    await U.collectDrops(bot, 6, 3000);
  }
}

// ---------- death ----------
async function recoverDeath(bot) {
  const d = bot.deathInfo;
  if (!d) return false;
  bot.deathInfo = null;
  if (Date.now() - d.time > 240000) return false;
  log('going back to my death spot');
  bot.currentGoal = 'recover items';
  await goto(bot, new goals.GoalNear(d.pos.x, d.pos.y, d.pos.z, 3), 60000);
  await U.collectDrops(bot, 16, 20000);
  return true;
}

module.exports = {
  foodCount, eatIfNeeded, eatGolden, autoArmor, tossJunk, swimFix,
  trySleep, reclaimBed, recoverDeath,
};
