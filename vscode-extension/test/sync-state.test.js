const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  computeSyncSnapshot,
  parseStatusReport,
  mapReportToSnapshot,
  getLastStatusError,
  buildPartStatusKey,
  buildDirectoryStatusKey,
} = require('../dist/syncState.js');

async function createWorkspaceWithConfig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocgit-sync-state-'));
  await fs.writeFile(path.join(root, 'vocareum.yaml'), 'version: "1.0"\n', 'utf8');
  return root;
}

function sampleReport(overrides = {}) {
  return {
    schema_version: 1,
    generated_at: '2026-06-11T00:00:00.000Z',
    config_path: 'vocareum.yaml',
    course: { org_id: '1', course_id: '201303' },
    auth: { mode: 'token', configured: true },
    runtime: 'local',
    git: { repo: true, branch: 'master', commit: 'abc', dirty: false },
    last_push: {
      timestamp: '2026-06-10T12:00:00Z',
      status: 'success',
      published_by: 'david',
      commit_sha: 'abc',
    },
    assignments: [
      {
        path: 'lab1',
        name: 'Lab 1',
        assignment_id: 'asn-1',
        status: 'needs_publish',
        parts: [
          {
            path: 'part1',
            part_id: 'part-1',
            status: 'needs_publish',
            directories: [
              { directory: 'startercode', status: 'needs_publish' },
              { directory: 'docs', status: 'synced' },
            ],
          },
        ],
      },
      {
        path: 'lab2',
        name: 'Lab 2',
        assignment_id: null,
        status: 'pending_create',
        parts: [],
      },
    ],
    summary: { synced: 0, needs_publish: 1, unknown: 0, pending_create: 1 },
    ...overrides,
  };
}

test('parseStatusReport accepts a schema_version 1 document', () => {
  const report = parseStatusReport(JSON.stringify(sampleReport()));
  assert.equal(report.assignments.length, 2);
});

test('parseStatusReport rejects unknown schema versions', () => {
  assert.throws(() => parseStatusReport(JSON.stringify(sampleReport({ schema_version: 99 }))));
});

test('mapReportToSnapshot maps statuses onto the snapshot maps', () => {
  const snapshot = mapReportToSnapshot(sampleReport());

  assert.equal(snapshot.assignmentStatuses.get('lab1'), 'needs_publish');
  assert.equal(snapshot.partStatuses.get(buildPartStatusKey('lab1', 'part1')), 'needs_publish');
  assert.equal(
    snapshot.directoryStatuses.get(buildDirectoryStatusKey('lab1', 'part1', 'startercode')),
    'needs_publish'
  );
  assert.equal(
    snapshot.directoryStatuses.get(buildDirectoryStatusKey('lab1', 'part1', 'docs')),
    'synced'
  );
  assert.equal(snapshot.hasPendingLocalChanges, true);
  assert.equal(snapshot.lastRemoteCheckAt.toISOString(), '2026-06-10T12:00:00.000Z');
});

test('mapReportToSnapshot maps pending_create to needs_publish (push would create)', () => {
  const snapshot = mapReportToSnapshot(sampleReport());
  assert.equal(snapshot.assignmentStatuses.get('lab2'), 'needs_publish');
});

test('mapReportToSnapshot maps unlinked to unknown (push outcome not locally decidable)', () => {
  const report = sampleReport();
  report.assignments.push({
    path: 'lab3',
    name: 'Lab 3',
    assignment_id: null,
    status: 'unlinked',
    parts: [],
  });
  const snapshot = mapReportToSnapshot(report);
  assert.equal(snapshot.assignmentStatuses.get('lab3'), 'unknown');
  assert.equal(snapshot.hasUnknownAssignments, true);
});

test('mapReportToSnapshot passes error statuses through to the badge', () => {
  const report = sampleReport();
  report.assignments[0].status = 'error';
  report.assignments[0].parts[0].status = 'error';
  report.assignments[0].parts[0].directories[0].status = 'error';
  const snapshot = mapReportToSnapshot(report);
  assert.equal(snapshot.assignmentStatuses.get('lab1'), 'error');
  assert.equal(snapshot.partStatuses.get(buildPartStatusKey('lab1', 'part1')), 'error');
  assert.equal(
    snapshot.directoryStatuses.get(buildDirectoryStatusKey('lab1', 'part1', 'startercode')),
    'error'
  );
});

