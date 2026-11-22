// mend applies patches to a tree of text files as specified in SPEC.md.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  move(old: string, next: string, text: string): void {
    this.now.set(old, null);
    this.now.set(next, text);
    this.moves.push([old, next]);
  }
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function parseError(index: number): never {
  throw new Exit2(`error: parse ${index + 1}`);
}

function checkPath(path: string): void {
  if (!safe(path)) throw new Fail('unsafe', path);
}

function requireFile(tree: Tree, path: string): string {
  const text = tree.get(path);
  if (text === null) throw new Fail('missing', path);
  return text;
}

function requireAbsent(tree: Tree, path: string): void {
  if (tree.get(path) !== null) throw new Fail('exists', path);
}

type LineFile = { lines: string[]; br: string; final: boolean };

function readLines(text: string): LineFile {
  const firstLF = text.indexOf('\n');
  const br = firstLF > 0 && text[firstLF - 1] === '\r' ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function writeLines({ lines, br, final }: LineFile): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

function createLines(lines: string[], final = true): string {
  return writeLines({ lines, br: '\n', final });
}

const indent = (line: string): string => line.match(/^[ \t]*/)![0];
const matchTiers = [
  (line: string) => line,
  (line: string) => line.replace(/[ \t]+$/, ''),
  (line: string) => line.replace(/^[ \t]+|[ \t]+$/g, ''),
];

function occurrences(lines: string[], old: string[], strict: boolean, start = 0, eof = false) {
  const last = lines.length - old.length;
  for (let tier = 0; tier < (strict ? 1 : matchTiers.length); tier++) {
    const normalize = matchTiers[tier]!;
    const expected = old.map(normalize);
    const positions: number[] = [];
    for (let at = eof ? Math.max(start, last) : start; at <= last; at++) {
      if (expected.every((line, offset) => normalize(lines[at + offset]!) === line)) positions.push(at);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

type Replacement = { text: string; context?: number };
type LineEdit = { old: string[]; next: Replacement[] };

function bodyEdit(body: string[]): LineEdit {
  const old: string[] = [];
  const next: Replacement[] = [];
  for (const line of body) {
    const text = line.slice(1);
    if (line.startsWith('+')) next.push({ text });
    else if (line.startsWith('-')) old.push(text);
    else if (line === '' || line.startsWith(' ')) {
      next.push({ text, context: old.length });
      old.push(text);
    }
  }
  return { old, next };
}

function replaceLines(file: LineFile, edit: LineEdit, at: number, tier: number): void {
  const patchIndent = tier === 2 ? indent(edit.old[0]!) : '';
  const fileIndent = tier === 2 ? indent(file.lines[at]!) : '';
  const next = edit.next.map(({ text, context }) => {
    if (context !== undefined) return file.lines[at + context]!;
    if (tier === 2 && !blank(text) && text.startsWith(patchIndent)) return fileIndent + text.slice(patchIndent.length);
    return text;
  });
  file.lines = [...file.lines.slice(0, at), ...next, ...file.lines.slice(at + edit.old.length)];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const markers = lines.map((line) => line.trimEnd());
  let path: string | undefined;
  let candidate: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (markers[i] !== '<<<<<<< SEARCH') {
      const trimmed = lines[i]!.trim();
      if (trimmed && !trimmed.startsWith('```')) candidate = trimmed;
      continue;
    }
    path = candidate ?? path;
    const separator = markers.indexOf('=======', i + 1);
    const end = separator < 0 ? -1 : markers.indexOf('>>>>>>> REPLACE', separator + 1);
    if (path === undefined || end < 0) parseError(i);
    const target = path;
    const old = lines.slice(i + 1, separator);
    const added = lines.slice(separator + 1, end);
    const replacement = { old, next: added.map((text) => ({ text })) };
    edits.push((tree) => {
      checkPath(target);
      if (old.length === 0) {
        requireAbsent(tree, target);
        tree.now.set(target, createLines(added));
        return;
      }
      const file = readLines(requireFile(tree, target));
      const match = occurrences(file.lines, old, strict);
      if (!match) throw new Fail('no-match', target);
      if (match.positions.length > 1) throw new Fail('ambiguous', target);
      replaceLines(file, replacement, match.positions[0]!, match.tier);
      tree.now.set(target, writeLines(file));
    });
    i = end;
    candidate = undefined;
  }
  return edits;
}

type Hunk = LineEdit & { start: number; body: string[]; final: boolean };
type UnifiedSection = {
  old: string | null;
  next: string | null;
  headers: boolean;
  renameFrom?: string;
  renameTo?: string;
  create?: boolean;
  remove?: boolean;
  hunks: Hunk[];
};

function unifiedPath(line: string): string | null {
  const path = line.slice(4).split('\t', 1)[0]!.trim();
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
}

function unifiedEdit(section: UnifiedSection, strict: boolean): Edit {
  const old = section.headers ? section.old : section.renameFrom ?? section.old;
  const next = section.headers ? section.next : section.renameTo ?? section.next;
  return (tree) => {
    if (old !== null) checkPath(old);
    if (next !== null) checkPath(next);
    if (old === null || section.create) {
      const path = next ?? '';
      checkPath(path);
      requireAbsent(tree, path);
      const added: string[] = [];
      let final = true;
      for (const { body } of section.hunks) {
        body.forEach((line, i) => {
          if (line.startsWith('+')) {
            added.push(line.slice(1));
            final = !body[i + 1]?.startsWith('\\');
          }
        });
      }
      tree.now.set(path, createLines(added, final));
      return;
    }
    const before = requireFile(tree, old);
    if (next === null || section.remove) {
      tree.now.set(old, null);
      return;
    }
    if (old !== next) requireAbsent(tree, next);
    const file = readLines(before);
    let delta = 0;
    for (const hunk of section.hunks) {
      let at = Math.max(0, Math.min(file.lines.length, hunk.start + delta));
      let tier = 0;
      if (hunk.old.length > 0) {
        const match = occurrences(file.lines, hunk.old, strict);
        if (!match) throw new Fail('no-match', old);
        const expected = hunk.start - 1 + delta;
        // Positions are ascending, so the earlier one wins a tie.
        at = match.positions.reduce((best, position) =>
          Math.abs(position - expected) < Math.abs(best - expected) ? position : best);
        tier = match.tier;
      }
      if (at + hunk.old.length === file.lines.length) file.final = hunk.final;
      replaceLines(file, hunk, at, tier);
      delta += hunk.next.length - hunk.old.length;
    }
    if (old === next) tree.now.set(old, writeLines(file));
    else tree.move(old, next, writeLines(file));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | undefined;
  const headerPair = (i: number): boolean => lines[i]!.startsWith('--- ') && !!lines[i + 1]?.startsWith('+++ ');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!header) parseError(i);
      section = { old: header[1]!, next: header[2]!, headers: false, hunks: [] };
      sections.push(section);
    } else if (line.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (!header || !section) parseError(i);
      const start = i + 1;
      let end = start;
      while (end < lines.length && /^(?:[ +\\-]|$)/.test(lines[end]!) && !headerPair(end)) end++;
      i = end - 1;
      while (end > start && lines[end - 1] === '') end--;
      const body = lines.slice(start, end);
      const lastOutput = body.findLastIndex((entry) => entry === '' || entry.startsWith(' ') || entry.startsWith('+'));
      const final = lastOutput < 0 || !body[lastOutput + 1]?.startsWith('\\');
      section.hunks.push({ ...bodyEdit(body), body, start: Number(header[1]), final });
    } else if (line.startsWith('--- ') && (headerPair(i) || (section && section.hunks.length === 0))) {
      if (!headerPair(i)) parseError(i + 1);
      if (!section || section.hunks.length > 0) {
        section = { old: null, next: null, headers: false, hunks: [] };
        sections.push(section);
      }
      section.old = unifiedPath(line);
      section.next = unifiedPath(lines[++i]!);
      section.headers = true;
    } else if (section && section.hunks.length === 0) {
      if (line.startsWith('rename from ')) section.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) section.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) section.create = true;
      else if (line.startsWith('deleted file mode')) section.remove = true;
    }
  }
  return sections.map((section) => unifiedEdit(section, strict));
}

