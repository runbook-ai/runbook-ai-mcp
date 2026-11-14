import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { TaskFile } from './files.js';

// Files the caller hands the browser agent. They go to the extension as
// initialTaskState.savedFiles -- the task's files, which the agent sees by
// name and description and reads with readTextFile / readImageFile, the same
// store the agent's own saves and downloads land in.
//
//   skills: skill folders (SKILL.md + scripts/*.js), e.g. a draft the agent
//     saved in an earlier run, written to <outputDir>/skills/<name>/. Sent
//     as draft-skill files (skills/<name>/...) and preloaded, so the run uses
//     this copy over a stored or bundled skill of the same name.
//   inputFiles: plain files, keyed by their base name.

export interface InputTaskFile extends TaskFile {
  name: string;
  description: string;
  skillDraft?: { name: string; version: string; tested: boolean };
}

export interface TaskInputs {
  files: Record<string, InputTaskFile>;
  skillNames: string[];
}

// Everything travels base64 over the hub websocket in one message.
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.html': 'text/html', '.htm': 'text/html',
  '.xml': 'application/xml', '.js': 'text/javascript', '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.zip': 'application/zip',
};

export function mimeTypeFor(file: string): string {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

export class InputError extends Error {}

function readFile(p: string): Buffer {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    throw new InputError(`${p} does not exist`);
  }
  if (!st.isFile()) throw new InputError(`${p} is not a file`);
  return fs.readFileSync(p);
}

function taskFile(key: string, bytes: Buffer, description: string, mimeType = mimeTypeFor(key)): InputTaskFile {
  return { name: key, mimeType, base64: bytes.toString('base64'), size: bytes.length, description };
}

// The SKILL.md frontmatter `name:` (top level), or null.
export function skillMdName(md: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!fm) return null;
  const m = /^name:\s*["']?([^"'\s]+)["']?\s*$/m.exec(fm[1]);
  return m ? m[1] : null;
}

// One skill folder -> its task files. The folder name must equal the
// frontmatter name (the rule the extension applies to stored skills); the
// extension builds and validates the skill itself and drops a broken one,
// which then shows up as "not preloaded".
export function readSkillDir(dir: string): { name: string; files: Record<string, InputTaskFile> } {
  const abs = path.resolve(dir);
  const mdPath = path.join(abs, 'SKILL.md');
  const md = readFile(mdPath);
  const name = skillMdName(md.toString('utf-8'));
  if (!name) throw new InputError(`${mdPath} has no frontmatter name`);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new InputError(`${mdPath}: skill name "${name}" must be lowercase letters, digits and hyphens`);
  }
  if (path.basename(abs) !== name) {
    throw new InputError(`${abs}: the folder name must equal the skill name "${name}"`);
  }
  const scripts: [string, Buffer][] = [];
  const scriptsDir = path.join(abs, 'scripts');
  if (fs.existsSync(scriptsDir) && fs.statSync(scriptsDir).isDirectory()) {
    for (const f of fs.readdirSync(scriptsDir).sort()) {
      if (/^[\w.-]+\.js$/.test(f)) scripts.push([f, readFile(path.join(scriptsDir, f))]);
    }
  }
  // Names this set of files: the extension uses only the files whose
  // version matches the SKILL.md's (dropping leftovers of older saves).
  const hash = crypto.createHash('sha256').update(md);
  for (const [f, b] of scripts) hash.update(`\0${f}\0`).update(b);
  const skillDraft = { name, version: hash.digest('hex').slice(0, 8), tested: true };
  const description = `Skill ${name} passed in by the caller`;
  const files: Record<string, InputTaskFile> = {};
  const add = (rel: string, bytes: Buffer, mime: string) => {
    const key = `skills/${name}/${rel}`;
    files[key] = { ...taskFile(key, bytes, description, mime), skillDraft };
  };
  add('SKILL.md', md, 'text/markdown');
  for (const [f, b] of scripts) add(`scripts/${f}`, b, 'text/javascript');
  return { name, files };
}

export function readTaskInputs(skillDirs: string[] = [], inputFiles: string[] = []): TaskInputs {
  const files: Record<string, InputTaskFile> = {};
  const skillNames: string[] = [];
  for (const dir of skillDirs) {
    const s = readSkillDir(dir);
    if (skillNames.includes(s.name)) throw new InputError(`skill "${s.name}" is passed twice`);
    skillNames.push(s.name);
    Object.assign(files, s.files);
  }
  for (const p of inputFiles) {
    const key = path.basename(path.resolve(p));
    if (files[key]) throw new InputError(`two input files are named "${key}"`);
    files[key] = taskFile(key, readFile(path.resolve(p)), 'Input file passed in by the caller');
  }
  const total = Object.values(files).reduce((a, f) => a + f.size!, 0);
  if (total > MAX_INPUT_BYTES) {
    throw new InputError(`input files total ${(total / 1048576).toFixed(1)} MB; the limit is ${MAX_INPUT_BYTES / 1048576} MB`);
  }
  return { files, skillNames };
}

// The extension returns all of the task's files, inputs included. Drop the
// ones that come back unchanged so the output folder holds only what the run
// produced (a skill the agent re-saved comes back with new content and is
// kept).
export function dropInputEcho(
  files: Record<string, TaskFile>,
  inputs: Record<string, TaskFile>,
): Record<string, TaskFile> {
  const out: Record<string, TaskFile> = {};
  for (const [key, file] of Object.entries(files || {})) {
    if (inputs[key] && inputs[key].base64 === file?.base64) continue;
    out[key] = file;
  }
  return out;
}

// Footer line for preloaded skills the extension skipped (over the
// loaded-skill caps, or a SKILL.md it could not build).
export function formatPreloadFooter(report: any, requested: string[]): string {
  if (!requested.length) return '';
  if (!report || typeof report !== 'object') {
    return '\n\n[skills: the extension did not report preloading; it may be too old to load passed-in skills]';
  }
  const skipped = Array.isArray(report.skipped) ? report.skipped : [];
  if (!skipped.length) return '';
  const lines = skipped.map((s: any) => `- ${s.name}: ${s.message || s.error}`);
  return `\n\nSkills not preloaded (${skipped.length}):\n${lines.join('\n')}`;
}
