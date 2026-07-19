require('dotenv').config();

const {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} = require('discord.js');
const puppeteer = require('puppeteer');

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

function extractHtml(text) {
  const blocks = [];
  const fencedHtml = /```html\s*([\s\S]*?)```/gi;
  let match;

  while ((match = fencedHtml.exec(text)) !== null) {
    if (match[1].trim()) {
      blocks.push(match[1].trim());
    }
  }

  if (blocks.length > 0) {
    return blocks.join('\n');
  }

  const trimmed = text.trim();
  if (/^<!doctype\s+html\b/i.test(trimmed) || /^<html(?:\s|>)/i.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function extractCodeBlocks(text) {
  const blocks = [];
  let messageText = text
    .replace(/```([^\r\n`]*)\r?\n([\s\S]*?)```/g, (match, language, content) => {
      const languageTag = language.trim().split(/\s+/)[0];
      const safeLanguage = languageTag.replace(/[^a-z0-9_-]/gi, '_');
      const filename = safeLanguage
        ? `code-${blocks.length + 1}.${safeLanguage}.txt`
        : `code-${blocks.length + 1}.txt`;
      blocks.push({ content, filename });
      return `(see attached ${filename})`;
    })
    .trim();

  const bareHtml = text.trim();
  if (
    blocks.length === 0 &&
    (/^<!doctype\s+html\b/i.test(bareHtml) || /^<html(?:\s|>)/i.test(bareHtml))
  ) {
    const filename = 'code-1.html.txt';
    blocks.push({ content: bareHtml, filename });
    messageText = `(see attached ${filename})`;
  }

  return {
    blocks,
    messageText: messageText || "Here's the code:",
  };
}

async function renderHtml(html) {
  const launchOptions = {};
  if (process.platform === 'linux') {
    launchOptions.args = ['--no-sandbox', '--disable-setuid-sandbox'];
  }
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const browser = await puppeteer.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });

    const contentHeight = await page.evaluate(() =>
      Math.max(
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0,
        800,
      ),
    );
    const height = Math.min(contentHeight, 4000);
    const screenshot = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: 1280, height },
    });
    return screenshot;
  } finally {
    await browser.close();
  }
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
    const html = extractHtml(response);
    let preview;
    if (html) {
      try {
        preview = await renderHtml(html);
      } catch (error) {
        console.error('Failed to render HTML preview:', error.message);
      }
    }
    const code = extractCodeBlocks(response);
    const files = code.blocks.map(
      ({ content, filename }) =>
        new AttachmentBuilder(Buffer.from(content, 'utf8'), { name: filename }),
    );
    if (preview) {
      files.unshift(
        new AttachmentBuilder(preview, { name: 'wilbot-html-preview.png' }),
      );
    }

    history.push(userMessage, { role: 'assistant', content: response });
    while (history.length > MAX_HISTORY_MESSAGES) {
      history.shift();
    }

    for (const [index, chunk] of splitMessage(code.messageText).entries()) {
      const reply = { content: chunk };
      if (index === 0 && files.length > 0) {
        reply.files = files;
      }
      await message.reply(reply);
    }
  } catch (error) {
    console.error('Failed to respond to message:', error.message);
    await message.reply('Sorry, I could not reach the AI service right now.');
  }
});

if (require.main === module) {
  client.login(DISCORD_TOKEN).catch((error) => {
    console.error('Failed to log in to Discord:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { extractCodeBlocks, extractHtml, renderHtml, splitMessage };
