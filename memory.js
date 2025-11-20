const fs = require("fs");
const path = "./messageMemory.json";

let memory = {};

// Load existing memory
function loadMemory() {
    if (fs.existsSync(path)) {
        memory = JSON.parse(fs.readFileSync(path, "utf8"));
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

    // keep only last 10
    if (memory[channelId].length > 30) {
        memory[channelId] = memory[channelId].slice(-10);
    }

    saveMemory();
}

module.exports = {
    loadMemory,
    saveMemory,
    logMessage,
    memory
};
