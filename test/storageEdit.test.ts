import { describe, expect, it } from 'vitest';
import { replaceSentence, sentenceCount } from '../src/core/storageEdit';

const OLD = 'The per diem for domestic travel is $60 per day.';
const NEW = 'The per diem for domestic travel is $75 per day.';

/** Applies the edit and checks that only the reported range changed (everything else byte-identical). */
function edit(storage: string, oldSentence = OLD, newSentence = NEW): string {
  const r = replaceSentence(storage, oldSentence, newSentence);
  if (!r.ok) throw new Error(`edit refused: ${r.code}`);
  expect(r.body.slice(0, r.start)).toBe(storage.slice(0, r.start));
  const tail = storage.length - r.end;
  expect(r.body.slice(r.body.length - tail)).toBe(storage.slice(r.end));
  return r.body;
}

const refused = (storage: string, oldSentence = OLD, newSentence = NEW) => {
  const r = replaceSentence(storage, oldSentence, newSentence);
  return r.ok ? 'ok' : r.code;
};

describe('replaceSentence (storage format)', () => {
  it('plain paragraph: only the number changes', () => {
    const s = '<h1>Travel</h1><p>Intro.</p><p>The per diem for domestic travel is $60 per day.</p><p>Other $60 text.</p>';
    expect(edit(s)).toBe('<h1>Travel</h1><p>Intro.</p><p>The per diem for domestic travel is $75 per day.</p><p>Other $60 text.</p>');
  });

  it('bold elsewhere in the sentence and a link stay untouched', () => {
    const s = '<p>The <strong>per diem</strong> for <a href="/wiki/x?a=60&amp;b=1">domestic travel</a> is $60 per day.</p>';
    expect(edit(s)).toBe('<p>The <strong>per diem</strong> for <a href="/wiki/x?a=60&amp;b=1">domestic travel</a> is $75 per day.</p>');
  });

  it('value inside <em> within the sentence', () => {
    const s = '<p>The per diem for domestic travel is <em>$60</em> per day.</p>';
    expect(edit(s)).toBe('<p>The per diem for domestic travel is <em>$75</em> per day.</p>');
  });

  it('keeps entities: &#36; and &nbsp; around the value', () => {
    const s = '<p>The per diem for domestic travel is &#36;60&nbsp;per day.</p>';
    expect(edit(s)).toBe('<p>The per diem for domestic travel is &#36;75&nbsp;per day.</p>');
  });

  it('table cell', () => {
    const s = '<table><tbody><tr><th>Rule</th><th>Amount</th></tr><tr><td><p>The per diem for domestic travel is $60 per day.</p></td><td>x</td></tr></tbody></table>';
    expect(edit(s)).toContain('<td><p>The per diem for domestic travel is $75 per day.</p></td>');
  });

  it('info macro rich-text body is edited; its parameters never', () => {
    const s =
      '<ac:structured-macro ac:name="info" ac:schema-version="1"><ac:parameter ac:name="title">The per diem for domestic travel is $60 per day</ac:parameter><ac:rich-text-body><p>The per diem for domestic travel is $60 per day.</p></ac:rich-text-body></ac:structured-macro>';
    expect(edit(s)).toBe(
      '<ac:structured-macro ac:name="info" ac:schema-version="1"><ac:parameter ac:name="title">The per diem for domestic travel is $60 per day</ac:parameter><ac:rich-text-body><p>The per diem for domestic travel is $75 per day.</p></ac:rich-text-body></ac:structured-macro>',
    );
  });

  it('thousands separator and a number word boundary', () => {
    const s = '<p>Trips over $2,000 require manager approval.</p>';
    expect(edit(s, 'Trips over $2,000 require manager approval.', 'Trips over $2,500 require manager approval.')).toBe('<p>Trips over $2,500 require manager approval.</p>');
  });

  it('matches case, curly quotes and whitespace loosely; escapes the replacement', () => {
    const s = '<p>The  Per Diem for domestic travel is $60 per day</p>';
    expect(edit(s, OLD, 'The per diem for domestic travel is $75 & more per day.')).toBe('<p>The  Per Diem for domestic travel is $75 &amp; more per day</p>');
  });

  it('refuses a sentence split across paragraphs or a list (needs a manual edit)', () => {
    expect(refused('<p>The per diem for domestic travel</p><p>is $60 per day.</p>')).toBe('quote_not_found');
    expect(refused('<ul><li>The per diem for domestic travel is</li><li>$60 per day.</li></ul>')).toBe('quote_not_found');
  });

  it('refuses a value split across markup', () => {
    expect(refused('<p>The per diem for domestic travel is $<strong>60</strong> per day.</p>', OLD, 'The per diem for domestic travel is EUR 75 per day.')).toBe('crosses_markup');
    expect(refused('<p>The per diem for domestic travel is <strong>$6</strong>0 per day.</p>')).toBe('crosses_markup');
  });

  it('refuses the sentence twice on the page, or the value twice in the sentence', () => {
    expect(refused(`<p>${OLD}</p><p>${OLD}</p>`)).toBe('sentence_ambiguous');
    const twice = 'Claims of $60 or more get $60 per day.';
    expect(refused(`<p>${twice}</p>`, twice, 'Claims of $60 or more get $75 per day.')).toBe('value_ambiguous');
  });

  it('refuses text only in CDATA, a macro parameter, a comment or an attribute', () => {
    expect(refused(`<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[${OLD}]]></ac:plain-text-body></ac:structured-macro>`)).toBe('quote_not_found');
    expect(refused(`<ac:structured-macro ac:name="x"><ac:parameter ac:name="t">${OLD}</ac:parameter></ac:structured-macro>`)).toBe('quote_not_found');
    expect(refused(`<!-- ${OLD} --><p>x</p>`)).toBe('quote_not_found');
    expect(refused(`<p title="${OLD}">x</p>`)).toBe('quote_not_found');
    // A link body in CDATA is read as text but never rewritten.
    expect(refused(`<p>The per diem for domestic travel is <ac:link><ac:plain-text-link-body><![CDATA[$60]]></ac:plain-text-link-body></ac:link> per day.</p>`)).toBe('crosses_markup');
  });

  it('refuses identical sentences', () => {
    expect(refused(`<p>${OLD}</p>`, OLD, OLD)).toBe('validation_failed');
  });

  it('round trip: applying the reverse edit gives back the original bytes', () => {
    const s = '<p class="x">Intro &amp; more.</p><p>The <strong>per diem</strong> for domestic travel is &#36;60&nbsp;per day.</p><ac:structured-macro ac:name="info"><ac:rich-text-body><p>Note.</p></ac:rich-text-body></ac:structured-macro>';
    const there = edit(s);
    expect(there).not.toBe(s);
    expect(edit(there, NEW, OLD)).toBe(s);
  });

  it('sentenceCount counts visible occurrences only', () => {
    expect(sentenceCount(`<p>${NEW}</p><p title="${OLD}">x</p>`, NEW)).toBe(1);
    expect(sentenceCount(`<p>${NEW}</p>`, OLD)).toBe(0);
  });
});
