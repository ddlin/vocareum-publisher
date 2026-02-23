const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shellEscape,
  buildVocGitCommand,
  extractOpenPath,
  extractAssignmentPath,
  extractVocareumLaunchIds
} = require('../dist/commandUtils.js');

test('shellEscape wraps values and escapes single quotes', () => {
  assert.equal(shellEscape('simple'), "'simple'");
  assert.equal(shellEscape("a'b"), "'a'\"'\"'b'");
});

test('buildVocGitCommand builds escaped command from args', () => {
  const cmd = buildVocGitCommand(['push', '--assignment', "lab'1"]);
  assert.equal(cmd, "vocgit 'push' '--assignment' 'lab'\"'\"'1'");
});

test('extractOpenPath supports direct string and tree payload', () => {
  assert.equal(extractOpenPath('/tmp/folder'), '/tmp/folder');
  assert.equal(extractOpenPath({ data: { fullPath: '/tmp/from-item' } }), '/tmp/from-item');
  assert.equal(extractOpenPath({ data: { fullPath: '' } }), undefined);
  assert.equal(extractOpenPath(undefined), undefined);
});

test('extractAssignmentPath reads assignment path from tree payload', () => {
  assert.equal(
    extractAssignmentPath({ data: { assignmentPath: 'labs/lab1' } }),
    'labs/lab1'
  );
  assert.equal(extractAssignmentPath({ data: {} }), undefined);
  assert.equal(extractAssignmentPath('labs/lab1'), undefined);
});

test('extractVocareumLaunchIds reads assignment and part IDs from tree payload', () => {
  assert.deepEqual(
    extractVocareumLaunchIds({ data: { assignmentId: '4959492', partId: '4959493' } }),
    { assignmentId: '4959492', partId: '4959493' }
  );
  assert.equal(extractVocareumLaunchIds({ data: { assignmentId: '4959492', partId: '' } }), undefined);
  assert.equal(extractVocareumLaunchIds({ data: { assignmentId: '', partId: '4959493' } }), undefined);
  assert.equal(extractVocareumLaunchIds(undefined), undefined);
});
