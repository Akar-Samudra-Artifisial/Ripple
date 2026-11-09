// Copied from Tripwire (src/core/pageText.ts); keep the two in step by hand.

/** Upper bound on page text sent to the LLM. */
export const MAX_PAGE_CHARS = 12_000;

export const TRUNCATED_MARK = '…[truncated]';

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

const TOKEN = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)[^>]*?(\/?)>|[^<]+|</g;
const LINE_BREAK = new Set(['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'li', 'div', 'blockquote', 'pre', 'ul', 'ol', 'table']);

/**
 * Confluence storage format (XHTML) → plain text for the LLM. Macros are dropped except their rich-text body,
 * macro parameters are dropped, list items become "- " lines and table cells are separated by " | ".
 */
export function storageToText(xhtml: string, maxChars = MAX_PAGE_CHARS): string {
  // Each frame says whether text inside it is visible; the innermost frame wins.
  const stack: { tag: string; visible: boolean }[] = [];
  const visible = () => stack[stack.length - 1]?.visible ?? true;
  let out = '';
  // Starts a new line unless already at the start of one (or right after a "- " list marker).
  const newline = () => {
    if (out !== '' && !out.endsWith('\n') && !/(^|\n)- $/.test(out)) out += '\n';
  };

  for (const m of xhtml.matchAll(TOKEN)) {
    const token = m[0];
    if (m[1] !== undefined) {
      if (visible()) out += m[1];
      continue;
    }
    if (token.startsWith('<!--')) continue;
    const tag = m[2]?.toLowerCase();
    if (tag === undefined) {
      if (visible()) out += decodeEntities(token);
      continue;
    }
    const closing = token.startsWith('</');
    const selfClosing = m[3] === '/';

    if (tag === 'ac:structured-macro' || tag === 'ac:parameter' || tag === 'ac:plain-text-body' || tag === 'ac:rich-text-body') {
      if (selfClosing) continue;
      if (closing) {
        const idx = stack.map((f) => f.tag).lastIndexOf(tag);
        if (idx >= 0) stack.splice(idx);
      } else {
        stack.push({ tag, visible: tag === 'ac:rich-text-body' });
      }
      continue;
    }
    if (!visible()) continue;
    if (tag === 'li' && !closing) {
      if (/(^|\n)- $/.test(out)) out += '\n';
      else newline();
      out += '- ';
    } else if ((tag === 'td' || tag === 'th') && !closing) out += ' | ';
    else if (LINE_BREAK.has(tag)) newline();
  }

  const text = out
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}${TRUNCATED_MARK}` : text;
}
