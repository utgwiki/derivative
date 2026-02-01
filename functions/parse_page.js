const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const { WIKI_ENDPOINTS } = require("../config.js");
const API = WIKI_ENDPOINTS.API;

let knownPages = [];
let pageLookup = new Map();

// --- WIKI API FUNCTIONS ---
async function getAllNamespaces() {
    try {
        const params = new URLSearchParams({
            action: "query",
            meta: "siteinfo",
            siprop: "namespaces",
            format: "json"
        });
        const res = await fetch(`${API}?${params.toString()}`, {
            headers: { "User-Agent": "DiscordBot/Derivative" }
        });
        if (!res.ok) throw new Error(`Namespaces fetch failed: ${res.status}`);
        const json = await res.json();
        const nsObj = json.query?.namespaces || {};

        const includeNs = Object.entries(nsObj)
            .map(([k, v]) => {
                const id = parseInt(k, 10);
                const name = (v && (v["*"] || v.canonical || "")).toString().trim();
                return { id, name };
            })
            .filter(({ id, name }) => {
                if (Number.isNaN(id) || id < 0) return false; 
                const lower = name.toLowerCase();
                if (lower.includes("talk")) return false;
                if (/^user\b/i.test(name) || /\buser\b/i.test(name)) return false;
                if (/^file\b/i.test(name) || /\bfile\b/i.test(name)) return false;
                return true;
            })
            .map(o => o.id);

        if (!includeNs.length) return [0, 4];

        return includeNs;
    } catch (err) {
        console.error("Failed to fetch namespaces:", err.message || err);
        return [0, 4];
    }
}

async function getAllPages() {
    const pages = [];
    try {
        const namespaces = await getAllNamespaces();

        for (const ns of namespaces) {
            let apcontinue = null;
            do {
                const params = new URLSearchParams({
                    action: "query",
                    format: "json",
                    list: "allpages",
                    aplimit: "max",
                    apfilterredir: "nonredirects",
                    apnamespace: String(ns),
                });
                if (apcontinue) params.append("apcontinue", apcontinue);

                const url = `${API}?${params.toString()}`;
                const res = await fetch(url, {
                    headers: { "User-Agent": "DiscordBot/Derivative" }
                });
                if (!res.ok) throw new Error(`Failed: ${res.status} ${res.statusText}`);
                const json = await res.json();

                if (json?.query?.allpages?.length) {
                    pages.push(...json.query.allpages.map(p => p.title));
                }

                apcontinue = json.continue?.apcontinue || null;
            } while (apcontinue);
        }

        return [...new Set(pages)];
    } catch (err) {
        console.error("getAllPages error:", err.message || err);
        return [...new Set(pages)]; 
    }
}

async function loadPages() {
    try {
        console.log("Loading all wiki pages...");

        const newPages = await getAllPages();
        // Modify array in-place so conversation.js sees the updates
        knownPages.length = 0; 
        knownPages.push(...newPages);
        
        pageLookup = new Map();
        for (const title of knownPages) {
            const canonical = title; 
            const norm1 = title.toLowerCase(); 
            const norm2 = title.replace(/_/g, " ").toLowerCase(); 
            pageLookup.set(norm1, canonical);
            pageLookup.set(norm2, canonical);
        }
        console.log(`Loaded ${knownPages.length} wiki pages.`);
    } catch (err) {
        console.error("Wiki load failed:", err.message);
    }
}

