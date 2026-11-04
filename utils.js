const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const config = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let lastSay = 0;
function say(bot, text) {
  const now = Date.now();
  if (now - lastSay < 1200) return;
  lastSay = now;
  try {
    bot.chat(String(text).slice(0, 240));
  } catch (e) {}
}

// Walk to a goal, but never hang forever
async function goto(bot, goal, ms = 30000) {
  let timer;
  const p = bot.pathfinder.goto(goal);
  p.catch(() => {});
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('timeout')), ms);
  });
  try {
    await Promise.race([p, timeout]);
    return true;
  } catch (e) {
    try {
      bot.pathfinder.stop();
    } catch (e2) {}
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- inventory helpers ----------
const inv = (bot, name) =>
  bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);

const invRe = (bot, re) =>
  bot.inventory.items().filter((i) => re.test(i.name)).reduce((s, i) => s + i.count, 0);

const findItem = (bot, re) => {
  const r = typeof re === 'string' ? new RegExp('^' + re + '$') : re;
  return bot.inventory.items().find((i) => r.test(i.name));
};

// everything: inventory + armor + offhand
const allItems = (bot) => bot.inventory.slots.filter(Boolean);

// ---------- owner ----------
function ownerEntity(bot) {
  if (!config.owner) return null;
  const key = Object.keys(bot.players).find((k) => k.toLowerCase() === config.owner.toLowerCase());
  const p = key && bot.players[key];
  return (p && p.entity) || null;
}

// ---------- block helpers ----------
const isItem = (e) => !!e && (e.name === 'item' || e.displayName === 'Item' || e.objectType === 'Item');
const isLiquid = (b) => !!b && /^(flowing_)?(water|lava)$/.test(b.name);
const isLava = (b) => !!b && /lava/.test(b.name);
const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

function nearLava(bot, pos) {
  if (isLava(bot.blockAt(pos))) return true;
  return DIRS6.some(([x, y, z]) => isLava(bot.blockAt(pos.offset(x, y, z))));
}

// ore/block touching air (a real player could see it)
function exposed(bot, pos) {
  return DIRS6.some(([x, y, z]) => {
    const b = bot.blockAt(pos.offset(x, y, z));
    return b && b.boundingBox === 'empty' && !isLava(b);
  });
}

// pick the fastest tool that can actually harvest this block
async function equipBestTool(bot, block) {
  let bestItem = null;
  let bestTime = Infinity;
  let found = false;
  const candidates = [null, ...bot.inventory.items()];
  for (const it of candidates) {
    const type = it ? it.type : null;
    let ok = true;
    try {
      ok = block.canHarvest(type);
    } catch (e) {
      ok = true;
    }
    if (!ok) continue;
    let t;
    try {
      t = block.digTime(type, false, false, false, [], bot.entity.effects);
    } catch (e) {
      continue;
    }
    if (t < bestTime - 1) {
      bestTime = t;
      bestItem = it;
      found = true;
    }
  }
  if (!found) return false;
  try {
    if (bestItem) {
      if (!bot.heldItem || bot.heldItem.type !== bestItem.type) await bot.equip(bestItem, 'hand');
    } else if (bot.heldItem) {
      await bot.unequip('hand');
    }
  } catch (e) {}
  return true;
}

async function digBlock(bot, block) {
  if (!block || block.boundingBox === 'empty') return true;
  if (!(await equipBestTool(bot, block))) return false;
  try {
    await bot.dig(block, true);
    return true;
  } catch (e) {
    return false;
  }
}

// walk to dropped items and pick them up
async function collectDrops(bot, radius = 10, ms = 7000) {
  const end = Date.now() + ms;
  const tries = {};
  while (Date.now() < end) {
    const me = bot.entity.position;
    const drop = bot.nearestEntity(
      (e) => isItem(e) && e.position.distanceTo(me) <= radius && (tries[e.id] || 0) < 2
    );
    if (!drop) break;
    tries[drop.id] = (tries[drop.id] || 0) + 1;
    const p = drop.position;
    await goto(bot, new goals.GoalNear(p.x, p.y, p.z, 0.8), 6000);
    await sleep(150);
  }
}

// go next to a block, dig it, pick up the drops
async function mineBlock(bot, block) {
  const p = block.position;
  const was = block.type;
  bot.moves.canDig = true;
  await goto(bot, new goals.GoalGetToBlock(p.x, p.y, p.z), 40000);
  bot.moves.canDig = false;
  const b = bot.blockAt(p);
  if (!b || b.type !== was) return true; // already gone
  if (bot.entity.position.distanceTo(b.position.offset(0.5, 0.5, 0.5)) > 5.5) return false;
  const dug = await digBlock(bot, b);
  if (dug) {
    await sleep(200);
    await collectDrops(bot, 8, 5000);
  }
  return dug;
}

// find nearest ore that is visible (exposed) or very close
function findOre(bot, names, maxDist = 48) {
  const ids = names
    .map((n) => bot.registry.blocksByName[n])
    .filter(Boolean)
    .map((b) => b.id);
  if (!ids.length) return null;
  const list = bot.findBlocks({ matching: ids, maxDistance: maxDist, count: 40 });
  const me = bot.entity.position;
  let best = null;
  let bd = Infinity;
  for (const p of list) {
    const d = p.distanceTo(me);
    if (d > 6 && !exposed(bot, p)) continue;
    if (nearLava(bot, p)) continue;
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best ? bot.blockAt(best) : null;
}

// place an item (table, furnace, bed) on the ground next to the bot
async function placeNear(bot, itemName, needsExtra = false) {
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) return null;
  try {
    await bot.equip(item, 'hand');
  } catch (e) {
    return null;
  }
  const base = bot.entity.position.floored();
  const cardinal = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const diagonal = [[1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]];
  const offs = needsExtra ? cardinal : cardinal.concat(diagonal);
  const free = (pos) => {
    const at = bot.blockAt(pos);
    const up = bot.blockAt(pos.offset(0, 1, 0));
    const below = bot.blockAt(pos.offset(0, -1, 0));
    return !!(
      at && up && below &&
      at.boundingBox === 'empty' && !isLiquid(at) &&
      up.boundingBox === 'empty' &&
      below.boundingBox === 'block'
    );
  };
  for (const [dx, dz] of offs) {
    const target = base.offset(dx, 0, dz);
    if (!free(target)) continue;
    if (needsExtra && !free(target.offset(dx, 0, dz))) continue; // beds need 2 cells
    const below = bot.blockAt(target.offset(0, -1, 0));
    try {
      await bot.placeBlock(below, new Vec3(0, 1, 0));
    } catch (e) {}
    await sleep(300);
    const nb = bot.blockAt(target);
    if (nb && nb.name === itemName) return nb;
  }
  return null;
}

module.exports = {
  sleep, log, say, goto,
  inv, invRe, findItem, allItems,
  ownerEntity,
  isItem, isLiquid, isLava, nearLava, exposed,
  equipBestTool, digBlock, collectDrops, mineBlock, findOre, placeNear,
};
