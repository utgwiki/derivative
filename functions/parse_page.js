const { fetch } = require("./utils.js");
const cheerio = require('cheerio');

let knownPages = [];
let pageLookup = new Map();

// --- UTILITIES ---
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
    const raw = String(input).trim();

    try {
        const directParams = new URLSearchParams({
            action: "query",
            format: "json",
            titles: raw,
            redirects: "1",
            indexpageids: "1"
        });

        const res = await fetch(`${wikiConfig.apiEndpoint}?${directParams.toString()}`, {
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
            return canonicalTitle;
        }

        const searchParams = new URLSearchParams({
            action: "query",
            list: "search",
            srsearch: `intitle:${raw}`,
            srlimit: "1",
            format: "json"
        });

        const searchRes = await fetch(`${wikiConfig.apiEndpoint}?${searchParams.toString()}`, {
            headers: { "User-Agent": "DiscordBot/Derivative" }
        });
        const searchJson = await searchRes.json();
        const topResult = searchJson.query?.search?.[0];

        if (topResult) {
            return topResult.title;
        }
    } catch (err) {
        console.warn(`findCanonicalTitle lookup failed for wiki ${wikiConfig.name}:`, err?.message || err);
    }

    return null;
}

async function getPageData(pageTitle, wikiConfig) {
    const canonical = await findCanonicalTitle(pageTitle, wikiConfig);
    if (!canonical) return null;

    const params = new URLSearchParams({
        action: "query",
        prop: "extracts|pageimages",
        exintro: "1",
        redirects: "1",
        titles: canonical,
        pithumbsize: "512",
        format: "json"
    });

    try {
        const res = await fetch(`${wikiConfig.apiEndpoint}?${params.toString()}`, {
            headers: { "User-Agent": "DiscordBot/Derivative" }
        });
        const json = await res.json();
        const pages = json.query?.pages;
        if (!pages) return null;
        const page = Object.values(pages)[0];

        return {
            canonical: page.title,
            extract: htmlToMarkdown(page.extract, wikiConfig.baseUrl),
            imageUrl: getFullSizeImageUrl(page.thumbnail?.source)
        };
    } catch (err) {
        console.error(`Failed to fetch page data for "${pageTitle}" on ${wikiConfig.name}:`, err.message);
        return null;
    }
}

async function getSectionIndex(pageTitle, sectionName, wikiConfig) {
    const canonical = await findCanonicalTitle(pageTitle, wikiConfig) || pageTitle;
    const params = new URLSearchParams({
        action: "parse",
        format: "json",
        prop: "sections",
        page: canonical
    });

    try {
        const res = await fetch(`${wikiConfig.apiEndpoint}?${params}`, {
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
        console.error(`Failed to fetch section index for "${sectionName}" in "${pageTitle}" on ${wikiConfig.name}:`, err.message);
        return null;
    }
}

async function getSectionContent(pageTitle, sectionName, wikiConfig) {
    const sectionInfo = await getSectionIndex(pageTitle, sectionName, wikiConfig);
    if (!sectionInfo) return null;

    const params = new URLSearchParams({
        action: "parse",
        format: "json",
        prop: "text",
        page: pageTitle,
        section: sectionInfo.index
    });

    try {
        const res = await fetch(`${wikiConfig.apiEndpoint}?${params}`, {
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
                else if (src.startsWith('/')) src = new URL(src, wikiConfig.baseUrl).href;
                src = getFullSizeImageUrl(src);
                const caption = $el.find('.gallerytext').text().trim();
                galleryItems.push({ url: src, caption });
            }
        });

        if (galleryItems.length > 0) {
            $('ul.gallery').remove();
        }

        return {
            content: htmlToMarkdown($.html(), wikiConfig.baseUrl),
            displayTitle: sectionInfo.line,
            gallery: galleryItems.length > 0 ? galleryItems : null
        };
    } catch (err) {
        console.error(`Failed to fetch section content for "${pageTitle}#${sectionName}" on ${wikiConfig.name}:`, err.message);
        return null;
    }
}

async function getLeadSection(pageTitle, wikiConfig) {
    const data = await getPageData(pageTitle, wikiConfig);
    return data?.extract || null;
}

async function performSearch(query, wikiConfig) {
    const params = new URLSearchParams({
        action: "query",
        list: "search",
        srsearch: query,
        format: "json"
    });

    try {
        const res = await fetch(`${wikiConfig.apiEndpoint}?${params.toString()}`, {
            headers: { "User-Agent": "DiscordBot/Derivative" }
        });
        const json = await res.json();
        const results = json.query?.search || [];
        if (results.length === 0) return "No results found.";
        return results.map(r => r.title).join(", ");
    } catch (err) {
        console.error(`Search API error for ${wikiConfig.name}:`, err);
        return "Error searching wiki.";
    }
}

async function getAllNamespaces(wikiConfig) {
    try {
        const params = new URLSearchParams({
            action: "query",
            meta: "siteinfo",
            siprop: "namespaces",
            format: "json"
        });
        const res = await fetch(`${wikiConfig.apiEndpoint}?${params.toString()}`, {
            headers: { "User-Agent": "DiscordBot/Derivative" }
        });
        const json = await res.json();
        const nsObj = json.query?.namespaces || {};
        return Object.entries(nsObj)
            .map(([k, v]) => parseInt(k, 10))
            .filter(id => id >= 0 && id % 2 === 0);
    } catch (err) {
        console.error(`Failed to fetch namespaces for ${wikiConfig.name}:`, err.message);
        return [0, 4];
    }
}

async function getAllPages(wikiConfig) {
    const pages = [];
    try {
        const namespaces = await getAllNamespaces(wikiConfig);
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

                const res = await fetch(`${wikiConfig.apiEndpoint}?${params.toString()}`, {
                    headers: { "User-Agent": "DiscordBot/Derivative" }
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
        console.error(`Error in getAllPages for ${wikiConfig.name}:`, err.message);
    }
    return [...new Set(pages)];
}

async function loadPages() {
    try {
        const { WIKIS } = require("../config.js");
        knownPages.length = 0;
        pageLookup = new Map();

        for (const wikiKey in WIKIS) {
            const wikiConfig = WIKIS[wikiKey];
            const newPages = await getAllPages(wikiConfig);
            knownPages.push(...newPages);
            for (const title of newPages) {
                pageLookup.set(title.toLowerCase(), title);
            }
            console.log(`Loaded ${newPages.length} pages from ${wikiConfig.name}`);
        }
    } catch (err) {
        console.error("loadPages failed:", err.message);
    }
}

async function getWikiContent(pageTitle, wikiConfig) {
    const params = new URLSearchParams({
        action: "parse",
        page: pageTitle,
        format: "json",
        prop: "text",
    });

    try {
        const res = await fetch(`${wikiConfig.apiEndpoint}?${params.toString()}`, {
            headers: {
                "User-Agent": "DiscordBot/Derivative"
            },
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const json = await res.json();

        if (json?.parse?.text?.["*"]) {
            return htmlToMarkdown(json.parse.text["*"], wikiConfig.baseUrl);
        }
        return null;
    } catch (err) {
        console.error(`Failed to fetch content for "${pageTitle}" on ${wikiConfig.name}:`, err.message);
        return null;
    }
}

module.exports = { 
    findCanonicalTitle, 
    getPageData,
    getSectionContent, 
    getLeadSection, 
    performSearch,
    getFullSizeImageUrl,
    loadPages,
    getWikiContent,
    knownPages
};
