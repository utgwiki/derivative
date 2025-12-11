require("dotenv").config();

// --- IMPORTS ---
const { MAIN_KEYS } = require("./geminikey.js");
const { loadMemory, logMessage, memory: persistedMemory } = require("./memory.js");
loadMemory(); 

// NEW IMPORTS FROM FUNCTIONS FOLDER
const { urlToGenerativePart } = require("./functions/image_handling.js");
const { 
    loadPages, 
    findCanonicalTitle, 
    getWikiContent, 
    getSectionContent, 
    getLeadSection, 
    parseWikiLinks, 
    parseTemplates,
    knownPages, 
    API         
} = require("./functions/parse_page.js");
const { 
    askGemini, 
    MESSAGES 
} = require("./functions/conversation.js");

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
    ChannelType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ContextMenuCommandBuilder,
    InteractionType,
    ApplicationCommandType
} = require("discord.js");

const { BOT_SETTINGS, STATUS_OPTIONS, WIKI_ENDPOINTS, BOT_NAME } = require("./config.js");
const { 
    IGNORED_CHANNELS, 
    TRIGGER_KEYWORDS, 
    RESPONSE_CHANCE, 
    MIN_FOLLOWUP_DELAY, 
    MAX_FOLLOWUP_DELAY 
} = BOT_SETTINGS;

// --- FOLLOW-UP STATE MANAGER ---
// Stores: { channelId: { timer: Timeout, lastInteraction: Date } }
const activeConversations = new Map(); 

// node-fetch wrapper 
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// -------------------- UTILITIES --------------------
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

// FOLLOW UP MESSAGES
const { getHistory } = require("./functions/conversation.js"); 

async function scheduleFollowUp(message) {
    const channelId = message.channel.id;

    // Clear existing timer if talking (reset the clock)
    if (activeConversations.has(channelId)) {
        clearTimeout(activeConversations.get(channelId).timer);
    }

    // Decide if we want to follow up (Random chance: 50%)
    // Only follow up in DMs or if the user specifically engaged recently
    if (Math.random() < 0.5) return; 

    // Calculate random delay
    const delay = Math.floor(Math.random() * (MAX_FOLLOWUP_DELAY - MIN_FOLLOWUP_DELAY + 1)) + MIN_FOLLOWUP_DELAY;
    
    // console.log(`Scheduling follow-up for ${channelId} in ${(delay/60000).toFixed(2)} minutes.`);

    const timer = setTimeout(async () => {
        try {
            // Check if the channel still exists
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!channel) return;

            // Get history to ensure we have context
            const history = getHistory(channelId);
            if (!history || history.length < 2) return; // Don't follow up on empty interactions

            // Construct the "Proactive" prompt
            const delayText = delay < 60000 
                ? `${Math.round(delay/1000)} seconds` 
                : `${Math.round(delay/60000)} minutes`;
            const systemNote = `[SYSTEM: It has been ${delayText} since you last spoke. 
            The user hasn't replied. 
            Construct a short, casual follow-up message based on the previous conversation context above. 
            Ask how they are, or bring up a related topic from the history. 
            You are also allowed to make a new topic with what you know about the conversation. You are not limited in talking about the current topic.
            Do NOT greet them like it's the first time. 
            If the last conversation ended naturally (like "bye"), do not send anything and output [TERMINATE_MESSAGE].]`;

            const mockMessage = {
                channel: channel,
                author: client.user,
                client: client,        // Added: Needed for handleUserRequest checks
                attachments: { size: 0 }, // Added: Pass attachment check safely
                content: systemNote,
                guild: channel.guild,
                createdTimestamp: Date.now() // Mock timestamp for follow-up
            };
            
            // Call handleUserRequest but pretend it's a system prompt
            // pass a flag to indicate this is a self-prompt
            await handleUserRequest(systemNote, systemNote, mockMessage, false, true);

        } catch (err) {
            console.error("Follow-up execution failed:", err);
        } finally {
            activeConversations.delete(channelId);
        }
    }, delay);

    activeConversations.set(channelId, {
        timer: timer,
        lastInteraction: Date.now()
    });
}

// -------------------- STATUS --------------------
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

// -------------------- CLIENT SETUP --------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
});