async function findCanonicalTitle(input) {
    if (!input) return null;
    const raw = String(input).trim();
    const norm = raw.replace(/_/g, " ").replace(/\s+/g, " ").trim();
    const lower = raw.toLowerCase();
    const lowerNorm = norm.toLowerCase();

    if (pageLookup.has(lower)) return pageLookup.get(lower);
    if (pageLookup.has(lowerNorm)) return pageLookup.get(lowerNorm);

    if (norm.includes(":")) {
        const parts = norm.split(":").map((seg, i) =>
            i === 0
                ? seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase()
                : seg.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("_")
        );
        const alt = parts.join(":"); 
        if (pageLookup.has(alt.toLowerCase())) return pageLookup.get(alt.toLowerCase());
    }

    try {
        const titleTryVariants = [
            raw,
            norm,
            norm.split(":").map((s, i) => i === 0 ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("_")).join(":")
        ].filter(Boolean);

        for (const t of titleTryVariants) {
            const params = new URLSearchParams({
                action: "query",
                format: "json",
                titles: t.replace(/ /g, "_"),
                redirects: "1",
                indexpageids: "1"
            });
            const res = await fetch(`${API}?${params.toString()}`, { headers: { "User-Agent": "DiscordBot/Derivative" } });
            if (!res.ok) continue;
            const json = await res.json();

            const pageids = json.query?.pageids || [];
            if (pageids.length === 0) continue;
            const page = json.query.pages[pageids[0]];
            if (!page) continue;
            if (page.missing !== undefined) continue;

            let canonicalTitle = page.title; 
            const redirects = json.query?.redirects || [];
            let fragment = null;
            if (redirects.length) {
                const rd = redirects.find(r => r.tofragment) || redirects[0];
                if (rd?.tofragment) fragment = rd.tofragment;
            }

            if (fragment) canonicalTitle = `${canonicalTitle}#${fragment}`;

            pageLookup.set(page.title.toLowerCase(), page.title);
            pageLookup.set(page.title.replace(/_/g, " ").toLowerCase(), page.title);
            pageLookup.set((canonicalTitle).toLowerCase(), canonicalTitle);

            return canonicalTitle;
        }
    } catch (err) {
        console.warn("findCanonicalTitle API lookup failed:", err?.message || err);
    }

    return null;
}

