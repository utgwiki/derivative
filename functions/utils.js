let fetchInstance;
/**
 * Lazy-loading node-fetch wrapper.
 * Requires Node.js >= 17.3.0 for AbortSignal.timeout support in callers.
 */
const fetch = async (...args) => {
    if (!fetchInstance) {
        const module = await import("node-fetch");
        fetchInstance = module.default;
    }
    return fetchInstance(...args);
};

function resolveWikiKey(baseUrl, wikis) {
    return Object.keys(wikis).find(k => wikis[k].baseUrl === baseUrl) || "tagging";
}

function escapeMarkdown(text) {
    if (!text) return "";
    return text.replace(/([\\`*_{}[\]()#+-.!|])/g, "\\$1");
}

module.exports = { fetch, resolveWikiKey, escapeMarkdown };
