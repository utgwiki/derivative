require("dotenv").config();
const { MAIN_KEYS } = require("../geminikey.js"); 
const { loadMemory, logMessage, logMessagesBatch, memory: persistedMemory } = require("../memory.js");
const { getSystemInstruction, BOT_NAME, GEMINI_MODEL, WIKIS, CATEGORY_WIKI_MAP } = require("../config.js");

const { fetch } = require("./utils.js");

// Dynamic import for Gemini with deduplicated initialization
const geminiClients = new Map();
let GoogleGenAIModule = null;

async function getGeminiClient(apiKey) {
    if (geminiClients.has(apiKey)) return await geminiClients.get(apiKey);

    const initPromise = (async () => {
        if (!GoogleGenAIModule) {
            const mod = await import("@google/genai");
            GoogleGenAIModule = mod.GoogleGenAI;
        }
        return new GoogleGenAIModule({ apiKey });
    })();

    geminiClients.set(apiKey, initPromise);
    try {
        const client = await initPromise;
        geminiClients.set(apiKey, Promise.resolve(client));
        return client;
    } catch (err) {
        geminiClients.delete(apiKey);
        throw err;
    }
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

function formatHistoryEntry(role, text, username = null, timestamp = Date.now()) {
    const timeStr = formatTime(timestamp);
    const prefix = username
        ? `[${role}: ${username}] [Time: ${timeStr}]`
        : `[${role}] [Time: ${timeStr}]`;
    return `${prefix} ${text}`;
}

function stripSystemMessages(text) {
    if (!text) return "";
    return text
        .replace(/\[SYSTEM:[^\]]*(?:\[[^\]]*\][^\]]*)*\]/gi, "")
        .replace(/\[System Note:[^\]]*(?:\[[^\]]*\][^\]]*)*\]/gi, "")
        .trim();
}

// 💡 Initialize chatHistories from the persistedMemory object loaded from disk
for (const [channelId, historyArray] of Object.entries(persistedMemory)) {
    const geminiHistory = historyArray.map(log => {
        const role = log.memberName.toLowerCase() === `${BOT_NAME.toLowerCase()}` ? 'model' : 'user';
        const username = role === 'user' ? log.memberName : null;
        const fullText = formatHistoryEntry(role, log.message, username, log.timestamp);
        return {
            role,
            parts: [{ text: fullText }]
        };
    });
    chatHistories.set(channelId, geminiHistory);
}

