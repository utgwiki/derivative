const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

async function urlToGenerativePart(url) {
    try {
        const response = await fetch(url);
        const contentType = response.headers.get("Content-Type");
        const urlIsImage = /\.(jpe?g|png|gif|webp)/i.test(url);

        if (!contentType || (!contentType.startsWith("image/") && !urlIsImage)) {
            console.error(`URL is not an image: ${url} (Content-Type: ${contentType})`);
            return null; 
        }

        const buffer = await response.buffer();
        const base64Data = buffer.toString("base64");
        
        const finalMimeType = contentType.startsWith("image/") ? contentType : (
            url.endsWith('.png') ? 'image/png' : 'image/jpeg' 
        );

        return {
            inlineData: {
                data: base64Data,
                mimeType: finalMimeType,
            },
        };
    } catch (error) {
        console.error("Error converting URL to GenerativePart:", error.message);
        return null;
    }
}

module.exports = { urlToGenerativePart };
