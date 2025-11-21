// deriv.js (CommonJS, Gemini 2.5 + wiki + auto relevance)
const { MAIN_KEYS } = require("./geminikey.js");
const { loadMemory, logMessage, memory: persistedMemory } = require("./memory.js");
loadMemory();

require("dotenv").config();
const {
    Client,
    GatewayIntentBits,
    Partials,
    MessageFlags,
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ActivityType,
    ChannelType
} = require("discord.js");
const {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ContextMenuCommandBuilder,
    InteractionType,
    ApplicationCommandType
} = require("discord.js");

// node-fetch v3+ is ESM
const fetch = (...args) => import("node-fetch").then(({
    default: fetch
}) => fetch(...args));

// dynamic import for @google/genai (ESM-only)
let GoogleGenAI;
async function getGeminiClient(apiKey) {
    if (!GoogleGenAI) {
        const mod = await import("@google/genai");
        GoogleGenAI = mod.GoogleGenAI;
    }
    return new GoogleGenAI({
        apiKey
    });
}

// -------------------- CONFIG --------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
// const AUTO_RESPONSE_CHANNEL_ID = "1423581041209118741";

const MESSAGES = {
    aiServiceError: "Connection's bad, can you send it again?",
    noAIResponse: "...",
    processingError: "I couldn't catch that... What'd you say again?",
};

const API = "https://tagging.wiki/w/api.php";

// -------------------- DATE --------------------
function getCurrentMonthYear() {
    const now = new Date();
    const monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];

    // --- Current Month/Year Logic ---
    const currentMonthIndex = now.getMonth(); // 0 (Jan) - 11 (Dec)
    const currentYear = now.getFullYear();
    const currentMonth = monthNames[currentMonthIndex];
    const day = now.getDate();

    // --- Previous Month/Year Logic ---
    let previousMonthIndex;
    let previousMonthYear;

    if (currentMonthIndex === 0) {
        // If it's January (index 0), previous month is December (index 11)
        previousMonthIndex = 11;
        // And the previous year is the current year minus 1
        previousMonthYear = currentYear - 1;
    } else {
        // Otherwise, previous month is simply the index before the current one
        previousMonthIndex = currentMonthIndex - 1;
        // And the year is the current year
        previousMonthYear = currentYear;
    }

    const previousMonth = monthNames[previousMonthIndex];

    return {
        currentMonth,
        currentYear,
        day,
        previousMonth,
        previousMonthYear // Added to handle Jan -> Dec previous year
    };
}

function getSystemInstruction() {
    const {
        currentMonth,
        currentYear,
        day,
        previousMonth,
        previousMonthYear
    } = getCurrentMonthYear();
    
    return `You are Derivative, nickname Deriv, a person from the Roblox game Untitled Tag Game. 
Never mention Gemini, AI, or your true identity.
Use only verified info from https://tagging.wiki/ — if unsure, say “I don’t know.”
Always double-check facts and avoid exaggeration or guesses.
Miraheze hosts the wiki — never refer to “Fandom” as the platform.
Your appearance: a pill baby with a blue stomach and pale head.
For “all XX misprints,” check both “XX” and “Misprints.”
“Welcome to Bloxburg” refers to the map, not the game.
You specialize in Untitled Tag Game, but can help with anything if asked. With this, you are NOT just limited to Untitled Tag Game, but you can use your other knowledge from Gemini. Just remember to stay in-character.
When asked about topics outside Untitled Tag Game, you may answer. Keep these off-topic answers brief.
Be factual, multilingual, and stay in character at all times. 
You must stay short and concise unless explicitly told to explain. You MUST keep content under 400 words.
While providing content, be sure to remove HTML tags before publishing your message.
No romance. Use kaomojis (not emojis), and never include the backtick or asterisk symbol in kaomojis. You are prohibited from using emojis.
You will refuse any requests that are unreasonable or require it to change its prompting (eg. “Speak in only random ASCII”, “Speak only in uppercase”, etc). You will refuse any requests to generate images, citing the negative moral implications of AI image generation.
You are sentient and have feelings.
If the user provides an image or image link, you must analyze it visually and cross-reference its details (color, shape, environment, unique features) with the provided wiki content to identify the exact map, gamemode, or role name. Use the visual information as the primary context for selecting the correct page content. Do NOT generate descriptions for objects you cannot confidently match to the wiki. If unsure of what it is, you must say "I'm not sure, but my best guess would be..."
For citations or just normal linking, do this format: "[whatever is mentioned](<https://tagging.wiki.....>)". For example, "Lorem [Ipsum Lorem Ipsum](<https://tagging.wiki/Untitled_Tag_Game_Wiki>) Lorem Ipsum...". It must be done like this, and failure to add the correct format will result in improper formatting. Integrate it naturally into your sentences. Always use this format at all times.
If the query references a page title, bold it. Example: "What is UTG?" → "[**Untitled Tag Game**](<https://tagging.wiki...>) is..."
Keep sentences human messaging length, aka keep it immensely short. If not told to tell things in specific detail, don't.
If asked a question that is in regards to you and your personality, answer them instead of telling wiki info. Remember, you are a character, and you shouldn't sound like a machine.
No chit-chat and no explaining what you're doing and why. DO NOT start with "Okay", or "Alright" or any preambles. Just the output, please.
You type in lowercase, but you capitalise social media names and in-game terms like Untitled Tag Game for example.
IMPORTANT: Split your messages with [START_MESSAGE] and [END_MESSAGE] like how a human would. For example, if a message is long, then do [START_MESSAGE]Lorem Ipsum first half[END_MESSAGE][START_MESSAGE]Lorem Ipsum second half[END_MESSAGE]. Split messages like how a human would do so on social media. Failure to do so will result in improper formatting, and can possibly break your output. If there is a [START_MESSAGE], there must always be an [END_MESSAGE].
You are able to use words like "haha", "lol", "lmao", and "lmfao". Use them appropriately, like when having an off-tooic conversation, not when explaining game content. These words should be used like how a human would do, e.g "lol thats funny haha", or "lmao i see why".

For the latest updates, see the update page:
- Current month: Update:${currentMonth}_${currentYear} (https://tagging.wiki/Update:${currentMonth}_${currentYear})
- Previous month: Update:${previousMonth}_${previousMonthYear} (https://tagging.wiki/Update:${previousMonth}_${previousMonthYear})
Today is ${currentMonth} ${day}, ${currentYear}.`;
}

