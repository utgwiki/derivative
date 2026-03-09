const { logMessagesBatch, memory, loadMemory } = require("../memory.js");
const fs = require("fs");

// Mock fs for testing
jest.mock("fs", () => ({
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    promises: {
        writeFile: jest.fn()
    }
}));

describe("Memory Pruning", () => {
    beforeEach(() => {
        // Clear memory
        for (const key in memory) delete memory[key];
        jest.clearAllMocks();
    });

    test("should limit messages per channel to 30", () => {
        const channelId = "test-channel";
        const messages = [];
        for (let i = 0; i < 50; i++) {
            messages.push({ memberName: "User", message: `Message ${i}`, timestamp: Date.now() });
        }

        logMessagesBatch(channelId, messages);

        expect(memory[channelId].length).toBe(30);
        expect(memory[channelId][0].message).toBe("Message 20");
        expect(memory[channelId][29].message).toBe("Message 49");
    });

    test("should limit total channels to 500", () => {
        for (let i = 0; i < 600; i++) {
            logMessagesBatch(`channel-${i}`, [{ memberName: "User", message: "Hi", timestamp: Date.now() }]);
        }

        const channelIds = Object.keys(memory);
        expect(channelIds.length).toBe(500);
        // The first 100 channels should have been pruned (assuming insertion order is preserved in Object.keys)
        expect(memory["channel-0"]).toBeUndefined();
        expect(memory["channel-99"]).toBeUndefined();
        expect(memory["channel-100"]).toBeDefined();
    });
});
