const { urlToGenerativePart } = require("./image_handling.js");
const { contributionScoresTool, getContributionScores } = require("./contribscores.js");
const {
    findCanonicalTitle,
    getWikiContent,
    getSectionContent,
    getLeadSection,
    getFullSizeImageUrl,
    knownPages
} = require("./parse_page.js");
const {
    askGemini,
    askGeminiForPages,
    MESSAGES
} = require("./conversation.js");
const { buildPageEmbed } = require("./interactions.js");
const { fetch } = require("./utils.js");
const { WIKIS, BOT_NAME, WIKI_ENDPOINTS } = require("../config.js");
const { MessageFlags } = require("discord.js");

const DISCORD_MAX_LENGTH = 2000;

function splitMessage(text, maxLength = DISCORD_MAX_LENGTH) {
    const messages = [];
    let currentText = text;

    while (currentText.length > 0) {
        if (currentText.length <= maxLength) {
            messages.push(currentText);
            break;
        }

        const searchLength = maxLength - 10;
        let splitIndex = currentText.lastIndexOf('\n', searchLength);
        if (splitIndex === -1) splitIndex = currentText.lastIndexOf(' ', searchLength);
        if (splitIndex === -1) splitIndex = searchLength;

        let segment = currentText.slice(0, splitIndex).trim();
        let remaining = currentText.slice(splitIndex).trim();

        const backtickMatches = segment.match(/```/g);
        const isInsideCodeBlock = backtickMatches && (backtickMatches.length % 2 !== 0);

        if (isInsideCodeBlock) {
            segment += "\n```";
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

async function handleAIRequest(promptMsg, rawUserMsg, messageOrInteraction, isEphemeral = false, isProactive = false) {
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
        let imageURLs = [];
        if (message && message.attachments && message.attachments.size > 0) {
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

        const defaultWiki = WIKIS["tagging"];

        if (imageParts.length > 0) {
             if (!promptMsg.trim()) {
                promptMsg = `Analyze the attached media in the context of the wiki ${defaultWiki.baseUrl}`;
            } else {
                promptMsg = `Analyze the attached media in the context of: ${promptMsg}`;
            }
        }

        let explicitTemplateName = null;
        let explicitTemplateContent = null;
        let explicitTemplateFoundTitle = null;
        let explicitTemplateGallery = null;
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

            const canonical = await findCanonicalTitle(rawTemplate, defaultWiki);

            if (canonical) {
                shouldUseComponentsV2 = true;
                skipGemini = true;

                if (sectionName) {
                    const sectionData = await getSectionContent(canonical, sectionName, defaultWiki);
                    if (sectionData) {
                        explicitTemplateContent = sectionData.content;
                        explicitTemplateFoundTitle = `${canonical} § ${sectionData.displayTitle}`;
                        explicitTemplateGallery = sectionData.gallery;
                    } else {
                        explicitTemplateContent = "No content available.";
                        explicitTemplateFoundTitle = `${canonical}#${sectionName}`;
                    }
                } else {
                    explicitTemplateContent = await getLeadSection(canonical, defaultWiki);
                    explicitTemplateFoundTitle = canonical;
                }
                explicitTemplateName = rawTemplate;
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
                    const content = await getWikiContent(pageTitle, defaultWiki);
                    if (content) wikiContent += `\n\n--- Page: ${pageTitle} ---\n${content}`;
                }
            }
        }

        const tools = {
            functionDeclarations: [contributionScoresTool],
            functions: {
                "getContributionScores": getContributionScores
            }
        };

        let reply = "";

        if (!skipGemini) {
            reply = await askGemini(
                promptMsg,
                wikiContent || undefined,
                pageTitles.join(", ") || undefined,
                imageParts,
                messageOrInteraction,
                tools,
                isProactive
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

        let parsedReply = reply;
        const embedRegex = /\[PAGE_EMBED:\s*(.*?)\]/gi;
        const embedMatches = [...parsedReply.matchAll(embedRegex)];
        let secondaryEmbedTitles = [];

        if (embedMatches.length > 0) {
            for (const m of embedMatches) {
                const requestedPage = m[1].trim();
                const canonical = await findCanonicalTitle(requestedPage, defaultWiki);
                if (canonical && !secondaryEmbedTitles.includes(canonical)) {
                    secondaryEmbedTitles.push(canonical);
                }
            }
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

        const fetchPageImage = async (title) => {
            if (!title) return null;
            try {
                const cleanTitle = title.includes(" § ") ? title.split(" § ")[0] : title.split("#")[0];
                const imageRes = await fetch(`${defaultWiki.apiEndpoint}?action=query&titles=${encodeURIComponent(cleanTitle)}&prop=pageimages&pithumbsize=512&format=json`);
                const imageJson = await imageRes.json();
                const pages = imageJson.query?.pages;
                const first = pages ? Object.values(pages)[0] : null;
                const src = first?.thumbnail?.source || null;
                return getFullSizeImageUrl(src);
            } catch (err) {
                return null;
            }
        }

        let primaryImageUrl = null;
        if (explicitTemplateFoundTitle) {
            primaryImageUrl = await fetchPageImage(explicitTemplateFoundTitle);
        }

        let sent = false;

        if (shouldUseComponentsV2) {
            try {
                const container = buildPageEmbed(
                    explicitTemplateFoundTitle,
                    parsedReply,
                    primaryImageUrl,
                    defaultWiki,
                    explicitTemplateGallery
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

        if (!sent && !shouldUseComponentsV2) {
            if (botUsedTags) {
                const replyOptions = { allowedMentions: { repliedUser: false } };
                (async () => {
                    while (botTaggedChunks.length > 0) {
                        const rawChunk = botTaggedChunks.shift();
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
                        } else if (messageOrInteraction.channel) {
                            await messageOrInteraction.channel.send(fallbackOptions);
                        }
                    }
                }
            }
            sent = true;
        }

        if (secondaryEmbedTitles.length > 0) {
            await new Promise(r => setTimeout(r, 500));

            for (const title of secondaryEmbedTitles) {
                try {
                    let wikiAbstract = null;
                    let gallery = null;
                    let displayTitle = title;

                    if (title.includes("#")) {
                        const [page, section] = title.split("#");
                        const sectionData = await getSectionContent(page.trim(), section.trim(), defaultWiki);
                        if (sectionData) {
                            wikiAbstract = sectionData.content;
                            displayTitle = `${page.trim()} § ${sectionData.displayTitle}`;
                            gallery = sectionData.gallery;
                        }
                    } else {
                        wikiAbstract = await getLeadSection(title, defaultWiki);
                    }

                    if (!wikiAbstract) wikiAbstract = "No content available.";
                    if (wikiAbstract.length > 800) wikiAbstract = wikiAbstract.slice(0, 800) + "...";

                    const cardImageUrl = await fetchPageImage(title);
                    const container = buildPageEmbed(displayTitle, wikiAbstract, cardImageUrl, defaultWiki, gallery);

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

                    await new Promise(r => setTimeout(r, 500));

                } catch (secErr) {
                    console.error(`Failed to send secondary page embed for ${title}:`, secErr);
                }
            }
        }

    } catch (err) {
        console.error("Error handling AI request:", err);
        try {
            await smartReply({ content: MESSAGES.processingError, ephemeral: true });
        } catch (finalErr) {}
    } finally {
        if (typingInterval) clearInterval(typingInterval);
    }
}

module.exports = { handleAIRequest };
