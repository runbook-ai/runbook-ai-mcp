import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  sanitizeFileName,
  writeTaskFiles,
  formatFilesFooter,
  imageContentItems,
  newRunDir,
  MAX_INLINE_IMAGE_BYTES,
  dropResultEcho,
} from '../src/files';

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

describe('task file write-out', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runbook-files-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sanitizes agent-chosen names to a safe basename', () => {
    expect(sanitizeFileName('orders.json', 'x')).toBe('orders.json');
    expect(sanitizeFileName('../../etc/passwd', 'x')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\me\\report.csv', 'x')).toBe('report.csv');
    expect(sanitizeFileName('a<b>:c?.txt', 'x')).toBe('a_b__c_.txt');
    expect(sanitizeFileName('', 'file-3')).toBe('file-3');
    expect(sanitizeFileName('..', 'file-3')).toBe('file-3');
  });

  it('writes every file, decoding base64, and reports paths', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: 1000 + i, name: `Widget ${i + 1}` }));
    const json = JSON.stringify(rows, null, 2);
    const files = {
      'widgets.json': { name: 'widgets.json', mimeType: 'application/json', base64: b64(json), size: json.length },
      'note.txt': { name: 'note.txt', mimeType: 'text/plain', base64: b64('héllo — 日本語') },
    };
    const r = writeTaskFiles(files, path.join(dir, 'out'));

    expect(r.failed).toEqual([]);
    expect(r.written.map(w => w.name).sort()).toEqual(['note.txt', 'widgets.json']);
    const widgets = r.written.find(w => w.name === 'widgets.json')!;
    expect(widgets.path).toBe(path.join(dir, 'out', 'widgets.json'));
    expect(widgets.mimeType).toBe('application/json');
    expect(JSON.parse(fs.readFileSync(widgets.path, 'utf-8'))).toHaveLength(40);
    expect(fs.readFileSync(path.join(dir, 'out', 'note.txt'), 'utf-8')).toBe('héllo — 日本語');
  });

  it('keeps traversal names inside outputDir', () => {
    const r = writeTaskFiles({ '../../escape.txt': { base64: b64('x') } }, dir);
    expect(r.written[0].path).toBe(path.join(dir, 'escape.txt'));
    expect(fs.existsSync(path.join(dir, 'escape.txt'))).toBe(true);
  });

  it('records a failure for a broken entry without dropping the others', () => {
    const r = writeTaskFiles({
      'ok.txt': { base64: b64('ok') },
      'bad.bin': { mimeType: 'application/octet-stream' } as any,
    }, dir);
    expect(r.written.map(w => w.name)).toEqual(['ok.txt']);
    expect(r.failed).toEqual([{ name: 'bad.bin', error: 'missing base64 content' }]);
  });

  it('handles empty/missing files without creating the directory', () => {
    const target = path.join(dir, 'never');
    expect(writeTaskFiles(undefined, target).written).toEqual([]);
    expect(writeTaskFiles({}, target).written).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('footer lists paths and sizes, never file content', () => {
    const json = JSON.stringify({ secret: 'do-not-inline' });
    const r = writeTaskFiles({ 'd.json': { mimeType: 'application/json', base64: b64(json) } }, dir);
    const footer = formatFilesFooter(r);
    expect(footer).toContain(`Files (1) written to ${dir}:`);
    expect(footer).toContain(`- ${path.join(dir, 'd.json')} (application/json, ${json.length} B)`);
    expect(footer).not.toContain('do-not-inline');
    expect(formatFilesFooter({ outputDir: dir, written: [], failed: [] })).toBe('');
  });

  it('returns small images as inline image content, skips non-images and huge images', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const huge = Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1, 1);
    const files = {
      'shot.png': { name: 'shot.png', mimeType: 'image/png', base64: b64(png) },
      'data.json': { name: 'data.json', mimeType: 'application/json', base64: b64('[]') },
      'huge.jpg': { name: 'huge.jpg', mimeType: 'image/jpeg', base64: b64(huge) },
    };
    const r = writeTaskFiles(files, dir);
    const items = imageContentItems(files, r.written);
    expect(items).toEqual([{ type: 'image', data: b64(png), mimeType: 'image/png' }]);
    // huge one still landed on disk
    expect(fs.statSync(path.join(dir, 'huge.jpg')).size).toBe(huge.length);
  });

  it('newRunDir yields distinct per-call directories under the root', () => {
    const a = newRunDir(dir);
    const b = newRunDir(dir);
    expect(path.dirname(a)).toBe(dir);
    expect(path.basename(a)).toMatch(/^task-\d{8}-\d{6}-[a-z0-9]{4}$/);
    expect(a).not.toBe(b);
  });

  it('drops the browser-result echo only when it duplicates the result text', () => {
    const result = '40 items saved to widgets.json';
    const files = {
      'widgets.json': { name: 'widgets.json', mimeType: 'application/json', base64: b64('[]') },
      'browser-result-1.txt': { name: 'browser-result-1.txt', mimeType: 'text/plain', base64: b64(result) },
    };
    expect(Object.keys(dropResultEcho(files, result))).toEqual(['widgets.json']);
    // An HTML report differs from the plain result text -> kept.
    const html = { 'browser-result-2.html': { name: 'browser-result-2.html', mimeType: 'text/html', base64: b64('<h1>report</h1>') } };
    expect(Object.keys(dropResultEcho(html, result))).toEqual(['browser-result-2.html']);
    expect(dropResultEcho(undefined, result)).toEqual({});
  });
});