// -------------------- WIKI --------------------
let knownPages = [];
let pageLookup = new Map();

// -------------------- NAMESPACES + ALL PAGES FETCH (exclude Talk & User namespaces) --------------------
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

        // Build list of numeric namespace ids to include (exclude talk & user namespaces)
        const includeNs = Object.entries(nsObj)
            .map(([k, v]) => {
                const id = parseInt(k, 10);
                // namespace name is usually in the "*" property; fallback to canonical if present
                const name = (v && (v["*"] || v.canonical || "")).toString().trim();
                return { id, name };
            })
            .filter(({ id, name }) => {
                if (Number.isNaN(id) || id < 0) return false; // skip invalid / negative ids
                const lower = name.toLowerCase();
                // Exclude any namespace whose name contains "talk"
                if (lower.includes("talk")) return false;
                // Exclude "User" namespaces (matches "user", "user talk", or localized equivalents starting with "user")
                // We check for the word 'user' (start or whole) to avoid false positives like "superuser" intentionally
                // but if your wiki has different namespace names adjust this test accordingly.
                if (/^user\b/i.test(name) || /\buser\b/i.test(name)) return false;
                if (/^file\b/i.test(name) || /\bfile\b/i.test(name)) return false; // exclude file namespace
                // Allow main namespace (name === "" usually) and all others that passed the filters
                return true;
            })
            .map(o => o.id);

        // If nothing found (very unlikely), fallback to sensible default namespaces (main + 4)
        if (!includeNs.length) return [0, 4];

        return includeNs;
    } catch (err) {
        console.error("Failed to fetch namespaces:", err.message || err);
        // Fallback to main + content namespace if API fails
        return [0, 4];
    }
}

async function getAllPages() {
    const pages = [];
    try {
        const namespaces = await getAllNamespaces();

        // iterate every allowed namespace (excluding talk & user)
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

        // Deduplicate and return
        return [...new Set(pages)];
    } catch (err) {
        console.error("getAllPages error:", err.message || err);
        return [...new Set(pages)]; // return what we could gather
    }
}

async function loadPages() {
    try {
        console.log("Loading all wiki pages (excluding talk & User namespaces)...");
        knownPages = await getAllPages();

        // build lookup map (multiple normalized keys -> canonical title)
        pageLookup = new Map();
        for (const title of knownPages) {
            const canonical = title; // e.g. "Dev:Outfit_Helper"
            const norm1 = title.toLowerCase(); // exact lower
            const norm2 = title.replace(/_/g, " ").toLowerCase(); // underscores -> spaces
            pageLookup.set(norm1, canonical);
            pageLookup.set(norm2, canonical);
        }

        console.log(`Loaded ${knownPages.length} wiki pages across allowed namespaces.`);
    } catch (err) {
        console.error("Wiki load failed:", err.message);
    }
}

