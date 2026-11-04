process.on('uncaughtException', (e) => console.error('UNCAUGHT:', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('UNHANDLED:', (e && e.stack) || e));

const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const config = require('./config');
const { log, say } = require('./utils');
const { runBrain } = require('./brain');
const { handleOwnerMessage } = require('./commands');
const { handleChat } = require('./ai');
const groq = require('./groq');
const senses = require('./senses');

let retryDelay = 5000;
const seen = new Map();

// short fixed commands still work instantly; everything else goes to the AI
const COMMAND_RE = /^(come|here|stay|wait|stop|follow|free|go|auto|work|resume|status|give\s|এসো|আসো|আয়|থামো|দাঁড়াও|সাথে|খেলো|কাজ)/i;

function setupMovements(bot) {
  const m = new Movements(bot);
  m.canDig = false; // turned on only while mining
  m.allowSprinting = true;
  m.allowParkour = true;
  m.allow1by1towers = true;
  if (m.blocksCantBreak) {
    for (const b of Object.values(bot.registry.blocksByName)) {
      if (
        /chest|furnace|crafting_table|_bed$|barrel|anvil|enchanting|spawner|obsidian|bedrock|portal|beacon|shulker|torch|ladder|rail|farmland|hopper|dispenser|dropper|piston|lectern|bookshelf|brewing|sign|banner/.test(
          b.name
        )
      ) {
        m.blocksCantBreak.add(b.id);
      }
    }
  }
  bot.moves = m;
  bot.pathfinder.setMovements(m);
}

function start() {
  log('Connecting to ' + config.host + ':' + config.port + ' as ' + config.username);
  if (!config.owner) log('WARNING: OWNER_NAME is not set, I will play alone without a master.');

  const bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version,
    auth: config.auth,
    checkTimeoutInterval: 90000,
  });

  bot.loadPlugin(pathfinder);
  let started = false;

  bot.on('spawn', () => {
    bot.pathfinder.setGoal(null);
    if (started) return;
    started = true;
    retryDelay = 5000;
    setupMovements(bot);
    senses.attach(bot);
    log('Joined the server as ' + bot.username + ' (version ' + bot.version + ')');
    if (config.groqKey) {
      groq.pickModel().catch((e) => log('Groq check failed:', e.message));
    } else {
      log('GROQ_API_KEY is not set, playing without AI chat.');
    }
    say(bot, 'Hello! I am here to play with you.');
    runBrain(bot);
  });

  bot.on('death', () => {
    if (bot.entity) bot.deathInfo = { pos: bot.entity.position.clone(), time: Date.now() };
    log('I died.');
  });

  // chat: owner commands, AI chat
  const dispatch = (username, message) => {
    if (!username || username === bot.username) return;
    const key = username + '|' + message;
    const now = Date.now();
    if (seen.get(key) > now - 1500) return;
    seen.set(key, now);

    const isOwner = !!config.owner && username.toLowerCase() === config.owner.toLowerCase();
    const mentioned = message.toLowerCase().includes(bot.username.toLowerCase());
    if (isOwner) log('OWNER SAYS: ' + message);

    if (isOwner && COMMAND_RE.test(message.trim())) {
      handleOwnerMessage(bot, message);
    } else if (isOwner && (config.aiReplyAll || mentioned)) {
      handleChat(bot, username, message, true);
    } else if (mentioned) {
      handleChat(bot, username, message, false); // other players: chat only, no orders
    }
  };
  bot.on('chat', dispatch);
  bot.on('whisper', dispatch);
  bot.on('messagestr', (msg) => {
    const m = msg.match(/^(?:<([^>]+)>|.*?([A-Za-z0-9_]{3,16})\s*[:>])\s*(.+)$/);
    if (m) dispatch(m[1] || m[2], m[3]);
  });

  bot.on('kicked', (reason) => {
    const text = JSON.stringify(reason);
    log('Kicked:', text);
    if (/duplicate_login/.test(text)) {
      log('Another copy of this bot uses the name "' + config.username + '". Stop the other one or set a different MC_USERNAME.');
      retryDelay = 60000;
    }
  });
  bot.on('error', (err) => log('Error:', err.message));
  bot.on('end', (reason) => {
    bot._stopped = true;
    log('Disconnected (' + reason + '). Retrying in ' + retryDelay / 1000 + 's...');
    setTimeout(start, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 60000);
  });
}

start();
