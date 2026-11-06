const { goals } = require('mineflayer-pathfinder');
const U = require('./utils');
const { say, goto, ownerEntity, log } = U;

async function giveItem(bot, token, count) {
  const owner = ownerEntity(bot);
  if (!owner) return say(bot, "I can't see you.");
  const word = token.replace(/_/g, ' ');
  const it = bot.inventory
    .items()
    .find((i) => i.name.replace(/_/g, ' ').includes(word));
  if (!it) return say(bot, "I don't have " + word + '.');
  await goto(bot, new goals.GoalNear(owner.position.x, owner.position.y, owner.position.z, 2), 20000);
  try {
    await bot.lookAt(owner.position.offset(0, 1.6, 0));
    const n = count ? Math.min(parseInt(count, 10), it.count) : it.count;
    await bot.toss(it.type, null, n);
    say(bot, 'Here you go: ' + n + ' ' + it.name);
  } catch (e) {
    log('give failed:', e.message);
  }
}

// Orders from the owner. Every order first stops whatever the bot is doing.
function handleOwnerMessage(bot, message) {
  const t = String(message).trim().toLowerCase();

  if (/^(come|here|এসো|আসো|আয়)/.test(t)) {
    bot.autonomy = false;
    bot.mode = 'auto';
    bot.directive = null;
    bot.pathfinder.stop();
    const owner = ownerEntity(bot);
    if (!owner) return say(bot, "I stopped, but I can't see you. Where are you?");
    bot.pathfinder.setGoal(new goals.GoalNear(owner.position.x, owner.position.y, owner.position.z, 2));
    return say(bot, 'Coming!');
  }
  if (/^(stay|wait|stop|থামো|দাঁড়াও)/.test(t)) {
    bot.autonomy = false;
    bot.mode = 'stay';
    bot.directive = null;
    bot.pathfinder.stop();
    return say(bot, 'Okay, staying here.');
  }
  if (/^(follow|সাথে)/.test(t)) {
    bot.autonomy = false;
    bot.mode = 'follow';
    bot.directive = null;
    bot.pathfinder.stop();
    return say(bot, 'Following you!');
  }
  if (/^(free|go|auto|work|resume|খেলো|কাজ)/.test(t)) {
    bot.autonomy = true;
    bot.mode = 'auto';
    return say(bot, 'Okay, I will play on my own. Tell me to come or stay any time.');
  }
  if (/^status/.test(t)) {
    const p = bot.entity.position;
    return say(
      bot,
      'HP ' + Math.round(bot.health) + ', food ' + bot.food + ', doing: ' + (bot.currentGoal || 'idle') +
        ', at ' + Math.round(p.x) + ' ' + Math.round(p.y) + ' ' + Math.round(p.z)
    );
  }
  const m = t.match(/^give\s+([a-z_]+)(?:\s+(\d+))?/);
  if (m) {
    bot.autonomy = false;
    giveItem(bot, m[1], m[2]).catch(() => {});
  }
}

module.exports = { handleOwnerMessage };
