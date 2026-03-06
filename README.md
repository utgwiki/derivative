## Hey, i’m Derivative! ꉂ(˵˃ ᗜ ˂˵)
**Derivative** is an AI wiki bot built from scratch, designed specifically for handling and understanding content on the [Untitled Tag Game Wiki](https://tagging.wiki). It fetches information directly from the wiki with up to 98% accuracy, and is able to keep a running memory of the last 30 messages in servers to maintain context in different conversations.

Some things that set Derivative apart include:
* maintaining back-and-forth conversations instead of giving isolated replies
* analyzing, interpreting, and describing images you send
* assisting with a wide range of tasks, from wiki debugging to general problem-solving
* retrieving and summarizing pages, categories, or templates straight from the wiki
* explaining how modules, templates, or formatting work without losing context
* adapting answers based on your conversation history (within its 30-message memory)

Feel free to add the bot into your server [here](https://discord.com/oauth2/authorize?client_id=1381286791751008349) ദ്ദി◝ ⩊ ◜.ᐟ

## Setup

Please note that `server.js` exists on the repository so that Instatus is able to get active status of the bot. It can be removed.

To run Derivative yourself, follow these steps:

1. **Prerequisites**
    - [Node.js](https://nodejs.org/) (v18 or higher recommended)
    - [npm](https://www.npmjs.com/)
    - A Discord Bot Token (from the [Discord Developer Portal](https://discord.com/developers/applications))
    - One or more Google Gemini API Keys (from [Google AI Studio](https://aistudio.google.com/))

2. **Installation**
    - Clone the repository and install the dependencies:
        ```bash
        git clone https://github.com/your-username/derivative.git
        cd derivative
        npm install
        ```

3. **Running the Bot**
    - Start the bot using:
        ```bash
        npm start
        ```
    
## Configuration
- Copy the `.env.example` file to a new file named `.env`:
  ```bash
  cp .env.example .env
  ```
- Open the `.env` file and fill in your credentials:
    - `DISCORD_TOKEN`: Your Discord bot token.
    - `GEMINI_PAGE_KEY`: A Gemini API key used for page parsing.
    - `GEMINI_MAIN_KEY`: Your primary Gemini API key for conversations.
    - `GEMINI_MAIN_KEY2` to `GEMINI_MAIN_KEY12`: (Optional) Additional keys for rotation.
    - `PORT`: (Optional) The port for the web server.
