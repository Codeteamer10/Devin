const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || './data';

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
}

async function appendConversation(entry) {
  await ensureDir(DATA_DIR);
  const file = path.join(DATA_DIR, 'conversations.jsonl');
  await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
}

async function appendFeedback(entry) {
  await ensureDir(DATA_DIR);
  const file = path.join(DATA_DIR, 'feedback.jsonl');
  await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
}

async function readJsonl(filePath) {
  const text = await fs.readFile(filePath, 'utf8').catch(() => '');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function readConversations(channelId, limit = 20) {
  const all = await readJsonl(path.join(DATA_DIR, 'conversations.jsonl'));
  const filtered = channelId ? all.filter((e) => e.channelId === channelId) : all;
  return filtered.slice(-limit);
}

async function readFeedback(channelId) {
  const all = await readJsonl(path.join(DATA_DIR, 'feedback.jsonl'));
  return channelId ? all.filter((e) => e.channelId === channelId) : all;
}

async function exportDataset() {
  const [conversations, feedback] = await Promise.all([
    readJsonl(path.join(DATA_DIR, 'conversations.jsonl')),
    readJsonl(path.join(DATA_DIR, 'feedback.jsonl')),
  ]);
  return JSON.stringify({ conversations, feedback }, null, 2);
}

module.exports = {
  appendConversation,
  appendFeedback,
  readConversations,
  readFeedback,
  exportDataset,
};
