const { urlToGenerativePart } = require("./image_handling.js");
const { contributionScoresTool, getContributionScores } = require("./contribscores.js");
const {
    findCanonicalTitle,
    getWikiContent,
    getSectionContent,
    getLeadSection,
    getFullSizeImageUrl
} = require("./parse_page.js");
const {
    askGemini,
    askGeminiForPages,
    MESSAGES
} = require("./conversation.js");
const { buildPageEmbed } = require("./interactions.js");
const { fetch } = require("./utils.js");
const { BOT_NAME } = require("../config.js");
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

async function handleAIRequest(promptMsg, rawUserMsg, messageOrInteraction, wikiConfig, isEphemeral = false, isProactive = false) {
    const rawUserMsgSafe = (rawUserMsg || '').toString();
    const wikiConfigSafe = Object.assign({ baseUrl: '' }, wikiConfig || {});

    if (!promptMsg || !promptMsg.trim()) return MESSAGES.noAIResponse;

    const isInteraction = interaction => interaction && (interaction.editReply || interaction.followUp);

    const smartReply = async (payload) => {
        if (isInteraction(messageOrInteraction)) {
            if (messageOrInteraction.replied) {
                return messageOrInteraction.followUp(payload);
            }
            if (messageOrInteraction.deferred) {
                return messageOrInteraction.editReply(payload);
            }
            return messageOrInteraction.reply(payload);
        } else {
            const sanitizedPayload = { ...payload };
            delete sanitizedPayload.ephemeral;
            delete sanitizedPayload.flags;

            if (typeof messageOrInteraction.reply === 'function') {
                return messageOrInteraction.reply(sanitizedPayload);
            } else if (messageOrInteraction.channel && typeof messageOrInteraction.channel.send === 'function') {
                return messageOrInteraction.channel.send(sanitizedPayload);
            }
        }
    };

    let message = null;
    if (messageOrInteraction.attachments) {
        message = messageOrInteraction;
    } else if (messageOrInteraction.targetMessage) {
        message = messageOrInteraction.targetMessage;
    }

    if (!message && typeof messageOrInteraction.isModalSubmit === 'function' && messageOrInteraction.isModalSubmit() && messageOrInteraction.customId?.startsWith("deriv_modal_")) {
        const targetMessageId = messageOrInteraction.customId.replace("deriv_modal_", "");
        try {
            message = await messageOrInteraction.channel.messages.fetch(targetMessageId);
        } catch (err) {
            console.error(`Failed to fetch message ${targetMessageId} for modal interaction:`, err.message);
            const errorMsg = "Could not retrieve the original message context. The request is being aborted.";
            if (isInteraction(messageOrInteraction)) {
                await messageOrInteraction.reply({ content: errorMsg, ephemeral: true }).catch(e => console.error("Recovery reply failed:", e));
            } else {
                await messageOrInteraction.reply({ content: errorMsg }).catch(e => console.error("Recovery reply failed:", e));
            }
            return;
        }
    }

    const contextMessage = messageOrInteraction;

    let typingInterval;
    if (contextMessage.channel?.sendTyping) {
        contextMessage.channel.sendTyping().catch(() => {});
        typingInterval = setInterval(() => contextMessage.channel.sendTyping().catch(() => {}), 8000);
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
        const matches = [...rawUserMsgSafe.matchAll(urlRegex)];
        const imageExtRegex = /\.(jpe?g|png|gif|webp|svg)(\?.*)?$/i;

        for (const match of matches) {
            const url = match[0];
            if (imageExtRegex.test(url)) {
                imageURLs.push(url);
            }
        }

        const uniqueImageURLs = [...new Set(imageURLs)].slice(0, 5);
        let imageParts = [];

        if (uniqueImageURLs.length > 0) {
            const results = await Promise.allSettled(uniqueImageURLs.map(url => urlToGenerativePart(url)));
            imageParts = results
                .filter(r => r.status === 'fulfilled' && r.value !== null)
                .map(r => r.value);

            results.forEach((r, i) => {
                if (r.status === 'rejected') {
                    console.warn(`Failed to process image URL ${uniqueImageURLs[i]}:`, r.reason);
                }
            });
        }

        if (imageParts.length > 0) {
             if (!promptMsg.trim()) {
                promptMsg = `Analyze the attached media in the context of the wiki ${wikiConfigSafe.baseUrl}`;
            } else {
                promptMsg = `Analyze the attached media in the context of: ${promptMsg}`;
            }
        }

        let explicitTemplateName = null;
        let explicitTemplateContent = null;
        let explicitTemplateFoundTitle = null;
        let explicitTemplateGallery = null;
        const templateMatch = rawUserMsgSafe.match(/\{\{([^{}|]+)(?:\|[^{}]*)?\}\}|\[\[([^[\]|]+)(?:\|[^[\]]*)?\]\]/);

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

            const canonical = await findCanonicalTitle(rawTemplate, wikiConfig);

            if (canonical) {
                shouldUseComponentsV2 = true;
                skipGemini = true;

                if (sectionName) {
                    const sectionData = await getSectionContent(canonical, sectionName, wikiConfig);
                    if (sectionData) {
                        explicitTemplateContent = sectionData.content;
                        explicitTemplateFoundTitle = `${canonical} § ${sectionData.displayTitle}`;
                        explicitTemplateGallery = sectionData.gallery;
                    } else {
                        explicitTemplateContent = "No content available.";
                        explicitTemplateFoundTitle = `${canonical}#${sectionName}`;
                    }
                } else {
                    explicitTemplateContent = await getLeadSection(canonical, wikiConfig);
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
            pageTitles = await askGeminiForPages(rawUserMsgSafe, wikiConfig);
            if (pageTitles.length) {
                for (const pageTitle of pageTitles) {
                    const content = await getWikiContent(pageTitle, wikiConfig);
                    if (content) wikiContent += `\n\n--- Page: ${pageTitle} ---\n${content}`;
                }
            }
        }

        const tools = {
            functionDeclarations: [contributionScoresTool],
            functions: {
                "getContributionScores": async () => {
                    const result = await getContributionScores(wikiConfig);
                    if (result.error) return { error: result.error };
                    return { result: result.result };
                }
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
                const canonical = await findCanonicalTitle(requestedPage, wikiConfig);
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
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            try {
                const cleanTitle = title.includes(" § ") ? title.split(" § ")[0] : title.split("#")[0];
                const imageRes = await fetch(`${wikiConfig.apiEndpoint}?action=query&titles=${encodeURIComponent(cleanTitle)}&prop=pageimages&pithumbsize=512&format=json`, {
                    signal: controller.signal
                });

                if (!imageRes.ok) throw new Error(`HTTP error! status: ${imageRes.status}`);

                const imageJson = await imageRes.json();
                const pages = imageJson.query?.pages;
                const first = pages ? Object.values(pages)[0] : null;
                const src = first?.thumbnail?.source || null;
                return getFullSizeImageUrl(src);
            } catch (err) {
                if (err.name === 'AbortError') {
                    console.warn(`Image fetch timed out for ${title}`);
                } else {
                    console.error(`Error fetching page image for ${title}:`, err.message);
                }
                return null;
            } finally {
                clearTimeout(timeout);
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
                    wikiConfig,
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

        if (!sent) {
            try {
                if (botUsedTags) {
                    const replyOptions = { allowedMentions: { repliedUser: false } };
                    for (const rawChunk of botTaggedChunks) {
                        const splitParts = splitMessage(rawChunk);
                        for (const part of splitParts) {
                            if (!sent) {
                                await smartReply({ ...replyOptions, content: part });
                                sent = true;
                            } else {
                                const delay = 1000 + Math.floor(Math.random() * 2000);
                                await new Promise(r => setTimeout(r, delay));
                                if (isInteraction(messageOrInteraction)) {
                                     await messageOrInteraction.followUp({ ...replyOptions, content: part });
                                } else if (messageOrInteraction.channel) {
                                     const sanitizedChunkOptions = { ...replyOptions, content: part };
                                     delete sanitizedChunkOptions.ephemeral;
                                     delete sanitizedChunkOptions.flags;
                                     await messageOrInteraction.channel.send(sanitizedChunkOptions);
                                }
                            }
                        }
                    }
                } else {
                    const replyParts = splitMessage(parsedReply, DISCORD_MAX_LENGTH);
                    if (replyParts.length > 0) {
                        for (const [index, part] of replyParts.entries()) {
                            const fallbackOptions = { content: part, allowedMentions: { repliedUser: false } };
                            if (index === 0) {
                                await smartReply(fallbackOptions);
                                sent = true;
                            } else {
                                if (isInteraction(messageOrInteraction)) {
                                    await messageOrInteraction.followUp(fallbackOptions);
                                } else if (messageOrInteraction.channel) {
                                    const sanitizedFallbackOptions = { ...fallbackOptions };
                                    delete sanitizedFallbackOptions.ephemeral;
                                    delete sanitizedFallbackOptions.flags;
                                    await messageOrInteraction.channel.send(sanitizedFallbackOptions);
                                }
                            }
                        }
                    }
                }
            } catch (fallbackErr) {
                console.error("Standard text reply failed:", fallbackErr);
            }
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
                        const sectionData = await getSectionContent(page.trim(), section.trim(), wikiConfig);
                        if (sectionData) {
                            wikiAbstract = sectionData.content;
                            displayTitle = `${page.trim()} § ${sectionData.displayTitle}`;
                            gallery = sectionData.gallery;
                        }
                    } else {
                        wikiAbstract = await getLeadSection(title, wikiConfig);
                    }

                    if (!wikiAbstract) wikiAbstract = "No content available.";
                    if (wikiAbstract.length > 800) wikiAbstract = wikiAbstract.slice(0, 800) + "...";

                    const cardImageUrl = await fetchPageImage(title);
                    const container = buildPageEmbed(displayTitle, wikiAbstract, cardImageUrl, wikiConfig, gallery);

                    const embedPayload = {
                        components: [container],
                        flags: MessageFlags.IsComponentsV2,
                        allowedMentions: { repliedUser: false }
                    };

                    if (isInteraction(messageOrInteraction)) {
                        await messageOrInteraction.followUp(embedPayload);
                    } else if (messageOrInteraction.channel) {
                        try {
                            const sanitizedEmbedPayload = { ...embedPayload };
                            delete sanitizedEmbedPayload.flags;
                            await messageOrInteraction.channel.send(sanitizedEmbedPayload);
                        } catch (err) {
                            console.warn("Failed to send secondary embed components to channel, falling back to content-only:", err.message);

                            const [baseTitle, frag] = title.split("#");
                            const cleanBase = baseTitle.replace(/ /g, "_");
                            const anchor = frag ? `#${encodeURIComponent(frag.replace(/ /g, "_"))}` : "";
                            const safeUrl = `${wikiConfig.articlePath}${encodeURIComponent(cleanBase)}${anchor}`;

                            await messageOrInteraction.channel.send({
                                content: `[**${displayTitle}**](<${safeUrl}>)\n${wikiAbstract}`
                            });
                        }
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
            await smartReply({ content: MESSAGES.processingError, ephemeral: true }).catch(finalErr => console.error("Error recovery failed:", finalErr));
        } catch (finalErr) {
             console.error("Error recovery failed (outer):", finalErr);
        }
    } finally {
        if (typingInterval) clearInterval(typingInterval);
    }
}

module.exports = { handleAIRequest };
