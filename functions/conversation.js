require("dotenv").config();
const { MAIN_KEYS } = require("../geminikey.js"); 
const { loadMemory, logMessage, memory: persistedMemory } = require("../memory.js");
const { performSearch, getWikiContent, findCanonicalTitle, knownPages } = require("./parse_page.js");
const { getSystemInstruction, BOT_NAME, GEMINI_MODEL } = require("../config.js");

// node-fetch
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Dynamic import for Gemini
let GoogleGenAI;
async function getGeminiClient(apiKey) {
    if (!GoogleGenAI) {
        const mod = await import("@google/genai");
        GoogleGenAI = mod.GoogleGenAI;
    }
    return new GoogleGenAI({ apiKey });
}

const MESSAGES = {
    aiServiceError: "Connection's bad, can you send it again?",
    noAIResponse: "...",
    processingError: "I couldn't catch that... What'd you say again?",
};

// --- MEMORY ---
const chatHistories = new Map();

// Helper to format time for AI context
function formatTime(timestamp) {
    if (!timestamp) return new Date().toISOString();
    return new Date(timestamp).toISOString();
}

// 💡 Initialize chatHistories from the persistedMemory object loaded from disk
for (const [channelId, historyArray] of Object.entries(persistedMemory)) {
    const geminiHistory = historyArray.map(log => {
        const role = log.memberName.toLowerCase() === `${BOT_NAME.toLowerCase()}` ? 'model' : 'user';
        const username = role === 'user' ? log.memberName : null;
        const timeStr = formatTime(log.timestamp);
        
        const prefix = username 
            ? `[${role}: ${username}] [Time: ${timeStr}]`
            : `[${role}] [Time: ${timeStr}]`;

        const fullText = `${prefix} ${log.message}`;

        return {
            role,
            parts: [{ text: fullText }]
        };
    });
    chatHistories.set(channelId, geminiHistory);
}

function addToHistory(channelId, role, text, username = null, timestamp = Date.now()) {
    if (!chatHistories.has(channelId)) chatHistories.set(channelId, []);
    const history = chatHistories.get(channelId);

    const timeStr = formatTime(timestamp);

    const prefix = username
        ? `[${role}: ${username}] [Time: ${timeStr}]`
        : `[${role}] [Time: ${timeStr}]`;

    const fullText = `${prefix} ${text}`;

    history.push({
        role,
        parts: [{ text: fullText }]
    });

    if (history.length > 30) {
        history.splice(0, history.length - 30);
    }

    const nameForJson = username || role.toUpperCase();
    logMessage(channelId, nameForJson, text, timestamp);
}

// --- NEW STANDALONE TOOLS ---

/**
 * Performs a search using the underlying logic (vector/text).
 * Returns the raw search results (usually a string or list).
 */
async function mwSearch(query) {
    console.log(`[Tool] Searching for: ${query}`);
    return await performSearch(query);
}

/**
 * Fetches content for a specific title.
 * Validates canonical title first.
 */
async function mwContent(requestedTitle) {
    console.log(`[Tool] Fetching content for: ${requestedTitle}`);
    
    // Ensure we get the right page title (canonical)
    const canonical = await findCanonicalTitle(requestedTitle) || requestedTitle;
    const content = await getWikiContent(canonical);

    return { 
        title: canonical, 
        text: content || null
    };
}

// --- GEMINI FUNCTIONS ---

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
    const currentTimestamp = message?.createdTimestamp || Date.now();
    const timeStr = formatTime(currentTimestamp);

    // 1. Build Initial System Prompt
    let sysInstr = getSystemInstruction();
    
    // [PRE-LOADED CONTEXT] from initialise.js injection
    if (wikiContent) {
        const titleHeader = pageTitle ? `"${pageTitle}"` : "Relevant Pages";
        sysInstr += `\n\n[PRE-LOADED CONTEXT]: ${titleHeader}\n${wikiContent}`;
    }

    if (!chatHistories.has(channelId)) chatHistories.set(channelId, []);

    try {
        return await runWithMainKeys(async (gemini) => {
            const chat = gemini.chats.create({
                model: GEMINI_MODEL, 
                maxOutputTokens: 2500,
                config: { 
                    systemInstruction: sysInstr,
                    tools: [
                        {urlContext: {}},
                        {googleSearch: {}}
                    ],
                },
                history: chatHistories.get(channelId),
            });

            // Initial User Message
            const timeContext = `[Time: ${timeStr}]`;
            let currentMessageParts = [...imageParts, { text: `${timeContext} ${userInput}` }];
            
            // --- THE TOOL LOOP ---
            let finalResponse = "";
            let iterations = 0;
            const MAX_ITERATIONS = 5; 

            while (iterations < MAX_ITERATIONS) {
                iterations++;

                // 1. Send message to Gemini
                const result = await chat.sendMessage({
                    message: currentMessageParts
                });
                
                let text = "";
                try {
                    if (typeof result.text === 'function') {
                        text = result.text(); 
                    } else if (result.response && typeof result.response.text === 'function') {
                        text = result.response.text();
                    } else if (result.candidates && result.candidates[0] && result.candidates[0].content) {
                         text = result.candidates[0].content.parts.map(p => p.text).join("");
                    } else if (typeof result.text === 'string') {
                         text = result.text;
                    }
                } catch (e) {
                     console.warn("Gemini response text extraction warning:", e);
                }

                text = (text || "").trim();
                
                // 2. Check for [MW_SEARCH: ...]
                const searchMatch = text.match(/\[MW_SEARCH:\s*(.*?)\]/i);
                if (searchMatch) {
                    const query = searchMatch[1].trim();
                    const searchResults = await mwSearch(query);
                    
                    currentMessageParts = [{ 
                        text: `[SYSTEM] Search Results for "${query}": ${searchResults}\nNow please select a page using [MW_CONTENT: Title] or answer the user.` 
                    }];
                    continue; 
                }

                // 3. Check for [MW_CONTENT: ...]
                const contentMatch = text.match(/\[MW_CONTENT:\s*(.*?)\]/i);
                if (contentMatch) {
                    const requestedTitle = contentMatch[1].trim();
                    
                    const { title, text: content } = await mwContent(requestedTitle);
                    
                    const resultText = content 
                        ? `[SYSTEM] Content for "${title}":\n${content.slice(0, 7000)}` 
                        : `[SYSTEM] Page "${requestedTitle}" not found or empty. Try a different search.`;

                    currentMessageParts = [{ text: resultText }];
                    continue;
                }

                // 4. No tags found? This is the final answer.
                finalResponse = text;
                break;
            }

            finalResponse = finalResponse
                .replace(/\[MW_SEARCH:.*?\]/g, "")
                .replace(/\[MW_CONTENT:.*?\]/g, "")
                .replace(/\[THOUGHT\][\s\S]*?\[\/THOUGHT\]|\[HISTORY[^\]]*\]/gi, "")
                .trim();

            if (!finalResponse) return MESSAGES.processingError;

            addToHistory(channelId, "model", finalResponse, BOT_NAME);
            return finalResponse;
        });
    } catch (err) {
        console.error("Gemini Loop Error:", err);
        return MESSAGES.aiServiceError;
    }
}

// to check if history exists for a channel/user
function getHistory(channelId) {
    return chatHistories.get(channelId) || [];
}

module.exports = { askGemini, MESSAGES, getHistory, mwSearch, mwContent };
