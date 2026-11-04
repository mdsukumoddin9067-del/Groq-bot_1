const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

module.exports = {
  host: process.env.MC_HOST || 'localhost',
  port: num(process.env.MC_PORT, 25565),
  username: process.env.MC_USERNAME || 'FriendBot',
  version: process.env.MC_VERSION || undefined,
  auth: process.env.MC_AUTH || 'offline',
  owner: (process.env.OWNER_NAME || '').trim(),
  leash: num(process.env.LEASH, 60), // max horizontal distance from owner while working
  followDistance: 3,

  // ---- Groq AI (free key from console.groq.com, starts with gsk_) ----
  groqKey: (process.env.GROQ_API_KEY || '').trim(),
  groqModel: (process.env.GROQ_MODEL || '').trim(), // optional, auto-picked if empty/not found
  aiReplyAll: (process.env.AI_REPLY_ALL || 'true').toLowerCase() !== 'false',
};