client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await loadPages(); // Now calls the function from parse_page.js
    setRandomStatus(client);

    // Start status rotation interval (every 10 minutes)
    setInterval(() => {
        setRandomStatus(client);
    }, STATUS_INTERVAL_MS);

    try {
        await client.application.commands.create(
            new ContextMenuCommandBuilder()
            .setName(`Ask ${BOT_NAME}...`)
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
        console.log(`✅ Registered global context menu: Ask ${BOT_NAME}`);
    } catch (err) {
        console.error("Failed to register context command:", err);
    }
});

// -------------------- HANDLER --------------------
async function handleUserRequest(promptMsg, rawUserMsg, messageOrInteraction, isEphemeral = false, isProactive = false) {
    // 1. Initial validation
    if (!promptMsg || !promptMsg.trim()) return MESSAGES.noAIResponse;

    // Determine if we're dealing with a Message or an Interaction to use the correct reply method
    const isInteraction = interaction =>
        interaction.editReply || interaction.followUp;

    // 💡 FIX START: Safely determine the Discord Message object 💡
    let message = null;
    if (messageOrInteraction.attachments) {
        // This is a direct Message object from messageCreate
        message = messageOrInteraction;
    } else if (messageOrInteraction.targetMessage) {
        // This is a Context Menu Interaction (like 'Ask...')
        message = messageOrInteraction.targetMessage;
    } else if (messageOrInteraction.client?._selectedMessage) {
        // This is a Context Menu Interaction (like 'Ask...')
        message = messageOrInteraction.client._selectedMessage;
    }
    // If 'message' is null here, it means no message object is available for attachment checks.
    // The message passed to askGemini should be the original Message or Interaction for history/reply context
    const contextMessage = messageOrInteraction;

    // 2. Start Typing Indicator
    let typingInterval;
    if (contextMessage.channel?.sendTyping) {
        messageOrInteraction.channel.sendTyping().catch(() => {});
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
        const matches = [...rawUserMsg.matchAll(urlRegex)];
        matches.forEach(match => imageURLs.push(match[0]));

        const uniqueImageURLs = [...new Set(imageURLs)].slice(0, 5); // Max 5 images
        let imageParts = [];

        if (uniqueImageURLs.length > 0) {
            // CALLING FUNCTION FROM image_handling.js
            const partPromises = uniqueImageURLs.map(url => urlToGenerativePart(url));
            const parts = await Promise.all(partPromises);
            imageParts = parts.filter(part => part !== null);
        }

        // C. Update userMsg if images are present (as discussed in the previous answer)
        if (imageParts.length > 0) {
            if (!promptMsg.trim()) {
                promptMsg = `What is in this image, and how does it relate to the wiki on ${WIKI_ENDPOINTS.BASE}?`;
            } else {
                promptMsg = `Analyze the attached image(s) in the context of the following request: ${promptMsg}`;
            }
        }

        // === Instant wiki [[...]] handling (case-insensitive), and explicit {{...}} detection ===
        const wikiLinkRegex = /\[\[([^[\]|]+)(?:\|[^[\]]*)?\]\]/g;
        const linkMatches = [...rawUserMsg.matchAll(wikiLinkRegex)];
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
                return `${WIKI_ENDPOINTS.ARTICLE_PATH}${parts.join(':')}${frag ? '#'+encodeURIComponent(frag.replace(/ /g,'_')) : ''}`;
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
        const templateMatch = rawUserMsg.match(/\{\{([^{}|]+)(?:\|[^{}]*)?\}\}/);

        let shouldUseComponentsV2 = false;
        let skipGemini = false;
        
        if (templateMatch) {
            let rawTemplate = templateMatch[1].trim();
            let sectionName = null;
        
            if (rawTemplate.includes("#")) {
                const [page, section] = rawTemplate.split("#");
                rawTemplate = page.trim();
                sectionName = section.trim();
            }
        
            const canonical = await findCanonicalTitle(rawTemplate);
            
            if (canonical) {
                // ✅ Page FOUND: We assume user wants the content.
                shouldUseComponentsV2 = true;
                skipGemini = true; // Skip AI
                explicitTemplateFoundTitle = canonical;

                if (sectionName) {
                    explicitTemplateContent = await getSectionContent(canonical, sectionName);
                } else {
                    const extractRes = await fetch(
                        `${API}?action=query&prop=extracts&exintro&explaintext&redirects=1&titles=${encodeURIComponent(canonical)}&format=json`
                    );
                    const extractJson = await extractRes.json();
                    const pageObj = Object.values(extractJson.query.pages)[0];
                    explicitTemplateContent = pageObj.extract || "No content available.";
                }
                explicitTemplateName = rawTemplate;
            } else {
                // The user might be asking "How do I use {{Template}}?"
                // DO NOT trigger skipGemini. Let the AI handle it.
                // We do nothing here, letting code proceed to askGemini.
                console.log(`Template pattern found "${rawTemplate}" but no page exists. Falling back to Gemini.`);
            }
        }

        // ---- page ----
        let pageTitles = [];
        let wikiContent = "";
        
        if (skipGemini) {
            if (explicitTemplateFoundTitle) {
                pageTitles = [explicitTemplateFoundTitle];
            }
        } else {
        }

        let reply = "";
        
        if (!skipGemini) {  
            reply = await askGemini(
                promptMsg, // Send the Full Context to Gemini
                wikiContent || undefined,
                pageTitles.join(", ") || undefined,
                imageParts,
                messageOrInteraction
            );
        } else {
            reply = explicitTemplateContent || "I don't know.";
        }

        // If Gemini outputs [TERMINATE_MESSAGE],
        // we silently drop it.
        if (reply.trim() === "[TERMINATE_MESSAGE]") {
            // Check if it's an interaction (has editReply). If so, we MUST reply to close the interaction.
            if (isInteraction(messageOrInteraction)) {
                // For interactions, we can't just be silent, or the command says "Application did not respond".
                // We'll just send a generic refusal or modify the output slightly.
                reply = "I cannot reply to that."; 
            } else {
                // For normal chat, we just stop entirely.
                if (typingInterval) clearInterval(typingInterval);
                return; 
            }
        }

        let parsedReply = await parseTemplates(reply);  
        parsedReply = await parseWikiLinks(parsedReply);

        // If this is an ephemeral message (Ask Derivative), strip the tags and force standard splitting
        if (isEphemeral) {
            // Remove the [START_MESSAGE] and [END_MESSAGE] tags globally
            parsedReply = parsedReply.replace(/\[START_MESSAGE\]/g, "").replace(/\[END_MESSAGE\]/g, "\n\n").trim();
        }

        // If NOT ephemeral, we check for tags to do the cool delayed sending
        let botTaggedChunks = [];
        let botUsedTags = false;

        if (!isEphemeral) {
            botTaggedChunks = extractTaggedBotChunks(parsedReply);
            botUsedTags = botTaggedChunks.length > 0;
        }

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
                        const pageUrl = `${WIKI_ENDPOINTS.ARTICLE_PATH}${parts.join(':')}${frag ? '#'+encodeURIComponent(frag.replace(/ /g,'_')) : ''}`;
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
        
                const channel = messageOrInteraction.channel; 
                const replyOptions = { allowedMentions: { repliedUser: false } };
                
                (async () => {
                    // 1. Send the first chunk 
                    const firstChunk = botTaggedChunks.shift();
                    if (firstChunk) {
                        try {
                            // Try to reply/edit first
                            if (isInteraction(messageOrInteraction)) {
                                await messageOrInteraction.editReply({ ...replyOptions, content: firstChunk });
                            } else {
                                // Message-based reply
                                await messageOrInteraction.reply({ ...replyOptions, content: firstChunk });
                            }
                        } catch (err) {
                            // --- FIX START ---
                            // If the user deleted the message, .reply() fails with 50035 or 10008.
                            // We catch this and fallback to a standard channel.send()
                            const isMissingMsg = err.code === 10008 || (err.code === 50035 && String(err.message).includes("Unknown message"));

                            if (isMissingMsg && channel) {
                                await channel.send({ ...replyOptions, content: firstChunk });
                            } else {
                                console.error("Error sending first chunk:", err); // Log real errors
                            }
                            // --- FIX END ---
                        }
                    }
        
                    // 2. Send the rest as follow-ups/channel sends with a delay
                    for (const chunk of botTaggedChunks) {
                        const delay = 1000 + Math.floor(Math.random() * 2000);
                        await new Promise(r => setTimeout(r, delay));
                
                        if (channel && typeof channel.send === "function") {
                             await channel.send({ ...replyOptions, content: chunk });
                        }
                    }
                })();
        
                return; // Stop the normal output path
            }

            // ... (Rest of your splitMessage logic for non-tagged messages) ...

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

                // For the first message, we use the original reply mechanism
                if (index === 0) {
                    try {
                        if (isInteraction(messageOrInteraction)) {
                            await messageOrInteraction.editReply(fallbackOptions);
                        } else {
                            await messageOrInteraction.reply(fallbackOptions);
                        }
                    } catch (err) {
                        // Fallback if message deleted
                        const isMissingMsg = err.code === 10008 || (err.code === 50035 && String(err.message).includes("Unknown message"));
                        if (isMissingMsg && messageOrInteraction.channel) {
                            await messageOrInteraction.channel.send(fallbackOptions);
                        }
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
        // --- 1. IGNORE DELETED MESSAGE ERRORS ---
        // Code 10008: Unknown Message 
        // Code 50035: Invalid Form Body (specifically "Unknown message" regarding the reference)
        const isUnknownMessage = 
            err.code === 10008 || 
            (err.code === 50035 && String(err.message).includes("Unknown message"));

        if (isUnknownMessage) {
            // The user deleted the message before we could reply. 
            // Stop everything silently. Do NOT try to reply again.
            return;
        }

        console.error("Error handling request:", err);

        // --- 2. SAFE ERROR REPORTING ---
        // If it's a different error, try to tell the user, but don't crash if that fails too.
        try {
            const errorOptions = {
                content: MESSAGES.processingError,
                allowedMentions: { repliedUser: false }
            };

            if (isInteraction(messageOrInteraction)) {
                if (!messageOrInteraction.replied && !messageOrInteraction.deferred) {
                    await messageOrInteraction.reply({ ...errorOptions, ephemeral: true });
                } else {
                    await messageOrInteraction.followUp({ ...errorOptions, ephemeral: true });
                }
            } else {
                // For normal messages, check if we can send to the channel 
                // instead of replying to avoid the "Unknown Message" error again
                if (messageOrInteraction.channel) {
                    await messageOrInteraction.channel.send(errorOptions);
                }
            }
        } catch (finalErr) {
            // If even sending the error message fails, just swallow the error to prevent a crash.
            // console.warn("Failed to send error response:", finalErr.message);
        }
    } finally {
        if (typingInterval) clearInterval(typingInterval);
    }
}

// -------------------- EVENTS --------------------
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    // If the channel name contains blocked words, ignore completely
    if (message.channel.name) {
        const lowerName = message.channel.name.toLowerCase();
        if (IGNORED_CHANNELS.some(blocked => lowerName.includes(blocked))) return;
    }
    
    // LOGGING WITH TIMESTAMP
    logMessage(
        message.channel.id,
        message.author.username,
        message.content,
        message.createdTimestamp // Pass timestamp
    );

    let rawUserMsg = message.content.trim(); // The clean input for Logic
    let promptMsg = rawUserMsg;              // The input + context for Gemini
    
    if (!rawUserMsg) return;

    const isDM = !message.guild;
    const mentioned = message.mentions.has(client.user);

    // FREE WILL Keyword Detection 
    let keywordTriggered = false;
    if (!mentioned && !isDM) {
        const lowerContent = rawUserMsg.toLowerCase();
        const hasKeyword = TRIGGER_KEYWORDS.some(kw => lowerContent.includes(kw));
        
        // If keyword found, roll the dice
        if (hasKeyword) {
            if (Math.random() < RESPONSE_CHANCE) {
                keywordTriggered = true;
            }
        }
    }
    
    let isReply = false;
    if (message.reference) {
        try {
            const referenced = await message.channel.messages.fetch(message.reference.messageId);
            isReply = referenced.author.id === client.user.id;
        } catch {}
    }

    const hasWikiSyntax = /\{\{[^{}]+\}\}|\[\[[^[\]]+\]\]/.test(message.content);

    // Respond if meets all conditions
    if (!(isDM || mentioned || isReply || hasWikiSyntax || keywordTriggered)) return;

    // If the user mentions the bot but writes very little (e.g. "@Derivative"), 
    // they probably want us to read the message strictly before it.
    const cleanContent = rawUserMsg.replace(/<@!?\d+>/g, "").trim();
    
    // Case 1: User is Replying to a specific message using Discord Reply
    if (message.reference) {
        try {
            const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
            
            // Make sure the referenced message has text content
            if (referencedMessage.content) {
                const contextHeader = `[SYSTEM: I am replying to ${referencedMessage.author.username}'s message: "${referencedMessage.content}"]`;
                promptMsg = `${contextHeader}\n\n${rawUserMsg}`;
            }
        } catch (err) {
            console.error("Failed to fetch reply context:", err);
        }
    } 
    // Case 2: General question (No Reply, No Image) - "Is this true?", "Explain", etc.
    // We fetch the last 5 human messages to give the bot context of the conversation.
    else if (message.attachments.size === 0 && !rawUserMsg.match(/(https?:\/\/[^\s]+)/g)) {
        try {
            // 1. Fetch last 15 messages (to ensure we get 5 humans after filtering bots)
            // 'before: message.id' ensures we don't fetch the current command itself
            const pastMessages = await message.channel.messages.fetch({ limit: 15, before: message.id });

            // 2. Filter: No bots, must have text content
            const lastHumanMessages = pastMessages
                .filter(m => !m.author.bot && m.content.trim().length > 0)
                .first(5) // Get the 5 most recent matching messages
                .reverse(); // Reverse them so they are in chronological order (Oldest -> Newest)

            // 3. Construct the context block
            if (lastHumanMessages.length > 0) {
                const contextLog = lastHumanMessages
                    .map(m => `[User: ${m.author.username}]: ${m.content}`)
                    .join("\n");

                const contextBlock = `[SYSTEM: Here is the recent conversation context...:\n${contextLog}\n]`;
                promptMsg = `${contextBlock}\n\n${rawUserMsg}`;
            }
        } catch (err) {
            console.error("Failed to fetch channel context:", err);
        }
    }
    
    // If content is empty/short AND it's not a direct reply to a specific message
    if (cleanContent.length < 12 && !message.reference && message.channel.type !== ChannelType.DM && !rawUserMsg.includes("[SYSTEM:")) {
        try {
            // Fetch last 2 messages (Current + Previous)
            const messages = await message.channel.messages.fetch({ limit: 2 });
            if (messages.size === 2) {
                const previousMessage = messages.last(); // .last() is the older one
                
                // Ensure previous message isn't a bot and has text
                if (previousMessage && !previousMessage.author.bot && previousMessage.content) {
                    // Prepend the context so Gemini sees: "Previous text... [User Ping]"
                    promptMsg = `${previousMessage.content}\n\n[System Note: User pinged you regarding the text above]`;
                }
            }
        } catch (err) {
            console.error("Failed to fetch previous context:", err);
        }
    }

    await handleUserRequest(promptMsg, rawUserMsg, message);

    // Only schedule if it's a DM or the user explicitly pinged/replied (showing interest)
    if (isDM || mentioned || isReply) {
        scheduleFollowUp(message);
    }
});

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isMessageContextMenuCommand()) return;
    if (interaction.commandName !== `Ask ${BOT_NAME}...`) return;

    logMessage(
        interaction.channelId,
        interaction.user.username,
        interaction.targetMessage?.content || "[No content]",
        interaction.createdTimestamp // Pass timestamp
    );
    
    const modal = new ModalBuilder()
        .setCustomId("deriv_modal")
        .setTitle(`Ask ${BOT_NAME}`);

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
        userPrompt,
        interaction.createdTimestamp // Pass timestamp
    );
    
    const isPrivateChannel = interaction.channel &&
    (interaction.channel.type === ChannelType.DM ||
     interaction.channel.type === ChannelType.GroupDM);

    // Only make response public in DMs
    const ephemeralSetting = !isPrivateChannel;

    await interaction.deferReply({
        ephemeral: ephemeralSetting
    });
    
    await handleUserRequest(userPrompt, userPrompt, interaction, ephemeralSetting);
});

client.login(DISCORD_TOKEN);
