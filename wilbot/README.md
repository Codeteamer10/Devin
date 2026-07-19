# Wilbot

Wilbot is an AI-powered Discord bot built with Node.js and `discord.js`. It
responds to mentions in guild channels and to direct messages using the
OpenCode Zen OpenAI-compatible API.

## Requirements

- Node.js 18 or newer (Node.js 20+ recommended)
- A Discord application with a bot token
- An OpenCode Zen API key

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in both values:

   ```powershell
   Copy-Item .env.example .env
   ```

   The bot requires the `Message Content Intent` in the Discord Developer
   Portal. Enable it under the bot's settings before inviting the bot.

3. Start Wilbot:

   ```powershell
   npm start
   ```

Wilbot uses the `deepseek-v4-flash-free` model at
`https://opencode.ai/zen/v1`. It keeps the latest five exchanges per channel,
shows a typing indicator while generating, and splits long responses to fit
Discord's 2,000-character message limit.

## Usage

- Mention the bot in a server channel: `@Wilbot What is a closure?`
- Send the bot a direct message.
