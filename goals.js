const { goals } = require('mineflayer-pathfinder');
const U = require('./utils');
const C = require('./combat');
const S = require('./survival');
const { inv, invRe, findItem, goto, sleep, log } = U;

const DIRS = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
const rot = (d) => ({ x: -d.z, z: d.x });

// ================= counters =================
const logsN = (b) => invRe(b, /_log$/);
const planksN = (b) => invRe(b, /_planks$/);
const woodUnits = (b) => logsN(b) * 4 + planksN(b);
const cobbleN = (b) => inv(b, 'cobblestone') + inv(b, 'cobbled_deepslate') + inv(b, 'blackstone');
const fuelN = (b) => inv(b, 'coal') + inv(b, 'charcoal');
const rawIronN = (b) => inv(b, 'raw_iron') + inv(b, 'iron_ore');
const ingotN = (b) => inv(b, 'iron_ingot');
const diamondN = (b) => inv(b, 'diamond');
const RAW_FOOD = ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon', 'potato'];
const rawFoodN = (b) => RAW_FOOD.reduce((s, n) => s + inv(b, n), 0);

const SMELT = {
  raw_iron: 'iron_ingot', iron_ore: 'iron_ingot',
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken',
  mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod',
  salmon: 'cooked_salmon', potato: 'baked_potato',
};

const TIERS = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];
function pickTier(bot) {
  let t = 0;
  for (const it of bot.inventory.items()) {
    const m = it.name.match(/^(wooden|stone|iron|diamond|netherite)_pickaxe$/);
    if (m) t = Math.max(t, TIERS.indexOf(m[1]) + 1);
  }
  return t;
}

// ================= gear lists =================
const IRON_ORDER = [
  { item: 'iron_pickaxe', type: 'pickaxe', cost: 3 },
  { item: 'iron_sword', type: 'sword', cost: 2 },
  { item: 'iron_chestplate', type: 'chestplate', cost: 8 },
  { item: 'iron_leggings', type: 'leggings', cost: 7 },
  { item: 'iron_helmet', type: 'helmet', cost: 5 },
  { item: 'iron_boots', type: 'boots', cost: 4 },
  { item: 'shield', type: 'shield', cost: 1 },
  { item: 'iron_axe', type: 'axe', cost: 3 },
];
const DIA_ORDER = [
  { item: 'diamond_pickaxe', type: 'pickaxe', cost: 3 },
  { item: 'diamond_sword', type: 'sword', cost: 2 },
  { item: 'diamond_chestplate', type: 'chestplate', cost: 8 },
  { item: 'diamond_leggings', type: 'leggings', cost: 7 },
  { item: 'diamond_helmet', type: 'helmet', cost: 5 },
  { item: 'diamond_boots', type: 'boots', cost: 4 },
];
const IRON_MATS = ['iron', 'diamond', 'netherite'];
const DIA_MATS = ['diamond', 'netherite'];

function haveGear(bot, e, mats) {
  const items = U.allItems(bot);
  if (e.type === 'shield') return items.some((i) => i.name === 'shield');
  return items.some((i) => mats.some((m) => i.name === m + '_' + e.type));
}
function missing(bot, order, mats) {
  return order.filter((e) => !haveGear(bot, e, mats));
}
function missingCost(bot, order, mats) {
  return missing(bot, order, mats).reduce((s, e) => s + e.cost, 0);
}
// strict order: next missing item, only if we can afford it
function nextCraft(bot, order, mats, have) {
  const m = missing(bot, order, mats);
  if (!m.length) return null;
  return have >= m[0].cost ? m[0] : null;
}

// ================= crafting =================
async function ensurePlanks(bot, n) {
  const have = planksN(bot);
  if (have >= n) return true;
  const logItem = bot.inventory
    .items()
    .filter((i) => /_log$/.test(i.name))
    .sort((a, b) => b.count - a.count)[0];
  if (!logItem) return false;
  const planks = logItem.name.replace(/_log$/, '_planks');
  const crafts = Math.min(logItem.count, Math.ceil((n - have) / 4));
  return await craftItem(bot, planks, crafts, true);
}

async function ensureSticks(bot, n) {
  const have = inv(bot, 'stick');
  if (have >= n) return true;
  if (!(await ensurePlanks(bot, 2))) return false;
  return await craftItem(bot, 'stick', Math.ceil((n - have) / 4), true);
}

