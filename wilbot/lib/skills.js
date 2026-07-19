const fs = require('fs').promises;
const path = require('path');

const SKILLS_DIR = process.env.SKILLS_DIR || './skills';
const DATA_DIR = process.env.DATA_DIR || './data';
const DATA_SKILLS_DIR = process.env.DATA_SKILLS_DIR || path.join(DATA_DIR, 'skills');
const DEFAULT_PROMPT = 'You are Wilbot, a helpful and concise Discord assistant. Keep replies short and conversational.';

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text.trim());
  if (!match) {
    return { metadata: {}, content: text.trim() };
  }
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    metadata[key] = value;
  }
  return { metadata, content: match[2].trim() };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
}

async function readSkillFile(filePath) {
  const text = await fs.readFile(filePath, 'utf8').catch(() => '');
  if (!text) return null;
  const { metadata, content } = parseFrontmatter(text);
  const name = path.basename(filePath, '.md');
  return {
    name,
    description: metadata.description || name,
    content,
  };
}

async function readSkillsFromDir(dir) {
  const result = {};
  const files = await fs.readdir(dir).catch(() => []);
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const skill = await readSkillFile(path.join(dir, file));
    if (skill) result[skill.name] = skill;
  }
  return result;
}

async function loadSkills() {
  const builtIn = await readSkillsFromDir(SKILLS_DIR);
  await ensureDir(DATA_SKILLS_DIR);
  const learned = await readSkillsFromDir(DATA_SKILLS_DIR);
  const merged = { ...builtIn, ...learned };
  if (!merged.default) {
    merged.default = {
      name: 'default',
      description: 'Default Wilbot assistant',
      content: DEFAULT_PROMPT,
    };
  }
  return merged;
}

async function saveSkill(name, markdown) {
  await ensureDir(DATA_SKILLS_DIR);
  await fs.writeFile(path.join(DATA_SKILLS_DIR, `${name}.md`), markdown, 'utf8');
}

async function appendAdaptiveNote(note) {
  await ensureDir(DATA_SKILLS_DIR);
  const file = path.join(DATA_SKILLS_DIR, 'adaptive.md');
  const existing = await fs.readFile(file, 'utf8').catch(() => '');
  const { metadata, content } = parseFrontmatter(existing);
  const newContent = content ? `${content}\n- ${note}` : `- ${note}`;
  const lines = newContent.split(/\r?\n/);
  const trimmed = lines.slice(-20).join('\n');
  const markdown = `---\nname: adaptive\ndescription: Learned preferences from feedback\n---\n\n${trimmed}`;
  await fs.writeFile(file, markdown, 'utf8');
}

function buildSystemPrompt(skills, activeName) {
  const active = skills[activeName] || skills.default;
  const parts = [skills.default ? skills.default.content : DEFAULT_PROMPT];
  if (active && active.name !== 'default' && active.content) {
    parts.push(`Adopt the following skill: ${active.name}\n${active.content}`);
  }
  const adaptive = skills.adaptive?.content;
  if (adaptive) {
    parts.push(`Learned preferences:\n${adaptive}`);
  }
  return parts.join('\n\n');
}

module.exports = {
  loadSkills,
  saveSkill,
  appendAdaptiveNote,
  buildSystemPrompt,
};