type Chunk = LineEdit & { anchor: string; eof: boolean };

function v4aUpdate(path: string, destination: string | undefined, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    checkPath(path);
    if (destination !== undefined) checkPath(destination);
    const before = requireFile(tree, path);
    if (destination !== undefined) requireAbsent(tree, destination);
    const file = readLines(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== '') {
        const anchor = occurrences(file.lines, [chunk.anchor], strict, cursor);
        if (!anchor) throw new Fail('no-match', path);
        cursor = anchor.positions[0]! + 1;
      }
      let at = chunk.eof ? file.lines.length : cursor;
      let tier = 0;
      if (chunk.old.length > 0) {
        const match = occurrences(file.lines, chunk.old, strict, cursor, chunk.eof);
        if (!match) throw new Fail('no-match', path);
        at = match.positions[0]!;
        tier = match.tier;
      }
      replaceLines(file, chunk, at, tier);
      cursor = at + chunk.next.length;
    }
    if (destination === undefined) tree.now.set(path, writeLines(file));
    else tree.move(path, destination, writeLines(file));
  };
}

function v4aChunks(lines: string[], start: number, end: number): Chunk[] {
  const chunks: Chunk[] = [];
  let i = start;
  while (i < end) {
    const line = lines[i]!;
    const explicit = line.startsWith('@@');
    if (!explicit && (chunks.length > 0 || !/^(?:[ +-]|$)/.test(line))) parseError(i);
    const anchor = explicit ? lines[i++]!.slice(2).trim() : '';
    const bodyStart = i;
    while (i < end && /^(?:[ +-]|$)/.test(lines[i]!)) i++;
    const body = lines.slice(bodyStart, i);
    const eof = i < end && lines[i] === '*** End of File';
    if (eof) i++;
    chunks.push({ ...bodyEdit(body), anchor, eof });
  }
  return chunks;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') parseError(Math.max(0, first));
  const last = lines.findLastIndex((line) => !blank(line));
  if (lines[last]!.trim() !== '*** End Patch') parseError(lines.length);
  const edits: Edit[] = [];
  const sectionHeader = /^\*\*\* (Add|Delete|Update) File: (.*)$/;
  for (let i = first + 1; i < last;) {
    const header = i;
    const line = lines[i++]!;
    if (blank(line)) continue;
    const match = sectionHeader.exec(line);
    if (!match) parseError(header);
    const [, kind, rawPath] = match;
    const path = rawPath!.trim();
    let end = i;
    while (end < last && !sectionHeader.test(lines[end]!)) end++;
    let bodyEnd = end;
    while (bodyEnd > i && blank(lines[bodyEnd - 1]!)) bodyEnd--;
    if (kind === 'Add') {
      const added: string[] = [];
      for (let j = i; j < bodyEnd; j++) {
        const entry = lines[j]!;
        if (entry !== '' && !entry.startsWith('+')) parseError(j);
        added.push(entry.slice(1));
      }
      edits.push((tree) => {
        checkPath(path);
        requireAbsent(tree, path);
        tree.now.set(path, createLines(added));
      });
    } else if (kind === 'Delete') {
      if (i < bodyEnd) parseError(i);
      edits.push((tree) => {
        checkPath(path);
        requireFile(tree, path);
        tree.now.set(path, null);
      });
    } else {
      const movePrefix = '*** Move to: ';
      const destination = i < bodyEnd && lines[i]!.startsWith(movePrefix)
        ? lines[i++]!.slice(movePrefix.length).trim()
        : undefined;
      const chunks = v4aChunks(lines, i, bodyEnd);
      if (chunks.length === 0 && destination === undefined) parseError(header);
      edits.push(v4aUpdate(path, destination, chunks, strict));
    }
    i = end;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    switch (kind) {
      case 'json': edits = jsonEdits(text, lines); break;
      case 'unified': edits = unifiedEdits(lines, strict); break;
      case 'search-replace': edits = searchReplaceEdits(lines, strict); break;
      case 'v4a': edits = v4aEdits(lines, strict); break;
      default: throw new Exit2('error: format');
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      tree.moves.length = moveCount;
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changes = new Map<string, string>();
  for (const [p, now] of tree.now) {
    const was = tree.original(p);
    if (was === now) continue;
    changes.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const [old, next] of tree.moves) {
    if (changes.get(old) === 'D' && changes.get(next) === 'A') {
      changes.delete(old);
      changes.set(next, `R ${old} -> ${next}`);
    }
  }
  const rows = [...changes].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([path, change]) => change.length === 1 ? `${change} ${path}` : change);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