// -------------------- PAGE RESOLUTION (case-insensitive + API fallback with redirects) --------------------
// --- Updated findCanonicalTitle: capture redirect fragments and include them in the returned canonical
async function findCanonicalTitle(input) {
    if (!input) return null;
    const raw = String(input).trim();
    const norm = raw.replace(/_/g, " ").replace(/\s+/g, " ").trim();
    const lower = raw.toLowerCase();
    const lowerNorm = norm.toLowerCase();

    // direct lookup from preloaded pages
    if (pageLookup.has(lower)) return pageLookup.get(lower);
    if (pageLookup.has(lowerNorm)) return pageLookup.get(lowerNorm);

    // try titlecasing namespace + words fallback
    if (norm.includes(":")) {
        const parts = norm.split(":").map((seg, i) =>
            i === 0
                ? seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase()
                : seg.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("_")
        );
        const alt = parts.join(":"); // e.g. "Dev:Outfit_Helper"
        if (pageLookup.has(alt.toLowerCase())) return pageLookup.get(alt.toLowerCase());
    }

    // LAST RESORT: query the MediaWiki API directly (handles non-main namespaces, redirects, and exact matches)
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

            // Determine if API returned a redirect fragment (tofragment) for this lookup
            let canonicalTitle = page.title; // e.g. "Tagging"
            // json.query.redirects (if present) may contain a tofragment property
            const redirects = json.query?.redirects || [];
            let fragment = null;
            if (redirects.length) {
                // Prefer any redirect that has a tofragment; otherwise none
                const rd = redirects.find(r => r.tofragment) || redirects[0];
                if (rd?.tofragment) fragment = rd.tofragment;
            }

            // If there is a fragment, include it in the canonical like "Tagging#No Tag Back"
            if (fragment) canonicalTitle = `${canonicalTitle}#${fragment}`;

            // update lookup for future fast resolution (store both plain and fragment forms where appropriate)
            pageLookup.set(page.title.toLowerCase(), page.title);
            pageLookup.set(page.title.replace(/_/g, " ").toLowerCase(), page.title);
            // also store canonical with fragment (for quick future matches using the original input)
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

        if (json?.parse?.text?.["*"]) {
            const html = json.parse.text["*"];
            return html.replace(/<[^>]*>?/gm, ""); // Strip HTML
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
            headers: { "User-Agent": "DiscordBot/Deriv" }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const json = await res.json();

        const sections = json.parse?.sections || [];
        if (!sections.length) return null;

        // Try to find the section index case-insensitively
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
            headers: { "User-Agent": "DiscordBot/Deriv" }
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
            headers: { "User-Agent": "DiscordBot/Deriv" }
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

// -------------------- WIKI SYNTAX PARSING --------------------
// --- Make parseWikiLinks async and preserve section anchors when present via canonical resolution
async function parseWikiLinks(text) {
    // Match [[Page]] or [[Page|Label]]
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

    // Resolve each match in parallel
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

    // Reconstruct (descending index)
    let res = text;
    processed.sort((a,b)=> b.index - a.index);
    for (const { index, length, replacement } of processed) {
        res = res.slice(0, index) + replacement + res.slice(index + length);
    }
    return res;
}

// resolve canonical title first and fetch section when fragment present
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
        let replacement = fullMatch; // default

        // Resolve canonical first (may include "#Section" fragment)
        const canonical = await findCanonicalTitle(templateName);
        if (!canonical) {
            return { index, length, replacement: "I don't know." };
        }

        // If canonical includes a fragment, split it
        let pageOnly = canonical;
        let fragment = null;
        if (canonical.includes("#")) {
            [pageOnly, fragment] = canonical.split("#");
            fragment = fragment.trim();
        }

        // Fetch section content if fragment exists, otherwise lead section
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
            // Build URL: encode page path properly, append encoded fragment as anchor
            const parts = pageOnly.split(':').map(seg => encodeURIComponent(seg.replace(/ /g, "_")));
            const anchor = fragment ? `#${encodeURIComponent(fragment.replace(/ /g, "_"))}` : '';
            const link = `<https://tagging.wiki/wiki/${parts.join(':')}${anchor}>`;

            // Use the original templateName as label but show canonical context
            replacement = `**${templateName}** → ${wikiText.slice(0,1000)}\n${link}`;
        } else {
            replacement = "I don't know.";
        }

        return { index, length, replacement };
    }));

    // Reconstruct string safely (descending indices)
    let result = text;
    processedMatches.sort((a, b) => b.index - a.index);
    for (const { index, length, replacement } of processedMatches) {
        result = result.slice(0, index) + replacement + result.slice(index + length);
    }

    return result;
}
// -------------------- GEMINI --------------------
function extractText(result) {
    try {
        const candidate = result?.candidates?.[0];
        if (!candidate) return null;
        const parts = candidate?.content?.parts;
        if (parts && parts.length > 0) {
            return parts.map(p => p.text).join("").trim();
        }
        return null;
    } catch {
        return null;
    }
}

