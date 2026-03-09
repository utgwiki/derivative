const { askGemini, getHistory } = require("../functions/conversation.js");

// Mocking some internal dependencies
jest.mock("../functions/parse_page.js", () => ({
    performSearch: jest.fn(),
    getWikiContent: jest.fn(),
    findCanonicalTitle: jest.fn(),
    knownPagesByWiki: new Map()
}));

jest.mock("../config.js", () => ({
    getSystemInstruction: jest.fn(),
    BOT_NAME: "Bot",
    GEMINI_MODEL: "gemini",
    WIKIS: {},
    CATEGORY_WIKI_MAP: {}
}));

jest.mock("../memory.js", () => ({
    loadMemory: jest.fn(),
    logMessage: jest.fn(),
    logMessagesBatch: jest.fn(),
    memory: {}
}));

describe("Conversation Pruning", () => {
    test("should limit history per channel to 30", async () => {
        const { persistConversationTurns } = require("../functions/conversation.js");
        const channelId = "test-history-channel";

        // We need to call persistConversationTurns 20 times (each call adds 2 turns: user and model)
        // 20 * 2 = 40. Limit is 30.
        for (let i = 0; i < 20; i++) {
            persistConversationTurns(channelId,
                { text: `User ${i}`, username: "User", timestamp: Date.now() },
                { text: `Model ${i}`, username: "Bot", timestamp: Date.now() }
            );
        }

        const history = getHistory(channelId);
        expect(history.length).toBe(30);
    });

    test("should limit total history channels to 500", () => {
        const { persistConversationTurns } = require("../functions/conversation.js");
        for (let i = 0; i < 600; i++) {
            persistConversationTurns(`channel-${i}`,
                { text: "Hi", username: "User", timestamp: Date.now() },
                { text: "Hello", username: "Bot", timestamp: Date.now() }
            );
        }

        // We can't easily check the size of chatHistories directly as it's not exported
        // but we can check if getHistory returns something for the last channels and nothing for first ones
        expect(getHistory("channel-0").length).toBe(0);
        expect(getHistory("channel-599").length).toBe(2);
    });
});
