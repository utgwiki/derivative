const { urlToGenerativePart } = require("./image_handling.js");
const { contributionScoresTool, getContributionScores } = require("./contribscores.js");
const {
    findCanonicalTitle,
    getWikiContent,
    getSectionContent,
    getLeadSection,
    getFullSizeImageUrl,
    getFileUrls
} = require("./parse_page.js");
const {
    askGemini,
    askGeminiForPages,
    MESSAGES
} = require("./conversation.js");
const { buildPageEmbed } = require("./interactions.js");
const { fetch, smartReply: sharedSmartReply } = require("./utils.js");
const { BOT_NAME, WIKIS } = require("../config.js");
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
    const wikiConfigSafe = Object.assign({ baseUrl: '', apiEndpoint: '', articlePath: '' }, wikiConfig || {});
    if (!wikiConfigSafe.apiEndpoint && wikiConfigSafe.baseUrl) {
        const key = Object.keys(WIKIS).find(k => WIKIS[k].baseUrl === wikiConfigSafe.baseUrl);
        if (key) {
            wikiConfigSafe.apiEndpoint = WIKIS[key].apiEndpoint;
            if (!wikiConfigSafe.articlePath) wikiConfigSafe.articlePath = WIKIS[key].articlePath;
        }
    }

    if (!promptMsg || !promptMsg.trim()) return MESSAGES.noAIResponse;

    const isInteraction = interaction => interaction && (interaction.editReply || interaction.followUp);

    const smartReply = (payload) => sharedSmartReply(messageOrInteraction, payload, MessageFlags);

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

            const canonical = await findCanonicalTitle(rawTemplate, wikiConfigSafe);

            if (canonical) {
                shouldUseComponentsV2 = true;
                skipGemini = true;

                if (sectionName) {
                    const sectionData = await getSectionContent(canonical, sectionName, wikiConfigSafe);
                    if (sectionData) {
                        explicitTemplateContent = sectionData.content;
                        explicitTemplateFoundTitle = `${canonical} § ${sectionData.displayTitle}`;
                        explicitTemplateGallery = sectionData.gallery;
                    } else {
                        explicitTemplateContent = "No content available.";
                        explicitTemplateFoundTitle = `${canonical}#${sectionName}`;
                    }
                } else {
                    explicitTemplateContent = await getLeadSection(canonical, wikiConfigSafe);
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
            pageTitles = await askGeminiForPages(rawUserMsgSafe, wikiConfigSafe);
            if (pageTitles.length) {
                for (const pageTitle of pageTitles) {
                    const content = await getWikiContent(pageTitle, wikiConfigSafe);
                    if (content) wikiContent += `\n\n--- Page: ${pageTitle} ---\n${content}`;
                }
            }
        }

        const tools = {
            functionDeclarations: [contributionScoresTool],
            functions: {
                "getContributionScores": async () => {
                    const result = await getContributionScores(wikiConfigSafe);
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
        const pageEmbedTitlesMap = new Map();

        if (embedMatches.length > 0) {
            for (const m of embedMatches) {
                const requestedPage = m[1].trim();
                const canonical = await findCanonicalTitle(requestedPage, wikiConfigSafe);
                if (canonical) {
                    pageEmbedTitlesMap.set(requestedPage.toLowerCase(), canonical);
                }
            }
        }

        const fileEmbedRegex = /\[FILE_EMBED:\s*(.*?)\]/gi;
        const fileEmbedMatches = [...parsedReply.matchAll(fileEmbedRegex)];
        let embeddedFileInfos = [];

        if (fileEmbedMatches.length > 0) {
            let fileTitles = [];
            for (const m of fileEmbedMatches) {
                const requestedFiles = m[1].split(",").map(f => f.trim());
                fileTitles.push(...requestedFiles);
            }
            fileTitles = [...new Set(fileTitles)];

            if (fileTitles.length > 0) {
                embeddedFileInfos = await getFileUrls(fileTitles, wikiConfigSafe);
            }
        }

        if (isEphemeral) {
            parsedReply = parsedReply
                .replace(/\[START_MESSAGE\]/g, "")
                .replace(/\[END_MESSAGE\]/g, "\n")
                .replace(/\[PAGE_EMBED:[^\]]*\]/g, "")
                .replace(/\[FILE_EMBED:[^\]]*\]/g, "")
                .trim();
        }

        let botTaggedChunks = [];
        let botUsedTags = false;

        if (!isEphemeral) {
            botTaggedChunks = extractTaggedBotChunks(parsedReply);
            botUsedTags = botTaggedChunks.length > 0;
        }

        const fetchPageImage = async (title) => {
            if (!title || !wikiConfigSafe.apiEndpoint) return null;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            try {
                const cleanTitle = title.includes(" § ") ? title.split(" § ")[0] : title.split("#")[0];
                const imageRes = await fetch(`${wikiConfigSafe.apiEndpoint}?action=query&titles=${encodeURIComponent(cleanTitle)}&prop=pageimages&pithumbsize=512&format=json`, {
                    signal: controller.signal,
                    headers: { "User-Agent": `DiscordBot/${BOT_NAME}` }
                });
                if (!imageRes.ok) throw new Error(`HTTP error! status: ${imageRes.status}`);
                const imageJson = await imageRes.json();
                const pages = imageJson.query?.pages;
                const first = pages ? Object.values(pages)[0] : null;
                const src = first?.thumbnail?.source || null;
                return getFullSizeImageUrl(src);
            } catch (err) {
                if (err.name !== 'AbortError') console.error(`Error fetching page image for ${title}:`, err.message);
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
        let v2Used = false;
        const sentEmbedTitles = new Set();

        const sendChunk = async (payload) => {
            const replyOptions = { ...payload, allowedMentions: { repliedUser: false } };
            if (isEphemeral) replyOptions.ephemeral = true;

            if (!sent) {
                await smartReply(replyOptions);
                sent = true;
            } else {
                await new Promise(r => setTimeout(r, 1000));
                if (isInteraction(messageOrInteraction)) {
                    await messageOrInteraction.followUp(replyOptions);
                } else if (messageOrInteraction.channel) {
                    const sanitized = { ...replyOptions };
                    delete sanitized.ephemeral;
                    delete sanitized.flags;
                    await messageOrInteraction.channel.send(sanitized);
                }
            }
        };

        const executeSequentialOutput = async (fullText) => {
            const combinedEmbedRegex = /\[(PAGE_EMBED|FILE_EMBED):\s*([^\]]*)\]/gi;
            let lastIndex = 0;
            let match;

            const sendText = async (text) => {
                const chunks = splitMessage(text);
                for (const chunk of chunks) {
                    if (shouldUseComponentsV2 && !v2Used) {
                        const container = buildPageEmbed(
                            explicitTemplateFoundTitle,
                            chunk,
                            primaryImageUrl,
                            wikiConfigSafe,
                            explicitTemplateGallery
                        );
                        await sendChunk({ components: [container], flags: MessageFlags.IsComponentsV2 });
                        v2Used = true;
                    } else {
                        await sendChunk({ content: chunk });
                    }
                }
            };

            while ((match = combinedEmbedRegex.exec(fullText)) !== null) {
                const precedingText = fullText.slice(lastIndex, match.index).trim();
                if (precedingText) {
                    await sendText(precedingText);
                }

                const type = match[1].toUpperCase();
                const value = match[2].trim();

                if (type === 'PAGE_EMBED') {
                    const canonical = pageEmbedTitlesMap.get(value.toLowerCase());
                    if (canonical && !sentEmbedTitles.has(canonical)) {
                        sentEmbedTitles.add(canonical);
                        let wikiAbstract = null;
                        let gallery = null;
                        let displayTitle = canonical;
                        let imageSearchTitle = canonical;

                        if (canonical.includes("#")) {
                            const [page, section] = canonical.split("#");
                            imageSearchTitle = page.trim();
                            const sectionData = await getSectionContent(page.trim(), section.trim(), wikiConfigSafe);
                            if (sectionData) {
                                wikiAbstract = sectionData.content;
                                displayTitle = `${page.trim()} § ${sectionData.displayTitle}`;
                                gallery = sectionData.gallery;
                            }
                        } else {
                            wikiAbstract = await getLeadSection(canonical, wikiConfigSafe);
                        }

                        if (!wikiAbstract) wikiAbstract = "No content available.";
                        if (wikiAbstract.length > 800) wikiAbstract = wikiAbstract.slice(0, 800) + "...";

                        const cardImageUrl = await fetchPageImage(imageSearchTitle);
                        const container = buildPageEmbed(displayTitle, wikiAbstract, cardImageUrl, wikiConfigSafe, gallery);
                        await sendChunk({ components: [container], flags: MessageFlags.IsComponentsV2 });
                    }
                } else if (type === 'FILE_EMBED') {
                    const currentFileTitles = value.split(",").map(f => f.trim());
                    const matches = embeddedFileInfos.filter(f => {
                        return currentFileTitles.some(t => {
                            const tLower = t.toLowerCase();
                            const fTitleLower = f.title.toLowerCase();
                            return fTitleLower === tLower ||
                                   fTitleLower === 'file:' + tLower ||
                                   (tLower.startsWith('file:') && fTitleLower === tLower);
                        });
                    });

                    if (matches.length > 1) {
                        const container = buildPageEmbed(null, null, null, wikiConfigSafe, matches.map(m => ({ url: m.url, caption: m.title })));
                        await sendChunk({ components: [container], flags: MessageFlags.IsComponentsV2 });
                    } else if (matches.length === 1) {
                        await sendChunk({ content: matches[0].url });
                    }
                }
                lastIndex = combinedEmbedRegex.lastIndex;
            }

            const remainingText = fullText.slice(lastIndex).trim();
            if (remainingText) {
                await sendText(remainingText);
            }
        };

        if (botUsedTags) {
            for (const chunk of botTaggedChunks) {
                await executeSequentialOutput(chunk);
            }
        } else {
            await executeSequentialOutput(parsedReply);
        }

        if (shouldUseComponentsV2 && !v2Used) {
            const container = buildPageEmbed(explicitTemplateFoundTitle, " ", primaryImageUrl, wikiConfigSafe, explicitTemplateGallery);
            await sendChunk({ components: [container], flags: MessageFlags.IsComponentsV2 });
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
