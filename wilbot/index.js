require('dotenv').config();

const {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} = require('discord.js');

const API_BASE_URL = 'https://opencode.ai/zen/v1';
const MODEL = 'deepseek-v4-flash-free';
const MAX_HISTORY_MESSAGES = 10;
const MAX_REPLY_LENGTH = 2000;

const { DISCORD_TOKEN, OPENCODE_ZEN_API_KEY } = process.env;

if (!DISCORD_TOKEN || !OPENCODE_ZEN_API_KEY) {
  throw new Error('DISCORD_TOKEN and OPENCODE_ZEN_API_KEY must be set in .env');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const channelHistories = new Map();

function getHistory(channelId) {
  if (!channelHistories.has(channelId)) {
    channelHistories.set(channelId, []);
  }
  return channelHistories.get(channelId);
}

function splitMessage(text) {
  const chunks = [];
  let remaining = text.trim();

  while (remaining.length > MAX_REPLY_LENGTH) {
    let splitAt = remaining.lastIndexOf('\n', MAX_REPLY_LENGTH);
    if (splitAt < MAX_REPLY_LENGTH / 2) {
      splitAt = remaining.lastIndexOf(' ', MAX_REPLY_LENGTH);
    }
    if (splitAt < MAX_REPLY_LENGTH / 2) {
      splitAt = MAX_REPLY_LENGTH;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

async function createCompletion(messages) {
  const response = await fetch(`${API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENCODE_ZEN_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 1000,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`OpenCode Zen returned ${response.status}: ${details}`);
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenCode Zen returned no message content');
  }
  return content;
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in to Discord as ${readyClient.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) {
    return;
  }

  const isDirectMessage = !message.guild;
  const isMentioned = message.mentions.has(client.user);
  if (!isDirectMessage && !isMentioned) {
    return;
  }

  const prompt = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();
  if (!prompt) {
    await message.reply('How can I help?');
    return;
  }

  const history = getHistory(message.channelId);
  const userMessage = { role: 'user', content: prompt };
  const messages = [
    {
      role: 'system',
      content:
        'You are Wilbot, a helpful and concise Discord assistant. Keep replies short and conversational.',
    },
    ...history,
    userMessage,
  ];

  try {
    await message.channel.sendTyping();
    const response = await createCompletion(messages);
    history.push(userMessage, { role: 'assistant', content: response });
    while (history.length > MAX_HISTORY_MESSAGES) {
      history.shift();
    }

    for (const chunk of splitMessage(response)) {
      await message.reply(chunk);
    }
  } catch (error) {
    console.error('Failed to respond to message:', error.message);
    await message.reply('Sorry, I could not reach the AI service right now.');
  }
});

client.login(DISCORD_TOKEN).catch((error) => {
  console.error('Failed to log in to Discord:', error.message);
  process.exitCode = 1;
});

module.exports = { splitMessage };
