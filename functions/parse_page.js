const { fetch, resolveWikiKey } = require("./utils.js");
const { WIKIS, BOT_NAME } = require("../config.js");
const cheerio = require('cheerio');

let knownPagesByWiki = new Map();
let pageLookupByWiki = new Map();

// Backward compatibility symbols (keeping for now to avoid breaking existing imports)
let knownPages = [];

// --- UTILITIES ---
async function fetchWithTimeout(url, options = {}, timeout = 5000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

function getFullSizeImageUrl(url) {
    if (!url || !url.includes('/thumb/')) return url;
    try {
        const urlObj = new URL(url);
        if (urlObj.pathname.includes('/thumb/')) {
            urlObj.pathname = urlObj.pathname.replace(/\/thumb\//, '/');
            const pathParts = urlObj.pathname.split('/');
            pathParts.pop();
            urlObj.pathname = pathParts.join('/');
            return urlObj.href;
        }
    } catch (e) {
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

    $('style, script, .thumb, figure, table, .mw-editsection, sup.reference, .noprint, .nomobile, .error, input, .ext-floatingui-content, .infobox, .portable-infobox, table[class*="infobox"], ol.references, .mw-collapsed, .template-navplate, .mw-indicator, .mw-indicators, .utg-tabs').remove();

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

    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n\s*\n/g, '\n\n');

    return text.trim();
}

// --- WIKI API FUNCTIONS ---
async function findCanonicalTitle(input, wikiConfig) {
    if (!input) return null;
    const wikiConfigSafe = wikiConfig || {};
    const raw = String(input).trim();
    const wikiKey = wikiConfigSafe.key || (wikiConfigSafe.baseUrl ? resolveWikiKey(wikiConfigSafe.baseUrl, WIKIS) : "tagging");

    if (pageLookupByWiki.has(wikiKey)) {
        const lookup = pageLookupByWiki.get(wikiKey);
        if (lookup.has(raw.toLowerCase())) return lookup.get(raw.toLowerCase());
    }

    const apiEndpoint = wikiConfigSafe.apiEndpoint || WIKIS[wikiKey]?.apiEndpoint;
    if (!apiEndpoint) return null;

    try {
        const directParams = new URLSearchParams({
            action: "query",
            format: "json",
            titles: raw,
            redirects: "1",
            indexpageids: "1"
        });

        const res = await fetchWithTimeout(`${apiEndpoint}?${directParams.toString()}`, {
            headers: { "User-Agent": `DiscordBot/${BOT_NAME}` }
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
            return canonicalTitle;
        }

        const searchParams = new URLSearchParams({
            action: "query",
            list: "search",
            srsearch: `intitle:${raw}`,
            srlimit: "1",
            format: "json"
        });

        const searchRes = await fetchWithTimeout(`${apiEndpoint}?${searchParams.toString()}`, {
            headers: { "User-Agent": `DiscordBot/${BOT_NAME}` }
        });
        const searchJson = await searchRes.json();
        const topResult = searchJson.query?.search?.[0];

        if (topResult) {
            return topResult.title;
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            console.warn(`findCanonicalTitle timed out for wiki ${wikiConfigSafe.name || wikiKey}`);
        } else {
            console.warn(`findCanonicalTitle lookup failed for wiki ${wikiConfigSafe.name || wikiKey}:`, err?.message || err);
        }
    }

    return null;
}

async function getPageData(pageTitle, wikiConfig) {
    const canonical = await findCanonicalTitle(pageTitle, wikiConfig);
    if (!canonical) return null;

    const wikiConfigSafe = wikiConfig || {};
    const wikiKey = wikiConfigSafe.key || (wikiConfigSafe.baseUrl ? resolveWikiKey(wikiConfigSafe.baseUrl, WIKIS) : "tagging");
    const apiEndpoint = wikiConfigSafe.apiEndpoint || WIKIS[wikiKey]?.apiEndpoint;
    if (!apiEndpoint) return null;

    const cleanTitle = canonical.includes("#") ? canonical.split("#")[0] : canonical;

    const params = new URLSearchParams({
        action: "query",
        prop: "extracts|pageimages",
        exintro: "1",
        redirects: "1",
        titles: cleanTitle,
        pithumbsize: "512",
        format: "json"
    });

    try {
        const res = await fetchWithTimeout(`${apiEndpoint}?${params.toString()}`, {
            headers: { "User-Agent": `DiscordBot/${BOT_NAME}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const pages = json.query?.pages;
        if (!pages) return null;
        const page = Object.values(pages)[0];

        return {
            canonical: page.title,
            extract: htmlToMarkdown(page.extract, wikiConfigSafe.baseUrl || WIKIS[wikiKey].baseUrl),
            imageUrl: getFullSizeImageUrl(page.thumbnail?.source)
        };
    } catch (err) {
        console.error(`Failed to fetch page data for "${pageTitle}" on ${wikiConfigSafe.name || wikiKey}:`, err.message);
        return null;
    }
}

async function getSectionIndex(pageTitle, sectionName, wikiConfig, canonicalTitle = null) {
    const canonical = canonicalTitle || await findCanonicalTitle(pageTitle, wikiConfig) || pageTitle;
    const wikiConfigSafe = wikiConfig || {};
    const wikiKey = wikiConfigSafe.key || (wikiConfigSafe.baseUrl ? resolveWikiKey(wikiConfigSafe.baseUrl, WIKIS) : "tagging");
    const apiEndpoint = wikiConfigSafe.apiEndpoint || WIKIS[wikiKey]?.apiEndpoint;
    if (!apiEndpoint) return null;

    const cleanTitle = canonical.includes("#") ? canonical.split("#")[0] : canonical;

    const params = new URLSearchParams({
        action: "parse",
        format: "json",
        prop: "sections",
        page: cleanTitle
    });

    try {
        const res = await fetchWithTimeout(`${apiEndpoint}?${params}`, {
            headers: { "User-Agent": `DiscordBot/${BOT_NAME}` }
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
        console.error(`Failed to fetch section index for "${sectionName}" in "${pageTitle}" on ${wikiConfigSafe.name || wikiKey}:`, err.message);
        return null;
    }
}

async function getSectionContent(pageTitle, sectionName, wikiConfig) {
    const canonical = await findCanonicalTitle(pageTitle, wikiConfig) || pageTitle;
    const sectionInfo = await getSectionIndex(pageTitle, sectionName, wikiConfig, canonical);
    if (!sectionInfo) return null;

    const wikiConfigSafe = wikiConfig || {};
    const wikiKey = wikiConfigSafe.key || (wikiConfigSafe.baseUrl ? resolveWikiKey(wikiConfigSafe.baseUrl, WIKIS) : "tagging");
    const apiEndpoint = wikiConfigSafe.apiEndpoint || WIKIS[wikiKey]?.apiEndpoint;
    if (!apiEndpoint) return null;

    const cleanTitle = canonical.includes("#") ? canonical.split("#")[0] : canonical;

    const params = new URLSearchParams({
        action: "parse",
        format: "json",
        prop: "text",
        page: cleanTitle,
        section: sectionInfo.index
    });

    try {
        const res = await fetchWithTimeout(`${apiEndpoint}?${params}`, {
            headers: { "User-Agent": `DiscordBot/${BOT_NAME}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
                else if (src.startsWith('/')) src = new URL(src, wikiConfigSafe.baseUrl || WIKIS[wikiKey].baseUrl).href;
                src = getFullSizeImageUrl(src);
                const caption = $el.find('.gallerytext').text().trim();
                galleryItems.push({ url: src, caption });
            }
        });

        if (galleryItems.length > 0) {
            $('ul.gallery').remove();
        }

        return {
            content: htmlToMarkdown($.html(), wikiConfigSafe.baseUrl || WIKIS[wikiKey].baseUrl),
            displayTitle: sectionInfo.line,
            gallery: galleryItems.length > 0 ? galleryItems : null
        };
    } catch (err) {
        console.error(`Failed to fetch section content for "${pageTitle}#${sectionName}" on ${wikiConfigSafe.name || wikiKey}:`, err.message);
        return null;
    }
}

async function getLeadSection(pageTitle, wikiConfig) {
    const data = await getPageData(pageTitle, wikiConfig);
    return data?.extract || null;
}

async function performSearch(query, wikiConfig) {
    const wikiConfigSafe = wikiConfig || {};
    const wikiKey = wikiConfigSafe.key || (wikiConfigSafe.baseUrl ? resolveWikiKey(wikiConfigSafe.baseUrl, WIKIS) : "tagging");
    const apiEndpoint = wikiConfigSafe.apiEndpoint || WIKIS[wikiKey]?.apiEndpoint;
    if (!apiEndpoint) throw new Error("No API endpoint configured for this wiki.");

    const params = new URLSearchParams({
        action: "query",
        list: "search",
        srsearch: query,
        format: "json"
    });

    const res = await fetchWithTimeout(`${apiEndpoint}?${params.toString()}`, {
        headers: { "User-Agent": `DiscordBot/${BOT_NAME}` }
    });
    if (!res.ok) throw new Error(`Wiki API returned ${res.status}: ${res.statusText}`);
    const json = await res.json();
    const results = json.query?.search || [];
    return results.map(r => r.title);
}

async function getAllNamespaces(wikiConfig) {
    const wikiConfigSafe = wikiConfig || {};
    const wikiKey = wikiConfigSafe.key || (wikiConfigSafe.baseUrl ? resolveWikiKey(wikiConfigSafe.baseUrl, WIKIS) : "tagging");
    const apiEndpoint = wikiConfigSafe.apiEndpoint || WIKIS[wikiKey]?.apiEndpoint;
    if (!apiEndpoint) return [0, 4];

    try {
        const params = new URLSearchParams({
            action: "query",
            meta: "siteinfo",
            siprop: "namespaces",
            format: "json"
        });
        const res = await fetchWithTimeout(`${apiEndpoint}?${params.toString()}`, {
            headers: { "User-Agent": `DiscordBot/${BOT_NAME}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const nsObj = json.query?.namespaces || {};
        return Object.entries(nsObj)
            .map(([k, v]) => parseInt(k, 10))
            .filter(id => id >= 0 && id % 2 === 0);
    } catch (err) {
        // Fallback to Main (0) and Project (4) namespaces if lookup fails.
        // These are conservative defaults used by most MediaWiki installations.
        console.warn(`Failed to fetch namespaces for ${wikiConfigSafe.name || wikiKey}, falling back to defaults [0, 4]:`, err.message);
        return [0, 4];
    }
}

async function getAllPages(wikiConfig) {
    const pages = [];
    const wikiConfigSafe = wikiConfig || {};
    const wikiKey = wikiConfigSafe.key || (wikiConfigSafe.baseUrl ? resolveWikiKey(wikiConfigSafe.baseUrl, WIKIS) : "tagging");
    const apiEndpoint = wikiConfigSafe.apiEndpoint || WIKIS[wikiKey]?.apiEndpoint;
    if (!apiEndpoint) return [];

    try {
        const namespaces = await getAllNamespaces(wikiConfigSafe);
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

                const res = await fetchWithTimeout(`${apiEndpoint}?${params.toString()}`, {
                    headers: { "User-Agent": `DiscordBot/${BOT_NAME}` }
                });
                if (!res.ok) throw new Error(`Wiki API returned ${res.status}`);
                const json = await res.json();
                if (json?.query?.allpages?.length) {
                    pages.push(...json.query.allpages.map(p => p.title));
                }
                apcontinue = json.continue?.apcontinue || null;
            } while (apcontinue);
        }
    } catch (err) {
        console.error(`Error in getAllPages for ${wikiConfigSafe.name || wikiKey}:`, err.message);
    }
    return [...new Set(pages)];
}

async function loadPages() {
    try {
        knownPagesByWiki.clear();
        pageLookupByWiki.clear();
        knownPages.length = 0;

        for (const wikiKey in WIKIS) {
            const wikiConfig = WIKIS[wikiKey];
            const newPages = await getAllPages(wikiConfig);
            knownPagesByWiki.set(wikiKey, newPages);
            knownPages.push(...newPages);

            const lookup = new Map();
            for (const title of newPages) {
                lookup.set(title.toLowerCase(), title);
            }
            pageLookupByWiki.set(wikiKey, lookup);
            console.log(`Loaded ${newPages.length} pages from ${wikiConfig.name}`);
        }
    } catch (err) {
        console.error("loadPages failed:", err.message);
    }
}

async function getFileUrls(fileTitles, wikiConfig) {
    if (!fileTitles || fileTitles.length === 0) return [];

    const wikiConfigSafe = wikiConfig || {};
    const wikiKey = wikiConfigSafe.key || (wikiConfigSafe.baseUrl ? resolveWikiKey(wikiConfigSafe.baseUrl, WIKIS) : "tagging");
    const apiEndpoint = wikiConfigSafe.apiEndpoint || WIKIS[wikiKey]?.apiEndpoint;
    if (!apiEndpoint) return [];

    const params = new URLSearchParams({
        action: "query",
        titles: fileTitles.join("|"),
        prop: "imageinfo",
        iiprop: "url|mime",
        format: "json",
        redirects: 1
    });

    try {
        const res = await fetchWithTimeout(`${apiEndpoint}?${params.toString()}`, {
            headers: { "User-Agent": `DiscordBot/${BOT_NAME}` }
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const pages = json.query?.pages;
        if (!pages) return [];

        const results = [];
        for (const page of Object.values(pages)) {
            if (page.missing === undefined && page.imageinfo?.[0]) {
                results.push({
                    title: page.title,
                    url: page.imageinfo[0].url,
                    mime: page.imageinfo[0].mime
                });
            }
        }
        return results;
    } catch (err) {
        console.error(`Failed to fetch file URLs for ${fileTitles.join(", ")}:`, err.message);
        return [];
    }
}

async function getWikiContent(pageTitle, wikiConfig) {
    const wikiConfigSafe = wikiConfig || {};
    const wikiKey = wikiConfigSafe.key || (wikiConfigSafe.baseUrl ? resolveWikiKey(wikiConfigSafe.baseUrl, WIKIS) : "tagging");
    const apiEndpoint = wikiConfigSafe.apiEndpoint || WIKIS[wikiKey]?.apiEndpoint;
    if (!apiEndpoint) return null;

    const cleanTitle = pageTitle.includes("#") ? pageTitle.split("#")[0] : pageTitle;
    const params = new URLSearchParams({
        action: "parse",
        page: cleanTitle,
        format: "json",
        prop: "text|images",
    });

    try {
        const res = await fetchWithTimeout(`${apiEndpoint}?${params.toString()}`, {
            headers: {
                "User-Agent": `DiscordBot/${BOT_NAME}`
            },
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const json = await res.json();

        if (json?.parse?.text?.["*"]) {
            let markdown = htmlToMarkdown(json.parse.text["*"], wikiConfigSafe.baseUrl || WIKIS[wikiKey].baseUrl);

            if (json.parse.images && json.parse.images.length > 0) {
                const imageList = json.parse.images
                    .filter(img => !img.toLowerCase().endsWith('.svg'))
                    .map(img => `File:${img}`)
                    .join(", ");
                if (imageList) {
                    markdown += `\n\n[SYSTEM: Available images on this page: ${imageList}]`;
                }
            }

            return markdown;
        }
        return null;
    } catch (err) {
        console.error(`Failed to fetch content for "${pageTitle}" on ${wikiConfigSafe.name || wikiKey}:`, err.message);
        return null;
    }
}

const searchWikiTool = {
    name: "searchWiki",
    description: "Search for pages on the wiki. Returns a list of matching page titles. Use this when you don't know the exact title or if there might be multiple relevant pages. If results are ambiguous, ask the user for clarification.",
    parametersJsonSchema: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "The search query."
            },
            wiki: {
                type: "string",
                description: "The wiki to search on.",
                enum: ["tagging", "farm"]
            }
        },
        required: ["query"]
    }
};

const fetchPageTool = {
    name: "fetchPage",
    description: "Fetch the full markdown content of a specific wiki page. Use this when you have a specific page title from searchWiki or if the user mentions a specific page. This tool will also provide a list of images available on the page.",
    parametersJsonSchema: {
        type: "object",
        properties: {
            title: {
                type: "string",
                description: "The exact title of the page to fetch."
            },
            wiki: {
                type: "string",
                description: "The wiki to fetch from.",
                enum: ["tagging", "farm"]
            }
        },
        required: ["title"]
    }
};

const googleSearchTool = {
    name: "googleSearch",
    description: "Search the web for information using Google. Use this for off-topic queries or when the wiki doesn't have the information you need. Keep answers brief and in character.",
    parametersJsonSchema: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "The search query."
            }
        },
        required: ["query"]
    }
};

module.exports = { 
    searchWikiTool,
    fetchPageTool,
    googleSearchTool,
    findCanonicalTitle, 
    getPageData,
    getSectionContent, 
    getLeadSection, 
    performSearch,
    getFullSizeImageUrl,
    loadPages,
    getWikiContent,
    getFileUrls,
    knownPages,
    knownPagesByWiki,
    pageLookupByWiki
};
