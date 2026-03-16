const { urlToGenerativePart } = require("./image_handling.js");
const { contributionScoresTool, getContributionScores } = require("./contribscores.js");
const {
    findCanonicalTitle,
    getWikiContent,
    getSectionContent,
    getLeadSection,
    getFullSizeImageUrl,
    getFileUrls,
    searchWikiTool,
    fetchPageTool,
    googleSearchTool,
    checkWikiTitlesTool,
    findMatches,
    performSearch
} = require("./parse_page.js");
const {
    askGemini,
    askGeminiForPages,
    MESSAGES
} = require("./conversation.js");
const { buildPageEmbed } = require("./embed_builder.js");
const { fetch, smartReply: sharedSmartReply } = require("./utils.js");
const { BOT_NAME, WIKIS, BOT_SETTINGS } = require("../config.js");
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

        let allWikiContent = "";
        const selectedTitlesByWiki = new Map();

        // 1. Page Selection turn (concurrently for all wikis)
        const wikiKeys = Object.keys(WIKIS);
        const selectionPromises = wikiKeys.map(async (key) => {
            const titles = await askGeminiForPages(rawUserMsgSafe, WIKIS[key]);
            if (titles.length > 0) {
                selectedTitlesByWiki.set(key, titles);
            }
        });
        await Promise.all(selectionPromises);

        // 2. Fetch content for selected pages
        for (const [wikiKey, titles] of selectedTitlesByWiki.entries()) {
            const wikiConfig = WIKIS[wikiKey];
            for (const title of titles) {
                try {
                    const content = await getWikiContent(title, wikiConfig);
                    if (content) {
                        allWikiContent += `\n\n[WIKI: ${wikiConfig.name}] [PAGE: ${title}]\n${content.slice(0, 5000)}\n`;
                    }
                } catch (err) {
                    console.error(`Failed to fetch pre-loaded content for ${title} on ${wikiKey}:`, err.message);
                }
            }
        }

        const tools = {
            functionDeclarations: [contributionScoresTool, googleSearchTool, checkWikiTitlesTool],
            functions: {
                "checkWikiTitles": async ({ text }) => {
                    const toolMatches = findMatches(text);
                    return { results: toolMatches };
                },
                "googleSearch": async ({ query }) => {
                    console.log(`[Tool] googleSearch calling sub-agent Gemini for: ${query}`);

                    if (typeof query !== 'string' || query.trim().length === 0) {
                        console.error(`[Tool] googleSearch invalid query:`, query);
                        return { error: "Invalid search query provided." };
                    }
                    const sanitizedQuery = query.trim();

                    try {
                        const searchResult = await askGemini(
                            `Search the web and provide a brief, factual answer to: ${sanitizedQuery}`,
                            null, // wikiContent
                            null, // pageTitle
                            [],
                            messageOrInteraction,
                            null,
                            true, // isProactive (prevents logging this sub-call to history)
                            { useGoogleSearch: true, useHistory: false }
                        );

                        if (searchResult === MESSAGES.aiServiceError || searchResult === MESSAGES.processingError) {
                            return { error: `Search sub-agent returned an error sentinel: ${searchResult}` };
                        }
                        if (searchResult && searchResult.error) {
                            return { error: `Search sub-agent reported an error: ${searchResult.error}` };
                        }

                        return { result: searchResult };
                    } catch (err) {
                        console.error(`[Tool] googleSearch sub-agent failed:`, err);
                        return { error: `Search failed: ${err.message}` };
                    }
                },
                "getContributionScores": async () => {
                    const result = await getContributionScores(wikiConfigSafe);
                    if (result.error) return { error: result.error };
                    return { result: result.result };
                }
            }
        };

        let reply = "";
        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount < maxRetries) {
            let shouldRetry = false;
            try {
                if (!skipGemini) {
                    reply = await askGemini(
                        promptMsg,
                        allWikiContent,
                        null, // pageTitle
                        imageParts,
                        messageOrInteraction,
                        tools,
                        isProactive,
                        {
                            useGoogleSearch: true,
                            allowContributionScoresFirst: false
                        }
                    );
                } else {
                    reply = explicitTemplateContent || "I don't know.";
                    break;
                }

                if (!reply || !reply.trim() || reply === MESSAGES.aiServiceError || reply === MESSAGES.processingError) {
                    const reason = !reply ? "empty" : (!reply.trim() ? "blank" : "error sentinel");
                    console.warn(`Invalid AI response (${reason}) on attempt ${retryCount + 1}.`);
                    shouldRetry = true;
                } else {
                    break;
                }
            } catch (err) {
                console.error(`Gemini attempt ${retryCount + 1} failed:`, err);

                const status = err.status || (err.response && err.response.status);
                const isTransient = (status === 429 || status >= 500) ||
                                    (err.name === 'AbortError') ||
                                    (err.message && (err.message.includes("RESOURCE_EXHAUSTED") || err.message.includes("429") || err.message.includes("503")));

                if (isTransient) {
                    shouldRetry = true;
                } else {
                    console.error("Permanent AI error encountered, stopping retries.");
                    reply = MESSAGES.processingError;
                    break;
                }
            }

            if (shouldRetry) {
                retryCount++;
                if (retryCount < maxRetries) {
                    const baseDelay = 1000;
                    const backoff = baseDelay * Math.pow(2, retryCount - 1);
                    const jitter = Math.random() * 500;
                    const totalDelay = backoff + jitter;

                    console.log(`Retrying AI generation... (${retryCount}/${maxRetries}) in ${Math.round(totalDelay)}ms`);
                    await new Promise(r => setTimeout(r, totalDelay));
                    continue;
                }
            } else {
                break;
            }
        }

        if (!reply || reply === MESSAGES.processingError || reply === MESSAGES.aiServiceError) {
            console.warn("AI generation failed after retries.");
            reply = "I'm sorry, I'm having trouble coming up with a response right now. Could you try asking again?";
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
                let baseTitle = requestedPage;
                let section = null;

                if (requestedPage.includes("#")) {
                    const idx = requestedPage.indexOf("#");
                    baseTitle = requestedPage.slice(0, idx).trim();
                    section = requestedPage.slice(idx + 1).trim();
                }

                const canonicalBase = await findCanonicalTitle(baseTitle, wikiConfigSafe);
                if (canonicalBase) {
                    const finalCanonical = section ? `${canonicalBase}#${section}` : canonicalBase;
                    pageEmbedTitlesMap.set(requestedPage.toLowerCase(), finalCanonical);
                }
            }
        }

        const fileEmbedRegex = /\[FILE_EMBED:\s*(.*?)\]/gi;
        const fileEmbedMatches = [...parsedReply.matchAll(fileEmbedRegex)];
        let embeddedFileInfos = [];

        if (fileEmbedMatches.length > 0) {
            let allTitles = [];
            for (const m of fileEmbedMatches) {
                const rawValue = m[1].trim();
                const titles = rawValue.split(",")
                    .map(f => f.trim())
                    .filter(f => f.length > 0)
                    .map(f => {
                        let t = f.replace(/_/g, " ");
                        if (t.toLowerCase().startsWith("file:")) {
                            t = "File:" + t.slice(5).trim();
                        } else {
                            t = "File:" + t;
                        }
                        return t;
                    })
                    .filter(t => t !== "File:");
                allTitles.push(...titles);
            }
            const uniqueTitles = [...new Set(allTitles)];

            if (uniqueTitles.length > 0) {
                try {
                    embeddedFileInfos = await getFileUrls(uniqueTitles, wikiConfigSafe);
                } catch (err) {
                    console.error(`Error resolving file URLs for ${uniqueTitles.join(", ")}:`, err);
                    embeddedFileInfos = [];
                }
            }
        }

        if (isEphemeral) {
            parsedReply = parsedReply
                .replace(/\[START_MESSAGE\]/g, "")
                .replace(/\[END_MESSAGE\]/g, "\n")
                .replace(/\[PAGE_EMBED:[^\]]*\]/g, "")
                .replace(/\[FILE_EMBED:[^\]]*\]/g, "")
                .trim();
            if (!parsedReply) parsedReply = "[Embeds hidden in ephemeral view]";
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
                    await messageOrInteraction.channel.send(sanitized);
                }
            }
        };

        const executeSequentialOutput = async (fullText) => {
            const pageEmbedRegex = /\[PAGE_EMBED:\s*(.*?)\]/gi;
            let lastIndex = 0;
            let match;

            const sendText = async (text) => {
                const cleanedText = text
                    .replace(/\[FILE_EMBED:[^\]]*\]/gi, "")
                    .replace(/\r\n/g, '\n')
                    .replace(/[^\S\r\n]+/g, ' ')
                    .trim();

                if (!cleanedText) return;

                const chunks = splitMessage(cleanedText);
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

            while ((match = pageEmbedRegex.exec(fullText)) !== null) {
                const precedingText = fullText.slice(lastIndex, match.index).trim();
                if (precedingText) {
                    await sendText(precedingText);
                }

                const value = match[1].trim();
                const canonical = pageEmbedTitlesMap.get(value.toLowerCase());
                if (canonical && !sentEmbedTitles.has(canonical)) {
                    sentEmbedTitles.add(canonical);
                    let wikiAbstract = null;
                    let gallery = null;
                    let displayTitle = canonical;
                    let imageSearchTitle = canonical;

                    if (canonical.includes("#")) {
                        const idx = canonical.indexOf("#");
                        const page = canonical.slice(0, idx).trim();
                        const section = canonical.slice(idx + 1).trim();
                        imageSearchTitle = page;
                        const sectionData = await getSectionContent(page, section, wikiConfigSafe);
                        if (sectionData) {
                            wikiAbstract = sectionData.content;
                            displayTitle = `${page} § ${sectionData.displayTitle}`;
                            gallery = sectionData.gallery;
                        }
                    } else {
                        wikiAbstract = await getLeadSection(canonical, wikiConfigSafe);
                    }

                    if (!wikiAbstract) wikiAbstract = "No content available.";

                    const graphemes = [...wikiAbstract];
                    if (graphemes.length > 800) {
                        wikiAbstract = graphemes.slice(0, 800).join('') + "...";
                    }

                    const cardImageUrl = await fetchPageImage(imageSearchTitle);
                    const container = buildPageEmbed(displayTitle, wikiAbstract, cardImageUrl, wikiConfigSafe, gallery);
                    await sendChunk({ components: [container], flags: MessageFlags.IsComponentsV2 });
                }
                lastIndex = pageEmbedRegex.lastIndex;
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

        const filteredFiles = embeddedFileInfos.filter(f => typeof f.url === 'string' && f.url.startsWith('http'));
        if (filteredFiles.length > 0) {
            const maxAttachments = (typeof BOT_SETTINGS.MAX_ATTACHMENTS === 'number') ? BOT_SETTINGS.MAX_ATTACHMENTS : 10;
            const finalFiles = filteredFiles.slice(0, maxAttachments);

            if (finalFiles.length > 1) {
                const gallery = finalFiles.map(f => ({ url: f.url, caption: f.title }));
                const container = buildPageEmbed(null, null, null, wikiConfigSafe, gallery);
                await sendChunk({ components: [container], flags: MessageFlags.IsComponentsV2 });
            } else if (finalFiles.length === 1) {
                await sendChunk({ content: finalFiles[0].url });
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