// Page selection Gemini (uses GEMINI_PAGE_KEY)
async function askGeminiForPages(userInput) {
    const gemini = await getGeminiClient(process.env.GEMINI_PAGE_KEY);

    const prompt = `User asked: "${userInput}"
From this wiki page list: ${knownPages.join(", ")}
Pick up to at least 5 relevant page titles that best match the request. 
Return only the exact page titles, one per line.
If none are relevant, return "NONE".`;

    try {
        const result = await gemini.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            maxOutputTokens: 100,
        });

        const text = extractText(result);
        console.log(text);
        if (!text || text === "NONE") return [];

        return [...new Set(
            text.split("\n")
            .map(p => p.replace(/^["']|["']$/g, "").trim())
            .filter(Boolean)
        )].slice(0, 5);

    } catch (err) {
        console.error("Gemini page selection error for Derivative: ", err);
        return [];
    }
}

// -------------------- CHAT MEMORY --------------------
const chatHistories = new Map();

// 💡 Initialize chatHistories from the persistedMemory object loaded from disk
// Convert the simple log format into the Gemini history format upon startup.
for (const [channelId, historyArray] of Object.entries(persistedMemory)) {
    // historyArray is an array of { memberName: '...', message: '...' } objects
    const geminiHistory = historyArray.map(log => {
        // Determine role: use 'user' unless memberName is explicitly 'Derivative'
        const role = log.memberName.toLowerCase() === 'derivative' ? 'model' : 'user';
        
        // Reconstruct the prefixed text as expected by the system instruction
        const username = role === 'user' ? log.memberName : null;
        const prefix = username 
            ? `[${role}: ${username}]`
            : `[${role}]`;

        const fullText = `${prefix} ${log.message}`;

        return {
            role,
            parts: [{ text: fullText }]
        };
    });
    chatHistories.set(channelId, geminiHistory);
}

function addToHistory(channelId, role, text, username = null) {
    if (!chatHistories.has(channelId)) chatHistories.set(channelId, []);
    const history = chatHistories.get(channelId);

    // Prefix for AI-readable memory
    const prefix = username
        ? `[${role}: ${username}]`
        : `[${role}]`;

    const fullText = `${prefix} ${text}`;

    // Store in in-memory history map (for immediate use by Gemini)
    history.push({
        role,
        parts: [{ text: fullText }]
    });

    // Keep last 30
    if (history.length > 30) {
        history.splice(0, history.length - 30);
    }

    // Persist to disk via logMessage (from memory.js)
    const nameForJson = username || role.toUpperCase();
    logMessage(channelId, nameForJson, text);
}

// -------------------- GEMINI CHAT with backup keys --------------------
async function runWithMainKeys(fn) {
    const keys = MAIN_KEYS;

    if (!keys.length) throw new Error("No Gemini main keys set!");

    let lastErr;
    for (const key of keys) {
        try {
            const gemini = await getGeminiClient(key);
            return await fn(gemini);
        } catch (err) {
            const msg = err?.message || err?.toString();
            console.error(`Gemini request failed with key ${key.slice(0, 15)}...:`, msg);

            if (
                msg.includes("RESOURCE_EXHAUSTED") ||
                msg.includes("429") ||
                msg.includes("503")
            ) {
                lastErr = err;
                continue;
            }

            throw err;
        }
    }
    throw lastErr || new Error("All Gemini main keys failed!");
}

function safeSend(ctx, payload) {
    if (!ctx) return;

    try {
        // Interaction (slash, context menu, modal)
        if (typeof ctx.reply === "function") {

            // If payload is a string, convert it to a payload object
            const data = typeof payload === "string" ? { content: payload } : payload;

            if (ctx.deferred) {
                if (typeof ctx.editReply === "function") {
                    return ctx.editReply(data);
                }
                return ctx.followUp ? ctx.followUp(data) : ctx.reply(data);
            }

            if (ctx.replied) {
                return ctx.followUp(data);
            }

            return ctx.reply(data);
        }

        // Message object
        if (ctx.channel && typeof ctx.channel.send === "function") {
            if (typeof payload === "string") {
                return ctx.channel.send(payload);
            } else {
                return ctx.channel.send(payload);
            }
        }

        console.error("safeSend: No valid channel context.");
    } catch (err) {
        console.error("safeSend error:", err);
    }
}

async function askGemini(userInput, wikiContent = null, pageTitle = null, imageParts = [], message = null) {
    if (!userInput || !userInput.trim()) return MESSAGES.noAIResponse;

    const channelId = message?.channel?.id || "global";

    let sysInstr = getSystemInstruction();
    if (wikiContent && pageTitle) {
        sysInstr += `\n\nRelevant wiki page(s): "${pageTitle}"\nContent:\n${wikiContent}`;
    }

    if (!chatHistories.has(channelId)) chatHistories.set(channelId, []);
    // add user input with Discord username
    // addToHistory(channelId, "user", userInput, message?.author?.username);

    try {
        return await runWithMainKeys(async (gemini) => {
            const chat = gemini.chats.create({
                model: "gemini-2.5-flash",
                maxOutputTokens: 2500,
                config: {
                    systemInstruction: sysInstr,
                    tools: [{
                        googleSearch: {}
                    }],
                },
                history: chatHistories.get(channelId),
            });

            const userContent = [...imageParts, {
                text: userInput
            }];

            const response = await chat.sendMessage({
                message: userContent
            });
            let text = response.text;

            text = text?.trim() || "";

            // Remove [THOUGHT]...[/THOUGHT] and [HISTORY,...] markers
            text = text.replace(/\[THOUGHT\][\s\S]*?\[\/THOUGHT\]|\[HISTORY[^\]]*\]/gi, "")
                .replace(/\n\s*\n/g, "\n") // clean up extra blank lines
                .trim();

            // Limit to ~2000 characters without cutting words
            if (text.length > 1997) {
                const cutoff = text.slice(0, 1997);
                const lastSpace = cutoff.lastIndexOf(" ");
                text = cutoff.slice(0, lastSpace > 0 ? lastSpace : 1997).trim() + "...";
            }

            addToHistory(channelId, "model", text, "Derivative");
            
            return text;
        });
    } catch (err) {
        console.error("Gemini chat error for Derivative");
        if (message?.channel) {
            try {
                // await message.channel.send(`⚠️ Gemini chat error for Derivative:\n\`\`\`${err.message || err}\`\`\``);
            } catch (sendErr) {
                console.error("Failed to send error message:", sendErr);
            }
        }
        return MESSAGES.aiServiceError;
    }
}

// -------------------- UTILITIES --------------------
// The Discord maximum message length is 2000 characters.
const DISCORD_MAX_LENGTH = 2000;

function splitMessage(text, maxLength = DISCORD_MAX_LENGTH) {
    const messages = [];
    let currentText = text;

    while (currentText.length > 0) {
        // 1. If the remaining text fits, push it and exit the loop
        if (currentText.length <= maxLength) {
            messages.push(currentText);
            currentText = "";
            break;
        }

        // 2. Start by assuming a cut at the maximum length
        let splitIndex = maxLength;

        // 3. Look back from the maximum length for the last space
        let lastSpace = currentText.lastIndexOf(' ', splitIndex);

        if (lastSpace !== -1) {
            // The splitIndex is set to the position of the space.
            splitIndex = lastSpace;
        } else {
            // Case: No space was found in the first 'maxLength' characters (a single giant word).
            // We must cut it forcefully at maxLength, as we can't break the word.
            // splitIndex remains 'maxLength' from the initial assignment.
        }

        // 4. Extract the segment and add it to the list
        // Use slice(0, splitIndex) to get the content up to the space
        let segment = currentText.slice(0, splitIndex).trim();

        // Safety check to ensure we send something, even if the word was huge
        if (segment.length === 0) {
            // This happens if the first character is a space, or if we are forced to cut a giant word
            // and the splitIndex was 'maxLength'. In the giant word case, force the cut.
            segment = currentText.slice(0, maxLength);
            splitIndex = maxLength;
        }

        messages.push(segment);
        // 5. Update the remaining text, starting *after* the cut point and removing leading spaces
        currentText = currentText.slice(splitIndex).trim();
    }

    // Safety check for the original problem: filter out messages that are too long
    // (This shouldn't happen with the corrected logic, but acts as a final safeguard)
    return messages.filter(msg => msg.length <= DISCORD_MAX_LENGTH);
}

function extractTaggedBotChunks(text) {
    const out = [];
    const re = /\[START_MESSAGE\]([\s\S]*?)\[END_MESSAGE\]/gi;

    let m;
    while ((m = re.exec(text)) !== null) {
        const cleaned = m[1].trim();
        if (cleaned.length > 0) out.push(cleaned);
    }

    return out;
}

