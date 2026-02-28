const { fetch } = require("./utils.js");
const { MessageFlags } = require("discord.js");

async function handleFileRequest(wikiConfig, fileName, messageOrInteraction) {
    const isInteraction = (interaction) => interaction && (interaction.editReply || interaction.followUp);

    const smartReply = async (payload) => {
        if (isInteraction(messageOrInteraction)) {
            if (messageOrInteraction.replied) return messageOrInteraction.followUp(payload);
            if (messageOrInteraction.deferred) return messageOrInteraction.editReply(payload);
            return messageOrInteraction.reply(payload);
        }
        return messageOrInteraction.reply(payload);
    };

    try {
        const params = new URLSearchParams({
            action: "query",
            format: "json",
            titles: `File:${fileName}`,
            prop: "imageinfo",
            iiprop: "url|mime"
        });

        const res = await fetch(`${wikiConfig.apiEndpoint}?${params.toString()}`);
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
        console.error("Error in handleFileRequest:", err);
        return await smartReply({ content: "An error occurred while fetching the file.", ephemeral: true });
    }
}

module.exports = { handleFileRequest };
