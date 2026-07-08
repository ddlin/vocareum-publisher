import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock ONLY the remote content fetch. path-security and fs stay REAL so the
// symlink-confinement logic is genuinely exercised against a real on-disk tree.
const { mockDownloadContent } = vi.hoisted(() => ({ mockDownloadContent: vi.fn() }));
vi.mock('../../src/api/content', () => ({
  downloadContent: mockDownloadContent,
}));

import { detectContentDrift } from '../../src/core/services/pull-service';
import type { Assignment } from '../../src/types/config';

/**
 * Regression: a repo pulled by an older vocgit contains a symlink that escapes
 * the part directory (e.g. `docs/README.html` -> the shared course/ tree). When
 * the user then deletes a *different* directory (`scripts/`) and runs
 * `pull --content`, the escaping symlink must NOT abort drift detection for the
 * whole assignment — otherwise the deleted directory is never restored (the
 * "had to drop vocareum.yaml and re-init" bug).
 */
describe('detectContentDrift — escaping symlink must not abort the whole assignment', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vocgit-drift-'));
  });
  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('skips only the escaping file and still flags a locally-deleted directory as added', async () => {
    // Part directory: assignment "asn1", single part at '.'.
    const partDir = path.join(workspaceRoot, 'asn1');
    await fs.mkdir(path.join(partDir, 'docs'), { recursive: true });

    // docs/README.html is a symlink whose target escapes the part directory.
    const outside = path.join(workspaceRoot, 'outside.html');
    await fs.writeFile(outside, 'outside');
    await fs.symlink(outside, path.join(partDir, 'docs', 'README.html'));

    // scripts/ was deleted locally (never created); remote still has scripts/build.sh.
    mockDownloadContent.mockResolvedValue({
      'docs/README.html': Buffer.from('remote readme'),
      'scripts/build.sh': Buffer.from('echo build'),
    });

    const assignment = {
      assignment_id: 'A1',
      name: 'Databricks Simple',
      path: 'asn1',
      parts: [
        { part_id: 'P1', name: 'Part 1', path: '.', directories: ['docs', 'scripts'] },
      ],
    } as unknown as Assignment;

    const warnings: string[] = [];
    const drift = await detectContentDrift(
      { assignments: [assignment], vocareum: { course_id: 'C1', architecture: 'container' } },
      {} as never,
      new Set<string>(),
      workspaceRoot,
      (m) => warnings.push(m),
    );

    // The whole-assignment abort must NOT fire.
    expect(warnings.some((w) => w.startsWith('Skipping content drift check for'))).toBe(false);

    // Drift IS detected for the assignment/part.
    expect(drift).toHaveLength(1);
    const diffs = drift[0].partsDrift[0].fileDiffs;

    // The locally-deleted directory's file is queued for restore.
    expect(diffs).toContainEqual({ filePath: 'scripts/build.sh', status: 'added' });

    // The escaping symlink file is skipped — never compared or restored — with a
    // targeted per-file warning instead of aborting the assignment.
    expect(diffs.find((d) => d.filePath === 'docs/README.html')).toBeUndefined();
    expect(warnings.some((w) => w.includes('docs/README.html') && w.includes('symlink'))).toBe(true);

    // apply writes partDrift.remoteFiles verbatim, and writeFileUnderBase THROWS
    // on an escaping path — so the escaping entry must be excluded from the stored
    // map, or apply would abort before restoring the deleted directory.
    const stored = Object.keys(drift[0].partsDrift[0].remoteFiles);
    expect(stored).toContain('scripts/build.sh');
    expect(stored).not.toContain('docs/README.html');
  });

  it('never flags a file reached through an escaping symlinked directory as deleted (would unlink outside the workspace)', async () => {
    // `startercode` is a symlink whose target is OUTSIDE the part directory and
    // holds a file that does not exist on the remote. The deleted-file detector
    // must not flag it — otherwise apply's fs.unlink would follow the symlink and
    // delete a file outside the workspace.
    const partDir = path.join(workspaceRoot, 'asn1');
    await fs.mkdir(partDir, { recursive: true });
    const outsideDir = path.join(workspaceRoot, 'outside');
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'do not touch');
    await fs.symlink(outsideDir, path.join(partDir, 'startercode'));

    // Remote has no files at all.
    mockDownloadContent.mockResolvedValue({});

    const assignment = {
      assignment_id: 'A1',
      name: 'Databricks Simple',
      path: 'asn1',
      parts: [{ part_id: 'P1', name: 'Part 1', path: '.', directories: ['startercode'] }],
    } as unknown as Assignment;

    const warnings: string[] = [];
    const drift = await detectContentDrift(
      { assignments: [assignment], vocareum: { course_id: 'C1', architecture: 'container' } },
      {} as never,
      new Set<string>(),
      workspaceRoot,
      (m) => warnings.push(m),
    );

    // No 'deleted' diff pointing through the escaping symlink → nothing to unlink.
    const allDiffs = drift.flatMap((d) => d.partsDrift.flatMap((p) => p.fileDiffs));
    expect(allDiffs.some((d) => d.filePath.startsWith('startercode/'))).toBe(false);
    expect(warnings.some((w) => w.includes('startercode') && w.includes('symlink'))).toBe(true);
    // And the outside file is untouched (detection is read-only, but assert intent).
    await expect(fs.readFile(path.join(outsideDir, 'secret.txt'), 'utf8')).resolves.toBe('do not touch');
  });

  it('skips a drifted file whose local path is an IN-PART symlink (writeFileUnderBase rejects all symlink targets) and still restores an unrelated deleted directory', async () => {
    // docs/README.html is a symlink to ../shared.html — target is INSIDE the part,
    // so isPathConfinedToBase passes. But writeFileUnderBase rejects ANY final
    // symlink target, so apply (which writes the whole remote-file map) would throw
    // and never restore the separately-deleted scripts/ directory. The file must be
    // excluded from the stored map at detection time.
    const partDir = path.join(workspaceRoot, 'asn1');
    await fs.mkdir(path.join(partDir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(partDir, 'shared.html'), 'local');
    await fs.symlink('../shared.html', path.join(partDir, 'docs', 'README.html'));

    mockDownloadContent.mockResolvedValue({
      'docs/README.html': Buffer.from('remote'), // differs from local → would be "modified"
      'scripts/build.sh': Buffer.from('echo build'), // scripts/ deleted locally
    });

    const assignment = {
      assignment_id: 'A1',
      name: 'Databricks Simple',
      path: 'asn1',
      parts: [{ part_id: 'P1', name: 'Part 1', path: '.', directories: ['docs', 'scripts'] }],
    } as unknown as Assignment;

    const warnings: string[] = [];
    const drift = await detectContentDrift(
      { assignments: [assignment], vocareum: { course_id: 'C1', architecture: 'container' } },
      {} as never,
      new Set<string>(),
      workspaceRoot,
      (m) => warnings.push(m),
    );

    expect(drift).toHaveLength(1);
    const part = drift[0].partsDrift[0];
    // The deleted directory is still queued for restore.
    expect(part.fileDiffs).toContainEqual({ filePath: 'scripts/build.sh', status: 'added' });
    // The symlink file is neither flagged for restore nor kept in the write map,
    // so apply cannot abort on it.
    expect(part.fileDiffs.find((d) => d.filePath === 'docs/README.html')).toBeUndefined();
    expect(Object.keys(part.remoteFiles)).not.toContain('docs/README.html');
    expect(Object.keys(part.remoteFiles)).toContain('scripts/build.sh');
    expect(warnings.some((w) => w.includes('docs/README.html') && w.includes('symlink'))).toBe(true);
  });
});
