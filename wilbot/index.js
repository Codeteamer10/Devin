require('dotenv').config();

const {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} = require('discord.js');
const puppeteer = require('puppeteer');
const skills = require('./lib/skills');
const learning = require('./lib/learning');

const API_BASE_URL = 'https://opencode.ai/zen/v1';
const MODEL = process.env.MODEL || 'deepseek-v4-flash-free';
const ULTRA_THINKING = process.env.ULTRA_THINKING !== 'false';
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
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.Reaction,
    Partials.User,
  ],
});

let loadedSkills = {};
const channelHistories = new Map();
const activeSkills = new Map();
const messageLog = new Map();

function getHistory(channelId) {
  if (!channelHistories.has(channelId)) {
    channelHistories.set(channelId, []);
  }
  return channelHistories.get(channelId);
}

function getActiveSkill(channelId) {
  return activeSkills.get(channelId) || 'default';
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
        ? `code-${blocks.length + 1}-${safeLanguage}.txt`
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
  const body = {
    model: MODEL,
    messages,
    temperature: 0.7,
    max_tokens: 1000,
  };

  if (ULTRA_THINKING) {
    body.reasoning_effort = 'max';
    body.thinking = { type: 'enabled' };
  }

  const response = await fetch(`${API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENCODE_ZEN_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`OpenCode Zen returned ${response.status}: ${details}`);
  }

  const result = await response.json();
  const message = result.choices?.[0]?.message;
  const content = message?.content;
  if (!content) {
    throw new Error('OpenCode Zen returned no message content');
  }
  return { content, reasoning: message?.reasoning_content };
}

function parseCommand(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^(?:!|\/)(\w+)(?:\s+(.*))?$/s);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: (match[2] || '').trim() };
}

async function handleCommand(message, prompt) {
  const command = parseCommand(prompt);
  if (!command) return false;

  if (command.command === 'skills') {
    const list = Object.values(loadedSkills)
      .map((s) => `- **${s.name}**: ${s.description}`)
      .join('\n');
    await message.reply(`Available skills:\n${list || 'No skills loaded.'}`);
    return true;
  }

  if (command.command === 'skill') {
    const name = command.args || 'default';
    if (!loadedSkills[name]) {
      await message.reply(`Unknown skill: ${name}. Use \`/skills\` to list.`);
      return true;
    }
    activeSkills.set(message.channelId, name);
    await message.reply(`Active skill set to **${name}**.`);
    return true;
  }

  if (command.command === 'learn') {
    const name = command.args || 'adaptive';
    await message.channel.sendTyping();
    const conversations = await learning.readConversations(message.channelId, 20);
    const feedback = await learning.readFeedback(message.channelId);
    const transcript = conversations
      .map((c) => `User: ${c.userPrompt}\nAssistant: ${c.assistantResponse}`)
      .join('\n\n');
    const feedbackText = feedback
      .map((f) => `- ${f.rating}: ${f.assistantResponse.slice(0, 200)}`)
      .join('\n');

    const messages = [
      {
        role: 'system',
        content:
          'You are a skill author. Write a reusable Discord bot skill in markdown with YAML frontmatter (name, description). Keep instructions concise.',
      },
      {
        role: 'user',
        content: `Create a skill named "${name}" from this conversation transcript and feedback.\n\nTranscript:\n${transcript}\n\nFeedback:\n${feedbackText}`,
      },
    ];

    try {
      const skillResponse = await createCompletion(messages);
      const markdown = skillResponse.content;
      await skills.saveSkill(name, markdown);
      loadedSkills = await skills.loadSkills();
      activeSkills.set(message.channelId, name);
      await message.reply(`Learned skill **${name}** and activated it.`);
    } catch (error) {
      console.error('Failed to learn skill:', error.message);
      await message.reply('Failed to learn a skill from this conversation.');
    }
    return true;
  }

  if (command.command === 'export') {
    try {
      const data = await learning.exportDataset();
      const attachment = new AttachmentBuilder(Buffer.from(data, 'utf8'), {
        name: 'wilbot-training-data.json',
      });
      await message.reply({
        content: 'Here is the collected conversation and feedback dataset.',
        files: [attachment],
      });
    } catch (error) {
      console.error('Failed to export data:', error.message);
      await message.reply('Failed to export training data.');
    }
    return true;
  }

  return false;
}

