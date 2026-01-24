require("dotenv").config();

// --- IMPORTS ---
const { MAIN_KEYS } = require("./geminikey.js");
const { loadMemory, logMessage, memory: persistedMemory } = require("./memory.js");
loadMemory(); 

// NEW IMPORTS FROM FUNCTIONS FOLDER
const { urlToGenerativePart } = require("./functions/image_handling.js");
const { getContributionScores } = require("./functions/contribscores.js");
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
    askGeminiForPages, 
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
        // If text fits, push and done
        if (currentText.length <= maxLength) {
            messages.push(currentText);
            break;
        }

        // 1. Determine safe split position
        // We reserve a slight buffer (e.g., 10 chars) in case we need to add code block tags
        const searchLength = maxLength - 10;
        
        let splitIndex = currentText.lastIndexOf('\n', searchLength);
        if (splitIndex === -1) splitIndex = currentText.lastIndexOf(' ', searchLength);
        if (splitIndex === -1) splitIndex = searchLength;

        let segment = currentText.slice(0, splitIndex).trim();
        let remaining = currentText.slice(splitIndex).trim();

        // 2. Check for unclosed code blocks (odd number of ```)
        // matches '```' sequences
        const backtickMatches = segment.match(/```/g);
        const isInsideCodeBlock = backtickMatches && (backtickMatches.length % 2 !== 0);

        if (isInsideCodeBlock) {
            // Close the block in this segment
            segment += "\n```";
            // Re-open the block in the next segment
            remaining = "```\n" + remaining;
        }

        messages.push(segment);
        currentText = remaining;
    }

    return messages;
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

// --- NEW: UNIFIED COMPONENT BUILDER ---
function buildPageEmbed(title, content, imageUrl) {
    const container = new ContainerBuilder();
    const mainSection = new SectionBuilder();

    // 1. Text Content
    mainSection.addTextDisplayComponents([new TextDisplayBuilder().setContent(content)]);
    
    // 2. Image (Thumbnail)
    const fallbackImage = "https://upload.wikimedia.org/wikipedia/commons/8/89/HD_transparent_picture.png"; 
    const finalImageUrl = (typeof imageUrl === "string" && imageUrl.trim() !== "") ? imageUrl : fallbackImage;
    
    try {
        mainSection.setThumbnailAccessory(thumbnail => thumbnail.setURL(finalImageUrl));
    } catch (err) { }      

    if (mainSection.components && mainSection.components.length > 0) {
        // filter undefined
        mainSection.components = mainSection.components.filter(c => c !== undefined);
        if (mainSection.components.length > 0) {
            container.addSectionComponents(mainSection);
        }
    }
    
    // 3. Action Row (Link Button)
    if (title) {
        try {
            const [pageOnly, frag] = String(title).split("#");
            const parts = pageOnly.split(':').map(s => encodeURIComponent(s.replace(/ /g, "_")));
            const pageUrl = `${WIKI_ENDPOINTS.ARTICLE_PATH}${parts.join(':')}${frag ? '#'+encodeURIComponent(frag.replace(/ /g,'_')) : ''}`;
            
            const row = new ActionRowBuilder();
            const btn = new ButtonBuilder()
                .setLabel(String(title).slice(0, 80))
                .setStyle(ButtonStyle.Link)
                .setURL(pageUrl);
    
            if (btn) row.addComponents(btn);
            if (row.components.length > 0) container.addActionRowComponents(row);
        } catch (err) {}
    }

    return container;
}

// FOLLOW UP MESSAGES
const { getHistory } = require("./functions/conversation.js"); 

