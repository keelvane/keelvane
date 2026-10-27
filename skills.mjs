import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_TEXT = 65536;
const MAX_DESC = 300;

function defaultRoots() {
  const home = os.homedir();
  return [
    { source: 'claude', dir: path.join(home, '.claude', 'skills'), flat: false },
    { source: 'codex', dir: path.join(home, '.codex', 'skills'), flat: false }
  ];
}

export function skillRoots() {
  const env = process.env.KEELVANE_SKILL_ROOTS;
  if (env) {
    let parsed;
    try {
      parsed = JSON.parse(env);
    } catch {
      throw new Error('KEELVANE_SKILL_ROOTS is not valid JSON');
    }
    if (!Array.isArray(parsed)) throw new Error('KEELVANE_SKILL_ROOTS must be a JSON array');
    return parsed;
  }
  return defaultRoots();
}

function stripQuotes(v) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseFrontmatter(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return { name: null, description: null, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return { name: null, description: null, body: text };
  const fm = lines.slice(1, end);
  const body = lines.slice(end + 1).join('\n');
  const out = { name: null, description: null };
  for (let i = 0; i < fm.length; i++) {
    const line = fm[i];
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (val === '>' || val === '|' || val === '>-' || val === '|-' || val === '>+' || val === '|+') {
      const parts = [];
      let j = i + 1;
      while (j < fm.length && (fm[j].startsWith(' ') || fm[j].startsWith('\t') || fm[j].trim() === '')) {
        if (fm[j].trim() !== '') parts.push(fm[j].replace(/^[ \t]+/, ''));
        j++;
      }
      i = j - 1;
      val = parts.join(val.startsWith('>') ? ' ' : '\n').trim();
    } else {
      val = stripQuotes(val);
    }
    if (key === 'name') out.name = val;
    if (key === 'description') out.description = val;
  }
  return { ...out, body };
}

function firstParagraph(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('#'))) i++;
  const parts = [];
  while (i < lines.length && lines[i].trim() !== '' && !lines[i].trim().startsWith('#')) {
    parts.push(lines[i].trim());
    i++;
  }
  return parts.join(' ');
}

function collapseDesc(s) {
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_DESC);
}

function unsupportedReason(text) {
  if (/claude-in-chrome|Claude_Browser/i.test(text)) return 'uses a browser Keelvane does not have';
  if (/subagent_type|\bAgent tool\b/i.test(text)) return 'uses sub-agents Keelvane does not have';
  if (/\bimagegen\b|\bimage_gen\b/i.test(text)) return 'uses image generation Keelvane does not have';
  return null;
}

function readSkillFile(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

function scanRoot(root) {
  let entries;
  try {
    entries = fs.readdirSync(root.dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (root.flat) {
      if (!ent.isFile()) continue;
      if (!/\.md$/i.test(ent.name)) continue;
      const absPath = path.join(root.dir, ent.name);
      const text = readSkillFile(absPath);
      if (text === null) continue;
      const { name: fmName, description: fmDesc, body } = parseFrontmatter(text);
      const name = fmName || ent.name.replace(/\.md$/i, '');
      if (!NAME_RE.test(name)) continue;
      const description = collapseDesc(fmDesc || firstParagraph(body));
      out.push({ name, description, source: root.source, path: absPath, dir: root.dir, unsupported: unsupportedReason(text) });
    } else {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      if (ent.name.startsWith('.')) continue;
      const dir = path.join(root.dir, ent.name);
      const skillPath = path.join(dir, 'SKILL.md');
      let text;
      try {
        text = fs.readFileSync(skillPath, 'utf8');
      } catch {
        continue;
      }
      const { name: fmName, description: fmDesc, body } = parseFrontmatter(text);
      const name = fmName || ent.name;
      if (!NAME_RE.test(name)) continue;
      const description = collapseDesc(fmDesc || firstParagraph(body));
      out.push({ name, description, source: root.source, path: skillPath, dir, unsupported: unsupportedReason(text) });
    }
  }
  return out;
}

export function listSkills(roots = skillRoots()) {
  const seen = new Map();
  for (const root of roots) {
    for (const skill of scanRoot(root)) {
      const key = skill.name.toLowerCase();
      if (!seen.has(key)) seen.set(key, skill);
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function loadSkill(name, roots = skillRoots()) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  const skill = listSkills(roots).find(s => s.name.toLowerCase() === name.toLowerCase());
  if (!skill) return null;
  let text = readSkillFile(skill.path);
  if (text === null) return null;
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '\n\n[skill truncated at 64 KB]';
  return { name: skill.name, source: skill.source, path: skill.path, dir: skill.dir, text };
}

export function listSkillsTool(args, session) {
  const skills = listSkills();
  if (skills.length === 0) return 'No skills found.';
  const lines = ['Skills (load one with load_skill):'];
  for (const s of skills) {
    let line = `${s.name} (${s.source}): ${s.description}`;
    if (s.unsupported) line += ` [limited: ${s.unsupported}]`;
    lines.push(line);
  }
  return lines.join('\n');
}

export function loadSkillTool(args, session) {
  const skill = loadSkill(args?.name);
  if (!skill) throw new Error(`unknown skill: ${args?.name}`);
  const dir = skill.dir.split(path.sep).join('/');
  return `Skill "${skill.name}" (${skill.source}). Files it references live in ${dir}.\n\n${skill.text}`;
}
