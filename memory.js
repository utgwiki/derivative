const fs = require("fs");
const path = "./messageMemory.json";

// Initialize as a const object so the reference never changes
const memory = {};

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

// Save memory back to file
function saveMemory() {
    fs.writeFileSync(path, JSON.stringify(memory, null, 2));
}

// Add a logged message (while keeping only last 30)
function logMessage(channelId, memberName, message) {
    if (!memory[channelId]) memory[channelId] = [];

    memory[channelId].push({
        memberName,
        message
    });

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
    memory
};