async function ensureTable(bot) {
  const id = bot.registry.blocksByName.crafting_table.id;
  const t = bot.findBlock({ matching: id, maxDistance: 24 });
  if (t) {
    if (bot.entity.position.distanceTo(t.position) > 3) {
      await goto(bot, new goals.GoalNear(t.position.x, t.position.y, t.position.z, 2), 20000);
    }
    return t;
  }
  if (!inv(bot, 'crafting_table')) {
    await ensurePlanks(bot, 4);
    if (!(await craftItem(bot, 'crafting_table', 1, true))) return null;
  }
  return await U.placeNear(bot, 'crafting_table');
}

async function craftItem(bot, name, crafts = 1, noTable = false) {
  const it = bot.registry.itemsByName[name];
  if (!it) {
    log('unknown item', name);
    return false;
  }
  let table = null;
  let recipes = bot.recipesFor(it.id, null, 1, null);
  if (!recipes.length && !noTable) {
    table = await ensureTable(bot);
    if (!table) return false;
    recipes = bot.recipesFor(it.id, null, 1, table);
  }
  if (!recipes.length) return false;
  for (const c of [crafts, 1]) {
    try {
      await bot.craft(recipes[0], c, table || undefined);
      return true;
    } catch (e) {
      log('craft failed', name, e.message);
    }
  }
  return false;
}

// ================= finding things =================
async function gatherWood(bot) {
  if (!bot._logIds) {
    bot._logIds = Object.values(bot.registry.blocksByName)
      .filter((b) => /_log$/.test(b.name))
      .map((b) => b.id);
  }
  const block = bot.findBlock({ matching: bot._logIds, maxDistance: 64 });
  if (!block) return false;
  return await U.mineBlock(bot, block);
}

async function mineStone(bot) {
  const names = ['stone', 'cobblestone', 'deepslate'];
  let block = U.findOre(bot, names, 32);
  if (!block) {
    if (!bot._stoneIds) {
      bot._stoneIds = names.map((n) => bot.registry.blocksByName[n]).filter(Boolean).map((b) => b.id);
    }
    block = bot.findBlock({ matching: bot._stoneIds, maxDistance: 32 });
  }
  if (!block) return false;
  return await U.mineBlock(bot, block);
}

// ================= exploring underground =================
function safeCells(bot, cells, floorPos) {
  for (const c of cells) {
    if (!bot.blockAt(c)) return false;
    if (U.nearLava(bot, c)) return false;
  }
  for (let k = 0; k < 4; k++) {
    const b = bot.blockAt(floorPos.offset(0, -k, 0));
    if (!b) return false;
    if (U.isLiquid(b)) return false;
    if (b.boundingBox === 'block') return true;
  }
  return false;
}

async function digCells(bot, cells) {
  for (const c of cells) {
    const b = bot.blockAt(c);
    if (b && b.boundingBox !== 'empty') {
      if (!(await U.digBlock(bot, b))) return false;
    }
  }
  return true;
}

// dig a staircase downwards
async function descend(bot, st, targetY) {
  for (let i = 0; i < 3; i++) {
    const p = bot.entity.position.floored();
    if (p.y <= targetY) return true;
    const f = p.offset(st.dir.x, 0, st.dir.z);
    const cells = [f.offset(0, 1, 0), f, f.offset(0, -1, 0)];
    if (!safeCells(bot, cells, f.offset(0, -2, 0))) {
      st.dir = rot(st.dir);
      return false;
    }
    if (!(await digCells(bot, cells))) {
      st.dir = rot(st.dir);
      return false;
    }
    if (!(await goto(bot, new goals.GoalBlock(f.x, f.y - 1, f.z), 8000))) {
      st.dir = rot(st.dir);
      return false;
    }
  }
  return true;
}

// dig a 1x2 tunnel forward (branch mining pattern)
async function tunnel(bot, st) {
  for (let i = 0; i < 3; i++) {
    const p = bot.entity.position.floored();
    const f = p.offset(st.dir.x, 0, st.dir.z);
    const cells = [f, f.offset(0, 1, 0)];
    if (!safeCells(bot, cells, f.offset(0, -1, 0))) {
      st.dir = rot(st.dir);
      st.mode = 'main';
      st.n = 0;
      return false;
    }
    if (!(await digCells(bot, cells))) {
      st.dir = rot(st.dir);
      return false;
    }
    if (!(await goto(bot, new goals.GoalBlock(f.x, f.y, f.z), 8000))) {
      st.dir = rot(st.dir);
      return false;
    }
    if (st.mode === 'shift') {
      st.left--;
      if (st.left <= 0) {
        st.dir = rot(st.dir);
        st.mode = 'main';
        st.n = 0;
      }
    } else {
      st.n++;
      if (st.n >= 36) {
        st.dir = rot(st.dir);
        st.mode = 'shift';
        st.left = 3;
      }
    }
  }
  return true;
}

