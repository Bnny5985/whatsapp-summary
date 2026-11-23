// Where the bot keeps its own data (database, logs, media, .env).
// Default = the bot folder, exactly as before. The desktop app sets BOT_DATA_DIR to a per-user folder
// so the program files can live somewhere read-only (Program Files) and updates never touch user data.
const path = require('path');

const DATA_DIR = process.env.BOT_DATA_DIR ? path.resolve(process.env.BOT_DATA_DIR) : __dirname;

module.exports = {
  DATA_DIR,
  dataPath: (...parts) => path.join(DATA_DIR, ...parts),
};
