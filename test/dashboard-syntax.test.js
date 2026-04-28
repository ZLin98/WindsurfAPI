import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

for (const skin of ['src/dashboard/index.html', 'src/dashboard/index-sketch.html']) {
  test(`${skin} inline scripts are syntactically valid`, () => {
    const html = readFileSync(join(root, skin), 'utf8');
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
      .map((match, index) => ({ index, attrs: match[1] || '', source: match[2] || '' }))
      .filter(({ attrs }) => !/\bsrc\s*=/.test(attrs))
      .filter(({ attrs }) => !/\btype\s*=\s*["']module["']/i.test(attrs));

    assert.ok(scripts.length > 0, `expected at least one non-module inline script in ${skin}`);
    for (const { index, source } of scripts) {
      assert.doesNotThrow(() => new Function(source), `inline script #${index} in ${skin} should parse`);
    }
  });
}

test('account detail only renders models left enabled by the account editor', () => {
  const html = readFileSync(join(root, 'src/dashboard/index.html'), 'utf8');
  assert.match(html, /const modelUniverse = \[\.\.\.new Set\(\[\.\.\.tierModels, \.\.\.availableModels\]\)\]/);
  assert.match(html, /const modelUniverse = \[\.\.\.new Set\(\[\.\.\.tierModels, \.\.\.acctAvailableModels\]\)\]/);
  assert.match(html, /const visibleModels = Array\.isArray\(a\.availableModels\)/);
  assert.match(html, /for \(const m of visibleModels\)/);
  assert.doesNotMatch(html, /model-chip \$\{blocked\.has\(m\.id\)/);
  assert.doesNotMatch(html, /\.model-chip\.blocked/);
  assert.doesNotMatch(html, /!availableSet\.size \|\| availableSet\.has/);
  assert.doesNotMatch(html, /!visibleSet\.size \|\| visibleSet\.has/);
  assert.match(html, /blockedModalFilter\(query\)/);
});

test('account table exposes upstream rate limits and uses full width layout', () => {
  const html = readFileSync(join(root, 'src/dashboard/index.html'), 'utf8');
  assert.match(html, /max-width:\s*none/);
  assert.match(html, /rateLimitSnapshot/);
  assert.match(html, /table\.header\.cloudLimit/);
  assert.match(html, /checkRateLimit\('/);
  assert.match(html, /refreshAllRateLimits/);
});
