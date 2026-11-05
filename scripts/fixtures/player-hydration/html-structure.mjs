const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Independent lexical hierarchy, deliberately without browser tag-repair rules.
// Fixture HTML is React-generated; raw-text SCRIPT/STYLE nodes are not allowed.
export function lexicalHtmlStructure(html) {
  const stack = [];
  const result = [];
  const tag = /<(\/)?([A-Za-z][A-Za-z0-9:-]*)\b(?:[^"'>]|"[^"]*"|'[^']*')*>/g;
  let match;
  while ((match = tag.exec(html))) {
    const name = match[2].toLowerCase();
    if (name === 'script' || name === 'style') throw new Error('Raw-text tags are outside this fixture parser');
    if (match[1]) {
      if (stack.pop() !== name) throw new Error(`Unbalanced closing tag ${name}`);
    } else {
      result.push([...stack, name].join('/'));
      if (!VOID_TAGS.has(name) && !/\/\s*>$/.test(match[0])) stack.push(name);
    }
  }
  if (stack.length) throw new Error(`Unclosed tags: ${stack.join('/')}`);
  return result;
}

export function browserHtmlStructure(html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const result = [];
  function walk(element, parents) {
    const path = [...parents, element.localName.toLowerCase()];
    result.push(path.join('/'));
    for (const child of element.children) walk(child, path);
  }
  for (const child of parsed.body.children) walk(child, []);
  return result;
}
