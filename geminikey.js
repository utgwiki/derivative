// geminikey.js
require("dotenv").config();

module.exports = {
  MAIN_KEYS: [
    process.env.GEMINI_MAIN_KEY,
    process.env.GEMINI_MAIN_KEY2,
    process.env.GEMINI_MAIN_KEY3,
    process.env.GEMINI_MAIN_KEY4,
    process.env.GEMINI_MAIN_KEY5,
    process.env.GEMINI_MAIN_KEY6,
    process.env.GEMINI_MAIN_KEY7,
    process.env.GEMINI_MAIN_KEY8,
    process.env.GEMINI_MAIN_KEY9,
    process.env.GEMINI_MAIN_KEY10,
    process.env.GEMINI_MAIN_KEY11,
    process.env.GEMINI_MAIN_KEY12,
  ].filter(Boolean),
};