async function sendReply(message, response) {
  const html = extractHtml(response.content);
  let preview;
  if (html) {
    try {
      preview = await renderHtml(html);
    } catch (error) {
      console.error('Failed to render HTML preview:', error.message);
    }
  }

  const code = extractCodeBlocks(response.content);
  const files = code.blocks.map(
    ({ content, filename }) =>
      new AttachmentBuilder(Buffer.from(content, 'utf8'), { name: filename }),
  );
  if (preview) {
    files.unshift(
      new AttachmentBuilder(preview, { name: 'wilbot-html-preview.png' }),
    );
  }

  const replies = [];
  for (const [index, chunk] of splitMessage(code.messageText).entries()) {
    const reply = { content: chunk };
    if (index === 0 && files.length > 0) {
      reply.files = files;
    }
    replies.push(await message.reply(reply));
  }
  return replies[0];
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

  let prompt = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();
  if (!prompt) {
    await message.reply('How can I help?');
    return;
  }

  if (await handleCommand(message, prompt)) {
    return;
  }

  const history = getHistory(message.channelId);
  const userMessage = { role: 'user', content: prompt };
  const systemContent = skills.buildSystemPrompt(loadedSkills, getActiveSkill(message.channelId));
  const messages = [
    { role: 'system', content: systemContent },
    ...history,
    userMessage,
  ];

  try {
    await message.channel.sendTyping();
    const response = await createCompletion(messages);

    const assistantMessage = { role: 'assistant', content: response.content };
    if (response.reasoning) {
      assistantMessage.reasoning_content = response.reasoning;
    }
    history.push(userMessage, assistantMessage);
    while (history.length > MAX_HISTORY_MESSAGES) {
      history.shift();
    }

    const replyMessage = await sendReply(message, response);

    messageLog.set(replyMessage.id, {
      channelId: message.channelId,
      userId: message.author.id,
      userPrompt: prompt,
      assistantResponse: response.content,
      skill: getActiveSkill(message.channelId),
      timestamp: new Date().toISOString(),
    });

    await learning.appendConversation({
      channelId: message.channelId,
      userId: message.author.id,
      userPrompt: prompt,
      assistantResponse: response.content,
      skill: getActiveSkill(message.channelId),
      model: MODEL,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Failed to respond to message:', error.message);
    await message.reply('Sorry, I could not reach the AI service right now.');
  }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot || !messageLog.has(reaction.message.id)) {
    return;
  }

  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('Failed to fetch reaction:', error.message);
      return;
    }
  }

  const logEntry = messageLog.get(reaction.message.id);
  const emoji = reaction.emoji.name;
  let rating;
  if (emoji === '👍') rating = 'up';
  else if (emoji === '👎') rating = 'down';
  else return;

  await learning.appendFeedback({
    messageId: reaction.message.id,
    channelId: logEntry.channelId,
    userId: user.id,
    userPrompt: logEntry.userPrompt,
    assistantResponse: logEntry.assistantResponse,
    rating,
    skill: logEntry.skill,
    timestamp: new Date().toISOString(),
  });

  if (rating === 'down') {
    await skills.appendAdaptiveNote(
      `User disliked this response to "${logEntry.userPrompt.slice(0, 100)}": "${logEntry.assistantResponse.slice(0, 200)}". Avoid similar responses in the future.`,
    );
    loadedSkills = await skills.loadSkills();
  }
});

async function main() {
  loadedSkills = await skills.loadSkills();
  await client.login(DISCORD_TOKEN);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Failed to start Wilbot:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  extractCodeBlocks,
  extractHtml,
  renderHtml,
  splitMessage,
  createCompletion,
  parseCommand,
};
