const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { WIKI_ENDPOINTS } = require("../config.js");

async function getContributionScores() {
    try {
        const params = new URLSearchParams({
            action: "parse",
            format: "json",
            text: "{{Special:ContributionScores/10/all}}", 
            prop: "text",
            disablelimitreport: "true"
        });

        const url = `${WIKI_ENDPOINTS.API}?${params.toString()}`;
        const res = await fetch(url, { headers: { "User-Agent": "DiscordBot/Deriv" } });
        const json = await res.json();
        const html = json.parse?.text?.["*"];

        if (!html) return "No contribution data available.";

        // Basic Regex to pull the username and score from the HTML table
        const rows = html.split('<tr class="">');
        rows.shift(); // Remove header

        let dataSummary = "TOP 10 CONTRIBUTORS DATA:\n";
        rows.forEach((row, i) => {
            const user = row.match(/<bdi>(.*?)<\/bdi>/)?.[1] || "Unknown";
            const stats = [...row.matchAll(/>([\d,]+)\s*<\/td>/g)];
            if (stats.length >= 4) {
                dataSummary += `${i+1}. ${user}: Score ${stats[1][1]}, Edits ${stats[3][1]}\n`;
            }
        });

        return dataSummary;
    } catch (err) {
        return "Error fetching leaderboard.";
    }
}

module.exports = { getContributionScores };
