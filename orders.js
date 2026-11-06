// "Obey mode": the bot does NOT play on its own unless the owner asks for it.
// The old goal code stays (it is used to carry out orders like "gather 10 wood"),
// but it only runs on its own when bot.autonomy is true.
const G = require('./goals');

const ORDER_ONLY = (process.env.ORDER_ONLY || 'true').toLowerCase() !== 'false';

if (ORDER_ONLY) {
  for (const g of G.GOALS) {
    // starving is the only exception: finding food must always work
    if (g.name === 'owner request' || g.name === 'urgent food' || g.wrapped) continue;
    const original = g.need;
    g.need = (b) => (b.autonomy ? original(b) : false);
    g.wrapped = true;
  }
  console.log(new Date().toISOString().slice(11, 19), 'Obey mode is ON: I only act on my owner\'s orders.');
}

module.exports = { ORDER_ONLY };
