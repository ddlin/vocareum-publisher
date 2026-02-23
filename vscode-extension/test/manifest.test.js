const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const manifestPath = path.join(__dirname, '..', 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function findCommand(commandId) {
  return (manifest.contributes.commands || []).find((cmd) => cmd.command === commandId);
}

test('manifest contributes API key management commands', () => {
  assert.ok(findCommand('vocgit.setApiKey'));
  assert.ok(findCommand('vocgit.clearApiKey'));
});

test('manifest contributes go-to-vocareum command for part items', () => {
  assert.ok(findCommand('vocgit.goToVocareum'));

  const itemContextMenu = manifest.contributes.menus['view/item/context'] || [];
  const inlineEntry = itemContextMenu.find(
    (item) => item.command === 'vocgit.goToVocareum' && item.group === 'inline'
  );
  assert.ok(inlineEntry);
  assert.equal(inlineEntry.when, 'view == vocgit.yamlView && viewItem == part');
});

test('actions view title menu exposes set/clear API key commands', () => {
  const viewTitleMenu = manifest.contributes.menus['view/title'] || [];
  const keyMenuItem = viewTitleMenu.find((item) => item.command === 'vocgit.setApiKey');
  const clearMenuItem = viewTitleMenu.find((item) => item.command === 'vocgit.clearApiKey');

  assert.ok(keyMenuItem);
  assert.ok(clearMenuItem);
  assert.equal(keyMenuItem.when, 'view == vocgit.actionsView');
  assert.equal(clearMenuItem.when, 'view == vocgit.actionsView');
});

test('legacy vocgit.apiKey setting is marked deprecated', () => {
  const apiKeySetting = manifest.contributes.configuration.properties['vocgit.apiKey'];
  assert.ok(apiKeySetting);
  assert.ok(apiKeySetting.deprecationMessage);
  assert.equal(apiKeySetting.scope, 'machine');
});
