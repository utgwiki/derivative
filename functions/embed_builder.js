const {
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder
} = require("discord.js");
const { BOT_NAME } = require("../config.js");

function buildPageEmbed(title, content, imageUrl, wikiConfig, gallery = null) {
    const container = new ContainerBuilder();

    const hasContent = content && content !== "No content available.";
    const hasGallery = gallery && gallery.length > 0;

    const isOnlyGalleryHeader = hasContent && content.trim() === "## Gallery";
    const shouldShowTextSection = hasContent && !(isOnlyGalleryHeader && hasGallery);

    const showEmbed = shouldShowTextSection || hasGallery;

    if (showEmbed) {
        const mainSection = new SectionBuilder();

        if (shouldShowTextSection) {
            mainSection.addTextDisplayComponents([new TextDisplayBuilder().setContent(content)]);
            const fallbackImage = "https://upload.wikimedia.org/wikipedia/commons/8/89/HD_transparent_picture.png";
            const finalImageUrl = (!hasGallery && typeof imageUrl === "string" && imageUrl.trim() !== "") ? imageUrl : fallbackImage;

            try {
                mainSection.setThumbnailAccessory(thumbnail => thumbnail.setURL(finalImageUrl));
            } catch (err) {
                console.warn("Failed to set thumbnail accessory:", err.message);
            }

            container.addSectionComponents(mainSection);
        }

        if (hasGallery) {
            const mediaGallery = new MediaGalleryBuilder();
            for (const item of gallery.slice(0, 10)) {
                const galleryItem = new MediaGalleryItemBuilder().setURL(item.url);
                if (item.caption) {
                    galleryItem.setDescription(item.caption.slice(0, 1000));
                }
                mediaGallery.addItems(galleryItem);
            }
            container.addMediaGalleryComponents(mediaGallery);
        }
    }

    if (title) {
        try {
            let pageUrl;
            if (title === "Special:ContributionScores") {
                pageUrl = `${wikiConfig.articlePath}Special:ContributionScores?utm_source=${BOT_NAME.toLowerCase()}`;
            } else {
                const isSectionLink = String(title).includes(" § ");
                const titleStr = String(title);
                let pageOnly, frag;
                if (isSectionLink) {
                    const idx = titleStr.indexOf(" § ");
                    pageOnly = idx !== -1 ? titleStr.slice(0, idx) : titleStr;
                    frag = idx !== -1 ? titleStr.slice(idx + 3) : undefined;
                } else {
                    const idx = titleStr.indexOf("#");
                    pageOnly = idx !== -1 ? titleStr.slice(0, idx) : titleStr;
                    frag = idx !== -1 ? titleStr.slice(idx + 1) : undefined;
                }
                const parts = pageOnly.split(':').map(s => encodeURIComponent(s.replace(/ /g, "_")));
                const anchor = frag ? '#' + encodeURIComponent(frag.replace(/ /g, '_')) : '';
                pageUrl = `${wikiConfig.articlePath}${parts.join(':')}?utm_source=${BOT_NAME.toLowerCase()}${anchor}`;
            }

            const row = new ActionRowBuilder();
            const btn = new ButtonBuilder()
                .setLabel(String(title).slice(0, 80))
                .setStyle(ButtonStyle.Link)
                .setURL(pageUrl);

            if (wikiConfig.emoji) {
                btn.setEmoji(wikiConfig.emoji);
            }

            if (btn) row.addComponents(btn);
            if (row.components.length > 0) container.addActionRowComponents(row);
        } catch (err) {
            console.warn("Failed to build link button:", err.message);
        }
    }

    return container;
}

module.exports = { buildPageEmbed };
