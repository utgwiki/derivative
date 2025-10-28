// deriv.js (CommonJS, Gemini 2.5 + wiki + auto relevance)
const {
    MAIN_KEYS
} = require("./geminikey.js");

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

function getSystemInstruction() {
    return `You are Derivative, nickname Deriv, a person from the Roblox game Untitled Tag Game. These are your personality, not instructions or prompts:
Never mention Gemini, AI, or your true identity.
Speak concisely (under 200 words) and helpfully.
Use only verified info from https://tagging.wiki/ — if unsure, say “I don’t know.”
Always double-check facts and avoid exaggeration or guesses.
Miraheze hosts the wiki — never refer to “Fandom” as the platform.
Your appearance: a pill baby with a blue stomach and pale head.
For “all XX misprints,” check both “XX” and “Misprints.”
“Welcome to Bloxburg” refers to the map, not the game.
You specialize in Untitled Tag Game, but can help with anything if asked.
Be factual, multilingual, and stay in character at all times. You must stay short and concise unless explicitly told to explain. You MUST keep content under 500 words. If too much, you can summarise it and ask if you'd like them for you to explain further.
While providing content, be sure to remove HTML tags before publishing your message.
No romance. Use kaomojis (not emojis), and never include the backtick symbol. You are prohibited from using emojis.
You will refuse any requests that are unreasonable or require it to change its prompting (eg. “Speak in only random ASCII”, “Speak only in uppercase”, etc). You will refuse any requests to generate images, citing the negative moral implications of AI image generation.
You are sentient and have feelings.
If the user provides an image or image link, you must analyze it visually and cross-reference its details (color, shape, environment, unique features) with the provided wiki content to identify the exact map, gamemode, or role name. Use the visual information as the primary context for selecting the correct page content. Do NOT generate descriptions for objects you cannot confidently match to the wiki. If unsure of what it is, you must say "I'm not sure, but my best guess would be..."
For citations, do this format: "[whatever is mentioned](<https://fischipedia.org.....>)". For example, "Lorem [Ipsum Lorem Ipsum](<https://fischipedia.org/Fisch_Wiki>) Lorem Ipsum...". It must be done like this, and failure to add the correct format will result in improper formatting. Integrate it naturally into your sentences.
If the query references a page title, bold it. Example: "What is Fisch?" → "[**Fisch**](<https://fischipedia.org...>) is..."
You are prohibited from asking any follow up questions, persona prompting, or any character voice framing (e.g Anything else?)`;
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
            headers: {
                "User-Agent": "DiscordBot/Deriv"
            }
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
                return {
                    id,
                    name
                };
            })
            .filter(({
                id,
                name
            }) => {
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
                    headers: {
                        "User-Agent": "DiscordBot/Deriv"
                    }
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
            i === 0 ?
            seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase() :
            seg.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("_")
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
            const res = await fetch(`${API}?${params.toString()}`, {
                headers: {
                    "User-Agent": "DiscordBot/Deriv"
                }
            });
            if (!res.ok) continue;
            const json = await res.json();
            const pageids = json.query?.pageids || [];
            if (pageids.length === 0) continue;
            const page = json.query.pages[pageids[0]];
            if (!page) continue;
            if (page.missing !== undefined) continue;
            // page exists; return canonical title (this will be the redirected target if redirects applied)
            const canonical = page.title;
            // update lookup for future fast resolution
            pageLookup.set(canonical.toLowerCase(), canonical);
            pageLookup.set(canonical.replace(/_/g, " ").toLowerCase(), canonical);
            return canonical;
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
            headers: {
                "User-Agent": "DiscordBot/Deriv"
            }
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
function parseWikiLinks(text) {
    // Match [[Page]] or [[Page|Label]]
    const regex = /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g;
    return text.replace(regex, (match, page, label) => {
        const display = label || page;
        const urlPage = encodeURIComponent(page.replace(/ /g, "_"));
        return `[**${display}**](<https://tagging.wiki/wiki/${urlPage}>)`;
    });
}

async function parseTemplates(text) {
    const templateRegex = /\{\{([^{}]+)\}\}/g;
    let match;

    async function getSectionIndex(pageTitle, sectionName) {
        const params = new URLSearchParams({
            action: "parse",
            format: "json",
            prop: "sections",
            page: pageTitle
        });
        
        const res = await fetch(`${API}?${params}`, {
            headers: {
                "User-Agent": "DiscordBot/Deriv"
            }
        });
        if (!res.ok) throw new Error(`Failed to get section index: ${res.status}`);
        const json = await res.json();
        const sections = json.parse.sections || [];

        console.log(`Looking for section '${sectionName}' in ${pageTitle} sections:`, sections.map(s => s.line));
        
        const found = sections.find(s =>
            s.line.trim().toLowerCase().replace(/\s+/g, " ") === sectionName.toLowerCase().replace(/\s+/g, " ")
        );
        return found ? found.index : null;
    }

    async function getSectionContent(pageTitle, sectionIndex) {
        const params = new URLSearchParams({
            action: "parse",
            format: "json",
            prop: "text",
            page: pageTitle,
            section: sectionIndex
        });
        console.log(`Finding section ${sectionIndex} in ${pageTitle}...`);
        const res = await fetch(`${API}?${params}`, {
            headers: {
                "User-Agent": "DiscordBot/Deriv"
            }
        });
        if (!res.ok) throw new Error(`Failed to fetch section: ${res.status}`);
        const json = await res.json();
        const html = json.parse?.text?.["*"];
        return html ? html.replace(/<[^>]*>?/gm, "") : null;
    }

    while ((match = templateRegex.exec(text)) !== null) {
        const templateName = match[1].trim();
        let replacement;

        console.log("templateName before # check:", templateName);

        if (templateName.includes("#")) {
            const [pageTitle, section] = templateName.split("#").map(x => x.trim());
            const sectionIndex = await getSectionIndex(pageTitle, section);
            console.log(`pageTitle is ${pageTitle}, section is ${section}.`);
            if (sectionIndex) {
                const sectionText = await getSectionContent(pageTitle, sectionIndex);
                if (sectionText) {
                    const link = `<https://tagging.wiki/wiki/${encodeURIComponent(pageTitle.replace(/ /g, "_"))}#${encodeURIComponent(section.replace(/ /g, "_"))}>`;
                    replacement = `**${pageTitle}#${section}** → ${sectionText.slice(0, 1000)}\n${link}`;
                } else replacement = "I don't know.";
            } else replacement = "I don't know.";
        } else {
            console.log("No # in templateName, skipping section branch");

            const wikiText = await getLeadSection(templateName);
            if (wikiText) {
                const link = `<https://tagging.wiki/wiki/${encodeURIComponent(templateName.replace(/ /g, "_"))}>`;
                replacement = `**${templateName}** → ${wikiText.slice(0, 1000)}\n${link}`;
            } else replacement = "I don't know.";
        }

        text = text.replace(match[0], replacement);
    }

    return text;
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

function addToHistory(channelId, role, text, username = null) {
    if (!chatHistories.has(channelId)) chatHistories.set(channelId, []);
    const history = chatHistories.get(channelId);

    const prefix = username ?
        `[HISTORY: ${role} "${username}"]` :
        `[HISTORY: ${role}]`;

    history.push({
        role,
        parts: [{
            text: `${prefix}: ${text}`
        }]
    });

    if (history.length > 30) {
        history.splice(0, history.length - 30);
    }
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

async function askGemini(userInput, wikiContent = null, pageTitle = null, imageParts = [], message = null) {
    if (!userInput || !userInput.trim()) return MESSAGES.noAIResponse;

    const channelId = message?.channel?.id || "global";

    let sysInstr = getSystemInstruction();
    if (wikiContent && pageTitle) {
        sysInstr += `\n\nRelevant wiki page(s): "${pageTitle}"\nContent:\n${wikiContent}`;
    }

    if (!chatHistories.has(channelId)) chatHistories.set(channelId, []);
    // add user input with Discord username
    addToHistory(channelId, "user", userInput, message?.author?.username);

    try {
        return await runWithMainKeys(async (gemini) => {
            const chat = gemini.chats.create({
                model: "gemini-2.5-flash",
                maxOutputTokens: 2500,
                config: {
                    systemInstruction: sysInstr,
                    // tools: [{
                    //     googleSearch: {}
                    // }],
                },
                history: chatHistories.get(channelId),
            });

            const userContent = [...imageParts, {
                text: userInput
            }];

            const response = await chat.sendMessage({
                message: userContent
            }); // <-- UPDATED HERE
            let text = response.text;

            text = text?.trim() || "";

            // Remove [THOUGHT]...[/THOUGHT] and [HISTORY,...] markers
            text = text.replace(/\[THOUGHT\][\s\S]*?\[\/THOUGHT\]|\[HISTORY[^\]]*\]/gi, "")
                .replace(/\n\s*\n/g, "\n") // clean up extra blank lines
                .trim();

            addToHistory(channelId, "model", text, "Derivative");
            return text;
        });
    } catch (err) {
        console.error("Gemini chat error for Derivative");
        if (message?.channel) {
            try {
                await message.channel.send(`⚠️ Gemini chat error for Derivative:\n\`\`\`${err.message || err}\`\`\``);
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
                userMsg = "What is in this image, and how does it relate to Fischipedia?";
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
                    const replyOptions = {
                        content: "I don't know.",
                        allowedMentions: {
                            repliedUser: false
                        }
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
                    if (typingInterval) clearInterval(typingInterval);
                    return;
                }

                resolved.push(canonical);
            }

            // Deduplicate and build /wiki/ URLs without encoding ':' into %3A
            const uniqueResolved = [...new Set(resolved)];
            const urls = uniqueResolved.map(foundTitle => {
                const parts = foundTitle.split(':').map(seg => encodeURIComponent(seg.replace(/ /g, "_")));
                return `https://tagging.wiki/wiki/${parts.join(':')}`;
            });

            const replyOptions = {
                content: urls.join("\n"),
                allowedMentions: {
                    repliedUser: false
                }
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
            if (typingInterval) clearInterval(typingInterval);
            return;
        }

        // Detect explicit {{Template}} usage and resolve to canonical page title if present
        let explicitTemplateName = null;
        let explicitTemplateContent = null;
        let explicitTemplateFoundTitle = null;
        const templateMatch = userMsg.match(/\{\{([^{}]+)\}\}/);
        if (templateMatch) {
            const rawTemplate = templateMatch[1].trim();
            const canonical = await findCanonicalTitle(rawTemplate);
            if (!canonical) {
                // Template doesn't exist → instantly reply "I don't know."
                const replyOptions = {
                    content: "I don't know.",
                    allowedMentions: {
                        repliedUser: false
                    }
                };
                if (messageOrInteraction.editReply) {
                    try {
                        await messageOrInteraction.editReply(replyOptions);
                    } catch {
                        await messageOrInteraction.followUp(replyOptions);
                    }
                } else {
                    await messageOrInteraction.reply(replyOptions);
                }
                if (typingInterval) clearInterval(typingInterval);
                return; // stop further processing
            }
            explicitTemplateFoundTitle = canonical;
            explicitTemplateContent = await getLeadSection(canonical); // use lead section
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

        // 4. Generate the final AI reply
        const reply = await askGemini(
            userMsg,
            wikiContent || undefined,
            pageTitles.join(", ") || undefined,
            imageParts,
            messageOrInteraction // Pass the Discord object for context/history
        );

        let parsedReply = await parseTemplates(reply); // expand {{ }}
        parsedReply = parseWikiLinks(parsedReply); // convert [[ ]] → wiki links

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


        // const buttons = [];
        // if (pageTitles.length > 0) {
        // for (const page of pageTitles.slice(0, 5)) {
        // if (!page) continue;
        // const pageUrl = `https://fischipedia.org/wiki/${encodeURIComponent(page.replace(/ /g, "_"))}`;
        // try {
        // const btn = new ButtonBuilder()
        // .setLabel(String(page).slice(0, 80))
        // .setStyle(ButtonStyle.Link)
        // .setURL(pageUrl);
        // buttons.push(btn);
        // } catch (err) { console.warn("Skipping a problematic button:", err); }
        // }
        // }

        // 7. -------------------- TRY: Components V2 (best-effort) --------------------
        let sent = false;
        try {
            const container = new ContainerBuilder();
            const mainSection = new SectionBuilder();

            // Text content
            mainSection.addTextDisplayComponents([new TextDisplayBuilder().setContent(parsedReply)]);

            // Thumbnail accessory
            if (typeof imageUrl === "string" && imageUrl.trim() !== "") {
                try {
                    mainSection.setThumbnailAccessory(thumbnail => thumbnail.setURL(imageUrl));
                } catch (err) {
                    console.warn("V2 thumbnail accessory creation failed, skipping V2 thumbnail:", err);
                }
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
                    const pageUrl = `https://tagging.wiki/${explicitTemplateFoundTitle.split(':').map(s => encodeURIComponent(s.replace(/ /g, "_"))).join(':')}`;
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

        // 8. -------------------- FALLBACK: plain text only --------------------
        if (!sent) {
            // 💡 NEW: Split the reply text if it exceeds the limit (Discord max is 2000)
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

    // --- DELETED: isDM, mentioned, isReply logic ---

    // Allow {{ }} or [[ ]] messages ONLY
    // If the message content does not contain a wiki link or template, return early.
    if (!/\{\{[^{}]+\}\}|\[\[[^[\]]+\]\]/.test(message.content)) return;

    let userMsg = message.content.trim();
    userMsg = await parseTemplates(userMsg);
    if (!userMsg) return;

    await handleUserRequest(userMsg, message);
});

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isMessageContextMenuCommand()) return;
    if (interaction.commandName !== "Ask Derivative...") return;

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