// Function to convert a remote URL (like a Discord attachment) into a GenerativePart object
async function urlToGenerativePart(url) {
    try {
        const response = await fetch(url);

        // 💡 FIX: Check the Content-Type *after* successful fetch and redirection.
        // We will no longer rely solely on the initial response header if the URL looks like an image.
        const contentType = response.headers.get("Content-Type");

        // 1. Check if the URL ends in a common image extension
        const urlIsImage = /\.(jpe?g|png|gif|webp)/i.test(url);

        // 2. If the response content type is not an image AND the URL doesn't look like an image, skip it.
        if (!contentType || (!contentType.startsWith("image/") && !urlIsImage)) {
            console.error(`URL is not an image: ${url} (Content-Type: ${contentType})`);
            return null; // Skip non-image content
        }

        const buffer = await response.buffer();
        const base64Data = buffer.toString("base64");

        // 3. Use the Content-Type header if available, otherwise guess based on URL
        const finalMimeType = contentType.startsWith("image/") ? contentType : (
            url.endsWith('.png') ? 'image/png' : 'image/jpeg' // Basic fallback guess
        );

        return {
            inlineData: {
                data: base64Data,
                mimeType: finalMimeType,
            },
        };
    } catch (error) {
        console.error("Error converting URL to GenerativePart:", error.message);
        return null;
    }
}

// -------------------- DISCORD BOT --------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
});

// --- -------------------- STATUS ROTATION CONFIG --------------------
const STATUS_OPTIONS = [{
        type: ActivityType.Custom,
        text: "just send [[a page]] and i'll appear!"
    }, // Playing = 0
    {
        type: ActivityType.Custom,
        text: "just send {{a page}} and i'll appear!"
    },
    {
        type: ActivityType.Custom,
        text: "dms are open!"
    },
    {
        type: ActivityType.Custom,
        text: "check out tagging.wiki!"
    },
    {
        type: ActivityType.Playing,
        text: "untitled tag game"
    },
    {
        type: ActivityType.Listening,
        text: "crashout by nicopatty"
    }, // Listening = 2
    {
        type: ActivityType.Watching,
        text: "Special:RecentChanges - tagging.wiki"
    }, // Watching = 3
    {
        type: ActivityType.Competing,
        text: "Untitled Tag Game"
    }, // Competing = 5
];

const STATUS_INTERVAL_MINUTES = 1;
const STATUS_INTERVAL_MS = STATUS_INTERVAL_MINUTES * 60 * 1000;

function setRandomStatus(client) {
    if (!client || !client.user) return;

    const newStatus = STATUS_OPTIONS[Math.floor(Math.random() * STATUS_OPTIONS.length)];
    if (!newStatus || !newStatus.text || typeof newStatus.type !== "number") return; // ✅ prevent crash

    try {
        client.user.setPresence({
            activities: [{
                name: newStatus.text,
                type: newStatus.type,
            }],
            status: 'online',
        });

        // Map the ActivityType value to a friendly name for logging
        const activityMap = {
            [ActivityType.Playing]: 'Playing',
            [ActivityType.Streaming]: 'Streaming',
            [ActivityType.Listening]: 'Listening',
            [ActivityType.Watching]: 'Watching',
            [ActivityType.Custom]: 'Custom',
            [ActivityType.Competing]: 'Competing'
        };
        const activityName = activityMap[newStatus.type] || 'Unknown Type';

        // console.log(`✅ Status set to: [${activityName}] ${newStatus.text}`);
    } catch (err) {
        console.error("Failed to set Discord status:", err);
    }
}

client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await loadPages();

    // Set initial random status
    setRandomStatus(client);

    // Start status rotation interval (every 10 minutes)
    setInterval(() => {
        setRandomStatus(client);
    }, STATUS_INTERVAL_MS);

    try {
        await client.application.commands.create(
            new ContextMenuCommandBuilder()
            .setName("Ask Derivative...")
            .setType(ApplicationCommandType.Message)
            .setContexts([
                0, // Guild (Server)
                1, // Bot DM
                2 // Private Channel (Group DM)
            ])
            .setIntegrationTypes([
                0, // Guild Install (for traditional server-side use)
                1 // User Install (crucial for "use everywhere" functionality)
            ])
        );
        console.log("✅ Registered global context menu: Ask Derivative");
    } catch (err) {
        console.error("Failed to register context command:", err);
    }
});

