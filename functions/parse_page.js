const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const cheerio = require('cheerio');

const { WIKI_ENDPOINTS } = require("../config.js");
const API = WIKI_ENDPOINTS.API;

let knownPages = [];
let pageLookup = new Map();

// --- UTILITIES ---
function getFullSizeImageUrl(url) {
    if (!url || !url.includes('/thumb/')) return url;
    try {
        const urlObj = new URL(url);
        if (urlObj.pathname.includes('/thumb/')) {
            // Remove /thumb/ from pathname
            urlObj.pathname = urlObj.pathname.replace(/\/thumb\//, '/');
            // Remove the last segment (thumbnail size part)
            const pathParts = urlObj.pathname.split('/');
            pathParts.pop();
            urlObj.pathname = pathParts.join('/');
            return urlObj.href;
        }
    } catch (e) {
        // Fallback for weird URLs
        let newUrl = url.replace(/\/thumb\//, '/');
        const lastSlash = newUrl.lastIndexOf('/');
        if (lastSlash !== -1) {
            newUrl = newUrl.substring(0, lastSlash);
        }
        return newUrl;
    }
    return url;
}

function htmlToMarkdown(html, baseUrl) {
    if (!html) return "";
    const $ = cheerio.load(html);

    // Remove unwanted elements
    $('style, script, .thumb, figure, table, .mw-editsection, sup.reference, .noprint, .nomobile, .error, input, .ext-floatingui-content, .infobox, .portable-infobox, table[class*="infobox"], ol.references, .mw-collapsed, .template-navplate').remove();

    function convertNode(node) {
        if (node.type === 'text') {
            return node.data;
        }

        const $node = $(node);
        let childrenContent = '';
        if (node.children) {
            node.children.forEach((child) => {
                childrenContent += convertNode(child);
            });
        }

        switch (node.name) {
            case 'b':
            case 'strong':
                return childrenContent.trim() ? `**${childrenContent.trim()}**` : '';
            case 'i':
            case 'em':
                return childrenContent.trim() ? `*${childrenContent.trim()}*` : '';
            case 'a':
                let href = $node.attr('href');
                if (href) {
                    if (href.startsWith('/')) {
                        href = new URL(href, baseUrl).href;
                    } else if (!href.startsWith('http')) {
                        try { href = new URL(href, baseUrl).href; } catch (e) {}
                    }
                    const text = childrenContent.trim().replace(/\[/g, '\\[').replace(/\]/g, '\\]');
                    return text ? `[${text}](<${href}>)` : '';
                }
                return childrenContent;
            case 'br':
                return '\n';
            case 'p':
            case 'div':
                return `${childrenContent}\n`;
            case 'li': {
                const isOrdered = node.parent && node.parent.name === 'ol';
                const prefix = isOrdered
                    ? `${Array.from(node.parent.children).filter(c => c.name === 'li').indexOf(node) + 1}. `
                    : '* ';
                return `${prefix}${childrenContent.trim()}\n`;
            }
            case 'h1':
            case 'h2':
                return childrenContent.trim() ? `## ${childrenContent.trim()}\n` : '';
            case 'h3':
            case 'h4':
            case 'h5':
            case 'h6':
                return childrenContent.trim() ? `### ${childrenContent.trim()}\n` : '';
            default:
                return childrenContent;
        }
    }

    let text = '';
    const root = $('.mw-parser-output').length ? $('.mw-parser-output') : $.root();
    root.contents().each((i, node) => {
        text += convertNode(node);
    });

    // Fix formatting: collapse multiple spaces and handle newlines
    text = text.replace(/[ \t]+/g, ' '); // Collapse spaces/tabs
    text = text.replace(/\n\s*\n/g, '\n\n'); // Max two newlines
    text = text.replace(/ +/g, ' '); // One more pass for space cleanup after newline adjustments

    return text.trim();
}

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
        const directParams = new URLSearchParams({
            action: "query",
            format: "json",
            titles: raw,
            redirects: "1",
            indexpageids: "1"
        });

        const res = await fetch(`${API}?${directParams.toString()}`, {
            headers: { "User-Agent": "DiscordBot/Derivative" }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const pageId = json.query?.pageids?.[0];
        const page = json.query?.pages?.[pageId];

        if (page && page.missing === undefined) {
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
            pageLookup.set(canonicalTitle.toLowerCase(), canonicalTitle);
            return canonicalTitle;
        }

        // use case insensitive search
        const searchParams = new URLSearchParams({
            action: "query",
            list: "search",
            srsearch: raw,
            srlimit: "1",
            format: "json"
        });

        const searchRes = await fetch(`${API}?${searchParams.toString()}`, {
            headers: { "User-Agent": "DiscordBot/Derivative" }
        });
        const searchJson = await searchRes.json();
        const topResult = searchJson.query?.search?.[0];

        if (topResult) {
            pageLookup.set(topResult.title.toLowerCase(), topResult.title);
            return topResult.title;
        }
    } catch (err) {
        console.warn("findCanonicalTitle lookup failed:", err?.message || err);
    }

    return null;
}

async function getWikiContent(pageTitle) {
    const params = new URLSearchParams({
        action: "parse",
        page: pageTitle,
        format: "json",
        prop: "text",
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
            return htmlToMarkdown(json.parse.text["*"], WIKI_ENDPOINTS.BASE);
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
            s => s.line.replace(/<[^>]*>?/gm, "").toLowerCase() === sectionName.toLowerCase()
        );

        if (!match) return null;

        return {
            index: match.index,
            line: match.line.replace(/<[^>]*>?/gm, "")
        };
    } catch (err) {
        console.error(`Failed to fetch section index for "${sectionName}" in "${pageTitle}":`, err.message);
        return null;
    }
}

async function getSectionContent(pageTitle, sectionName) {
    const sectionInfo = await getSectionIndex(pageTitle, sectionName);
    if (!sectionInfo) {
        console.warn(`Section "${sectionName}" not found in "${pageTitle}"`);
        return null;
    }

    const params = new URLSearchParams({
        action: "parse",
        format: "json",
        prop: "text",
        page: pageTitle,
        section: sectionInfo.index
    });

    try {
        const res = await fetch(`${API}?${params}`, {
            headers: { "User-Agent": "DiscordBot/Derivative" }
        });
        const json = await res.json();

        const html = json.parse?.text?.["*"];
        if (!html) return null;

        const $ = cheerio.load(html);
        const galleryItems = [];

        $('ul.gallery .gallerybox').each((i, el) => {
            const $el = $(el);
            const img = $el.find('img').first();
            let src = img.attr('src');

            if (src) {
                if (src.startsWith('//')) src = 'https:' + src;
                else if (src.startsWith('/')) src = new URL(src, WIKI_ENDPOINTS.BASE).href;

                // Transform to full-size URL
                src = getFullSizeImageUrl(src);

                const caption = $el.find('.gallerytext').text().trim();
                galleryItems.push({ url: src, caption });
            }
        });

        // Remove gallery from HTML to avoid duplicating captions in content
        if (galleryItems.length > 0) {
            $('ul.gallery').remove();
        }

        return {
            content: htmlToMarkdown($.html(), WIKI_ENDPOINTS.BASE),
            displayTitle: sectionInfo.line,
            gallery: galleryItems.length > 0 ? galleryItems : null
        };
    } catch (err) {
        console.error(`Failed to fetch section content for "${pageTitle}#${sectionName}":`, err.message);
        return null;
    }
}

async function getLeadSection(pageTitle) {
    const params = new URLSearchParams({
        action: "query",
        prop: "extracts",
        exintro: "1",
        redirects: "1",
        titles: pageTitle,
        format: "json"
    });

    try {
        const res = await fetch(`${API}?${params.toString()}`, {
            headers: { "User-Agent": "DiscordBot/Derivative" }
        });
        const json = await res.json();
        const pages = json.query?.pages;
        if (!pages) return null;
        const page = Object.values(pages)[0];
        const html = page?.extract;
        if (!html) return null;
        return htmlToMarkdown(html, WIKI_ENDPOINTS.BASE);
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

        const actualText = (wikiText && typeof wikiText === 'object') ? wikiText.content : wikiText;

        if (actualText) {
            const parts = pageOnly.split(':').map(seg => encodeURIComponent(seg.replace(/ /g, "_")));
            const anchor = fragment ? `#${encodeURIComponent(fragment.replace(/ /g, "_"))}` : '';
            const link = `<${WIKI_ENDPOINTS.ARTICLE_PATH}${parts.join(':')}${anchor}>`;

            replacement = `**${templateName}** → ${actualText.slice(0,1000)}\n${link}`;
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
        format: "json"
    });

    try {
        const res = await fetch(`${API}?${params.toString()}`, {
            headers: { "User-Agent": "DiscordBot/Derivative" }
        });
        
        if (!res.ok) throw new Error("Search failed");
        
        const json = await res.json();
        const results = json.query?.search || [];
        
        if (results.length === 0) return "No results found.";

        // Return a list of titles
        return results.map(r => r.title).join(", ");
    } catch (err) {
        console.error("Search API error:", err);
        return "Error searching wiki.";
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
    getFullSizeImageUrl
};
