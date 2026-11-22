import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PATCH_BYTES = 1024 * 1024;
const blank = (s: string): boolean => s.trim() === '';

class ParseError extends Error {}
class SizeLimit extends Error {}
class PatchError extends Error {
  constructor(code: string, path: string) {
    super(`error: ${code} ${path}`);
  }
}

function parse(index: number): never {
  throw new ParseError(`error: parse ${index + 1}`);
}

function patchLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function safe(path: string): void {
  if (path.includes('\\') || path.includes('\0') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new PatchError('unsafe', path);
  }
}

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly originalModes = new Map<string, number>();
  readonly modes = new Map<string, number>();
  readonly moves = new Map<string, string>();

  original(path: string): string | null {
    if (!this.orig.has(path)) {
      let text = null;
      try {
        const stat = statSync(path);
        if (stat.isFile()) {
          if (stat.size > MAX_FILE_BYTES) throw new SizeLimit();
          text = readFileSync(path, 'utf8');
          this.originalModes.set(path, stat.mode & 0o7777);
        }
      } catch (error) {
        if (error instanceof SizeLimit) throw error;
        text = null;
      }
      this.orig.set(path, text);
    }
    return this.orig.get(path)!;
  }

  get(path: string): string | null {
    return this.now.has(path) ? this.now.get(path)! : this.original(path);
  }

  require(path: string): string {
    const text = this.get(path);
    if (text === null) throw new PatchError('missing', path);
    return text;
  }

  vacant(path: string): void {
    if (this.get(path) !== null) throw new PatchError('exists', path);
  }

  create(path: string, text: string): void {
    this.vacant(path);
    this.now.set(path, text);
    this.modes.set(path, 0o644);
  }

  move(oldPath: string, newPath: string, text: string): void {
    this.now.set(oldPath, null);
    this.now.set(newPath, text);
    this.modes.set(newPath, this.modes.get(oldPath) ?? this.originalModes.get(oldPath)!);
    this.moves.set(oldPath, newPath);
  }
}

type Edit = (tree: Tree) => void;

class FileLines {
  readonly break: string;
  lines: string[];
  final: boolean;

  constructor(text: string) {
    const first = text.indexOf('\n');
    this.break = first > 0 && text[first - 1] === '\r' ? '\r\n' : '\n';
    this.lines = text ? text.split(this.break) : [];
    this.final = text.endsWith(this.break);
    if (this.final) this.lines.pop();
  }

  replace(at: number, count: number, lines: string[]): void {
    this.lines = this.lines.slice(0, at).concat(lines, this.lines.slice(at + count));
  }

  text(): string {
    return this.lines.length ? this.lines.join(this.break) + (this.final ? this.break : '') : '';
  }
}

const newFile = (lines: string[]): string => lines.length ? lines.join('\n') + '\n' : '';

