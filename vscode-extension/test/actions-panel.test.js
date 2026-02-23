const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'src', 'VocGitActionsProvider.ts');
const source = fs.readFileSync(sourcePath, 'utf8');

test('actions panel includes dynamic API key button labels', () => {
  assert.match(source, /id="set-key-button"/);
  assert.match(source, /Set VOCAREUM_API_KEY/);
  assert.match(source, /Update VOC API KEY/);
  assert.match(source, /'setApiKey'/);
});

test('actions panel includes CSP hardening', () => {
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /default-src 'none'/);
  assert.match(source, /script-src 'nonce-/);
});
