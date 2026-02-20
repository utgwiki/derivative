const fs = require("fs");
const path = "./messageMemory.json";

// Initialize as a const object so the reference never changes
const memory = {};
let saveTimeout = null;
const CHANNEL_LIMIT = 100;

// Load existing memory
function loadMemory() {
    if (fs.existsSync(path)) {
        const rawData = fs.readFileSync(path, "utf8");
        try {
            const parsedData = JSON.parse(rawData);
            
            // Clear current keys (optional, but good practice)
            for (const key in memory) delete memory[key];
            
            // Merge loaded data into the existing 'memory' constant
            Object.assign(memory, parsedData);
        } catch (e) {
            console.error("Error parsing memory file:", e);
        }
    } else {
        fs.writeFileSync(path, JSON.stringify({}, null, 2));
    }
}

// Save memory back to file with debouncing
async function saveMemory() {
    if (saveTimeout) clearTimeout(saveTimeout);

    saveTimeout = setTimeout(async () => {
        try {
            await fs.promises.writeFile(path, JSON.stringify(memory, null, 2));
            saveTimeout = null;
        } catch (err) {
            console.error("Error saving memory file:", err);
        }
    }, 5000); // 5 second debounce
}

// Add a logged message (while keeping only last 30)
// Updated to include timestamp
function logMessage(channelId, memberName, message, timestamp = Date.now()) {
    logMessagesBatch(channelId, [{ memberName, message, timestamp }]);
}

function logMessagesBatch(channelId, messages) {
    if (!messages || messages.length === 0) return;

    if (!memory[channelId]) {
        // Enforce channel limit
        const channelIds = Object.keys(memory);
        if (channelIds.length >= CHANNEL_LIMIT) {
            // Find oldest channel by last message timestamp
            let oldestChannelId = null;
            let oldestTimestamp = Infinity;

            for (const id of channelIds) {
                const history = memory[id];
                const lastMsg = history[history.length - 1];
                if (lastMsg && lastMsg.timestamp < oldestTimestamp) {
                    oldestTimestamp = lastMsg.timestamp;
                    oldestChannelId = id;
                }
            }

            if (oldestChannelId) {
                delete memory[oldestChannelId];
            } else {
                // Fallback to removing the first key if no timestamps are found
                delete memory[channelIds[0]];
            }
        }
        memory[channelId] = [];
    }

    for (const msg of messages) {
        memory[channelId].push({
            memberName: msg.memberName,
            message: msg.message,
            timestamp: msg.timestamp || Date.now()
        });
    }

    // keep only last 30
    if (memory[channelId].length > 30) {
        memory[channelId] = memory[channelId].slice(-30);
    }

    saveMemory();
}

module.exports = {
    loadMemory,
    saveMemory,
    logMessage,
    logMessagesBatch,
    memory
};