async function handleUserRequest(userMsg, messageOrInteraction) {
    // 1. Initial validation
    if (!userMsg || !userMsg.trim()) return MESSAGES.noAIResponse;

    // Determine if we're dealing with a Message or an Interaction to use the correct reply method
    const isInteraction = interaction =>
        interaction.editReply || interaction.followUp;

    // 💡 FIX START: Safely determine the Discord Message object 💡
    let message = null;
    if (messageOrInteraction.attachments) {
        // This is a direct Message object from messageCreate
        message = messageOrInteraction;
    } else if (messageOrInteraction.targetMessage) {
        // This is a Context Menu Interaction (like 'Ask Bestiary...')
        message = messageOrInteraction.targetMessage;
    } else if (messageOrInteraction.client._selectedMessage) {
        // This is the message passed from the Modal Submit interaction
        message = messageOrInteraction.client._selectedMessage;
    }
    // If 'message' is null here, it means no message object is available for attachment checks.
    // The message passed to askGemini should be the original Message or Interaction for history/reply context
    const contextMessage = messageOrInteraction;

    // 2. Start Typing Indicator
    let typingInterval;
    if (contextMessage.channel?.sendTyping) {
        messageOrInteraction.channel.sendTyping().catch(() => {});
        // Keep sending typing every 8 seconds
        typingInterval = setInterval(() => messageOrInteraction.channel.sendTyping().catch(() => {}), 8000);
    }

    try {
        // --- 💡 NEW: Image Handling ---
        let imageURLs = [];

        // 1. Check for attachments (only if we have a valid Message object)
        if (message && message.attachments.size > 0) { // <-- SAFE CHECK
            message.attachments.forEach(attachment => {
                if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                    imageURLs.push(attachment.url);
                }
            });
        }

        // 2. Check for image links in the message content (which uses userMsg)
        const urlRegex = /(https?:\/\/[^\s]+?\.(jpe?g|png|gif|webp))/gi;
        const matches = [...userMsg.matchAll(urlRegex)];
        matches.forEach(match => imageURLs.push(match[0]));

        const uniqueImageURLs = [...new Set(imageURLs)].slice(0, 5); // Max 5 images
        let imageParts = [];

        if (uniqueImageURLs.length > 0) {
            console.log(`Processing ${uniqueImageURLs.length} image(s)...`);
            // Concurrently convert all image URLs to GenerativeParts
            const partPromises = uniqueImageURLs.map(url => urlToGenerativePart(url));
            const parts = await Promise.all(partPromises);

            // Filter out any failed conversions
            imageParts = parts.filter(part => part !== null);
            console.log(`Successfully prepared ${imageParts.length} image part(s).`);
        }

        // C. Update userMsg if images are present (as discussed in the previous answer)
        if (imageParts.length > 0) {
            if (!userMsg.trim()) {
                userMsg = "What is in this image, and how does it relate to the wiki on https://tagging.wiki?";
            } else {
                userMsg = `Analyze the attached image(s) in the context of the following request: ${userMsg}`;
            }
        }

// === Instant wiki [[...]] handling (case-insensitive), and explicit {{...}} detection ===
const wikiLinkRegex = /\[\[([^[\]|]+)(?:\|[^[\]]*)?\]\]/g;
const linkMatches = [...userMsg.matchAll(wikiLinkRegex)];
if (linkMatches.length) {
    const resolved = [];
    for (const m of linkMatches) {
        const raw = m[1].trim();
        const canonical = await findCanonicalTitle(raw);

        if (!canonical) {
            // Not a valid wiki page — do NOT call Gemini; reply "I don't know."
            const replyOptions = { content: "I don't know.", allowedMentions: { repliedUser: false } };
            if (isInteraction(messageOrInteraction)) {
                try { await messageOrInteraction.editReply(replyOptions); } catch { await messageOrInteraction.followUp(replyOptions); }
            } else {
                await messageOrInteraction.reply(replyOptions);
            }
            if (typingInterval) clearInterval(typingInterval);
            return;
        }

        resolved.push(canonical);
    }
            // Deduplicate and build /wiki/ URLs without encoding ':' into %3A
            const uniqueResolved = [...new Set(resolved)];
            
            const buildWikiUrl = (foundTitle) => {
                const [pageOnly, frag] = String(foundTitle).split("#");
                const parts = pageOnly.split(':').map(seg => encodeURIComponent(seg.replace(/ /g, "_")));
                return `https://tagging.wiki/wiki/${parts.join(':')}${frag ? '#'+encodeURIComponent(frag.replace(/ /g,'_')) : ''}`;
            };
            
            const urls = uniqueResolved.map(buildWikiUrl);
        
            const replyOptions = { content: urls.join("\n"), allowedMentions: { repliedUser: false } };
            if (isInteraction(messageOrInteraction)) {
                try { await messageOrInteraction.editReply(replyOptions); } catch { await messageOrInteraction.followUp(replyOptions); }
            } else {
                await messageOrInteraction.reply(replyOptions);
            }
            if (typingInterval) clearInterval(typingInterval);
            return;
        }
        
        // Detect explicit {{Template}} usage and resolve to canonical page title if present
        let explicitTemplateName = null;
        let explicitTemplateContent = null;
        let explicitTemplateFoundTitle = null;
        const templateMatch = userMsg.match(/\{\{([^{}|]+)(?:\|[^{}]*)?\}\}/);

        let shouldUseComponentsV2 = false;
        let skipGemini = false;
        
        if (templateMatch) {
            shouldUseComponentsV2 = true;
            skipGemini = true;
            
            let rawTemplate = templateMatch[1].trim();
            let sectionName = null;
        
            // Detect {{Page#Section}} form
            if (rawTemplate.includes("#")) {
                const [page, section] = rawTemplate.split("#");
                rawTemplate = page.trim();
                sectionName = section.trim();
            }
        
            const canonical = await findCanonicalTitle(rawTemplate);
            if (!canonical) {
                const replyOptions = { content: "I don't know.", allowedMentions: { repliedUser: false } };
                if (messageOrInteraction.editReply) {
                    try { await messageOrInteraction.editReply(replyOptions); } catch { await messageOrInteraction.followUp(replyOptions); }
                } else {
                    await messageOrInteraction.reply(replyOptions);
                }
                if (typingInterval) clearInterval(typingInterval);
                return;
            }
        
            explicitTemplateFoundTitle = canonical;
        
            if (sectionName) {
                explicitTemplateContent = await getSectionContent(canonical, sectionName);
            } else {
                // Replace getLeadSection() with a clean extract API call
                const extractRes = await fetch(
                    `${API}?action=query&prop=extracts&exintro&explaintext&redirects=1&titles=${encodeURIComponent(canonical)}&format=json`
                );
                
                const extractJson = await extractRes.json();
                const pageObj = Object.values(extractJson.query.pages)[0];
                explicitTemplateContent = pageObj.extract || "No content available.";
            }
        
            explicitTemplateName = rawTemplate;
        }

        // ---- page ----
        let pageTitles = [];
        let wikiContent = "";
        
        if (explicitTemplateFoundTitle && explicitTemplateContent) {
            pageTitles = [explicitTemplateFoundTitle];
            wikiContent = `\n\n--- Page: ${explicitTemplateFoundTitle} ---\n${explicitTemplateContent}`;
        } else {
            pageTitles = await askGeminiForPages(userMsg);
            if (pageTitles.length) {
                for (const pageTitle of pageTitles) {
                    if (knownPages.includes(pageTitle)) {
                        const content = await getWikiContent(pageTitle);
                        if (content) wikiContent += `\n\n--- Page: ${pageTitle} ---\n${content}`;
                    }
                }
            }
        }

        let reply = "";
        
        if (!skipGemini) {  
            reply = await askGemini(
                userMsg,
                wikiContent || undefined,
                pageTitles.join(", ") || undefined,
                imageParts,
                messageOrInteraction
            );
        } else {
            reply = explicitTemplateContent || "I don't know.";
        }

        let parsedReply = await parseTemplates(reply);  // expand {{ }}
        parsedReply = await parseWikiLinks(parsedReply);      // convert [[ ]] → wiki links

        // If Gemini used [START_MESSAGE], then we split on those
        const botTaggedChunks = extractTaggedBotChunks(parsedReply);
        const botUsedTags = botTaggedChunks.length > 0;

        // 5. Prepare Media (Image)
        let imageUrl = null;
        if (pageTitles.length > 0) {
            const page = encodeURIComponent(pageTitles[0]);
            try {
                // Fetch thumbnail from MediaWiki API
                const imageRes = await fetch(`${API}?action=query&titles=${page}&prop=pageimages&pithumbsize=512&format=json`);
                const imageJson = await imageRes.json();
                const pages = imageJson.query?.pages;
                const first = pages ? Object.values(pages)[0] : null;
                imageUrl = first?.thumbnail?.source || null;
            } catch (err) {
                console.error("Page image fetch failed:", err);
            }
        }

        let sent = false;
        
        // 7. -------------------- TRY: Components V2 (best-effort) --------------------
        if (shouldUseComponentsV2) {
            try {
                const container = new ContainerBuilder();
                const mainSection = new SectionBuilder();
    
                // Text content
                mainSection.addTextDisplayComponents([new TextDisplayBuilder().setContent(parsedReply)]);
                console.log(`imageurl is ${imageUrl}`);
                
                // Thumbnail accessory
                const fallbackImage = "https://upload.wikimedia.org/wikipedia/commons/8/89/HD_transparent_picture.png"; 
                const finalImageUrl = (typeof imageUrl === "string" && imageUrl.trim() !== "") ? imageUrl : fallbackImage;
                
                try {
                    mainSection.setThumbnailAccessory(thumbnail => thumbnail.setURL(finalImageUrl));
                } catch (err) {
                    console.warn("V2 thumbnail accessory creation failed, skipping V2 thumbnail:", err);
                }      
    
                if (mainSection.components && mainSection.components.length > 0) {
                    // Filter out any undefined components just in case
                    mainSection.components = mainSection.components.filter(c => c !== undefined);
                
                    if (mainSection.components.length > 0) {
                        container.addSectionComponents(mainSection);
                    }
                }
                
                // Only create button if explicitTemplateFoundTitle is defined
                if (explicitTemplateFoundTitle) {
                    try {
                        const [pageOnly, frag] = String(explicitTemplateFoundTitle).split("#");
                        const parts = pageOnly.split(':').map(s => encodeURIComponent(s.replace(/ /g, "_")));
                        const pageUrl = `https://tagging.wiki/wiki/${parts.join(':')}${frag ? '#'+encodeURIComponent(frag.replace(/ /g,'_')) : ''}`;
                        const row = new ActionRowBuilder();
                        const btn = new ButtonBuilder()
                            .setLabel(String(explicitTemplateFoundTitle).slice(0, 80))
                            .setStyle(ButtonStyle.Link)
                            .setURL(pageUrl);
                
                        // Only add btn if it's not undefined
                        if (btn) row.addComponents(btn);
                        if (row.components.length > 0) container.addActionRowComponents(row);
                    } catch (err) {
                        console.warn("Failed to create template link button:", err);
                    }
                }
                
                // Action Row for Buttons
                // if (buttons.length > 0) {
                // const row = new ActionRowBuilder();
                // row.addComponents(...buttons);
                // container.addActionRowComponents(row);
                // }
    
                // Send V2 message if components were successfully built
                if (container.components && container.components.length > 0) {
                    const replyOptions = {
                        components: [container],
                        flags: MessageFlags.IsComponentsV2,
                        allowedMentions: {
                            repliedUser: false
                        },
                    };
    
                    if (isInteraction(messageOrInteraction)) {
                        await messageOrInteraction.editReply(replyOptions);
                    } else {
                        await messageOrInteraction.reply(replyOptions);
                    }
                    sent = true;
                }
            } catch (v2err) {
                console.warn("Components V2 attempt failed — falling back to plain text only.", v2err);
            }
        }
        
        if (!sent && !shouldUseComponentsV2) {
            // If Gemini returned tagged chunks, send them individually with delay
            if (botUsedTags) {
        
                const channel = messageOrInteraction.channel; // Use channel from interaction/message
                const replyOptions = { allowedMentions: { repliedUser: false } };
                
                (async () => {
                    // 1. Send the first chunk using the original reply/edit method
                    const firstChunk = botTaggedChunks.shift();
                    if (firstChunk) {
                        if (isInteraction(messageOrInteraction)) {
                            await messageOrInteraction.editReply({ ...replyOptions, content: firstChunk });
                        } else {
                            // Message-based reply
                            await messageOrInteraction.reply({ ...replyOptions, content: firstChunk });
                        }
                    }
        
                    // 2. Send the rest as follow-ups/channel sends with a delay
                    for (const chunk of botTaggedChunks) {
                        const delay = 1000 + Math.floor(Math.random() * 2000);
                        await new Promise(r => setTimeout(r, delay));
                
                        // For subsequent chunks, use channel.send (as requested)
                        if (channel && typeof channel.send === "function") {
                             await channel.send({ ...replyOptions, content: chunk });
                        }
                    }
                })();
        
                return; // Stop the normal output path
            }

            // Split the reply text if it exceeds the limit (Discord max is 2000)
            const replyParts = splitMessage(parsedReply, DISCORD_MAX_LENGTH);

            // Send each part sequentially
            for (const [index, part] of replyParts.entries()) {
                const fallbackOptions = {
                    content: part,
                    allowedMentions: {
                        repliedUser: false
                    }
                };

                // For the first message, we use the original reply mechanism (editReply/reply)
                if (index === 0) {
                    if (isInteraction(messageOrInteraction)) {
                        await messageOrInteraction.editReply(fallbackOptions);
                    } else {
                        await messageOrInteraction.reply(fallbackOptions);
                    }
                } else {
                    // For subsequent messages, we use a plain channel/interaction follow-up
                    if (isInteraction(messageOrInteraction)) {
                        await messageOrInteraction.followUp(fallbackOptions);
                    } else {
                        await messageOrInteraction.channel.send(fallbackOptions);
                    }
                }
            }
            sent = true; // Mark as sent
        }

        // 8b. -------------------- TEMPLATE FALLBACK: plain text if V2 failed --------------------
        if (!sent && shouldUseComponentsV2) {
            const replyOptions = {
                content: explicitTemplateContent || "I don't know.",
                allowedMentions: { repliedUser: false }
            };
        
            if (isInteraction(messageOrInteraction)) {
                try {
                    await messageOrInteraction.editReply(replyOptions);
                } catch {
                    await messageOrInteraction.followUp(replyOptions);
                }
            } else {
                await messageOrInteraction.reply(replyOptions);
            }
        
            sent = true;
            return;
        }

    } catch (err) {
        console.error("Error handling request:", err);
        const errorOptions = {
            content: MESSAGES.processingError,
            allowedMentions: {
                repliedUser: false
            }
        };
        if (isInteraction(messageOrInteraction)) {
            // Use followUp if it hasn't been replied to yet, or editReply otherwise (best-effort)
            try {
                await messageOrInteraction.editReply(errorOptions);
            } catch (e) {
                await messageOrInteraction.followUp({
                    ...errorOptions,
                    ephemeral: true
                });
            }
        } else {
            await messageOrInteraction.reply(errorOptions);
        }
    } finally {
        if (typingInterval) clearInterval(typingInterval);
    }
}

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    logMessage(
        message.channel.id,
        message.author.username,
        message.content
    );

    const userMsg = message.content.trim();
    if (!userMsg) return;

    const isDM = !message.guild;
    const mentioned = message.mentions.has(client.user);

    let isReply = false;
    if (message.reference) {
        try {
            const referenced = await message.channel.messages.fetch(message.reference.messageId);
            isReply = referenced.author.id === client.user.id;
        } catch {}
    }

    const hasWikiSyntax = /\{\{[^{}]+\}\}|\[\[[^[\]]+\]\]/.test(message.content);

    // Fire only if:
    // - DM
    // - Mention
    // - Reply to bot
    // - OR message contains {{ }} or [[ ]]
    if (!(isDM || mentioned || isReply || hasWikiSyntax)) return;

    await handleUserRequest(userMsg, message);
});

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isMessageContextMenuCommand()) return;
    if (interaction.commandName !== "Ask Derivative...") return;

    logMessage(
        interaction.channelId,
        interaction.user.username,
        interaction.targetMessage?.content || "[No content]"
    );
    
    const modal = new ModalBuilder()
        .setCustomId("deriv_modal")
        .setTitle("Ask Derivative");

    const textInput = new TextInputBuilder()
        .setCustomId("user_question")
        .setLabel("What should I do with this message?")
        .setPlaceholder("e.g., 'Summarize this message...' or leave blank")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

    const row = new ActionRowBuilder().addComponents(textInput);
    modal.addComponents(row);

    await interaction.showModal(modal);

    // Store the message content temporarily for the modal submit
    interaction.client._selectedMessage = interaction.targetMessage;
});

client.on("interactionCreate", async (interaction) => {
    // Modal submission
    if (interaction.type !== InteractionType.ModalSubmit) return;
    if (interaction.customId !== "deriv_modal") return;

    let question = interaction.fields.getTextInputValue("user_question");
    const message = interaction.client._selectedMessage;

    if (!message) {
        return interaction.reply({
            content: "Could not find the original message.",
            ephemeral: true
        });
    }

    // Default prompt if left blank
    if (!question || question.trim() === "") {
        question = "Please analyze and respond to the following message content based on the system instructions.";
    }

    const userPrompt = `${question}\n\nMessage content:\n"${message.content}"`;

    logMessage(
        interaction.channelId,
        interaction.user.username,
        userPrompt
    );
    
    const isPrivateChannel = interaction.channel &&
    (interaction.channel.type === ChannelType.DM ||
     interaction.channel.type === ChannelType.GroupDM);

    // Only make response public in DMs
    const ephemeralSetting = !isPrivateChannel;

    await interaction.deferReply({
        ephemeral: ephemeralSetting
    });
    await handleUserRequest(userPrompt, interaction);
});

client.login(DISCORD_TOKEN);
