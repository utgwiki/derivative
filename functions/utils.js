let fetchInstance;
/**
 * Lazy-loading node-fetch wrapper.
 * Requires Node.js >= 17.3.0 for AbortSignal.timeout support in callers.
 */
const fetch = async (...args) => {
    if (!fetchInstance) {
        const module = await import("node-fetch");
        fetchInstance = module.default;
    }
    return fetchInstance(...args);
};

function resolveWikiKey(baseUrl, wikis) {
    return Object.keys(wikis).find(k => wikis[k].baseUrl === baseUrl) || "tagging";
}

function escapeMarkdown(text) {
    if (!text) return "";
    return text.replace(/([\\`*_{}[\]()#+-.!|])/g, "\\$1");
}

/**
 * Sends a reply or message based on whether it's an interaction or a regular message.
 * @param {object} messageOrInteraction - The original message or interaction.
 * @param {object} payload - The message payload to send.
 * @param {object} MessageFlags - The Discord.js MessageFlags object.
 * @param {object} [botMessageToEdit] - Optional bot message to edit instead of sending a new one.
 * @returns {Promise<Message>}
 */
async function smartReply(messageOrInteraction, payload, MessageFlags, botMessageToEdit = null) {
    const isInteraction = (interaction) => interaction && (interaction.editReply || interaction.followUp);

    if (botMessageToEdit) {
        try {
            return await botMessageToEdit.edit(payload);
        } catch (err) {
            console.warn("Failed to edit message, sending new one instead:", err.message);
        }
    }

    if (isInteraction(messageOrInteraction)) {
        if (messageOrInteraction.deferred) {
            return messageOrInteraction.editReply(payload);
        }
        if (messageOrInteraction.replied) {
            return messageOrInteraction.followUp(payload);
        }
        return messageOrInteraction.reply(payload);
    } else {
        const sanitizedPayload = { ...payload };
        delete sanitizedPayload.ephemeral;

        // Preserve IsComponentsV2 flag for non-interaction messages
        if (MessageFlags && sanitizedPayload.flags) {
            sanitizedPayload.flags &= MessageFlags.IsComponentsV2;
            if (sanitizedPayload.flags === 0) delete sanitizedPayload.flags;
        } else {
            delete sanitizedPayload.flags;
        }

        if (typeof messageOrInteraction.reply === 'function') {
            return messageOrInteraction.reply(sanitizedPayload);
        } else if (messageOrInteraction.channel && typeof messageOrInteraction.channel.send === 'function') {
            return messageOrInteraction.channel.send(sanitizedPayload);
        }
        throw new Error("smartReply could not send message: unsupported messageOrInteraction shape.");
    }
}

module.exports = { fetch, resolveWikiKey, escapeMarkdown, smartReply };
