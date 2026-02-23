const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { computeSyncSnapshot } = require('../dist/syncState.js');

async function createTempWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'vocgit-sync-state-'));
}

async function writeBaseAssignment(workspaceRoot, content = 'print("hello")\n') {
  const assignmentDir = path.join(workspaceRoot, 'lab1', 'part1', 'startercode');
  await fs.mkdir(assignmentDir, { recursive: true });
  await fs.writeFile(path.join(assignmentDir, 'main.py'), content, 'utf8');
}

function singleFileDirectoryHash(relativePath, content) {
  const fileHash = crypto.createHash('sha256').update(Buffer.from(content)).digest('hex');
  return crypto.createHash('sha256').update(`${relativePath}:${fileHash}`).digest('hex');
}

function emptyDirectoryHash() {
  return crypto.createHash('sha256').update('empty').digest('hex');
}

async function writeConfig(workspaceRoot, extraYaml = '') {
  const baseYaml = `
version: '1.0'
vocareum:
  org_id: '1'
  course_id: '2'
assignments:
  - path: lab1
    parts:
      - path: part1
${extraYaml}
`.trimStart();

  await fs.writeFile(path.join(workspaceRoot, 'vocareum.yaml'), baseYaml, 'utf8');
}

test('computeSyncSnapshot marks assignment as unknown when publish history is missing', async (t) => {
  const workspaceRoot = await createTempWorkspace();
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  await writeBaseAssignment(workspaceRoot);
  await writeConfig(workspaceRoot);

  const snapshot = await computeSyncSnapshot(workspaceRoot);
  assert.ok(snapshot);
  assert.equal(snapshot.assignmentStatuses.get('lab1'), 'unknown');
  assert.equal(snapshot.partStatuses.get('lab1/part1'), 'unknown');
  assert.equal(snapshot.directoryStatuses.get('lab1/part1/startercode'), 'unknown');
  assert.equal(snapshot.directoryStatuses.get('lab1/part1/scripts'), 'unknown');
  assert.equal(snapshot.directoryStatuses.get('lab1/part1/docs'), 'unknown');
  assert.equal(snapshot.directoryStatuses.get('lab1/part1/data'), 'unknown');
  assert.equal(snapshot.hasUnknownAssignments, true);
  assert.equal(snapshot.hasPendingLocalChanges, false);
  assert.equal(snapshot.lastRemoteCheckAt, undefined);
});

test('computeSyncSnapshot marks assignment as needs_publish when hash differs', async (t) => {
  const workspaceRoot = await createTempWorkspace();
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  await writeBaseAssignment(workspaceRoot);
  await writeConfig(workspaceRoot, `
publish_history:
  - timestamp: '2026-02-20T00:00:00Z'
    content_state:
      "lab1/part1/startercode": "not-the-current-hash"
`);

  const snapshot = await computeSyncSnapshot(workspaceRoot);
  assert.ok(snapshot);
  assert.equal(snapshot.assignmentStatuses.get('lab1'), 'needs_publish');
  assert.equal(snapshot.partStatuses.get('lab1/part1'), 'needs_publish');
  assert.equal(snapshot.directoryStatuses.get('lab1/part1/startercode'), 'needs_publish');
  assert.equal(snapshot.directoryStatuses.get('lab1/part1/scripts'), 'needs_publish');
  assert.equal(snapshot.hasPendingLocalChanges, true);
  assert.ok(snapshot.lastRemoteCheckAt instanceof Date);
});

test('computeSyncSnapshot marks assignment as synced when hash matches publish history', async (t) => {
  const workspaceRoot = await createTempWorkspace();
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const fileContent = 'print("hello")\n';
  await writeBaseAssignment(workspaceRoot, fileContent);
  const matchingHash = singleFileDirectoryHash('main.py', fileContent);
  const emptyHash = emptyDirectoryHash();

  await writeConfig(workspaceRoot, `
publish_history:
  - timestamp: '2026-02-20T12:34:56Z'
    content_state:
      "lab1/part1/startercode": "${matchingHash}"
      "lab1/part1/scripts": "${emptyHash}"
      "lab1/part1/docs": "${emptyHash}"
      "lab1/part1/data": "${emptyHash}"
`);

  const snapshot = await computeSyncSnapshot(workspaceRoot);
  assert.ok(snapshot);
  assert.equal(snapshot.assignmentStatuses.get('lab1'), 'synced');
  assert.equal(snapshot.partStatuses.get('lab1/part1'), 'synced');
  assert.equal(snapshot.directoryStatuses.get('lab1/part1/startercode'), 'synced');
  assert.equal(snapshot.directoryStatuses.get('lab1/part1/scripts'), 'synced');
  assert.equal(snapshot.directoryStatuses.get('lab1/part1/docs'), 'synced');
  assert.equal(snapshot.directoryStatuses.get('lab1/part1/data'), 'synced');
  assert.equal(snapshot.hasPendingLocalChanges, false);
  assert.equal(snapshot.hasUnknownAssignments, false);
  assert.ok(snapshot.latestLocalChangeAt instanceof Date);
});
