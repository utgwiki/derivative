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
// Convert the simple log format into the Gemini history format upon startup.
for (const [channelId, historyArray] of Object.entries(persistedMemory)) {
    // historyArray is an array of { memberName: '...', message: '...', timestamp: ... } objects
    const geminiHistory = historyArray.map(log => {
        // Determine role: use 'user' unless memberName is explicitly 'Derivative'
        const role = log.memberName.toLowerCase() === `${BOT_NAME.toLowerCase()}` ? 'model' : 'user';
        
        // Reconstruct the prefixed text as expected by the system instruction
        const username = role === 'user' ? log.memberName : null;
        
        // Add timestamp to context so AI knows when this happened
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

    // Prefix for AI-readable memory
    const prefix = username
        ? `[${role}: ${username}] [Time: ${timeStr}]`
        : `[${role}] [Time: ${timeStr}]`;

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
    logMessage(channelId, nameForJson, text, timestamp);
}

// --- GEMINI FUNCTIONS ---
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
            model: GEMINI_MODEL,
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
        console.error(`Gemini page selection error for ${BOT_NAME}: `, err);
        return [];
    }
}

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
    
    // Extract timestamp from the message object if available, otherwise use now
    const currentTimestamp = message?.createdTimestamp || Date.now();
    const timeStr = formatTime(currentTimestamp);

    // 1. Build Initial System Prompt
    let sysInstr = getSystemInstruction();
    
    // (Legacy support: if we pre-fetched pages in the old way, include them)
    if (wikiContent && pageTitle) {
        sysInstr += `\n\n[PRE-LOADED CONTEXT]: "${pageTitle}"\n${wikiContent}`;
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
            // Inject the timestamp into the user prompt so the AI knows "Now"
            const timeContext = `[Time: ${timeStr}]`;
            let currentMessageParts = [...imageParts, { text: `${timeContext} ${userInput}` }];
            
            // --- THE TOOL LOOP ---
            let finalResponse = "";
            let iterations = 0;
            const MAX_ITERATIONS = 5; // Prevent infinite loops

            while (iterations < MAX_ITERATIONS) {
                iterations++;

                // 1. Send message to Gemini
                const result = await chat.sendMessage({
                    message: currentMessageParts
                });
                
                // 💡 SAFELY EXTRACT TEXT
                let text = "";
                try {
                    if (typeof result.text === 'function') {
                        // Standard SDK: result.response.text() or result.text()
                        text = result.text(); 
                    } else if (result.response && typeof result.response.text === 'function') {
                        text = result.response.text();
                    } else if (result.candidates && result.candidates[0] && result.candidates[0].content) {
                        // Raw candidate access
                         text = result.candidates[0].content.parts.map(p => p.text).join("");
                    } else if (typeof result.text === 'string') {
                         text = result.text;
                    }
                } catch (e) {
                     // Sometimes text() throws if safety blocks are triggered
                     console.warn("Gemini response text extraction warning:", e);
                }

                // If text is still empty or undefined, handle gracefully
                text = (text || "").trim();
                
                // 2. Check for [MW_SEARCH: ...]
                const searchMatch = text.match(/\[MW_SEARCH:\s*(.*?)\]/i);
                if (searchMatch) {
                    const query = searchMatch[1].trim();
                    console.log(`[Tool] Searching for: ${query}`);
                    
                    const searchResults = await performSearch(query);
                    
                    // Feed result back to Gemini
                    currentMessageParts = [{ 
                        text: `[SYSTEM] Search Results for "${query}": ${searchResults}\nNow please select a page using [MW_CONTENT: Title] or answer the user.` 
                    }];
                    
                    // Don't display the tool call to the user yet, loop again
                    continue; 
                }

                // 3. Check for [MW_CONTENT: ...]
                const contentMatch = text.match(/\[MW_CONTENT:\s*(.*?)\]/i);
                if (contentMatch) {
                    const requestedTitle = contentMatch[1].trim();
                    console.log(`[Tool] Fetching content for: ${requestedTitle}`);

                    // Use canonical title finder to ensure we get the right page
                    const canonical = await findCanonicalTitle(requestedTitle) || requestedTitle;
                    const content = await getWikiContent(canonical);
                    
                    const resultText = content 
                        ? `[SYSTEM] Content for "${canonical}":\n${content.slice(0, 2500)}` // Limit length to avoid token overflow
                        : `[SYSTEM] Page "${requestedTitle}" not found or empty. Try a different search.`;

                    // Feed content back to Gemini
                    currentMessageParts = [{ text: resultText }];
                    continue;
                }

                // 4. No tags found? This is the final answer.
                finalResponse = text;
                break;
            }

            // Clean up internal thoughts if any remain
            finalResponse = finalResponse
                .replace(/\[MW_SEARCH:.*?\]/g, "")
                .replace(/\[MW_CONTENT:.*?\]/g, "")
                .replace(/\[THOUGHT\][\s\S]*?\[\/THOUGHT\]|\[HISTORY[^\]]*\]/gi, "")
                .trim();

            // If completely empty (e.g. blocked content), return a fallback
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

module.exports = { askGemini, MESSAGES, getHistory };