async function stripStep(bot, targetY) {
  bot.moves.canDig = false;
  if (!bot.strip) {
    bot.strip = { dir: DIRS[Math.floor(Math.random() * 4)], mode: 'main', n: 0, left: 0 };
  }
  const y = Math.floor(bot.entity.position.y);
  if (y > targetY + 1) return await descend(bot, bot.strip, targetY);
  return await tunnel(bot, bot.strip);
}

async function mineOre(bot, names, targetY) {
  const ore = U.findOre(bot, names, 48);
  if (ore) {
    bot.strip = null;
    return await U.mineBlock(bot, ore);
  }
  return await stripStep(bot, targetY);
}

async function wander(bot, r = 30) {
  const p = bot.entity.position;
  const a = Math.random() * Math.PI * 2;
  const x = Math.floor(p.x + Math.cos(a) * r);
  const z = Math.floor(p.z + Math.sin(a) * r);
  bot.moves.canDig = false;
  return await goto(bot, new goals.GoalXZ(x, z), 40000);
}

// ================= furnace =================
async function getFurnace(bot) {
  const fid = bot.registry.blocksByName.furnace.id;
  const f = bot.findBlock({ matching: fid, maxDistance: 32 });
  if (f) return f;
  if (!inv(bot, 'furnace')) {
    if (cobbleN(bot) < 8) {
      await mineStone(bot);
      return null;
    }
    if (!(await craftItem(bot, 'furnace', 1))) return null;
  }
  return await U.placeNear(bot, 'furnace');
}

function pickFuel(bot) {
  return (
    findItem(bot, /^coal$/) || findItem(bot, /^charcoal$/) ||
    findItem(bot, /_planks$/) || findItem(bot, /_log$/)
  );
}

async function smeltAll(bot, rawNames) {
  const stacks = bot.inventory
    .items()
    .filter((i) => rawNames.includes(i.name) && SMELT[i.name])
    .sort((a, b) => b.count - a.count);
  if (!stacks.length) return false;
  const fb = await getFurnace(bot);
  if (!fb) return false;
  await goto(bot, new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2), 20000);
  let furnace;
  try {
    furnace = await bot.openFurnace(fb);
  } catch (e) {
    log('cannot open furnace:', e.message);
    return false;
  }
  let done = false;
  try {
    try {
      if (furnace.outputItem()) await furnace.takeOutput();
    } catch (e) {}
    const it = stacks[0];
    const n = Math.min(it.count, 64);
    const fuel = pickFuel(bot);
    if (!fuel) return false;
    const per = /coal|charcoal/.test(fuel.name) ? 8 : 1.5;
    const fuelCount = Math.min(fuel.count, Math.ceil(n / per));
    await furnace.putInput(it.type, null, n);
    await furnace.putFuel(fuel.type, null, fuelCount);
    let got = 0;
    const deadline = Date.now() + n * 10500 + 8000;
    while (Date.now() < deadline && got < n) {
      await sleep(1000);
      try {
        if (furnace.outputItem()) {
          const t = await furnace.takeOutput();
          if (t) got += t.count;
        }
      } catch (e) {}
      if (C.nearestThreat(bot, 8)) break;
    }
    done = got > 0;
  } catch (e) {
    log('smelting error:', e.message);
  } finally {
    try {
      furnace.close();
    } catch (e) {}
  }
  return done;
}

// ================= bed =================
async function getBed(bot) {
  const wool = {};
  for (const it of bot.inventory.items()) {
    const m = it.name.match(/^(.+)_wool$/);
    if (m) wool[m[1]] = (wool[m[1]] || 0) + it.count;
  }
  const color = Object.keys(wool).find((c) => wool[c] >= 3);
  if (!color) return await C.huntAnimal(bot, ['sheep']);
  await ensurePlanks(bot, 3);
  return await craftItem(bot, color + '_bed', 1);
}

// ================= crafting steps =================
async function craftWoodenTools(bot) {
  await ensurePlanks(bot, 14);
  await ensureSticks(bot, 4);
  await craftItem(bot, 'wooden_pickaxe', 1);
  await craftItem(bot, 'wooden_sword', 1);
  await craftItem(bot, 'wooden_axe', 1);
  return pickTier(bot) >= 1;
}

