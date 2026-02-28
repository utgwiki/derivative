const { fetch } = require("./utils.js");
const { MessageFlags } = require("discord.js");

async function handleFileRequest(wikiConfig, fileName, messageOrInteraction) {
    const isInteraction = (interaction) => interaction && (interaction.editReply || interaction.followUp);

    const smartReply = async (payload) => {
        if (isInteraction(messageOrInteraction)) {
            if (messageOrInteraction.replied) return messageOrInteraction.followUp(payload);
            if (messageOrInteraction.deferred) return messageOrInteraction.editReply(payload);
            return messageOrInteraction.reply(payload);
        } else {
            const sanitizedPayload = { ...payload };
            delete sanitizedPayload.ephemeral;
            delete sanitizedPayload.flags;
            // components might work for messages but V2 components are specifically for interactions in some contexts
            // however, standard components work for both. If these are V2-only, we might need to remove them.
            // For now, removing ephemeral and flags is the most critical.
            return messageOrInteraction.reply(sanitizedPayload);
        }
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
        const params = new URLSearchParams({
            action: "query",
            format: "json",
            titles: `File:${fileName}`,
            prop: "imageinfo",
            iiprop: "url|mime"
        });

        const res = await fetch(`${wikiConfig.apiEndpoint}?${params.toString()}`, {
            signal: controller.signal
        });

        if (!res.ok) {
            throw new Error(`Wiki API returned ${res.status}: ${res.statusText}`);
        }

        const json = await res.json();
        const pages = json.query?.pages;
        const page = pages ? Object.values(pages)[0] : null;
        const imageInfo = page?.imageinfo?.[0];

        if (imageInfo) {
            return await smartReply({
                content: imageInfo.url,
                allowedMentions: { repliedUser: false }
            });
        } else {
            return await smartReply({
                content: `File "${fileName}" not found on [${wikiConfig.name} Wiki](<${wikiConfig.baseUrl}>).`,
                ephemeral: true
            });
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            console.error("File request fetch timed out.");
            return await smartReply({ content: "Request timed out while fetching the file.", ephemeral: true });
        }
        console.error("Error in handleFileRequest:", err);
        return await smartReply({ content: "An error occurred while fetching the file.", ephemeral: true });
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { handleFileRequest };
