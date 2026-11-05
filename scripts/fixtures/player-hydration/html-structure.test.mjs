import assert from 'node:assert/strict';
import test from 'node:test';
import { lexicalHtmlStructure } from './html-structure.mjs';

test('initial native player retains exactly the two-DIV contract', () => {
  assert.deepEqual(lexicalHtmlStructure('<div class="frame"><div data-vjs-player=""></div></div>'),
    ['div', 'div/div']);
});

test('void elements do not change ancestry', () => {
  assert.deepEqual(lexicalHtmlStructure('<div><input/><span><br>text</span></div>'),
    ['div', 'div/input', 'div/span', 'div/span/br']);
});

test('quoted greater-than characters and SVG closing tags remain balanced', () => {
  assert.deepEqual(lexicalHtmlStructure('<button title="a > b"><svg><path d="x > y"></path></svg></button>'),
    ['button', 'button/svg', 'button/svg/path']);
});

test('invalid P/DIV nesting is preserved for comparison with browser repair', () => {
  assert.deepEqual(lexicalHtmlStructure('<p><div>invalid</div></p>'), ['p', 'p/div']);
});

test('unbalanced and raw-text markup cannot silently pass the static check', () => {
  assert.throws(() => lexicalHtmlStructure('<div><span></div>'), /Unbalanced/);
  assert.throws(() => lexicalHtmlStructure('<div>'), /Unclosed/);
  assert.throws(() => lexicalHtmlStructure('<script>ignored</script>'), /Raw-text/);
});
