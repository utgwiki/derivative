const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { WIKI_ENDPOINTS } = require("../config.js");

async function getContributionScores() {
    try {
        // We use text={{...}} to trigger the special page parse
        const params = new URLSearchParams({
            action: "parse",
            format: "json",
            text: "{{Special:ContributionScores/10/all}}", 
            prop: "text",
            disablelimitreport: "true"
        });

        const url = `${WIKI_ENDPOINTS.API}?${params.toString()}`;
        
        const res = await fetch(url, {
            headers: { "User-Agent": "DiscordBot/Deriv" }
        });

        if (!res.ok) throw new Error(`API Error: ${res.status}`);
        
        const json = await res.json();
        const html = json.parse?.text?.["*"];

        if (!html) return "Error: Could not retrieve contribution scores.";

        // --- HTML PARSING ---
        // 1. Split by table rows
        const rows = html.split('<tr class="">');
        rows.shift(); // Remove table header garbage

        let dataString = "--- DATA: TOP 10 WIKI CONTRIBUTORS ---\n";

        rows.forEach((row, index) => {
            const cleanRow = row.replace(/\n/g, "");
            
            // Extract Username
            const userMatch = cleanRow.match(/class="mw-userlink"[^>]*><bdi>(.*?)<\/bdi>/);
            const username = userMatch ? userMatch[1] : "Unknown";

            // Extract Numbers (Rank, Score, Pages, Changes)
            // The API returns cells like: <td>1</td> <td>6,005</td> ...
            const statMatches = [...cleanRow.matchAll(/>([\d,]+)\s*<\/td>/g)];
            
            if (statMatches.length >= 4) {
                const score = statMatches[1][1];   // Col 2
                const pages = statMatches[2][1];   // Col 3
                const changes = statMatches[3][1]; // Col 4
                
                // Format nicely for Gemini to read
                dataString += `#${index + 1} ${username}: Score ${score} | Pages Created ${pages} | Edits ${changes}\n`;
            }
        });

        return dataString;

    } catch (err) {
        console.error("Error fetching contrib scores:", err);
        return "System Error: Unable to fetch contribution scores.";
    }
}

module.exports = { getContributionScores };
