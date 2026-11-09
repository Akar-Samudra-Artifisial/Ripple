/**
 * M4: replaces one sentence of a page in Confluence storage format (XHTML) without an HTML parser.
 *
 * The storage is tokenised with the same regex as `storageToText`. Visible text (outside macro parameters and
 * plain-text bodies, comments and attributes) is decoded character by character, each decoded character keeping the
 * storage range it came from (an entity such as `&#36;` or `&nbsp;` is one range). The old sentence is found in that
 * text with the `quoteInText` normalisation (case, curly quotes, dashes, whitespace). Old and new sentence are then
 * compared: the changed part, widened to whole words or numbers, must sit inside ONE storage text node, and only that
 * range of the storage is rewritten. Everything else (markup, entities, other text) stays byte-identical.
 *
 * Anything that cannot be replaced that way is refused with a code (the copy needs a manual edit): the sentence is
 * not found as visible text of one block (split over paragraphs or cells, in CDATA, a macro parameter or an
 * attribute), it occurs more than once, the changed part crosses markup or the old value occurs twice in the sentence.
 */

export type StorageEditCode = 'quote_not_found' | 'sentence_ambiguous' | 'value_ambiguous' | 'value_not_found' | 'crosses_markup' | 'validation_failed';

export type StorageEditResult = { ok: true; body: string; start: number; end: number } | { ok: false; code: StorageEditCode };

