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
            if (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("429") || msg.includes("503")) {
                lastErr = err;
                continue;
            }
            throw err;
        }
    }
    throw lastErr || new Error("All Gemini main keys failed!");
}

// 💡 UPDATED: Now accepts 'tools' parameter
async function askGemini(userInput, wikiContent = null, pageTitle = null, imageParts = [], message = null, tools = null) {
    if (!userInput || !userInput.trim()) return MESSAGES.noAIResponse;

    const channelId = message?.channel?.id || "global";
    const currentTimestamp = message?.createdTimestamp || Date.now();
    const timeStr = formatTime(currentTimestamp);

    // 1. Build Initial System Prompt
    let sysInstr = getSystemInstruction();
    
    if (wikiContent && pageTitle) {
        sysInstr += `\n\n[PRE-LOADED CONTEXT]: "${pageTitle}"\n${wikiContent}`;
    }

    if (!chatHistories.has(channelId)) chatHistories.set(channelId, []);

    try {
        return await runWithMainKeys(async (gemini) => {
            
            // PREPARE TOOLS CONFIGURATION
            let geminiTools = [];

            // If custom tools (like leaderboard) are passed, add their definitions
            if (tools && tools.functionDeclarations) {
                geminiTools.push({ functionDeclarations: tools.functionDeclarations });
            } else {
                // Fallback to Google Search if no custom tools are provided
                geminiTools = [ {googleSearch: {}}, {urlContext: {}} ];
            }

            const chat = gemini.chats.create({
                model: GEMINI_MODEL, 
                maxOutputTokens: 2500,
                config: { 
                    systemInstruction: sysInstr,
                    tools: geminiTools, 
                },
                history: chatHistories.get(channelId),
            });

            // Initial User Message
            const timeContext = `[Time: ${timeStr}]`;
            let currentMessageParts = [...imageParts, { text: `${timeContext} ${userInput}` }];
            
            let finalResponse = "";
            let iterations = 0;
            const MAX_ITERATIONS = 5; 
            
            while (iterations < MAX_ITERATIONS) {
                iterations++;

                // 1. Send message to Gemini
                const result = await chat.sendMessage(
                    currentMessageParts[0]?.role
                        ? currentMessageParts[0]
                        : { role: "user", parts: currentMessageParts }
                );
                
                const result = result.response;
                
                // 💡 CHECK FOR NATIVE FUNCTION CALLS
                const parts = response.candidates?.[0]?.content?.parts || [];
                const functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);

                if (functionCalls.length > 0) {
                    const functionResponses = [];
                    
                    for (const call of functionCalls) {
                        const fnName = call.name;
                        const fnArgs = call.args;
                        
                        console.log(`[Tool] Gemini calling function: ${fnName}`);

                        if (tools?.functions?.[fnName]) {
                            try {
                                const fnResult = await tools.functions[fnName](fnArgs);
                                
                                // 💡 This structure is what satisfies the "ContentUnion" requirement
                                functionResponses.push({
                                    functionResponse: {
                                        name: fnName,
                                        response: fnResult 
                                    }
                                });
                            } catch (fnErr) {
                                console.error(`Function ${fnName} failed:`, fnErr);
                                functionResponses.push({
                                    functionResponse: {
                                        name: fnName,
                                        response: { error: "Execution failed" }
                                    }
                                });
                            }
                        }
                    }

                    // 💡 THE CRITICAL FIX: 
                    // Wrap the parts in a Content object with the 'function' role.
                    // This is what prevents the ContentUnion error on the next sendMessage() call.
                    currentMessageParts = [{
                        role: "function",
                        parts: functionResponses
                    }];
                    
                    continue; // Loop back to give Gemini the data
                }

                // 2. EXTRACT TEXT safely
                let text = "";
                try {
                    text = response.text();
                } catch (e) {
                    text = parts.filter(p => p.text).map(p => p.text).join("");
                }
                text = (text || "").trim();
                
                // 3. Handle Legacy MW_SEARCH / MW_CONTENT tags
                const searchMatch = text.match(/\[MW_SEARCH:\s*(.*?)\]/i);
                if (searchMatch) {
                    const query = searchMatch[1].trim();
                    console.log(`[Tool] Searching for: ${query}`);
                    const searchResults = await performSearch(query);
                    currentMessageParts = [{
                        role: "user",
                        parts: [{ text: `[SYSTEM] Search Results for "${query}": ${searchResults}\nNow please select a page using [MW_CONTENT: Title] or answer the user.` }]
                    }];
                    continue; 
                }

                const contentMatch = text.match(/\[MW_CONTENT:\s*(.*?)\]/i);
                if (contentMatch) {
                    const requestedTitle = contentMatch[1].trim();
                    console.log(`[Tool] Fetching content for: ${requestedTitle}`);
                    const canonical = await findCanonicalTitle(requestedTitle) || requestedTitle;
                    const content = await getWikiContent(canonical);
                    
                    const resultText = content 
                        ? `[SYSTEM] Content for "${canonical}":\n${content.slice(0, 7000)}` 
                        : `[SYSTEM] Page not found.`;

                    currentMessageParts = [{ text: resultText }];
                    continue;
                }

                // 4. Final Answer
                finalResponse = text;
                break;
            }

            // Clean up internal thoughts
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

function getHistory(channelId) {
    return chatHistories.get(channelId) || [];
}

module.exports = { askGemini, askGeminiForPages, MESSAGES, getHistory };
