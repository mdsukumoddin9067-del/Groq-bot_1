const { goals } = require('mineflayer-pathfinder');
const config = require('./config');
const U = require('./utils');
const C = require('./combat');
const S = require('./survival');
const G = require('./goals');
const { sleep, log } = U;

function follow(bot, owner) {
  if (!owner) return;
  bot.currentGoal = 'follow owner';
  bot.moves.canDig = false;
  const g = bot.pathfinder.goal;
  if (!g || g.entity !== owner) {
    bot.pathfinder.setGoal(new goals.GoalFollow(owner, config.followDistance), true);
  }
}

// nothing to do: stay close to the owner, look friendly
async function idle(bot) {
  bot.currentGoal = 'idle';
  const owner = U.ownerEntity(bot);
  if (owner) {
    const d = bot.entity.position.distanceTo(owner.position);
    if (d > 7) {
      bot.moves.canDig = false;
      await U.goto(bot, new goals.GoalNear(owner.position.x, owner.position.y, owner.position.z, 3), 20000);
      return;
    }
    try {
      await bot.lookAt(owner.position.offset(0, 1.6, 0));
    } catch (e) {}
    if (Math.random() < 0.05) {
      bot.setControlState('jump', true);
      await sleep(200);
      bot.setControlState('jump', false);
    }
    await sleep(700);
    return;
  }
  await G.wander(bot, 12);
  await sleep(1500);
}

async function tick(bot) {
  if (!bot.entity || bot.isSleeping) {
    await sleep(500);
    return;
  }

  S.swimFix(bot);

  // housekeeping every few seconds
  if (Date.now() - bot.lastHouse > 5000) {
    bot.lastHouse = Date.now();
    await S.autoArmor(bot);
    await S.tossJunk(bot);
  }

  if (await S.eatIfNeeded(bot)) return;

  // enemies first (also protects the owner)
  const threat = C.nearestThreat(bot, 16);
  if (threat) {
    bot.currentGoal = 'fight ' + threat.name;
    await C.handleThreat(bot, threat);
    return;
  }

  await S.reclaimBed(bot);
  if (await S.recoverDeath(bot)) return;

  const owner = U.ownerEntity(bot);

  if (bot.mode === 'stay') {
    bot.currentGoal = 'staying';
    bot.pathfinder.setGoal(null);
    await sleep(500);
    return;
  }
  if (bot.mode === 'follow') {
    follow(bot, owner);
    await sleep(300);
    return;
  }

  // stay within a leash (horizontal) of the owner while working
  if (owner) {
    const dx = bot.entity.position.x - owner.position.x;
    const dz = bot.entity.position.z - owner.position.z;
    if (Math.sqrt(dx * dx + dz * dz) > config.leash) {
      bot.currentGoal = 'going to owner';
      bot.moves.canDig = false;
      await U.goto(bot, new goals.GoalNear(owner.position.x, owner.position.y, owner.position.z, 4), 30000);
      return;
    }
  }

  if (await S.trySleep(bot)) return;

  // pick the first goal that is needed and not on cooldown
  for (const g of G.GOALS) {
    if ((bot.cool[g.name] || 0) > Date.now()) continue;
    let need = false;
    try {
      need = g.need(bot);
    } catch (e) {
      need = false;
    }
    if (!need) continue;

    if (bot.currentGoal !== g.name) log('GOAL:', g.name);
    bot.currentGoal = g.name;

    let ok = false;
    try {
      ok = await g.run(bot);
    } catch (e) {
      log('goal error (' + g.name + '):', e.message);
    }
    if (ok) {
      bot.fail[g.name] = 0;
    } else {
      bot.fail[g.name] = (bot.fail[g.name] || 0) + 1;
      if (bot.fail[g.name] >= 2) {
        bot.fail[g.name] = 0;
        bot.cool[g.name] = Date.now() + 45000;
        log('cannot do "' + g.name + '" right now, exploring a bit');
        await G.wander(bot, 30);
      }
    }
    return;
  }

  await idle(bot);
}

// if we are trying to move but not moving, nudge the bot
function startStuckWatch(bot) {
  let last = null;
  let since = Date.now();
  const iv = setInterval(() => {
    if (bot._stopped) return clearInterval(iv);
    if (!bot.entity) return;
    const p = bot.entity.position;
    if (last && p.distanceTo(last) < 0.3 && bot.pathfinder.isMoving()) {
      if (Date.now() - since > 8000) {
        log('stuck, trying to get free');
        bot.pathfinder.stop();
        bot.setControlState('jump', true);
        bot.setControlState('forward', true);
        setTimeout(() => {
          bot.setControlState('jump', false);
          bot.setControlState('forward', false);
        }, 500);
        since = Date.now();
      }
    } else {
      last = p.clone();
      since = Date.now();
    }
  }, 1000);
}

async function runBrain(bot) {
  bot.mode = 'auto';
  bot.cool = {};
  bot.fail = {};
  bot.lastHouse = 0;
  bot.currentGoal = 'starting';
  startStuckWatch(bot);
  while (!bot._stopped) {
    try {
      await tick(bot);
    } catch (e) {
      log('tick error:', e.message);
      await sleep(1000);
    }
    await sleep(120);
  }
}

module.exports = { runBrain };