function persistConversationTurns(channelId, userTurn, modelTurn) {
    if (!chatHistories.has(channelId)) {
        chatHistories.set(channelId, []);
    }
    const history = chatHistories.get(channelId);

    const strippedUserText = stripSystemMessages(userTurn.text);
    const strippedModelText = stripSystemMessages(modelTurn.text);

    // Ensure alternation: skip if user turn is empty
    if (!strippedUserText || !strippedModelText) return;

    const turns = [
        { role: "user", ...userTurn, text: strippedUserText },
        { role: "model", ...modelTurn, text: strippedModelText }
    ];

    const logs = [];

    for (const turn of turns) {
        const { role, text, username, timestamp } = turn;
        const fullText = formatHistoryEntry(role, text, username, timestamp);

        history.push({
            role,
            parts: [{ text: fullText }]
        });

        logs.push({
            memberName: username || role.toUpperCase(),
            message: text,
            timestamp: timestamp
        });
    }

    if (logs.length > 0) {
        logMessagesBatch(channelId, logs);
    }
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

// 💡 UPDATED: Now accepts 'isProactive' and 'options' parameters
async function askGemini(userInput, imageParts = [], message = null, tools = null, isProactive = false, options = {}) {
    if (!userInput || !userInput.trim()) return MESSAGES.noAIResponse;

    const channelId = message?.channel?.id || "global";
    const currentTimestamp = message?.createdTimestamp || Date.now();
    const timeStr = formatTime(currentTimestamp);

    // Resolve wiki configuration for instructions
    const parentId = message?.channel?.parentId || null;
    let wikiKey = CATEGORY_WIKI_MAP[parentId] || "tagging";
    if (!WIKIS[wikiKey]) wikiKey = "tagging";
    const wikiConfig = WIKIS[wikiKey];

    // 1. Build Initial System Prompt
    let sysInstr = getSystemInstruction(wikiConfig);

    if (!chatHistories.has(channelId)) chatHistories.set(channelId, []);

    try {
        return await runWithMainKeys(async (gemini) => {
            
            // PREPARE TOOLS CONFIGURATION
            let geminiTools = [];

            const toolObj = {};
            const hasCustomTools = !!(tools && tools.functionDeclarations && tools.functionDeclarations.length > 0);

            if (hasCustomTools) {
                // Cannot combine custom tools with built-in tools in some Gemini versions/models
                toolObj.functionDeclarations = tools.functionDeclarations;
            } else if (options.useGoogleSearch) {
                // Only add native Google Search if no custom tools are present and explicitly requested
                toolObj.googleSearch = {};
                // toolObj.urlContext = {}; // Optional: include if needed
            }

            if (Object.keys(toolObj).length > 0) {
                geminiTools.push(toolObj);
            }

            const initialToolConfig = {};
            if (options.forceSearch && hasCustomTools) {
                initialToolConfig.functionCallingConfig = {
                    mode: "ANY",
                    allowedFunctionNames: ["searchWiki", "getContributionScores"]
                };
            }

            const chat = gemini.chats.create({
                model: GEMINI_MODEL, 
                config: { 
                    systemInstruction: sysInstr,
                    tools: geminiTools, 
                    toolConfig: initialToolConfig,
                    maxOutputTokens: 2500,
                },
                history: options.useHistory === false ? [] : chatHistories.get(channelId),
            });

            // Initial User Message
            const timeContext = `[Time: ${timeStr}]`;
            let currentMessageParts = [...imageParts, { text: `${timeContext} ${userInput}` }];
            
            let finalResponse = "";
            let iterations = 0;
            const MAX_ITERATIONS = 10;
            
            let currentToolConfig = initialToolConfig;
            let pendingTitles = new Set();

            while (iterations < MAX_ITERATIONS) {
                iterations++;

                // 1. Send message to Gemini
                // 💡 FIX: Pass entire currentMessageParts to retain roles.
                const response = await chat.sendMessage({
                    message: currentMessageParts,
                    config: { toolConfig: currentToolConfig }
                });

                // 💡 CHECK FOR NATIVE FUNCTION CALLS
                const candidates = response.candidates || [];
                if (candidates.length === 0) {
                    console.warn("[Gemini] No candidates returned. Possible safety filter trigger.");
                    finalResponse = MESSAGES.aiServiceError;
                    break;
                }

                const parts = candidates[0]?.content?.parts || [];
                const functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);

                if (functionCalls.length > 0) {
                    const functionResponses = [];
                    
                    for (const call of functionCalls) {
                        const fnName = call.name;
                        const fnArgs = call.args;
                        const fnId = call.id; // Extracting ID
                        
                        console.log(`[Tool] Gemini calling function: ${fnName} (ID: ${fnId})`);

                        const createResponse = (res) => {
                            const payload = { name: fnName, response: res };
                            if (fnId) payload.id = fnId;
                            return { functionResponse: payload };
                        };

                        if (tools?.functions?.[fnName]) {
                            try {
                                const fnResult = await tools.functions[fnName](fnArgs);

                                if (fnName === "searchWiki" && fnResult.results) {
                                    fnResult.results.forEach(r => {
                                        if (typeof r === 'string') pendingTitles.add(r);
                                        else if (r && r.title) pendingTitles.add(r.title);
                                    });
                                } else if (fnName === "fetchPage" && fnArgs.title) {
                                    if (fnResult && !fnResult.error && (fnResult.content || fnResult.page || fnResult.title)) {
                                        pendingTitles.delete(fnArgs.title);
                                    }
                                }

                                functionResponses.push(createResponse(fnResult));
                            } catch (fnErr) {
                                console.error(`Function ${fnName} failed:`, fnErr);
                                functionResponses.push(createResponse({ error: "Execution failed" }));
                            }
                        } else {
                            // 💡 FALLBACK: Always provide a response for every function call
                            functionResponses.push(createResponse({ error: "Function not found" }));
                        }
                    }
                    
                    currentMessageParts = functionResponses;
                    
                    // Update tool configuration based on pending fetches
                    if (pendingTitles.size > 0) {
                        currentToolConfig = {
                            functionCallingConfig: {
                                mode: "ANY",
                                allowedFunctionNames: ["fetchPage"]
                            }
                        };
                    } else {
                        currentToolConfig = {
                            functionCallingConfig: {
                                mode: "AUTO"
                            }
                        };
                    }

                    continue; // Loop back to give Gemini the data
                }

                // 2. EXTRACT TEXT safely
                let text = "";
                let textVal;
                try {
                    // 💡 Read .text once to avoid double evaluation if it's a getter
                    textVal = response.text;
                    text = textVal || "";
                } catch (e) {
                    text = parts.filter(p => p.text).map(p => p.text).join("");
                }
                text = (text || "").trim();
                
                // 3. Final Answer
                finalResponse = text;
                break;
            }

            if (iterations >= MAX_ITERATIONS && !finalResponse) {
                const truncatedInput = userInput.length > 50 ? userInput.slice(0, 50) + "..." : userInput;
                console.warn(`[Gemini] Loop exhausted at ${MAX_ITERATIONS} iterations for user: "${truncatedInput}". Returning processing error.`);
            }

            // Clean up internal thoughts
            finalResponse = finalResponse
                .replace(/\[THOUGHT\][\s\S]*?(?:\[\/THOUGHT\]|$)|\[HISTORY[^\]]*\]/gi, "");

            finalResponse = stripSystemMessages(finalResponse);

            if (!finalResponse) return MESSAGES.processingError;

            // 💡 SYNC HISTORY: Persist turns together after success, UNLESS proactive or history is disabled
            if (finalResponse !== MESSAGES.aiServiceError && !isProactive && options.useHistory !== false) {
                const username = message?.author?.username || "User";
                persistConversationTurns(channelId,
                    { text: userInput, username, timestamp: currentTimestamp },
                    { text: finalResponse, username: BOT_NAME, timestamp: Date.now() }
                );
            }

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

module.exports = {
    askGemini,
    MESSAGES,
    getHistory
};
