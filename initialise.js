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
    mwSearch,   
    mwContent, 
    MESSAGES,
    getHistory 
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
        if (currentText.length <= maxLength) {
            messages.push(currentText);
            currentText = "";
            break;
        }

        let splitIndex = maxLength;
        let lastSpace = currentText.lastIndexOf(' ', splitIndex);

        if (lastSpace !== -1) {
            splitIndex = lastSpace;
        }

        let segment = currentText.slice(0, splitIndex).trim();

        if (segment.length === 0) {
            segment = currentText.slice(0, maxLength);
            splitIndex = maxLength;
        }

        messages.push(segment);
        currentText = currentText.slice(splitIndex).trim();
    }
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

// FOLLOW UP MESSAGES
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
const STATUS_INTERVAL_MINUTES = 1;
const STATUS_INTERVAL_MS = STATUS_INTERVAL_MINUTES * 60 * 1000;

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
        // --- 💡 Image Handling ---
        let imageURLs = [];
        if (message && message.attachments.size > 0) { 
            message.attachments.forEach(attachment => {
                if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                    imageURLs.push(attachment.url);
                }
            });
        }
        const urlRegex = /(https?:\/\/[^\s]+?\.(jpe?g|png|gif|webp))/gi;
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
                promptMsg = `What is in this image, and how does it relate to the wiki on ${WIKI_ENDPOINTS.BASE}?`;
            } else {
                promptMsg = `Analyze the attached image(s) in the context of the following request: ${promptMsg}`;
            }
        }

        // === Instant wiki [[...]] handling ===
        const wikiLinkRegex = /\[\[([^[\]|]+)(?:\|[^[\]]*)?\]\]/g;
        const linkMatches = [...rawUserMsg.matchAll(wikiLinkRegex)];
        if (linkMatches.length) {
            const resolved = [];
            for (const m of linkMatches) {
                const raw = m[1].trim();
                const canonical = await findCanonicalTitle(raw);
                if (!canonical) {
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
        
        // Detect explicit {{Template}} usage
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
                console.log(`Template pattern found "${rawTemplate}" but no page exists. Falling back to Gemini.`);
            }
        }

        // ---- NEW LOGIC: MW_SEARCH -> MW_CONTENT PRE-FETCH ----
        let pageTitles = [];
        let wikiContent = "";
        
        if (skipGemini) {
            if (explicitTemplateFoundTitle) {
                pageTitles = [explicitTemplateFoundTitle];
            }
        } else {
            // 💡 REPLACED LOGIC: MW_SEARCH implementation
            // 1. Perform MW_SEARCH on the user input
            const searchResults = await mwSearch(rawUserMsg);
            
            // 2. Parse results to find a candidate title.
            // Assumption: searchResults might be a string (from vector search) or list.
            // We split by newline and take the first valid line as the most relevant page.
            if (searchResults && typeof searchResults === 'string') {
                 const lines = searchResults.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                 if (lines.length > 0) {
                     // Try to match the first result to a canonical page
                     const firstCandidate = lines[0];
                     
                     // 3. Get Content via MW_CONTENT
                     const { title, text } = await mwContent(firstCandidate);
                     
                     if (title && text) {
                         pageTitles.push(title);
                         wikiContent += `\n\n--- Page: ${title} ---\n${text.slice(0, 10000)}`; // Limit size
                     }
                 }
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

        // If Gemini outputs [TERMINATE_MESSAGE], silently drop it unless interaction
        if (reply.trim() === "[TERMINATE_MESSAGE]") {
            if (isInteraction(messageOrInteraction)) {
                reply = "I cannot reply to that."; 
            } else {
                if (typingInterval) clearInterval(typingInterval);
                return; 
            }
        }

        let parsedReply = await parseTemplates(reply);  
        parsedReply = await parseWikiLinks(parsedReply);

        if (isEphemeral) {
            parsedReply = parsedReply.replace(/\[START_MESSAGE\]/g, "").replace(/\[END_MESSAGE\]/g, "\n\n").trim();
        }

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
        
        // 7. -------------------- TRY: Components V2 --------------------
        if (shouldUseComponentsV2) {
            try {
                const container = new ContainerBuilder();
                const mainSection = new SectionBuilder();
    
                mainSection.addTextDisplayComponents([new TextDisplayBuilder().setContent(parsedReply)]);
                
                const fallbackImage = "https://upload.wikimedia.org/wikipedia/commons/8/89/HD_transparent_picture.png"; 
                const finalImageUrl = (typeof imageUrl === "string" && imageUrl.trim() !== "") ? imageUrl : fallbackImage;
                
                try {
                    mainSection.setThumbnailAccessory(thumbnail => thumbnail.setURL(finalImageUrl));
                } catch (err) {
                    console.warn("V2 thumbnail accessory creation failed:", err);
                }      
    
                if (mainSection.components && mainSection.components.length > 0) {
                    mainSection.components = mainSection.components.filter(c => c !== undefined);
                    if (mainSection.components.length > 0) container.addSectionComponents(mainSection);
                }
                
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
                        if (btn) row.addComponents(btn);
                        if (row.components.length > 0) container.addActionRowComponents(row);
                    } catch (err) {
                        console.warn("Failed to create template link button:", err);
                    }
                }
    
                if (container.components && container.components.length > 0) {
                    const replyOptions = {
                        components: [container],
                        flags: MessageFlags.IsComponentsV2,
                        allowedMentions: { repliedUser: false },
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
            if (botUsedTags) {
                const channel = messageOrInteraction.channel; 
                const replyOptions = { allowedMentions: { repliedUser: false } };
                
                (async () => {
                    const firstChunk = botTaggedChunks.shift();
                    if (firstChunk) {
                        try {
                            if (isInteraction(messageOrInteraction)) {
                                await messageOrInteraction.editReply({ ...replyOptions, content: firstChunk });
                            } else {
                                await messageOrInteraction.reply({ ...replyOptions, content: firstChunk });
                            }
                        } catch (err) {
                            const isMissingMsg = err.code === 10008 || (err.code === 50035 && String(err.message).includes("Unknown message"));
                            if (isMissingMsg && channel) {
                                await channel.send({ ...replyOptions, content: firstChunk });
                            } else {
                                console.error("Error sending first chunk:", err); 
                            }
                        }
                    }
        
                    for (const chunk of botTaggedChunks) {
                        const delay = 1000 + Math.floor(Math.random() * 2000);
                        await new Promise(r => setTimeout(r, delay));
                        if (channel && typeof channel.send === "function") {
                             await channel.send({ ...replyOptions, content: chunk });
                        }
                    }
                })();
                return; 
            }

            const replyParts = splitMessage(parsedReply, DISCORD_MAX_LENGTH);

            for (const [index, part] of replyParts.entries()) {
                const fallbackOptions = {
                    content: part,
                    allowedMentions: { repliedUser: false }
                };
                if (index === 0) {
                    try {
                        if (isInteraction(messageOrInteraction)) {
                            await messageOrInteraction.editReply(fallbackOptions);
                        } else {
                            await messageOrInteraction.reply(fallbackOptions);
                        }
                    } catch (err) {
                        const isMissingMsg = err.code === 10008 || (err.code === 50035 && String(err.message).includes("Unknown message"));
                        if (isMissingMsg && messageOrInteraction.channel) {
                            await messageOrInteraction.channel.send(fallbackOptions);
                        }
                    }
                } else {
                    if (isInteraction(messageOrInteraction)) {
                        await messageOrInteraction.followUp(fallbackOptions);
                    } else {
                        await messageOrInteraction.channel.send(fallbackOptions);
                    }
                }
            }
            sent = true; 
        }

        if (!sent && shouldUseComponentsV2) {
            const replyOptions = {
                content: explicitTemplateContent || "I don't know.",
                allowedMentions: { repliedUser: false }
            };
            if (isInteraction(messageOrInteraction)) {
                try { await messageOrInteraction.editReply(replyOptions); } catch { await messageOrInteraction.followUp(replyOptions); }
            } else {
                await messageOrInteraction.reply(replyOptions);
            }
            sent = true;
            return;
        }

    } catch (err) {
        const isUnknownMessage = 
            err.code === 10008 || 
            (err.code === 50035 && String(err.message).includes("Unknown message"));

        if (isUnknownMessage) return;

        console.error("Error handling request:", err);

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
                if (messageOrInteraction.channel) {
                    await messageOrInteraction.channel.send(errorOptions);
                }
            }
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
        return interaction.reply({
            content: "Could not find the original message.",
            ephemeral: true
        });
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
    
    const isPrivateChannel = interaction.channel &&
    (interaction.channel.type === ChannelType.DM ||
     interaction.channel.type === ChannelType.GroupDM);

    const ephemeralSetting = !isPrivateChannel;

    await interaction.deferReply({
        ephemeral: ephemeralSetting
    });
    
    await handleUserRequest(userPrompt, userPrompt, interaction, ephemeralSetting);
});

client.login(DISCORD_TOKEN);
