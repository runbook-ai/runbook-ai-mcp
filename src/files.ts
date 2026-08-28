import fs from 'fs';
import os from 'os';
import path from 'path';

// Files the browser agent produced during a run (saveToFile results,
// downloads, extraction outputs). The extension ships them base64-encoded
// on the task-response as `files: { [name]: TaskFile }`.
export interface TaskFile {
  name?: string;
  mimeType?: string;
  base64: string;
  size?: number;
}

export interface WrittenFile {
  name: string;
  path: string;
  size: number;
  mimeType: string;
}

export interface WriteTaskFilesResult {
  outputDir: string;
  written: WrittenFile[];
  failed: { name: string; error: string }[];
}

// Images above this are still written to disk but not embedded as MCP image
// content -- most clients reject multi-MB inline images and the path is
// enough for the caller to open it.
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

export function defaultOutputRoot(): string {
  return process.env.RUNBOOK_AI_FILES_DIR || path.join(os.tmpdir(), 'runbook-ai-mcp');
}

// Per-call directory under the root so files from separate runs never
// clobber each other: <root>/task-YYYYMMDD-HHMMSS-xxxx.
export function newRunDir(root: string = defaultOutputRoot()): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return path.join(root, `task-${stamp}-${rand}`);
}

// Reduce an agent-chosen file name to a safe basename: no directories, no
// traversal, no control characters. Empty results fall back to `fallback`.
export function sanitizeFileName(name: string, fallback: string): string {
  let base = path.basename(String(name || '').replace(/\\/g, '/'));
  base = base.replace(/[\x00-\x1f<>:"|?*]/g, '_').trim();
  if (!base || base === '.' || base === '..') base = fallback;
  return base;
}

export function writeTaskFiles(
  files: Record<string, TaskFile> | undefined | null,
  outputDir: string,
): WriteTaskFilesResult {
  const result: WriteTaskFilesResult = { outputDir, written: [], failed: [] };
  const entries = Object.entries(files || {});
  if (entries.length === 0) return result;

  fs.mkdirSync(outputDir, { recursive: true });
  entries.forEach(([key, file], i) => {
    const rawName = (file && file.name) || key;
    const name = sanitizeFileName(rawName, `file-${i + 1}`);
    try {
      if (!file || typeof file.base64 !== 'string') {
        throw new Error('missing base64 content');
      }
      const bytes = Buffer.from(file.base64, 'base64');
      const filePath = path.join(outputDir, name);
      fs.writeFileSync(filePath, bytes);
      result.written.push({
        name,
        path: filePath,
        size: bytes.length,
        mimeType: file.mimeType || 'application/octet-stream',
      });
    } catch (e: any) {
      result.failed.push({ name, error: e?.message || String(e) });
    }
  });
  return result;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Text block appended to the tool result so the caller learns where the
// files landed. Content is deliberately NOT inlined -- the point of the
// agent saving to a file is to keep bulk data out of the caller's context.
export function formatFilesFooter(r: WriteTaskFilesResult): string {
  if (r.written.length === 0 && r.failed.length === 0) return '';
  const lines = ['', '', `Files (${r.written.length}) written to ${r.outputDir}:`];
  for (const f of r.written) {
    lines.push(`- ${f.path} (${f.mimeType}, ${formatSize(f.size)})`);
  }
  for (const f of r.failed) {
    lines.push(`- ${f.name}: FAILED to write (${f.error})`);
  }
  return lines.join('\n');
}

// MCP image content items for image files small enough to inline, so
// screenshots the agent saved show up directly in the caller's view.
export function imageContentItems(
  files: Record<string, TaskFile> | undefined | null,
  written: WrittenFile[],
): { type: 'image'; data: string; mimeType: string }[] {
  const items: { type: 'image'; data: string; mimeType: string }[] = [];
  if (!files) return items;
  const writtenByName = new Map(written.map(w => [w.name, w]));
  Object.entries(files).forEach(([key, file], i) => {
    const mime = file?.mimeType || '';
    if (!mime.startsWith('image/') || typeof file.base64 !== 'string') return;
    const name = sanitizeFileName(file.name || key, `file-${i + 1}`);
    const w = writtenByName.get(name);
    const size = w ? w.size : Math.floor(file.base64.length * 3 / 4);
    if (size > MAX_INLINE_IMAGE_BYTES) return;
    items.push({ type: 'image', data: file.base64, mimeType: mime });
  });
  return items;
}

// The extension always persists the agent's final answer as
// browser-result-<n>.<ext> (for planner/runbook renderers). Over MCP that
// text is already the tool result, so an identical copy is just noise --
// drop it. A differing copy (e.g. an HTML report with screenshots inlined)
// is kept because it carries content the plain result text does not.
export function dropResultEcho(
  files: Record<string, TaskFile> | undefined | null,
  resultText: string | undefined,
): Record<string, TaskFile> {
  const out: Record<string, TaskFile> = {};
  for (const [key, file] of Object.entries(files || {})) {
    const name = (file && file.name) || key;
    if (/^browser-result-\d+\.(txt|json|html|md)$/.test(name) && typeof file?.base64 === 'string') {
      const decoded = Buffer.from(file.base64, 'base64').toString('utf-8');
      if (decoded === resultText) continue;
    }
    out[key] = file;
  }
  return out;
}
