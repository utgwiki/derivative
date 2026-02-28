// --- WIKI CONFIGURATION ---
const BOT_NAME = "Derivative"; 

const WIKIS = {
    "tagging": {
        name: "Untitled Tag Game",
        baseUrl: "https://tagging.wiki",
        apiEndpoint: "https://tagging.wiki/w/api.php",
        articlePath: "https://tagging.wiki/wiki/",
        prefix: "utg",
        emoji: "1472436401680158741"
    },
    "farm": {
        name: "Farm",
        baseUrl: "https://farm.miraheze.org",
        apiEndpoint: "https://farm.miraheze.org/w/api.php",
        articlePath: "https://farm.miraheze.org/wiki/",
        prefix: "farm",
        emoji: "1472436382998728714"
    }
};

const CATEGORY_WIKI_MAP = {
    // Fill with category IDs if needed
};

const toggleContribScore = true;
const STATUS_INTERVAL_MS = 5 * 60 * 1000;

// --- DISCORD STATUSES ---
const STATUS_OPTIONS = [
    { type: 4, text: "just send [[a page]] or {{a page}}!" },
    { type: 4, text: "now supporting multiple wikis!" },
    { type: 4, text: "use [[utg:page]] for Untitled Tag Game embedding" },
    { type: 4, text: "use [[farm:Page]] for Farm embedding" },
    { type: 4, text: "tagging.wiki" },
    { type: 4, text: "farm.miraheze.org" },
    { type: 4, text: "₊˚⊹⋆" },
    { type: 4, text: "⋆｡𖦹°⭒˚｡⋆" },
    { type: 4, text: "✶⋆.˚" },
    { type: 4, text: "°˖➴" },
    { type: 0, text: "Untitled Tag Game" },
    { type: 0, text: "Farm" },
    { type: 5, text: "Untitled Tag Game" },
    { type: 5, text: "Farm" },
    { type: 3, text: "A Block's Journey teaser trailer" },
    { type: 4, text: "edit your message and my embed will too!" },
    { type: 4, text: "react with :wastebasket: on my messages & i'll delete!" },
];

module.exports = {
    BOT_NAME,
    WIKIS,
    CATEGORY_WIKI_MAP,
    toggleContribScore,
    STATUS_INTERVAL_MS,
    STATUS_OPTIONS,
    // Keep WIKI_ENDPOINTS for backward compatibility if still used
    WIKI_ENDPOINTS: {
        BASE: "https://tagging.wiki",
        API: "https://tagging.wiki/w/api.php",
        ARTICLE_PATH: "https://tagging.wiki/wiki/"
    },
    BOT_SETTINGS: {
        IGNORED_CHANNELS: ["bulletin", "announcements", "rules", "updates", "logs"],
        TRIGGER_KEYWORDS: ["derivative", "deriv"],
        RESPONSE_CHANCE: 0.4,
        MIN_FOLLOWUP_DELAY: 10 * 1000,
        MAX_FOLLOWUP_DELAY: 60 * 60 * 1000,
    },
    GEMINI_MODEL: "gemini-2.5-flash"
};
