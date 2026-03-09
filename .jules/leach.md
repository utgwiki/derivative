# Leach's Journal

## Critical Learnings

- **Unbounded History Maps**: The `chatHistories` Map in `functions/conversation.js` was growing indefinitely for every channel the bot interacted with. This is a classic leak in Discord bots.
- **Persistent Memory Growth**: The `memory` object in `memory.js` was accumulating messages without any limit. A previous 30-message limit had been removed, leading to potentially massive JSON files and memory usage.
- **Unloaded Persistence**: The `messageMemory.json` was being saved but never loaded back into the `memory` object at startup, which is more of a bug but contributes to inconsistent state.
- **Missing Map Pruning**: Context maps like `botToAuthorMap` need regular pruning to ensure they don't grow indefinitely as the bot processes more interactions.

## Cleanup Strategies

- **Buffer Slicing**: Using `array.slice(-N)` is an efficient way to keep only the last N entries in a history array.
- **Channel Limiting**: For bots that may be in thousands of servers, limiting the total number of cached channels is essential. We implemented a 500-channel limit.
- **Atomic Persistence**: Ensure that memory is both saved (with debouncing) and loaded at the appropriate lifecycle points.
