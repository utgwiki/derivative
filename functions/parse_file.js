const { fetch } = require("./utils.js");
const {
    ContainerBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    FileBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require("discord.js");
const { BOT_NAME } = require("../config.js");

/**
 * Handles the /wiki file command.
 * @param {object} wikiConfig - The wiki configuration object.
 * @param {string} fileName - The name of the file to fetch.
 * @param {object} messageOrInteraction - The Discord message or interaction object.
 */
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

            // Preserve IsComponentsV2 flag for non-interaction messages
            if (sanitizedPayload.flags && (sanitizedPayload.flags & MessageFlags.IsComponentsV2)) {
                sanitizedPayload.flags = MessageFlags.IsComponentsV2;
            } else {
                delete sanitizedPayload.flags;
            }

            if (typeof messageOrInteraction.reply === 'function') {
                return messageOrInteraction.reply(sanitizedPayload);
            } else if (messageOrInteraction.channel && typeof messageOrInteraction.channel.send === 'function') {
                return messageOrInteraction.channel.send(sanitizedPayload);
            }
        }
    };

    // Ensure fileName starts with "File:" (namespace 6)
    let searchTitle = fileName;
    if (!searchTitle.toLowerCase().startsWith("file:")) {
        searchTitle = "File:" + fileName;
    }

    const params = new URLSearchParams({
        action: "query",
        titles: searchTitle,
        prop: "imageinfo",
        iiprop: "url|mime",
        format: "json",
        redirects: 1
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
        const res = await fetch(`${wikiConfig.apiEndpoint}?${params.toString()}`, {
            headers: { "User-Agent": `DiscordBot/${BOT_NAME}` },
            signal: controller.signal
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

        const json = await res.json();
        const pages = json.query?.pages;
        if (!pages) {
            return await smartReply({ content: "File not found.", ephemeral: true });
        }

        const page = Object.values(pages)[0];
        if (page.missing !== undefined) {
            return await smartReply({ content: `File "${fileName}" not found on [${wikiConfig.name}](<${wikiConfig.baseUrl}>).`, ephemeral: true });
        }

        const info = page.imageinfo?.[0];
        if (!info) {
            return await smartReply({ content: "Could not retrieve file information.", ephemeral: true });
        }

        const url = info.url;
        const mime = info.mime || "";
        const title = page.title;

        const container = new ContainerBuilder();

        const isPictureOrVideo = mime.startsWith("image/") || mime.startsWith("video/");

        if (isPictureOrVideo) {
            const mediaGallery = new MediaGalleryBuilder();
            mediaGallery.addItems(new MediaGalleryItemBuilder().setURL(url));
            container.addMediaGalleryComponents(mediaGallery);
        } else {
            // Audio or non-media
            const fileComp = new FileBuilder().setURL(url);
            container.addFileComponents(fileComp);
        }

        // Action Row with Button
        const parts = title.split(':').map(s => encodeURIComponent(s.replace(/ /g, "_")));
        const pageUrl = `${wikiConfig.articlePath}${parts.join(':')}?utm_source=${BOT_NAME.toLowerCase()}`;

        const row = new ActionRowBuilder();
        const btn = new ButtonBuilder()
            .setLabel(title.slice(0, 80))
            .setStyle(ButtonStyle.Link)
            .setURL(pageUrl);

        if (wikiConfig.emoji) {
            try {
                btn.setEmoji(wikiConfig.emoji);
            } catch (err) {
                console.warn("Failed to set emoji on button:", err.message);
            }
        }
        row.addComponents(btn);
        container.addActionRowComponents(row);

        return await smartReply({
            content: "",
            components: [container],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { repliedUser: false }
        });

    } catch (err) {
        if (err.name === 'AbortError') {
            console.error("File request fetch timed out.");
            return await smartReply({ content: "Request timed out while fetching the file information.", ephemeral: true });
        }
        console.error("Error in handleFileRequest:", err);
        return await smartReply({ content: "An error occurred while fetching the file information.", ephemeral: true });
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { handleFileRequest };
