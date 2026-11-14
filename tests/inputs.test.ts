import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeTaskFiles, safeRelativePath } from '../src/files';
import {
  readTaskInputs, readSkillDir, dropInputEcho, formatPreloadFooter, skillMdName, InputError, MAX_INPUT_BYTES,
} from '../src/inputs';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const md = (name: string, body = 'Procedure.') =>
  `---\nname: ${name}\ndescription: "Does ${name} things"\nmetadata:\n  runbookai:\n    version: 1a2b3c4d\n---\n\n${body}\n`;

describe('caller inputs: skills and inputFiles', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runbook-inputs-test-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function skillDir(name: string, body?: string, scripts: Record<string, string> = {}, root = dir) {
    const d = path.join(root, name);
    fs.mkdirSync(path.join(d, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), md(name, body));
    for (const [f, src] of Object.entries(scripts)) fs.writeFileSync(path.join(d, 'scripts', f), src);
    return d;
  }

  it('keeps folders when writing output, still inside outputDir', () => {
    expect(safeRelativePath('skills/acme/scripts/api.js', 'x')).toBe('skills/acme/scripts/api.js');
    expect(safeRelativePath('../../etc/passwd', 'x')).toBe('etc/passwd');
    expect(safeRelativePath('/abs/./a.txt', 'x')).toBe('abs/a.txt');
    expect(safeRelativePath('C:\\Users\\me\\r.csv', 'x')).toBe('C_/Users/me/r.csv');
    expect(safeRelativePath('../..', 'file-2')).toBe('file-2');
    const out = path.join(dir, 'out');
    const r = writeTaskFiles({
      'skills/acme/SKILL.md': { name: 'skills/acme/SKILL.md', base64: b64(md('acme')) },
      'skills/acme/scripts/api.js': { name: 'skills/acme/scripts/api.js', base64: b64('function f() {}') },
      'skills/beta/SKILL.md': { name: 'skills/beta/SKILL.md', base64: b64(md('beta')) },
    }, out);
    expect(r.failed).toEqual([]);
    expect(fs.readFileSync(path.join(out, 'skills/acme/scripts/api.js'), 'utf-8')).toBe('function f() {}');
    expect(skillMdName(fs.readFileSync(path.join(out, 'skills/beta/SKILL.md'), 'utf-8'))).toBe('beta');
  });

  it('round trip: a written-out draft folder reads back as a skill input', () => {
    const out = path.join(dir, 'out');
    writeTaskFiles({
      'skills/acme/SKILL.md': { name: 'skills/acme/SKILL.md', base64: b64(md('acme')) },
      'skills/acme/scripts/api.js': { name: 'skills/acme/scripts/api.js', base64: b64('function f() {}') },
    }, out);
    const s = readSkillDir(path.join(out, 'skills', 'acme'));
    expect(s.name).toBe('acme');
    expect(Object.keys(s.files).sort()).toEqual(['skills/acme/SKILL.md', 'skills/acme/scripts/api.js']);
    const v = s.files['skills/acme/SKILL.md'].skillDraft!;
    expect(v).toMatchObject({ name: 'acme', tested: true });
    expect(s.files['skills/acme/scripts/api.js'].skillDraft).toEqual(v);
    expect(s.files['skills/acme/scripts/api.js'].mimeType).toBe('text/javascript');
  });

  it('versions by content: an edit changes the version', () => {
    const d = skillDir('acme', 'One.');
    const v1 = readSkillDir(d).files['skills/acme/SKILL.md'].skillDraft!.version;
    fs.writeFileSync(path.join(d, 'scripts', 'api.js'), 'function g() {}');
    const v2 = readSkillDir(d).files['skills/acme/SKILL.md'].skillDraft!.version;
    expect(v1).toMatch(/^[0-9a-f]{8}$/);
    expect(v2).not.toBe(v1);
  });

  it('takes several skills plus input files', () => {
    const csv = path.join(dir, 'leads.csv');
    fs.writeFileSync(csv, 'a,b\n1,2\n');
    const r = readTaskInputs([skillDir('acme'), skillDir('beta', 'B.', { 'x.js': 'function x() {}' })], [csv]);
    expect(r.skillNames).toEqual(['acme', 'beta']);
    expect(Object.keys(r.files).sort()).toEqual(
      ['leads.csv', 'skills/acme/SKILL.md', 'skills/beta/SKILL.md', 'skills/beta/scripts/x.js']);
    expect(r.files['leads.csv']).toMatchObject({ name: 'leads.csv', mimeType: 'text/csv', size: 8 });
    expect(r.files['leads.csv'].skillDraft).toBeUndefined();
    expect(Buffer.from(r.files['leads.csv'].base64, 'base64').toString()).toBe('a,b\n1,2\n');
  });

  it('ignores non-.js files under scripts/', () => {
    const d = skillDir('acme', 'A.', { 'api.js': 'function a() {}', 'notes.txt': 'x' });
    expect(Object.keys(readSkillDir(d).files).sort()).toEqual(['skills/acme/SKILL.md', 'skills/acme/scripts/api.js']);
  });

  it('rejects bad skill folders and duplicate names', () => {
    const expectErr = (fn: () => any, re: RegExp) => {
      expect(fn).toThrow(InputError);
      expect(fn).toThrow(re);
    };
    expectErr(() => readTaskInputs([path.join(dir, 'missing')]), /does not exist/);
    const wrong = path.join(dir, 'wrong-dir');
    fs.mkdirSync(wrong);
    fs.writeFileSync(path.join(wrong, 'SKILL.md'), md('acme'));
    expectErr(() => readTaskInputs([wrong]), /folder name must equal the skill name "acme"/);
    const nofm = path.join(dir, 'nofm');
    fs.mkdirSync(nofm);
    fs.writeFileSync(path.join(nofm, 'SKILL.md'), '# no frontmatter');
    expectErr(() => readTaskInputs([nofm]), /no frontmatter name/);
    const other = fs.mkdtempSync(path.join(dir, 'o-'));
    expectErr(() => readTaskInputs([skillDir('acme'), skillDir('acme', 'again', {}, other)]), /passed twice/);
    const a = path.join(dir, 'a'), b = path.join(dir, 'b');
    fs.mkdirSync(a); fs.mkdirSync(b);
    fs.writeFileSync(path.join(a, 'x.txt'), '1'); fs.writeFileSync(path.join(b, 'x.txt'), '2');
    expectErr(() => readTaskInputs([], [path.join(a, 'x.txt'), path.join(b, 'x.txt')]), /two input files are named "x.txt"/);
    expectErr(() => readTaskInputs([], [dir]), /is not a file/);
  });

  it('caps the total input size', () => {
    const big = path.join(dir, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(MAX_INPUT_BYTES + 1));
    expect(() => readTaskInputs([], [big])).toThrow(/the limit is 25 MB/);
  });

  it('drops inputs that come back unchanged, keeps a re-saved skill', () => {
    const inputs = readTaskInputs([skillDir('acme', 'Old.')]).files;
    const back = {
      ...inputs,
      'skills/acme/SKILL.md': { ...inputs['skills/acme/SKILL.md'], base64: b64(md('acme', 'New.')) },
      'result.json': { base64: b64('{}') },
    };
    expect(Object.keys(dropInputEcho(back, inputs)).sort()).toEqual(['result.json', 'skills/acme/SKILL.md']);
  });

  it('reports skipped preloads, and old extensions that report nothing', () => {
    expect(formatPreloadFooter(undefined, [])).toBe('');
    expect(formatPreloadFooter({ loaded: ['a'], skipped: [] }, ['a'])).toBe('');
    expect(formatPreloadFooter(undefined, ['a'])).toMatch(/may be too old/);
    const f = formatPreloadFooter({ loaded: ['a'], skipped: [{ name: 'b', error: 'skill-limit-reached', message: 'Already 5 skills loaded' }] }, ['a', 'b']);
    expect(f).toContain('Skills not preloaded (1):\n- b: Already 5 skills loaded');
  });
});
