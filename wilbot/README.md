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

2. Copy `.env.example` to `.env` and fill in the values:

   ```powershell
   Copy-Item .env.example .env
   ```

   The bot requires the `Message Content Intent` in the Discord Developer
   Portal. Enable it under the bot's settings before inviting the bot.

   `ULTRA_THINKING` defaults to `true`, which enables DeepSeek V4's reasoning
   mode (`reasoning_effort: max` and `thinking: enabled`). Set it to `false`
   to disable reasoning. You can also override the model with `MODEL`.

3. Start Wilbot:

   ```powershell
   npm start
   ```

Wilbot uses the `deepseek-v4-flash-free` model at
`https://opencode.ai/zen/v1`. It keeps the latest five exchanges per channel,
shows a typing indicator while generating, and splits long responses to fit
Discord's 2,000-character limit. When a response includes HTML in an
`html` fenced code block (or is a complete HTML document), Wilbot also attaches
a PNG preview rendered with Puppeteer. All fenced code blocks are also sent as
`.txt` file attachments instead of remaining inline in the message.

## Skills & adaptation

Wilbot supports Hermes-style markdown skills in the `skills/` folder. Switch
skills with a command:

- `/skills` — list available skills
- `/skill coder` — switch to the `coder` skill/persona
- `/learn my-skill` — generate a new skill from the recent conversation
- `/export` — get a `wilbot-training-data.json` file with conversations and feedback

React with `👍` or `👎` on any of Wilbot's replies to record feedback. Negative
feedback is appended to `data/skills/adaptive.md` and included in future system prompts.
The conversation/feedback dataset can be used for supervised fine-tuning or DPO.

## Usage

- Mention the bot in a server channel: `@Wilbot What is a closure?`
- Send the bot a direct message.

## Fly.io deployment

Wilbot runs as a worker process and does not expose an HTTP service. Install and
authenticate the [Fly CLI](https://fly.io/docs/flyctl/install/) first, then run
these commands from the `wilbot` directory:

```powershell
fly launch --no-deploy
fly secrets set DISCORD_TOKEN=... OPENCODE_ZEN_API_KEY=...
fly deploy
```

The included `fly.toml` mounts a Fly volume at `/app/data` so conversation
history, feedback, and learned skills in `data/skills/` persist across deploys.
The `skills/` folder is baked into the Docker image as the built-in skill catalog.
