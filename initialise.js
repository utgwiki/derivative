require("dotenv").config();

const { setRandomStatus } = require("./functions/presence.js");
const { commands } = require("./functions/commands.js");
const { 
    handleInteraction: baseHandleInteraction,
    handleUserRequest: handleWikiRequest,
    responseMap,
    botToAuthorMap,
    pruneMap
} = require("./functions/interactions.js");
const { handleAIRequest } = require("./functions/ai_handler.js");

const {
    Client,
    GatewayIntentBits,
    Partials,
    ApplicationCommandType,
    ContextMenuCommandBuilder,
    ChannelType
} = require("discord.js");

const { WIKIS, CATEGORY_WIKI_MAP, STATUS_INTERVAL_MS, BOT_NAME, BOT_SETTINGS } = require("./config.js");
const { logMessage } = require("./memory.js");
const {
    getHistory
} = require("./functions/conversation.js");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const {
    IGNORED_CHANNELS,
    TRIGGER_KEYWORDS,
    RESPONSE_CHANCE,
    MIN_FOLLOWUP_DELAY,
    MAX_FOLLOWUP_DELAY
} = BOT_SETTINGS;

// --- FOLLOW-UP STATE MANAGER ---
const activeConversations = new Map();

// -------------------- UTILITIES --------------------
const PREFIX_WIKI_MAP = Object.keys(WIKIS).reduce((acc, key) => {
    const prefix = WIKIS[key].prefix;
    if (prefix) acc[prefix] = key;
    return acc;
}, {});

const prefixPattern = Object.values(WIKIS).map(w => w.prefix).join('|');

const syntaxRegex = new RegExp(
    `\\{\\{(?:(${prefixPattern}):)?([^{}|]+)(?:\\|[^{}]*)?\\}\\}|` +
    `\\[\\[(?:(${prefixPattern}):)?([^\\]|]+)(?:\\|[^[\\]]*)?\\]\\]`
);

// -------------------- CLIENT SETUP --------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    // Load pages for AI context
    const { loadPages } = require("./functions/parse_page.js");
    await loadPages();

    setRandomStatus(client);
    setInterval(() => { setRandomStatus(client); }, STATUS_INTERVAL_MS);

    try {
        console.log("Registering slash commands...");
        const allCommands = [...commands,
            new ContextMenuCommandBuilder()
            .setName(`Ask ${BOT_NAME}...`)
            .setType(ApplicationCommandType.Message)
            .setContexts([0, 1, 2])
            .setIntegrationTypes([0, 1])
        ];
        await client.application.commands.set(allCommands);
        console.log("✅ Registered slash commands.");
    } catch (err) {
        console.error("Failed to register commands:", err);
    }
});

// -------------------- FOLLOW-UP --------------------
async function scheduleFollowUp(message) {
    const channelId = message.channel.id;
    if (activeConversations.has(channelId)) {
        clearTimeout(activeConversations.get(channelId).timer);
    }
    if (Math.random() < 0.5) {
        activeConversations.delete(channelId);
        return;
    }

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
                attachments: new Map(),
                content: systemNote,
                guild: channel.guild,
                createdTimestamp: Date.now()
            };

            await handleAIRequest(systemNote, systemNote, mockMessage, false, true);

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

// -------------------- EVENTS --------------------
function getWikiAndPage(messageContent, channelParentId) {
    const match = messageContent.match(syntaxRegex);
    if (!match) return null;

    const prefix = match[1] || match[3];
    const rawPageName = (match[2] || match[4]).trim();

    let wikiConfig = null;
    if (prefix) {
        wikiConfig = WIKIS[PREFIX_WIKI_MAP[prefix]];
    } else {
        const wikiKey = CATEGORY_WIKI_MAP[channelParentId] || "tagging";
        wikiConfig = WIKIS[wikiKey];
    }

    return { wikiConfig, rawPageName };
}

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

    const res = getWikiAndPage(message.content, message.channel.parentId);
    if (res) {
        const { wikiConfig, rawPageName } = res;
        if (wikiConfig) {
            const response = await handleWikiRequest(wikiConfig, rawPageName, message);
            if (response && response.id) {
                responseMap.set(message.id, response.id);
                botToAuthorMap.set(response.id, message.author.id);
                pruneMap(responseMap);
                pruneMap(botToAuthorMap);
                return; // Prioritize wiki links over AI
            }
        }
    }

    // AI Logic
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

    if (!(isDM || mentioned || isReply || keywordTriggered)) return;

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
    } else {
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

    await handleAIRequest(promptMsg, rawUserMsg, message);

    if (isDM || mentioned || isReply) {
        scheduleFollowUp(message);
    }
});

client.on("messageUpdate", async (oldMessage, newMessage) => {
    if (newMessage.partial) {
        try {
            await newMessage.fetch();
        } catch (err) {
            console.warn("Failed to fetch updated message:", err.message);
            return;
        }
    }

    if (oldMessage.partial) {
        try {
            await oldMessage.fetch();
        } catch (err) {
            console.warn("Failed to fetch old message content for update comparison:", err.message);
        }
    }

    if (newMessage.author?.bot) return;
    if (oldMessage.content === newMessage.content) return;
    if (!responseMap.has(newMessage.id)) return;

    const res = getWikiAndPage(newMessage.content, newMessage.channel.parentId);
    if (!res) return;

    const { wikiConfig, rawPageName } = res;
    const botMessageId = responseMap.get(newMessage.id);

    try {
        const botMessage = await newMessage.channel.messages.fetch(botMessageId);
        if (botMessage) {
            const response = await handleWikiRequest(wikiConfig, rawPageName, newMessage, botMessage);
            if (response && response.id) {
                botToAuthorMap.set(response.id, newMessage.author.id);
                pruneMap(botToAuthorMap);
            }
        }
    } catch (err) {
        console.warn("Failed to fetch bot message for update:", err.message);
    }
});

client.on("messageReactionAdd", async (reaction, user) => {
    if (user.bot) return;
    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error('Something went wrong when fetching the reaction:', error);
            return;
        }
    }

    const emoji = reaction.emoji.name;
    if (emoji === "🗑️" || emoji === "wastebucket" || emoji === "wastebasket") {
        const message = reaction.message;
        if (message.author.id !== client.user.id) return;

        let originalAuthorId = botToAuthorMap.get(message.id);

        if (!originalAuthorId && message.reference) {
            try {
                const referencedMsg = await message.channel.messages.fetch(message.reference.messageId);
                originalAuthorId = referencedMsg.author.id;
                botToAuthorMap.set(message.id, originalAuthorId);
            } catch (err) {
                console.warn(`Failed to fetch referenced message ${message.reference.messageId} for bot message ${message.id}:`, err);
            }
        }

        if (user.id === originalAuthorId) {
            try {
                await message.delete();
            } catch (err) {
                console.warn("Failed to delete message on reaction:", err.message);
            }
        }
    }
});

async function handleInteraction(interaction) {
    if (interaction.isModalSubmit()) {
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
        await handleAIRequest(userPrompt, userPrompt, interaction, true);
        return;
    }

    await baseHandleInteraction(interaction);
}

client.on("interactionCreate", (interaction) => {
    handleInteraction(interaction).catch(err => console.error("Interaction error:", err));
});

client.login(DISCORD_TOKEN);
