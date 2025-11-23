const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const API = "https://tagging.wiki/w/api.php";
let knownPages = [];
let pageLookup = new Map();

// --- HELPER ---
function stripHtmlPreservingLinks(html) {
    if (!html) return "";

    // Remove style/script blocks completely (prevents CSS output)
    html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");

    // Convert links
    let text = html.replace(
        /<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1[^>]*>(.*?)<\/a>/gi,
        (match, quote, href, label) => {
            if (href.startsWith("/")) href = "https://tagging.wiki" + href;
            if (label.includes("[") || label.includes("]")) return label;
            const cleanLabel = label.replace(/<[^>]*>?/gm, "");
            return `[${cleanLabel}](<${href}>)`;
        }
    );

    // Only p and br → newline
    text = text.replace(/<(p|br)[^>]*>/gi, "\n");

    // Strip all other tags
    text = text.replace(/<[^>]*>?/gm, "");

    // Decode entities
    text = text
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ');

    // Collapse multiple blank lines
    return text.replace(/\n\s*\n/g, "\n\n").trim();
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
            headers: { "User-Agent": "DiscordBot/Deriv" }
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
                    headers: { "User-Agent": "DiscordBot/Deriv" }
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
            const res = await fetch(`${API}?${params.toString()}`, { headers: { "User-Agent": "DiscordBot/Deriv" } });
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
                "User-Agent": "DiscordBot/Deriv",
                "Origin": "https://tagging.wiki",
            },
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const json = await res.json();

        const html = json.parse?.text?.["*"];
        if (!html) return null;

        return stripHtmlPreservingLinks(html);
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
            headers: { "User-Agent": "DiscordBot/Deriv" }
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
        section: sectionIndex,
        disablelimitreport: "true",
        disableeditsection: "true",
        disabletoc: "true"
    });

    try {
        const res = await fetch(`${API}?${params}`, {
            headers: { "User-Agent": "DiscordBot/Deriv" }
        });
        const json = await res.json();

        const html = json.parse?.text?.["*"];
        if (!html) return null;
        
        return stripHtmlPreservingLinks(html);
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
        section: "0", 
        disablelimitreport: "true",
        disableeditsection: "true",
        disabletoc: "true"
    });

    try {
        const res = await fetch(`${API}?${params}`, {
            headers: { "User-Agent": "DiscordBot/Deriv" }
        });
        const json = await res.json();
        const html = json.parse?.text?.["*"];
        if (!html) return null;

        return stripHtmlPreservingLinks(html);
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
        const url = `<https://tagging.wiki/wiki/${parts.join(':')}${anchor}>`;

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
            const link = `<https://tagging.wiki/wiki/${parts.join(':')}${anchor}>`;

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

module.exports = { 
    API, 
    knownPages, 
    loadPages, 
    findCanonicalTitle, 
    getWikiContent, 
    getSectionContent, 
    getLeadSection, 
    parseWikiLinks, 
    parseTemplates 
};