async function getWikiContent(pageTitle) {
    const params = new URLSearchParams({
        action: "parse",
        page: pageTitle,
        format: "json",
        prop: "text|images",
    });

    try {
        const res = await fetch(`${API}?${params.toString()}`, {
            headers: {
                "User-Agent": "DiscordBot/Derivative",
                "Origin": WIKI_ENDPOINTS.BASE,
            },
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const json = await res.json();

        if (json?.parse?.text?.["*"]) {
            const html = json.parse.text["*"];

            const noStyle = html.replace(/<style[\s\S]*?<\/style>/gi, "");
            const stripped = noStyle.replace(/<[^>]*>/g, "");

            return stripped;
        }
        return null;
    } catch (err) {
        console.error(`Failed to fetch content for "${pageTitle}":`, err.message);
        return null;
    }
}

async function getSectionIndex(pageTitle, sectionName) {
    const canonical = await findCanonicalTitle(pageTitle) || pageTitle;
    const params = new URLSearchParams({
        action: "parse",
        format: "json",
        prop: "sections",
        page: canonical
    });

    try {
        const res = await fetch(`${API}?${params}`, {
            headers: { "User-Agent": "DiscordBot/Derivative" }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const json = await res.json();

        const sections = json.parse?.sections || [];
        if (!sections.length) return null;

        const match = sections.find(
            s => s.line.toLowerCase() === sectionName.toLowerCase()
        );

        return match?.index || null;
    } catch (err) {
        console.error(`Failed to fetch section index for "${sectionName}" in "${pageTitle}":`, err.message);
        return null;
    }
}

async function getSectionContent(pageTitle, sectionName) {
    const sectionIndex = await getSectionIndex(pageTitle, sectionName);
    if (!sectionIndex) {
        console.warn(`Section "${sectionName}" not found in "${pageTitle}"`);
        return null;
    }

    const params = new URLSearchParams({
        action: "parse",
        format: "json",
        prop: "text",
        page: pageTitle,
        section: sectionIndex
    });

    try {
        const res = await fetch(`${API}?${params}`, {
            headers: { "User-Agent": "DiscordBot/Derivative" }
        });
        const json = await res.json();

        const html = json.parse?.text?.["*"];
        if (!html) return null;
        return html.replace(/<[^>]*>?/gm, ""); // strip HTML
    } catch (err) {
        console.error(`Failed to fetch section content for "${pageTitle}#${sectionName}":`, err.message);
        return null;
    }
}

async function getLeadSection(pageTitle) {
    const params = new URLSearchParams({
        action: "parse",
        format: "json",
        prop: "text",
        page: pageTitle,
        section: "0"
    });

    try {
        const res = await fetch(`${API}?${params}`, {
            headers: { "User-Agent": "DiscordBot/Derivative" }
        });
        const json = await res.json();
        const html = json.parse?.text?.["*"];
        if (!html) return null;
        return html.replace(/<[^>]*>?/gm, ""); // Strip HTML
    } catch (err) {
        console.error(`Failed to fetch lead section for "${pageTitle}":`, err.message);
        return null;
    }
}

async function parseWikiLinks(text) {
    const regex = /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g;
    const matches = [];
    let match;

    while ((match = regex.exec(text)) !== null) {
        matches.push({
            index: match.index,
            length: match[0].length,
            page: match[1].trim(),
            label: match[2] ? match[2].trim() : null
        });
    }

    const processed = await Promise.all(matches.map(async m => {
        const display = m.label || m.page;
        const canonical = await findCanonicalTitle(m.page) || m.page;

        let pageOnly = canonical;
        let fragment = null;
        if (canonical.includes("#")) {
            [pageOnly, fragment] = canonical.split("#");
            fragment = fragment.trim();
        }

        const parts = pageOnly.split(':').map(seg => encodeURIComponent(seg.replace(/ /g, "_")));
        const anchor = fragment ? `#${encodeURIComponent(fragment.replace(/ /g, "_"))}` : '';
        const url = `<${WIKI_ENDPOINTS.ARTICLE_PATH}${parts.join(':')}${anchor}>`;

        return { index: m.index, length: m.length, replacement: `[**${display}**](${url})` };
    }));

    let res = text;
    processed.sort((a,b)=> b.index - a.index);
    for (const { index, length, replacement } of processed) {
        res = res.slice(0, index) + replacement + res.slice(index + length);
    }
    return res;
}

async function parseTemplates(text) {
    const regex = /\{\{([^{}|]+)(?:\|([^{}]*))?\}\}/g;
    const matches = [];
    let match;

    while ((match = regex.exec(text)) !== null) {
        matches.push({
            fullMatch: match[0],
            templateName: match[1].trim(),
            param: match[2]?.trim(),
            index: match.index, 
            length: match[0].length,
        });
    }

    const processedMatches = await Promise.all(matches.map(async (m) => {
        const { fullMatch, templateName, param, index, length } = m;
        let replacement = fullMatch; 

        const canonical = await findCanonicalTitle(templateName);
        if (!canonical) {
            return { index, length, replacement: "I don't know." };
        }

        let pageOnly = canonical;
        let fragment = null;
        if (canonical.includes("#")) {
            [pageOnly, fragment] = canonical.split("#");
            fragment = fragment.trim();
        }

        let wikiText = null;
        try {
            if (fragment) {
                wikiText = await getSectionContent(pageOnly, fragment);
            } else {
                wikiText = await getLeadSection(pageOnly);
            }
        } catch (err) {
            wikiText = null;
        }

        if (wikiText) {
            const parts = pageOnly.split(':').map(seg => encodeURIComponent(seg.replace(/ /g, "_")));
            const anchor = fragment ? `#${encodeURIComponent(fragment.replace(/ /g, "_"))}` : '';
            const link = `<${WIKI_ENDPOINTS.ARTICLE_PATH}${parts.join(':')}${anchor}>`;

            replacement = `**${templateName}** → ${wikiText.slice(0,1000)}\n${link}`;
        } else {
            replacement = "I don't know.";
        }

        return { index, length, replacement };
    }));

    let result = text;
    processedMatches.sort((a, b) => b.index - a.index);
    for (const { index, length, replacement } of processedMatches) {
        result = result.slice(0, index) + replacement + result.slice(index + length);
    }

    return result;
}

async function performSearch(query) {
    const params = new URLSearchParams({
        action: "query",
        list: "search",
        srsearch: query,
        srlimit: 5,
        format: "json"
    });

    try {
        const res = await fetch(`${API}?${params.toString()}`, {
            headers: { "User-Agent": "DiscordBot/Derivative" }
        });
        
        if (!res.ok) throw new Error("Search failed");
        
        const json = await res.json();
        return json.query?.search || [];
    } catch (err) {
        console.error("Search API error:", err);
        return [];
    }
}

/**
 * Tool function to fetch from the wiki.
 * Now performs a search first to find the most relevant pages.
 */
async function searchWiki({ query }) {
    console.log(`[Tool] Wiki request for: "${query}"`);

    try {
        // 1. Try direct lookup first (most accurate for specific titles)
        const directUrl = `${API}?action=query&format=json&prop=extracts|pageprops&explaintext=1&titles=${encodeURIComponent(query)}&redirects=1`;
        const directRes = await fetch(directUrl, { headers: { "User-Agent": "DiscordBot/Derivative" } });
        const directData = await directRes.json();
        const directPages = directData.query?.pages;

        if (directPages) {
            const page = Object.values(directPages)[0];
            if (page && page.pageid && !(page.pageprops && page.pageprops.disambiguation !== undefined)) {
                return {
                    status: "success",
                    title: page.title,
                    summary: page.extract
                };
            }
        }

        // 2. If direct lookup failed or is ambiguous, perform a full-text search
        const searchResults = await performSearch(query);

        if (searchResults.length === 0) {
            return { error: `No wiki articles found for "${query}".` };
        }

        // 3. Fetch content for the top results (up to 3)
        const topResults = searchResults.slice(0, 3);
        const pagesData = await Promise.all(topResults.map(async (result) => {
            try {
                const pageTitle = result.title;
                const url = `${API}?action=query&format=json&prop=extracts|pageprops&explaintext=1&titles=${encodeURIComponent(pageTitle)}&redirects=1`;
                const res = await fetch(url, { headers: { "User-Agent": "DiscordBot/Derivative" } });
                const data = await res.json();
                if (!data.query?.pages) return null;
                return Object.values(data.query.pages)[0];
            } catch (err) {
                console.warn(`Failed to fetch page "${result.title}":`, err.message);
                return null;
            }
        }));

        const validPages = pagesData.filter(p => p && p.pageid && p.extract);

        if (validPages.length === 0) {
            return { error: `No wiki content found for "${query}".` };
        }

        // Check for disambiguation in the top result
        const firstPage = validPages[0];
        if (firstPage.pageprops && firstPage.pageprops.disambiguation !== undefined) {
            const linksUrl = `${API}?action=query&format=json&prop=links&titles=${encodeURIComponent(firstPage.title)}&pllimit=10`;
            const linksRes = await fetch(linksUrl, { headers: { "User-Agent": "DiscordBot/Derivative" } });
            const linksData = await linksRes.json();
            const links = Object.values(linksData.query?.pages || {})[0]?.links?.map(l => l.title) || [];

            return {
                status: "ambiguous",
                message: "Multiple topics found. Ask the user which one they mean.",
                options: links
            };
        }

        // Return combined results from the top pages
        const MAX_EXTRACT_LENGTH = 2000;
        const combinedSummary = validPages.map(p => {
            const truncatedExtract = p.extract.length > MAX_EXTRACT_LENGTH 
                ? p.extract.slice(0, MAX_EXTRACT_LENGTH) + "..." 
                : p.extract;
            return `Title: ${p.title}\nSummary: ${truncatedExtract}`;
        }).join("\n\n---\n\n");

        return {
            status: "success",
            title: validPages.length === 1 ? firstPage.title : "Search Results",
            summary: combinedSummary
        };

    } catch (err) {
        console.error("searchWiki error:", err);
        return { error: "Failed to fetch data from Wiki API." };
    }
}

module.exports = { 
    API, 
    knownPages, 
    loadPages, 
    findCanonicalTitle, 
    getWikiContent, 
    getSectionContent, 
    getLeadSection, 
    parseWikiLinks, 
    parseTemplates,
    performSearch,
    searchWiki
};
