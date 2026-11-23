// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON tool calls), finds the lines each edit names at the first of
// three matching tiers, and changes every file or none. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// SPEC.md is the whole contract: this file implements sections 1 to 10 of
// it, including the three-tier matcher, all four readers, and the
// all-or-nothing write with move reporting.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

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

// ---- Files: lines, line break, final break (SPEC.md section 3) ----

interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// ---- Matching lines (SPEC.md section 5) ----

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line. */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

function replaceLines(lines: string[], o: string[], n: NLine[], pos: number, tier: number): string[] {
  const out = lines.slice(0, pos);
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWs(lines[pos]!);
    p = leadingWs(o[0]!);
  }
  for (const e of n) {
    if (e.ctx) {
      out.push(lines[pos + e.oIdx]!);
    } else {
      let t = e.text;
      if (tier === 2 && t !== '' && trimWs(t) !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  out.push(...lines.slice(pos + o.length));
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<{ old: string; nw: string }> = [];
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

// ---- JSON edits (SPEC.md section 9) ----

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

// ---- Unified diffs (SPEC.md section 6) ----

interface BodyEntry {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
}
interface UniHunk {
  a: number;
  body: BodyEntry[];
}
interface UniSection {
  minus: string | null;
  plus: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffA: string | null;
  diffB: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UniHunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}
function headerPath(rest: string): string {
  return rest.split('\t')[0]!.trim();
}

function splitBody(hunk: UniHunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const e of hunk.body) {
    if (e.kind === 'ctx') {
      o.push(e.text);
      n.push({ text: e.text, ctx: true, oIdx: o.length - 1 });
    } else if (e.kind === 'old') {
      o.push(e.text);
    } else if (e.kind === 'new') {
      n.push({ text: e.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkNoNewline(hunk: UniHunk): boolean {
  for (let k = hunk.body.length - 1; k >= 0; k--) {
    const e = hunk.body[k]!;
    if (e.kind === 'ctx' || e.kind === 'new') return hunk.body[k + 1]?.kind === 'mark';
  }
  return false;
}

/** True when a `\` line follows the last `+` line of any hunk, for a creation. */
function creationNoNewline(hunks: UniHunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const h = hunks[hi]!;
    for (let k = h.body.length - 1; k >= 0; k--) {
      if (h.body[k]!.kind === 'new') return h.body[k + 1]?.kind === 'mark';
    }
  }
  return false;
}

function applyUniHunks(model: FileModel, hunks: UniHunk[], strict: boolean, path: string): FileModel {
  let cur = model;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitBody(h);
    const noNl = hunkNoNewline(h);
    if (o.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), cur.lines.length);
      const lines = [...cur.lines.slice(0, pos), ...n.map((e) => e.text), ...cur.lines.slice(pos)];
      const final = pos === cur.lines.length ? !noNl : cur.final;
      cur = { lines, br: cur.br, final };
    } else {
      const found = findTier(cur.lines, o, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const lines = replaceLines(cur.lines, o, n, best, found.tier);
      const final = best + o.length === cur.lines.length ? !noNl : cur.final;
      cur = { lines, br: cur.br, final };
    }
    d += n.length - o.length;
  }
  return cur;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let hunk: UniHunk | null = null;
  const endHunk = (): void => {
    if (hunk) {
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      hunk = null;
    }
  };
  const freshSection = (): UniSection => {
    const s: UniSection = {
      minus: null,
      plus: null,
      renameFrom: null,
      renameTo: null,
      diffA: null,
      diffB: null,
      newFile: false,
      delFile: false,
      hunks: [],
    };
    sections.push(s);
    sec = s;
    return s;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      endHunk();
      const s = freshSection();
      s.diffA = m[1]!;
      s.diffB = m[2]!;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      endHunk();
      const oldP = stripAB(headerPath(line.slice(4)));
      const newP = stripAB(headerPath(lines[i + 1]!.slice(4)));
      if (sec !== null && sec.hunks.length === 0 && !(sec.minus !== null && sec.plus !== null)) {
        sec.minus = oldP;
        sec.plus = newP;
      } else {
        const s = freshSection();
        s.minus = oldP;
        s.plus = newP;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/.exec(line);
      if (!m || sec === null) throw new Exit2(`error: parse ${i + 1}`);
      endHunk();
      hunk = { a: Number(m[1]), body: [] };
      sec.hunks.push(hunk);
      continue;
    }
    if (hunk !== null) {
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        if (line === '') hunk.body.push({ kind: 'ctx', text: '' });
        else if (line[0] === ' ') hunk.body.push({ kind: 'ctx', text: line.slice(1) });
        else if (line[0] === '-') hunk.body.push({ kind: 'old', text: line.slice(1) });
        else if (line[0] === '+') hunk.body.push({ kind: 'new', text: line.slice(1) });
        else hunk.body.push({ kind: 'mark', text: line.slice(1) });
        continue;
      }
      endHunk();
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        sec.plus = stripAB(headerPath(line.slice(4)));
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice('rename from '.length).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice('rename to '.length).trim();
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.newFile = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.delFile = true;
        continue;
      }
    }
    // Outside bodies, lines that are not part of a section header are ignored.
  }
  endHunk();

  const edits: Edit[] = [];
  for (const s of sections) {
    const rawOld = s.minus ?? s.renameFrom ?? s.diffA ?? null;
    const rawNew = s.plus ?? s.renameTo ?? s.diffB ?? null;
    const oldPath = rawOld === '/dev/null' ? null : rawOld;
    const newPath = rawNew === '/dev/null' ? null : rawNew;
    const hunks = s.hunks;
    if (oldPath === null && newPath === null) {
      edits.push(() => undefined);
      continue;
    }
    const isCreate = s.newFile || oldPath === null;
    const isDelete = !isCreate && (s.delFile || newPath === null);
    const isMove = !isCreate && !isDelete && oldPath !== newPath;
    if (isCreate) {
      const np = newPath!;
      edits.push((tree) => {
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const content: string[] = [];
        for (const h of hunks) for (const e of h.body) if (e.kind === 'new') content.push(e.text);
        tree.now.set(np, content.length === 0 ? '' : content.join('\n') + (creationNoNewline(hunks) ? '' : '\n'));
      });
    } else if (isDelete) {
      const op = oldPath!;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      });
    } else if (isMove) {
      const op = oldPath!;
      const np = newPath!;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const cur = tree.get(op);
        if (cur === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const model = applyUniHunks(parseFile(cur), hunks, strict, op);
        tree.now.set(op, null);
        tree.now.set(np, serializeFile(model));
        tree.moves.push({ old: op, nw: np });
      });
    } else {
      const p = oldPath!;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const cur = tree.get(p);
        if (cur === null) throw new Fail('missing', p);
        const model = applyUniHunks(parseFile(cur), hunks, strict, p);
        tree.now.set(p, serializeFile(model));
      });
    }
  }
  return edits;
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdit(path: string, old: string[], nw: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (old.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, nw.length === 0 ? '' : nw.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const model = parseFile(cur);
    const found = findTier(model.lines, old, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const n: NLine[] = nw.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const lines = replaceLines(model.lines, old, n, pos, found.tier);
    tree.now.set(path, serializeFile({ lines, br: model.br, final: model.final }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let m = i - 1; m > prevEnd; m--) {
      const t = lines[m]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    const old = lines.slice(i + 1, j);
    const nw = lines.slice(j + 1, k);
    edits.push(srEdit(path, old, nw, strict));
    prevPath = path;
    prevEnd = k;
    i = k + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface V4Chunk {
  anchor: string | null;
  body: BodyEntry[];
  eof: boolean;
}

function v4SectionStart(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith('*** Add File:')) return 'add';
  if (line.startsWith('*** Delete File:')) return 'delete';
  if (line.startsWith('*** Update File:')) return 'update';
  return null;
}

function v4AddEdit(path: string, addLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
  };
}

function v4DeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4UpdateEdit(path: string, moveTo: string | null, chunks: V4Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let model = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(model.lines, [ch.anchor], strict, cursor);
        if (!found) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const o: string[] = [];
      const n: NLine[] = [];
      for (const e of ch.body) {
        if (e.kind === 'ctx') {
          o.push(e.text);
          n.push({ text: e.text, ctx: true, oIdx: o.length - 1 });
        } else if (e.kind === 'old') {
          o.push(e.text);
        } else if (e.kind === 'new') {
          n.push({ text: e.text, ctx: false, oIdx: -1 });
        }
      }
      if (o.length === 0) {
        const pos = ch.eof ? model.lines.length : cursor;
        const lines = [...model.lines.slice(0, pos), ...n.map((e) => e.text), ...model.lines.slice(pos)];
        model = { lines, br: model.br, final: model.final };
        cursor = pos + n.length;
      } else {
        const found = findTier(model.lines, o, strict, cursor);
        if (!found) throw new Fail('no-match', path);
        let occ = found.occ;
        if (ch.eof) occ = occ.filter((p) => p + o.length === model.lines.length);
        if (occ.length === 0) throw new Fail('no-match', path);
        const pos = occ[0]!;
        const lines = replaceLines(model.lines, o, n, pos, found.tier);
        model = { lines, br: model.br, final: model.final };
        cursor = pos + n.length;
      }
    }
    const out = serializeFile(model);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const kind = v4SectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? '*** Add File:' : kind === 'delete' ? '*** Delete File:' : '*** Update File:';
    const path = line.slice(prefix.length).trim();
    const startLine = i + 1;
    i++;
    const raw: number[] = [];
    while (i < last && v4SectionStart(lines[i]!) === null) {
      raw.push(i);
      i++;
    }
    while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const ri of raw) {
        const l = lines[ri]!;
        if (l === '') addLines.push('');
        else if (l.startsWith('+')) addLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${ri + 1}`);
      }
      edits.push(v4AddEdit(path, addLines));
    } else if (kind === 'delete') {
      for (const ri of raw) {
        if (!blank(lines[ri]!)) throw new Exit2(`error: parse ${ri + 1}`);
      }
      edits.push(v4DeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let pos = 0;
      if (pos < raw.length && lines[raw[pos]!]!.startsWith('*** Move to:')) {
        moveTo = lines[raw[pos]!]!.slice('*** Move to:'.length).trim();
        pos++;
      }
      const chunks: V4Chunk[] = [];
      let cur: V4Chunk | null = null;
      for (; pos < raw.length; pos++) {
        const ri = raw[pos]!;
        const l = lines[ri]!;
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
        } else if (l.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${ri + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length === 0) cur = { anchor: null, body: [], eof: false };
            else if (blank(l)) continue;
            else throw new Exit2(`error: parse ${ri + 1}`);
          }
          if (l === '') cur.body.push({ kind: 'ctx', text: '' });
          else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l[0] === '-') cur.body.push({ kind: 'old', text: l.slice(1) });
          else cur.body.push({ kind: 'new', text: l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${ri + 1}`);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      edits.push(v4UpdateEdit(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

// ---- Run (SPEC.md sections 1, 2, 10) ----

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const wasNew = tree.original(m.nw);
    if (wasOld !== null && tree.get(m.old) === null && wasNew === null && tree.get(m.nw) !== null) {
      rows.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
      usedOld.add(m.old);
      usedNew.add(m.nw);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      if (tree.now.get(p) === null && tree.original(p) !== null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null || now === tree.original(p)) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