async function scheduleFollowUp(message) {
    const channelId = message.channel.id;
    if (activeConversations.has(channelId)) {
        clearTimeout(activeConversations.get(channelId).timer);
    }
    if (Math.random() < 0.5) return; 

    const delay = Math.floor(Math.random() * (MAX_FOLLOWUP_DELAY - MIN_FOLLOWUP_DELAY + 1)) + MIN_FOLLOWUP_DELAY;
    
    const timer = setTimeout(async () => {
        try {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!channel) return;

            const history = getHistory(channelId);
            if (!history || history.length < 2) return; 

            const delayText = delay < 60000 ? `${Math.round(delay/1000)} seconds` : `${Math.round(delay/60000)} minutes`;
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
                client: client,
                attachments: { size: 0 }, 
                content: systemNote,
                guild: channel.guild,
                createdTimestamp: Date.now()
            };
            
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
const STATUS_INTERVAL_MS = 1 * 60 * 1000;

function setRandomStatus(client) {
    if (!client || !client.user) return;
    const newStatus = STATUS_OPTIONS[Math.floor(Math.random() * STATUS_OPTIONS.length)];
    if (!newStatus || !newStatus.text || typeof newStatus.type !== "number") return;

    try {
        client.user.setPresence({
            activities: [{ name: newStatus.text, type: newStatus.type }],
            status: 'online',
        });
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
    await loadPages(); 
    setRandomStatus(client);
    setInterval(() => { setRandomStatus(client); }, STATUS_INTERVAL_MS);

    try {
        console.log("Clearing existing global commands...");
        await client.application.commands.set([]); 
        
        await client.application.commands.create(
            new ContextMenuCommandBuilder()
            .setName(`Ask ${BOT_NAME}...`)
            .setType(ApplicationCommandType.Message)
            .setContexts([0, 1, 2])
            .setIntegrationTypes([0, 1])
        );
        console.log(`✅ Registered global context menu: Ask ${BOT_NAME}`);
    } catch (err) {
        console.error("Failed to register context command:", err);
    }
});

// -------------------- HANDLER --------------------
async function handleUserRequest(promptMsg, rawUserMsg, messageOrInteraction, isEphemeral = false, isProactive = false) {
    if (!promptMsg || !promptMsg.trim()) return MESSAGES.noAIResponse;

    const isInteraction = interaction => interaction.editReply || interaction.followUp;

    const smartReply = async (payload) => {
        if (isInteraction(messageOrInteraction)) {
            if (messageOrInteraction.deferred || messageOrInteraction.replied) {
                return messageOrInteraction.followUp(payload);
            }
            return messageOrInteraction.reply(payload);
        } else if (typeof messageOrInteraction.reply === 'function') {
            return messageOrInteraction.reply(payload);
        } else if (messageOrInteraction.channel && typeof messageOrInteraction.channel.send === 'function') {
            return messageOrInteraction.channel.send(payload);
        }
    };
    
    let message = null;
    if (messageOrInteraction.attachments) {
        message = messageOrInteraction;
    } else if (messageOrInteraction.targetMessage) {
        message = messageOrInteraction.targetMessage;
    } else if (messageOrInteraction.client?._selectedMessage) {
        message = messageOrInteraction.client._selectedMessage;
    }
    const contextMessage = messageOrInteraction;

    let typingInterval;
    if (contextMessage.channel?.sendTyping) {
        messageOrInteraction.channel.sendTyping().catch(() => {});
        typingInterval = setInterval(() => messageOrInteraction.channel.sendTyping().catch(() => {}), 8000);
    }

    try {
        // --- Image/Video Handling ---
        let imageURLs = [];
        if (message && message.attachments.size > 0) {
            message.attachments.forEach(attachment => {
                if (attachment.contentType && (attachment.contentType.startsWith('image/') || attachment.contentType.startsWith('video/'))) {
                    imageURLs.push(attachment.url);
                }
            });
        }

        const urlRegex = /(https?:\/\/[^\s]+)/gi;
        const matches = [...rawUserMsg.matchAll(urlRegex)];
        matches.forEach(match => imageURLs.push(match[0]));

        const uniqueImageURLs = [...new Set(imageURLs)].slice(0, 5); 
        let imageParts = [];

        if (uniqueImageURLs.length > 0) {
            const partPromises = uniqueImageURLs.map(url => urlToGenerativePart(url));
            const parts = await Promise.all(partPromises);
            imageParts = parts.filter(part => part !== null);
        }

        if (imageParts.length > 0) {
             if (!promptMsg.trim()) {
                promptMsg = `Analyze the attached media in the context of the wiki ${WIKI_ENDPOINTS.BASE}`;
            } else {
                promptMsg = `Analyze the attached media in the context of: ${promptMsg}`;
            }
        }

        // === Instant wiki [[...]] handling and explicit {{...}} detection === 
        let explicitTemplateName = null;
        let explicitTemplateContent = null;
        let explicitTemplateFoundTitle = null;
        const templateMatch = rawUserMsg.match(/\{\{([^{}|]+)(?:\|[^{}]*)?\}\}|\[\[([^[\]|]+)(?:\|[^[\]]*)?\]\]/);

        let shouldUseComponentsV2 = false;
        let skipGemini = false;
        
        if (templateMatch) {
            let rawTemplate = (templateMatch[1] || templateMatch[2]).trim();
            let sectionName = null;
        
            if (rawTemplate.includes("#")) {
                const [page, section] = rawTemplate.split("#");
                rawTemplate = page.trim();
                sectionName = section.trim();
            }
        
            const canonical = await findCanonicalTitle(rawTemplate);
            
            if (canonical) {
                shouldUseComponentsV2 = true;
                skipGemini = true; 
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
                console.log(`Pattern found "${rawTemplate}" but no page exists. Falling back to Gemini.`);
            }
        }

        let pageTitles = [];
        let wikiContent = "";
        
        if (skipGemini) {
            if (explicitTemplateFoundTitle) pageTitles = [explicitTemplateFoundTitle];
        } else {
            pageTitles = await askGeminiForPages(rawUserMsg); 
            if (pageTitles.length) {
                for (const pageTitle of pageTitles) {
                    if (knownPages.includes(pageTitle)) { 
                        const content = await getWikiContent(pageTitle);
                        if (content) wikiContent += `\n\n--- Page: ${pageTitle} ---\n${content}`;
                    }
                }
            }

            const leaderboardKeywords = ["top contributors", "leaderboard", "most edits", "contribution scores"];
            if (leaderboardKeywords.some(key => rawUserMsg.toLowerCase().includes(key))) {
                const scores = await getContributionScores();
                wikiContent += `\n\n[SYSTEM DATA: CONTRIBUTION LEADERBOARD]\n${scores}`;
            }
        }
        
        let reply = "";
        
        if (!skipGemini) {  
            reply = await askGemini(
                promptMsg, 
                wikiContent || undefined,
                pageTitles.join(", ") || undefined,
                imageParts,
                messageOrInteraction
            );
        } else {
            reply = explicitTemplateContent || "I don't know.";
        }

        if (reply.trim() === "[TERMINATE_MESSAGE]") {
            if (isInteraction(messageOrInteraction)) {
                reply = "I cannot reply to that."; 
            } else {
                if (typingInterval) clearInterval(typingInterval);
                return; 
            }
        }

        // --- EXTRACT PAGE_EMBEDS ---
        let parsedReply = reply; 
        
        // Find ALL [PAGE_EMBED: ...] tags
        const embedRegex = /\[PAGE_EMBED:\s*(.*?)\]/gi;
        const embedMatches = [...parsedReply.matchAll(embedRegex)];
        let secondaryEmbedTitles = []; 

        if (embedMatches.length > 0) {
            for (const m of embedMatches) {
                const requestedPage = m[1].trim();
                const canonical = await findCanonicalTitle(requestedPage);
                // Store unique canonical titles
                if (canonical && !secondaryEmbedTitles.includes(canonical)) {
                    secondaryEmbedTitles.push(canonical);
                }
            }
            // Remove the tags from the text
            parsedReply = parsedReply.replace(embedRegex, "").trim();
        }

        if (isEphemeral) {
            parsedReply = parsedReply
  .replace(/\[START_MESSAGE\]/g, "")
  .replace(/\[END_MESSAGE\]/g, "\n")
  .replace(/\[PAGE_EMBED:[^\]]*\]/g, "")
  .trim();
        }

        let botTaggedChunks = [];
        let botUsedTags = false;

        if (!isEphemeral) {
            botTaggedChunks = extractTaggedBotChunks(parsedReply);
            botUsedTags = botTaggedChunks.length > 0;
        }

        // Helper to get image for a page
        const fetchPageImage = async (title) => {
            if (!title) return null;
            try {
                const imageRes = await fetch(`${API}?action=query&titles=${encodeURIComponent(title)}&prop=pageimages&pithumbsize=512&format=json`);
                const imageJson = await imageRes.json();
                const pages = imageJson.query?.pages;
                const first = pages ? Object.values(pages)[0] : null;
                return first?.thumbnail?.source || null;
            } catch (err) {
                return null;
            }
        }

        // Prepare Image for V2 (Primary User Request)
        let primaryImageUrl = null;
        if (explicitTemplateFoundTitle) {
            primaryImageUrl = await fetchPageImage(explicitTemplateFoundTitle);
        }

        let sent = false;
        
        // -------------------- COMPONENTS V2 (User Triggered {{Page}}) --------------------
        if (shouldUseComponentsV2) {
            try {
                const container = buildPageEmbed(
                    explicitTemplateFoundTitle, 
                    parsedReply, // For explicit user trigger, the 'reply' IS the content (extracted text)
                    primaryImageUrl
                );
                
                if (container.components && container.components.length > 0) {
                    const replyOptions = {
                        components: [container],
                        flags: MessageFlags.IsComponentsV2,
                        allowedMentions: { repliedUser: false },
                    };
                    await smartReply(replyOptions);
                    sent = true;
                }
            } catch (v2err) {
                console.warn("Components V2 attempt failed — falling back to plain text.", v2err);
            }
        }
        
        // -------------------- STANDARD TEXT REPLY --------------------
        if (!sent && !shouldUseComponentsV2) {
            if (botUsedTags) {
                const replyOptions = { allowedMentions: { repliedUser: false } };
                (async () => {
                    // FIX: Iterate through chunks and SPLIT specific chunks if they are too long
                    while (botTaggedChunks.length > 0) {
                        const rawChunk = botTaggedChunks.shift();
                        // Apply splitMessage to the chunk in case the chunk itself is huge
                        const splitParts = splitMessage(rawChunk);

                        for (const part of splitParts) {
                            if (!sent) {
                                await smartReply({ ...replyOptions, content: part });
                                sent = true; 
                            } else {
                                const delay = 1000 + Math.floor(Math.random() * 2000);
                                await new Promise(r => setTimeout(r, delay));
                                if (messageOrInteraction.channel) {
                                     await messageOrInteraction.channel.send({ ...replyOptions, content: part });
                                }
                            }
                        }
                    }
                })();
            } else {
                const replyParts = splitMessage(parsedReply, DISCORD_MAX_LENGTH);
                for (const [index, part] of replyParts.entries()) {
                    const fallbackOptions = { content: part, allowedMentions: { repliedUser: false } };
                    if (index === 0) {
                        await smartReply(fallbackOptions);
                    } else {
                        if (isInteraction(messageOrInteraction)) {
                            await messageOrInteraction.followUp(fallbackOptions);
                        } else {
                            await messageOrInteraction.channel.send(fallbackOptions);
                        }
                    }
                }
            }
            sent = true;
        }
        
        // V2 Fallback (Should rarely happen)
        if (!sent && shouldUseComponentsV2) {
            const rawFallback = explicitTemplateContent || parsedReply;
            const fallbackParts = splitMessage(rawFallback, DISCORD_MAX_LENGTH);
            
            for (const [index, part] of fallbackParts.entries()) {
                const opts = { content: part, allowedMentions: { repliedUser: false } };
                if (index === 0) await smartReply(opts);
                else if (messageOrInteraction.channel) await messageOrInteraction.channel.send(opts);
            }
        }
        
        // -------------------- SECONDARY EMBEDS (AI Triggered [PAGE_EMBED]) --------------------
        // We wait for the main text to finish sending/chunking before sending embeds?
        // Since the chunking is async/separate, we can just fire these off.
        if (secondaryEmbedTitles.length > 0) {
            // Small delay to ensure main text appears first
            await new Promise(r => setTimeout(r, 500)); 

            for (const title of secondaryEmbedTitles) {
                try {
                    // 1. Fetch content (Lead section or Extract)                    
                    const extractRes = await fetch(
                       `${WIKI_ENDPOINTS.API}?action=query&prop=extracts&exintro&explaintext&redirects=1&titles=${encodeURIComponent(title)}&format=json`
                    );
                    const extractJson = await extractRes.json();
                    const pageObj = Object.values(extractJson.query.pages)[0];
                    let wikiAbstract = pageObj.extract || "No content available.";
                    
                    if (wikiAbstract.length > 800) wikiAbstract = wikiAbstract.slice(0, 800) + "...";

                    // 2. Fetch Image
                    const cardImageUrl = await fetchPageImage(title);

                    // 3. Build Container using SHARED function
                    const container = buildPageEmbed(title, wikiAbstract, cardImageUrl);

                    // 4. Send
                    const embedPayload = {
                        components: [container],
                        flags: MessageFlags.IsComponentsV2,
                        allowedMentions: { repliedUser: false }
                    };

                    if (isInteraction(messageOrInteraction)) {
                        await messageOrInteraction.followUp(embedPayload);
                    } else if (messageOrInteraction.channel) {
                        await messageOrInteraction.channel.send(embedPayload);
                    }
                    
                    // Delay between multiple cards
                    await new Promise(r => setTimeout(r, 500));

                } catch (secErr) {
                    console.error(`Failed to send secondary page embed for ${title}:`, secErr);
                }
            }
        }

    } catch (err) {
        const isUnknownMessage = err.code === 10008 || (err.code === 50035 && String(err.message).includes("Unknown message"));
        if (isUnknownMessage) return;
        console.error("Error handling request:", err);
        try {
            await smartReply({ content: MESSAGES.processingError, ephemeral: true });
        } catch (finalErr) {}
    } finally {
        if (typingInterval) clearInterval(typingInterval);
    }
}

// -------------------- EVENTS --------------------
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    if (message.channel.name) {
        const lowerName = message.channel.name.toLowerCase();
        if (IGNORED_CHANNELS.some(blocked => lowerName.includes(blocked))) return;
    }
    
    logMessage(
        message.channel.id,
        message.author.username,
        message.content,
        message.createdTimestamp 
    );

    let rawUserMsg = message.content.trim(); 
    let promptMsg = rawUserMsg;              
    
    if (!rawUserMsg) return;

    const isDM = !message.guild;
    const mentioned = message.mentions.has(client.user);

    let keywordTriggered = false;
    if (!mentioned && !isDM) {
        const lowerContent = rawUserMsg.toLowerCase();
        const hasKeyword = TRIGGER_KEYWORDS.some(kw => lowerContent.includes(kw));
        if (hasKeyword && Math.random() < RESPONSE_CHANCE) {
            keywordTriggered = true;
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

    if (!(isDM || mentioned || isReply || hasWikiSyntax || keywordTriggered)) return;

    const cleanContent = rawUserMsg.replace(/<@!?\d+>/g, "").trim();
    
    if (message.reference) {
        try {
            const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
            if (referencedMessage.content) {
                const contextHeader = `[SYSTEM: I am replying to ${referencedMessage.author.username}'s message: "${referencedMessage.content}"]`;
                promptMsg = `${contextHeader}\n\n${rawUserMsg}`;
            }
        } catch (err) {
            console.error("Failed to fetch reply context:", err);
        }
    } 
    else if (message.attachments.size === 0 && !rawUserMsg.match(/(https?:\/\/[^\s]+)/g)) {
        try {
            const pastMessages = await message.channel.messages.fetch({ limit: 15, before: message.id });
            const lastHumanMessages = pastMessages
                .filter(m => !m.author.bot && m.content.trim().length > 0)
                .first(5) 
                .reverse(); 

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
    
    if (cleanContent.length < 12 && !message.reference && message.channel.type !== ChannelType.DM && !rawUserMsg.includes("[SYSTEM:")) {
        try {
            const messages = await message.channel.messages.fetch({ limit: 2 });
            if (messages.size === 2) {
                const previousMessage = messages.last(); 
                if (previousMessage && !previousMessage.author.bot && previousMessage.content) {
                    promptMsg = `${previousMessage.content}\n\n[System Note: User pinged you regarding the text above]`;
                }
            }
        } catch (err) {
            console.error("Failed to fetch previous context:", err);
        }
    }

    await handleUserRequest(promptMsg, rawUserMsg, message);

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
        interaction.createdTimestamp 
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
    interaction.client._selectedMessage = interaction.targetMessage;
});

client.on("interactionCreate", async (interaction) => {
    if (interaction.type !== InteractionType.ModalSubmit) return;
    if (interaction.customId !== "deriv_modal") return;

    let question = interaction.fields.getTextInputValue("user_question");
    const message = interaction.client._selectedMessage;

    if (!message) {
        return interaction.reply({ content: "Could not find the original message.", ephemeral: true });
    }

    if (!question || question.trim() === "") {
        question = "Please analyze and respond to the following message content based on the system instructions.";
    }

    const userPrompt = `${question}\n\nMessage content:\n"${message.content}"`;

    logMessage(
        interaction.channelId,
        interaction.user.username,
        userPrompt,
        interaction.createdTimestamp
    );
    
    const isPrivateChannel = interaction.channel && (interaction.channel.type === ChannelType.DM || interaction.channel.type === ChannelType.GroupDM);
    const ephemeralSetting = !isPrivateChannel;

    await interaction.deferReply({ ephemeral: ephemeralSetting });
    await handleUserRequest(userPrompt, userPrompt, interaction, true);
});

client.login(DISCORD_TOKEN);