async function craftStoneTools(bot) {
  await ensureSticks(bot, 6);
  await craftItem(bot, 'stone_pickaxe', 1);
  if (cobbleN(bot) >= 2) await craftItem(bot, 'stone_sword', 1);
  if (cobbleN(bot) >= 3) await craftItem(bot, 'stone_axe', 1);
  return pickTier(bot) >= 2;
}

async function craftGearEntry(bot, e) {
  if (e.type === 'shield') await ensurePlanks(bot, 6);
  else if (['pickaxe', 'sword', 'axe'].includes(e.type)) await ensureSticks(bot, 4);
  return await craftItem(bot, e.item, 1);
}

function diamondY(bot) {
  const minY = bot.game && typeof bot.game.minY === 'number' ? bot.game.minY : 0;
  return minY + 11; // safely above the lava lake level
}

// ================= the goal list (in priority order) =================
const GOALS = [
  {
    name: 'urgent food',
    need: (b) => b.food <= 8 && S.foodCount(b) === 0,
    run: (b) => C.huntAnimal(b),
  },
  {
    name: 'collect wood',
    need: (b) => pickTier(b) < 4 && woodUnits(b) < (pickTier(b) === 0 ? 14 : 8),
    run: gatherWood,
  },
  {
    name: 'craft wooden tools',
    need: (b) => pickTier(b) === 0 && woodUnits(b) >= 14,
    run: craftWoodenTools,
  },
  {
    name: 'mine stone',
    need: (b) => pickTier(b) >= 1 && pickTier(b) < 4 && cobbleN(b) < 16,
    run: mineStone,
  },
  {
    name: 'craft stone tools',
    need: (b) => pickTier(b) === 1 && cobbleN(b) >= 3,
    run: craftStoneTools,
  },
  {
    name: 'mine coal',
    need: (b) =>
      pickTier(b) >= 2 && fuelN(b) < 6 &&
      (missingCost(b, IRON_ORDER, IRON_MATS) > 0 || rawIronN(b) > 0 || rawFoodN(b) > 0),
    run: (b) => mineOre(b, ['coal_ore', 'deepslate_coal_ore'], 45),
  },
  {
    name: 'smelt iron',
    need: (b) => pickTier(b) >= 2 && rawIronN(b) > 0 && (fuelN(b) > 0 || woodUnits(b) >= 4),
    run: (b) => smeltAll(b, ['raw_iron', 'iron_ore']),
  },
  {
    name: 'craft iron gear',
    need: (b) => !!nextCraft(b, IRON_ORDER, IRON_MATS, ingotN(b)),
    run: (b) => craftGearEntry(b, nextCraft(b, IRON_ORDER, IRON_MATS, ingotN(b))),
  },
  {
    name: 'mine iron',
    need: (b) =>
      pickTier(b) >= 2 &&
      missingCost(b, IRON_ORDER, IRON_MATS) > ingotN(b) + rawIronN(b),
    run: (b) => mineOre(b, ['iron_ore', 'deepslate_iron_ore'], 16),
  },
  {
    name: 'cook food',
    need: (b) =>
      (fuelN(b) > 0 || woodUnits(b) >= 4) &&
      (rawFoodN(b) >= 4 || (rawFoodN(b) > 0 && S.foodCount(b) - rawFoodN(b) === 0)),
    run: (b) => smeltAll(b, RAW_FOOD),
  },
  {
    name: 'hunt food',
    need: (b) => pickTier(b) >= 1 && S.foodCount(b) < 5,
    run: (b) => C.huntAnimal(b),
  },
  {
    name: 'make a bed',
    need: (b) => pickTier(b) >= 2 && !findItem(b, /_bed$/) && !b.placedBed,
    run: getBed,
  },
  {
    name: 'craft diamond gear',
    need: (b) => !!nextCraft(b, DIA_ORDER, DIA_MATS, diamondN(b)),
    run: (b) => craftGearEntry(b, nextCraft(b, DIA_ORDER, DIA_MATS, diamondN(b))),
  },
  {
    name: 'mine diamonds',
    need: (b) =>
      pickTier(b) >= 3 &&
      missingCost(b, DIA_ORDER, DIA_MATS) > diamondN(b),
    run: (b) => mineOre(b, ['diamond_ore', 'deepslate_diamond_ore'], diamondY(b)),
  },
];

module.exports = { GOALS, wander };