const TOKEN = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)[^>]*?(\/?)>|[^<]+|</g;
const ENTITY_OR_CHAR = /&(?:#x[0-9a-f]+|#\d+|[a-z]+);|[\s\S]/giu;
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Tags that end a block of text: a sentence never runs across them. */
const BLOCK = new Set(['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'td', 'th', 'li', 'div', 'blockquote', 'pre', 'ul', 'ol', 'table', 'ac:layout-section', 'ac:layout-cell', 'ac:task', 'ac:task-body']);
const MACRO_FRAMES = new Set(['ac:structured-macro', 'ac:parameter', 'ac:plain-text-body', 'ac:rich-text-body']);
const SEP = '\u0000';

/** One decoded character of visible text and where it came from (`node` = token index; -1 for a block break). */
interface Unit {
  ch: string;
  node: number;
  /** Text inside CDATA is never rewritten. */
  editable: boolean;
  start: number;
  end: number;
}

function decodeOne(raw: string): string {
  if (raw.length === 1 || raw[0] !== '&') return raw;
  const code = raw.slice(1, -1);
  if (code[0] === '#') {
    const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw;
  }
  return NAMED_ENTITIES[code.toLowerCase()] ?? raw;
}

/** Visible characters of the storage, with block breaks as separators. */
function visibleUnits(storage: string): Unit[] {
  const units: Unit[] = [];
  const stack: { tag: string; visible: boolean }[] = [];
  const visible = () => stack[stack.length - 1]?.visible ?? true;
  const brk = (at: number) => {
    if (units.length > 0 && units[units.length - 1]?.ch !== SEP) units.push({ ch: SEP, node: -1, editable: false, start: at, end: at });
  };
  let node = 0;
  for (const m of storage.matchAll(TOKEN)) {
    node++;
    const token = m[0];
    const at = m.index;
    if (m[1] !== undefined) {
      // CDATA: matched like text (a link body) but never edited.
      if (visible()) for (const ch of m[1]) units.push({ ch, node, editable: false, start: at, end: at + token.length });
      continue;
    }
    if (token.startsWith('<!--')) continue;
    const tag = m[2]?.toLowerCase();
    if (tag === undefined) {
      if (token === '<') {
        brk(at);
        continue;
      }
      if (!visible()) continue;
      for (const e of token.matchAll(ENTITY_OR_CHAR)) {
        const start = at + e.index;
        for (const ch of decodeOne(e[0])) units.push({ ch, node, editable: true, start, end: start + e[0].length });
      }
      continue;
    }
    if (MACRO_FRAMES.has(tag)) {
      brk(at);
      if (m[3] === '/') continue;
      if (token.startsWith('</')) {
        const idx = stack.map((f) => f.tag).lastIndexOf(tag);
        if (idx >= 0) stack.splice(idx);
      } else stack.push({ tag, visible: tag === 'ac:rich-text-body' });
      continue;
    }
    if (BLOCK.has(tag)) brk(at);
  }
  return units;
}

interface Mapped {
  text: string;
  /** Per UTF-16 unit of `text`: index of the source unit/character. */
  map: number[];
}

const normChar = (ch: string): string =>
  ch
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/[–—]/g, '-');

/**
 * The `quoteInText` normalisation applied per character, keeping where each output character came from. Runs of
 * whitespace become one space (none at a start or before/after a separator); `sentence` also drops a trailing full stop.
 */
function normalise(chars: readonly string[], sentence: boolean): Mapped {
  let text = '';
  const map: number[] = [];
  let pendingSpace = -1;
  chars.forEach((raw, i) => {
    if (raw === SEP) {
      pendingSpace = -1;
      text += SEP;
      map.push(i);
      return;
    }
    for (const c of normChar(raw)) {
      if (/\s/u.test(c)) {
        if (pendingSpace < 0) pendingSpace = i;
        continue;
      }
      if (pendingSpace >= 0 && text !== '' && !text.endsWith(SEP)) {
        text += ' ';
        map.push(pendingSpace);
      }
      pendingSpace = -1;
      text += c;
      for (let k = 0; k < c.length; k++) map.push(i);
    }
  });
  if (sentence) {
    const cut = text.replace(/[.\s]+$/u, '').length;
    return { text: text.slice(0, cut), map: map.slice(0, cut) };
  }
  return { text, map };
}

const charsOf = (s: string): string[] => [...s];

const isWordAt = (s: string, i: number): boolean => {
  const c = s[i];
  if (c === undefined) return false;
  if (/[\p{L}\p{N}]/u.test(c)) return true;
  // A separator inside a number ("2,000", "1.5").
  return (c === ',' || c === '.') && /\d/.test(s[i - 1] ?? '') && /\d/.test(s[i + 1] ?? '');
};

/** Start indexes of `needle` in `hay` (overlapping occurrences included). */
function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === '') return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** Occurrences of `needle` in `hay` that start and end at word boundaries. */
const wordOccurrences = (hay: string, needle: string): number =>
  occurrences(hay, needle).filter((i) => !(isWordAt(hay, i - 1) && isWordAt(needle, 0)) && !(isWordAt(hay, i + needle.length) && isWordAt(needle, needle.length - 1))).length;

const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** How often `sentence` occurs as visible text of one block of the page (normalised as by `quoteInText`). */
export function sentenceCount(storage: string, sentence: string): number {
  const q = normalise(charsOf(sentence), true).text;
  if (q === '') return 0;
  const page = normalise(visibleUnits(storage).map((u) => u.ch), false).text;
  return occurrences(page, q).length;
}

/**
 * Rewrites `oldSentence` into `newSentence` in the storage, touching only the changed words. See the module comment
 * for what is refused.
 */
export function replaceSentence(storage: string, oldSentence: string, newSentence: string): StorageEditResult {
  const oldRaw = charsOf(oldSentence);
  const newRaw = charsOf(newSentence);
  const o = normalise(oldRaw, true);
  const n = normalise(newRaw, true);
  if (o.text === '' || n.text === '' || o.text.includes(SEP) || n.text.includes(SEP)) return { ok: false, code: 'validation_failed' };
  if (o.text === n.text) return { ok: false, code: 'validation_failed' };

  const units = visibleUnits(storage);
  const page = normalise(
    units.map((u) => u.ch),
    false,
  );
  const found = occurrences(page.text, o.text);
  if (found.length === 0) return { ok: false, code: 'quote_not_found' };
  if (found.length > 1) return { ok: false, code: 'sentence_ambiguous' };
  const at = found[0] as number;

  // Changed region: common prefix/suffix, widened to whole words (the shared parts are identical, so widening is the
  // same on both sentences).
  const max = Math.min(o.text.length, n.text.length);
  let p = 0;
  while (p < max && o.text[p] === n.text[p]) p++;
  let s = 0;
  while (s < max - p && o.text[o.text.length - 1 - s] === n.text[n.text.length - 1 - s]) s++;
  while (p > 0 && isWordAt(o.text, p - 1) && (isWordAt(o.text, p) || isWordAt(n.text, p))) p--;
  while (s > 0 && isWordAt(o.text, o.text.length - s) && (isWordAt(o.text, o.text.length - 1 - s) || isWordAt(n.text, n.text.length - 1 - s))) s--;
  const oldEnd = o.text.length - s;
  const newEnd = n.text.length - s;
  if (oldEnd <= p) return { ok: false, code: 'value_not_found' };
  const oldPart = o.text.slice(p, oldEnd);
  if (wordOccurrences(o.text, oldPart) > 1) return { ok: false, code: 'value_ambiguous' };

  // Storage range of the changed region: one editable text node.
  const pageIdx = (k: number): number => page.map[at + k] as number;
  const first = units[pageIdx(p)] as Unit;
  const last = units[pageIdx(oldEnd - 1)] as Unit;
  for (let i = pageIdx(p); i <= pageIdx(oldEnd - 1); i++) {
    const u = units[i] as Unit;
    if (!u.editable || u.node !== first.node) return { ok: false, code: 'crosses_markup' };
  }

  // Replacement: the new sentence's characters for the changed region, as written there.
  const replacement = newEnd > p ? newRaw.slice(n.map[p] as number, (n.map[newEnd - 1] as number) + 1).join('') : '';
  const start = first.start;
  const end = last.end;
  const body = `${storage.slice(0, start)}${escapeText(replacement)}${storage.slice(end)}`;
  return { ok: true, body, start, end };
}