test('computeSyncSnapshot runs the CLI in the workspace and maps its output', async () => {
  const root = await createWorkspaceWithConfig();
  const calls = [];
  const snapshot = await computeSyncSnapshot(root, {
    runCli: async (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      return { stdout: JSON.stringify(sampleReport()), stderr: '' };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'vocgit');
  assert.deepEqual(calls[0].args, ['status', '--json']);
  assert.equal(calls[0].cwd, root);
  assert.equal(snapshot.assignmentStatuses.get('lab1'), 'needs_publish');
  assert.equal(getLastStatusError(), undefined);
});

test('computeSyncSnapshot returns undefined without invoking the CLI when vocareum.yaml is absent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocgit-sync-state-'));
  let invoked = false;
  const snapshot = await computeSyncSnapshot(root, {
    runCli: async () => {
      invoked = true;
      return { stdout: '{}', stderr: '' };
    },
  });

  assert.equal(snapshot, undefined);
  assert.equal(invoked, false);
});

test('computeSyncSnapshot reports cli-not-found when the binary is missing', async () => {
  const root = await createWorkspaceWithConfig();
  const snapshot = await computeSyncSnapshot(root, {
    runCli: async () => {
      const err = new Error('spawn vocgit ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });

  assert.equal(snapshot, undefined);
  assert.equal(getLastStatusError().kind, 'cli-not-found');
});

test('computeSyncSnapshot reports cli-too-old when --json is not supported', async () => {
  const root = await createWorkspaceWithConfig();
  const snapshot = await computeSyncSnapshot(root, {
    runCli: async () => {
      const err = new Error('Command failed');
      err.code = 1;
      err.stderr = "error: unknown option '--json'";
      throw err;
    },
  });

  assert.equal(snapshot, undefined);
  assert.equal(getLastStatusError().kind, 'cli-too-old');
});

test('computeSyncSnapshot reports bad-schema on unparseable or wrong-version output', async () => {
  const root = await createWorkspaceWithConfig();
  const snapshot = await computeSyncSnapshot(root, {
    runCli: async () => ({ stdout: 'not json at all', stderr: '' }),
  });

  assert.equal(snapshot, undefined);
  assert.equal(getLastStatusError().kind, 'bad-schema');
});

test('computeSyncSnapshot coalesces rapid calls for the same workspace into one CLI run', async () => {
  const root = await createWorkspaceWithConfig();
  let invocations = 0;
  const options = {
    cacheTtlMs: 60_000,
    runCli: async () => {
      invocations += 1;
      return { stdout: JSON.stringify(sampleReport()), stderr: '' };
    },
  };

  // Simulates one tree render: course, assignment, and part levels each fetch
  const [a, b, c] = await Promise.all([
    computeSyncSnapshot(root, options),
    computeSyncSnapshot(root, options),
    computeSyncSnapshot(root, options),
  ]);

  assert.equal(invocations, 1);
  assert.ok(a && b && c);
});

test('invalidateSnapshotCache forces a fresh CLI run', async () => {
  const { invalidateSnapshotCache } = require('../dist/syncState.js');
  const root = await createWorkspaceWithConfig();
  let invocations = 0;
  const options = {
    cacheTtlMs: 60_000,
    runCli: async () => {
      invocations += 1;
      return { stdout: JSON.stringify(sampleReport()), stderr: '' };
    },
  };

  await computeSyncSnapshot(root, options);
  invalidateSnapshotCache();
  await computeSyncSnapshot(root, options);

  assert.equal(invocations, 2);
});

test('computeSyncSnapshot never walks escaping assignment paths for the mtime display', async () => {
  const root = await createWorkspaceWithConfig();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'vocgit-outside-'));
  await fs.writeFile(path.join(outside, 'fresh.txt'), 'newest file on disk');

  const report = sampleReport();
  report.assignments = [
    // CLI flags symlink escapes as error → must be skipped
    { path: 'lab-link', name: 'L', assignment_id: 'a', status: 'error', parts: [] },
    // Lexical escape that a hostile/old CLI failed to flag → guard must skip
    { path: path.relative(root, outside), name: 'E', assignment_id: 'b', status: 'needs_publish', parts: [] },
  ];

  const snapshot = await computeSyncSnapshot(root, {
    cacheTtlMs: 0,
    runCli: async () => ({ stdout: JSON.stringify(report), stderr: '' }),
  });

  // Neither escaping assignment contributes an mtime
  assert.equal(snapshot.latestLocalChangeAt, undefined);
});

test('computeSyncSnapshot uses the configured CLI path', async () => {
  const root = await createWorkspaceWithConfig();
  const calls = [];
  await computeSyncSnapshot(root, {
    cliPath: '/opt/tools/vocgit',
    runCli: async (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      return { stdout: JSON.stringify(sampleReport()), stderr: '' };
    },
  });

  assert.equal(calls[0].cmd, '/opt/tools/vocgit');
});
