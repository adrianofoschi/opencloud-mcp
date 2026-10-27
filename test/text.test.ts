import { describe, expect, it } from 'vitest';
import { plainExcerpt, searchPatterns } from '../src/text.js';

describe('search patterns', () => {
  it('builds a name and a content pattern from the words, dropping query syntax', () => {
    expect(searchPatterns('fattura')).toEqual({ name: '*fattura*', content: 'content:fattura' });
    expect(searchPatterns('  fattura   lavatrice ')).toEqual({ name: '*fattura*lavatrice*',
      content: 'content:fattura content:lavatrice' });
    expect(searchPatterns('content:(x) OR "y"* <z>')).toEqual({ name: '*contentx*OR*y*z*',
      content: 'content:contentx content:OR content:y content:z' });
    expect(searchPatterns('  :*()  ')).toBeUndefined();
  });

  it('keeps accented letters, digits, dots and dashes', () => {
    expect(searchPatterns('città 2024-05 v1.2')?.content).toBe('content:città content:2024-05 content:v1.2');
  });
});

describe('excerpts', () => {
  it('decodes the entities left in highlights and removes the mark tags', () => {
    expect(plainExcerpt('…non è valido come &lt;mark&gt;fattura&lt;/m'))
      .toBe('…non è valido come fattura</m');
    expect(plainExcerpt('&amp;lt;mark&amp;gt;Fattura&amp;lt;/mark&amp;gt; Accompagnatoria&amp;#xA;&amp;#xA;BLASS'))
      .toBe('Fattura Accompagnatoria BLASS');
  });
});