function detect(lines: string[]): string | null {
  const first = lines.find((line) => !blank(line))?.trim();
  if (!first) return null;
  if (first === '*** Begin Patch') return 'v4a';
  if (first[0] === '[' || first[0] === '{') return 'json';
  if (lines.some((line) => line.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((line, i) => line.startsWith('diff --git ') || headerPair(lines, i))) return 'unified';
  return null;
}

function jsonEdit(value: unknown): Edit | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const path = o.path;
  if (typeof path !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      safe(path);
      tree.create(path, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      safe(path);
      const before = tree.require(path);
      const crlf = before.indexOf('\n') > 0 && before[before.indexOf('\n') - 1] === '\r';
      const lf = (s: string): string => crlf ? s.replaceAll('\r\n', '\n') : s;
      const text = lf(before);
      const old = lf(oldStr);
      const at = text.indexOf(old);
      if (at < 0) throw new PatchError('no-match', path);
      if (text.indexOf(old, at + 1) >= 0) throw new PatchError('ambiguous', path);
      const out = text.slice(0, at) + lf(newStr) + text.slice(at + old.length);
      tree.now.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const at = o.insert_line;
    const add = o.new_str === '' ? [] : o.new_str.split('\n').map((line) => line.replace(/\r$/, ''));
    if (o.new_str.endsWith('\n')) add.pop();
    return (tree) => {
      safe(path);
      const file = new FileLines(tree.require(path));
      if (at < 0 || at > file.lines.length) throw new PatchError('no-match', path);
      file.replace(at, 0, add);
      tree.now.set(path, file.text());
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  if (first < 0) parse(0);
  function read(text: string, index: number): unknown {
    try {
      return JSON.parse(text);
    } catch {
      parse(index);
    }
  }
  function edit(value: unknown, index: number): Edit {
    return jsonEdit(value) ?? parse(index);
  }
  if (lines[first].trimStart().startsWith('[')) {
    const entries = read(text, first);
    if (!Array.isArray(entries)) parse(first);
    return Array.from(entries, (entry) => edit(entry, first));
  }
  const edits: Edit[] = [];
  lines.forEach((line, index) => {
    if (!blank(line)) edits.push(edit(read(line, index), index));
  });
  return edits;
}

const normalize = [
  (line: string): string => line,
  (line: string): string => line.replace(/[ \t]+$/, ''),
  (line: string): string => line.replace(/^[ \t]+|[ \t]+$/g, ''),
];

type BodyLine = { kind: ' ' | '-' | '+'; text: string; noBreak?: boolean };

function bodyLine(line: string): BodyLine {
  return { kind: (line[0] || ' ') as BodyLine['kind'], text: line.slice(1) };
}

function matches(lines: string[], old: string[], strict: boolean, start = 0, end = lines.length - old.length) {
  for (let tier = 0; tier < (strict ? 1 : normalize.length); tier += 1) {
    const norm = normalize[tier];
    const wanted = old.map(norm);
    const positions: number[] = [];
    for (let at = start; at <= end; at += 1) {
      if (wanted.every((line, offset) => line === norm(lines[at + offset]))) positions.push(at);
    }
    if (positions.length) return { tier, positions };
  }
  return null;
}

function replacement(body: BodyLine[], lines: string[], at: number, tier: number): string[] {
  const first = body.find((line) => line.kind !== '+');
  const patchIndent = first?.text.match(/^[ \t]*/)![0] ?? '';
  const fileIndent = lines[at]?.match(/^[ \t]*/)![0] ?? '';
  const out: string[] = [];
  let cursor = at;
  for (const line of body) {
    if (line.kind === ' ') out.push(lines[cursor++]);
    else if (line.kind === '-') cursor += 1;
    else if (tier === 2 && !blank(line.text) && line.text.startsWith(patchIndent)) {
      out.push(fileIndent + line.text.slice(patchIndent.length));
    } else out.push(line.text);
  }
  return out;
}

function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousPath: string | undefined;
  let boundary = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') continue;
    let name = i - 1;
    while (name >= boundary && (blank(lines[name]) || lines[name].trim().startsWith('```'))) name -= 1;
    const path = name >= boundary ? lines[name].trim() : previousPath ?? parse(i);
    let split = i + 1;
    while (split < lines.length && !['=======', '<<<<<<< SEARCH', '>>>>>>> REPLACE'].includes(lines[split].trimEnd())) split += 1;
    if (lines[split]?.trimEnd() !== '=======') parse(i);
    let end = split + 1;
    while (end < lines.length && !['<<<<<<< SEARCH', '>>>>>>> REPLACE'].includes(lines[end].trimEnd())) end += 1;
    if (lines[end]?.trimEnd() !== '>>>>>>> REPLACE') parse(i);
    const old = lines.slice(i + 1, split);
    const added = lines.slice(split + 1, end);
    edits.push((tree) => {
      safe(path);
      if (!old.length) {
        tree.create(path, newFile(added));
        return;
      }
      const file = new FileLines(tree.require(path));
      const match = matches(file.lines, old, strict);
      if (!match) throw new PatchError('no-match', path);
      if (match.positions.length !== 1) throw new PatchError('ambiguous', path);
      const at = match.positions[0];
      const body: BodyLine[] = [
        ...old.map((text): BodyLine => ({ kind: '-', text })),
        ...added.map((text): BodyLine => ({ kind: '+', text })),
      ];
      file.replace(at, old.length, replacement(body, file.lines, at, match.tier));
      tree.now.set(path, file.text());
    });
    previousPath = path;
    boundary = end + 1;
    i = end;
  }
  return edits;
}

function headerPair(lines: string[], index: number): boolean {
  return lines[index]?.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ');
}

const diffPath = (path: string): string => path.split('\t', 1)[0].trim().replace(/^[ab]\//, '');
type Hunk = { start: number | null; body: BodyLine[] };
type Section = {
  oldPath: string;
  newPath: string;
  renameFrom?: string;
  renameTo?: string;
  paired: boolean;
  create: boolean;
  delete: boolean;
  hunks: Hunk[];
};

function unifiedEdit(section: Section, strict: boolean): Edit {
  const oldPath = (!section.paired && section.renameFrom !== undefined) ? section.renameFrom : section.oldPath;
  const newPath = (!section.paired && section.renameTo !== undefined) ? section.renameTo : section.newPath;
  const create = section.create || oldPath === '/dev/null';
  const remove = section.delete || newPath === '/dev/null';
  return (tree) => {
    if (oldPath !== '/dev/null') safe(oldPath);
    if (newPath !== '/dev/null') safe(newPath);
    if (create) {
      const added = section.hunks.flatMap(({ body }) => body.filter((line) => line.kind === '+'));
      tree.create(newPath, added.length ? added.map((line) => line.text).join('\n') + (added.at(-1)?.noBreak ? '' : '\n') : '');
      return;
    }
    const before = tree.require(oldPath);
    if (remove) {
      const file = new FileLines(before);
      const body = section.hunks.flatMap((hunk) => hunk.body);
      const old = body.filter((line) => line.kind !== '+').map((line) => line.text);
      if (body.some((line) => line.kind !== '-') || old.length !== file.lines.length ||
          !matches(file.lines, old, strict)) throw new PatchError('no-match', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    const moving = oldPath !== newPath;
    if (moving) tree.vacant(newPath);
    const file = new FileLines(before);
    let delta = 0;
    for (const { start, body } of section.hunks) {
      const old = body.filter((line) => line.kind !== '+').map((line) => line.text);
      let at: number;
      let tier = 0;
      if (old.length) {
        const match = matches(file.lines, old, strict);
        if (!match) throw new PatchError('no-match', oldPath);
        tier = match.tier;
        at = match.positions[0];
        if (start === null) {
          if (!body.some((line) => line.kind === ' ')) throw new PatchError('no-match', oldPath);
          if (match.positions.length > 1) throw new PatchError('ambiguous', oldPath);
        } else {
          const near = start - 1 + delta;
          for (const position of match.positions) {
            if (Math.abs(position - near) < Math.abs(at - near)) at = position;
          }
        }
      } else {
        if (start === null) throw new PatchError('no-match', oldPath);
        at = Math.max(0, Math.min(file.lines.length, start + delta));
      }
      const next = replacement(body, file.lines, at, tier);
      if (at + old.length === file.lines.length) file.final = !body.findLast((line) => line.kind !== '-')?.noBreak;
      file.replace(at, old.length, next);
      delta += next.length - old.length;
    }
    if (moving) tree.move(oldPath, newPath, file.text());
    else tree.now.set(oldPath, file.text());
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let section: Section | undefined;
  const open = (oldPath: string, newPath: string): Section => {
    const next = { oldPath, newPath, paired: false, create: false, delete: false, hunks: [] };
    sections.push(next);
    return next;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const paths = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!paths) parse(i);
      section = open(paths[1], paths[2]);
    } else if (headerPair(lines, i)) {
      const oldPath = diffPath(line.slice(4));
      const newPath = diffPath(lines[++i].slice(4));
      if (!section || section.paired || section.hunks.length) section = open(oldPath, newPath);
      section.oldPath = oldPath;
      section.newPath = newPath;
      section.paired = true;
    } else if (line.startsWith('@@')) {
      const headerIndex = i;
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!section || (!header && line.trim() !== '@@')) parse(i);
      const start = header ? Number(header[1]) : null;
      const body: BodyLine[] = [];
      let pendingBlanks = 0;
      while (i + 1 < lines.length && !headerPair(lines, i + 1)) {
        const item = lines[i + 1];
        if (item && !' +-\\'.includes(item[0])) break;
        i += 1;
        if (!item) {
          pendingBlanks += 1;
          continue;
        }
        while (pendingBlanks > 0) {
          body.push(bodyLine(''));
          pendingBlanks -= 1;
        }
        if (item[0] === '\\') {
          const previous = body.at(-1);
          if (previous) previous.noBreak = true;
        } else body.push(bodyLine(item));
      }
      if (header) {
        const expectedOld = Number(header[2] ?? 1);
        const expectedNew = Number(header[4] ?? 1);
        const oldCount = body.filter((item) => item.kind !== '+').length;
        const newCount = body.filter((item) => item.kind !== '-').length;
        // A bare blank can be an unprefixed context line or a separator after the hunk.
        const contextBlanks = expectedOld - oldCount;
        if (contextBlanks < 0 || contextBlanks > pendingBlanks || contextBlanks !== expectedNew - newCount) parse(headerIndex);
        for (let n = 0; n < contextBlanks; n += 1) body.push(bodyLine(''));
      }
      section.hunks.push({ start, body });
    } else if (section && !section.hunks.length) {
      if (line.startsWith('--- ')) parse(i + 1);
      if (line.startsWith('rename from ')) section.renameFrom = line.slice(12);
      if (line.startsWith('rename to ')) section.renameTo = line.slice(10);
      if (line.startsWith('new file mode')) section.create = true;
      if (line.startsWith('deleted file mode')) section.delete = true;
    }
  }
  return sections.map((entry) => unifiedEdit(entry, strict));
}

type Chunk = { anchor: string; eof: boolean; body: BodyLine[] };

function updateEdit(path: string, destination: string | undefined, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    safe(path);
    if (destination !== undefined) safe(destination);
    const file = new FileLines(tree.require(path));
    if (destination !== undefined) tree.vacant(destination);
    let cursor = 0;
    for (const { anchor, eof, body } of chunks) {
      if (anchor) {
        const match = matches(file.lines, [anchor], strict, cursor);
        if (!match) throw new PatchError('no-match', path);
        cursor = match.positions[0] + 1;
      }
      const old = body.filter((line) => line.kind !== '+').map((line) => line.text);
      let at = eof ? file.lines.length - old.length : cursor;
      let tier = 0;
      if (old.length) {
        const match = matches(file.lines, old, strict, eof ? Math.max(cursor, at) : cursor, file.lines.length - old.length);
        if (!match) throw new PatchError('no-match', path);
        at = match.positions[0];
        tier = match.tier;
      }
      const next = replacement(body, file.lines, at, tier);
      file.replace(at, old.length, next);
      cursor = at + next.length;
    }
    if (destination === undefined) tree.now.set(path, file.text());
    else tree.move(path, destination, file.text());
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  if (first < 0 || lines[first].trim() !== '*** Begin Patch') parse(Math.max(first, 0));
  const last = lines.findLastIndex((line) => !blank(line));
  if (last === first || lines[last].trim() !== '*** End Patch') parse(lines.length);
  const edits: Edit[] = [];
  const heading = /^\*\*\* (Add|Delete|Update) File: (.*)$/;
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i])) {
      i += 1;
      continue;
    }
    const header = i;
    const entry = heading.exec(lines[i++]);
    if (!entry) parse(header);
    const path = entry[2].trim();
    const begin = i;
    while (i < last && !heading.test(lines[i])) i += 1;
    let end = i;
    while (end > begin && blank(lines[end - 1])) end -= 1;
    if (entry[1] === 'Add') {
      const added: string[] = [];
      for (let j = begin; j < end; j += 1) {
        if (lines[j] && !lines[j].startsWith('+')) parse(j);
        added.push(lines[j].slice(1));
      }
      edits.push((tree) => {
        safe(path);
        tree.create(path, newFile(added));
      });
    } else if (entry[1] === 'Delete') {
      if (begin < end) parse(begin);
      edits.push((tree) => {
        safe(path);
        tree.require(path);
        tree.now.set(path, null);
      });
    } else {
      let j = begin;
      let destination: string | undefined;
      if (j < end && lines[j].startsWith('*** Move to: ')) destination = lines[j++].slice(13).trim();
      const chunks: Chunk[] = [];
      while (j < end) {
        let anchor = '';
        if (lines[j].startsWith('@@')) anchor = lines[j++].slice(2).trim();
        else if (chunks.length || (lines[j] && !' +-'.includes(lines[j][0]))) parse(j);
        const body: BodyLine[] = [];
        while (j < end && (!lines[j] || ' +-'.includes(lines[j][0]))) body.push(bodyLine(lines[j++]));
        const eof = j < end && lines[j] === '*** End of File';
        if (eof) j += 1;
        chunks.push({ anchor, eof, body });
      }
      if (!chunks.length && destination === undefined) parse(header);
      edits.push(updateEdit(path, destination, chunks, strict));
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const arg of args) {
    if (!ended && arg === '--') ended = true;
    else if (!ended && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=') && format === null && FORMATS.includes(arg.slice(9))) format = arg.slice(9);
      else if (arg === '--check' && !check) check = true;
      else if (arg === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(arg);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = !pos.length || pos[0] === '-' ? null : pos[0];
  let bytes = Buffer.alloc(0);
  try {
    bytes = readFileSync(file ?? 0);
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  if (bytes.length > MAX_PATCH_BYTES) return { code: 124, out: [] };
  const text = bytes.toString(file === null ? 'latin1' : 'utf8');
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (!edits.length) parse(0);
  } catch (error) {
    if (error instanceof ParseError) return { code: 2, out: [error.message] };
    throw error;
  }
  const tree = new Tree();
  const failures: PatchError[] = [];
  for (const edit of edits) {
    try {
      // Each edit stages its result only after all of its validation succeeds.
      edit(tree);
    } catch (error) {
      if (error instanceof SizeLimit) return { code: 124, out: [] };
      if (!(error instanceof PatchError)) throw error;
      failures.push(error);
    }
  }
  if (failures.length) {
    writeSync(2, failures[0].message + '\n');
    return { code: 1, out: [...failures.map((error) => error.message), `failed: ${failures.length} of ${edits.length} edits`] };
  }
  for (const text of tree.now.values()) {
    if (text !== null && Buffer.byteLength(text) > MAX_FILE_BYTES) return { code: 124, out: [] };
  }
  const rows: string[] = [];
  const moved = new Set<string>();
  for (const oldPath of [...tree.moves.keys()].sort()) {
    const newPath = tree.moves.get(oldPath)!;
    if (tree.original(oldPath) !== null && tree.now.get(oldPath) === null &&
        tree.original(newPath) === null && tree.get(newPath) !== null && !moved.has(newPath)) {
      rows.push(`R ${oldPath} -> ${newPath}`);
      moved.add(oldPath);
      moved.add(newPath);
    }
  }
  for (const path of [...tree.now.keys()].sort()) {
    const was = tree.original(path);
    const now = tree.now.get(path)!;
    if (was === now && !tree.modes.has(path)) continue;
    if (was !== now && !moved.has(path)) rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${path}`);
    if (check) continue;
    if (now === null) rmSync(path, { force: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, now);
      chmodSync(path, tree.modes.get(path) ?? tree.originalModes.get(path) ?? 0o644);
    }
  }
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
