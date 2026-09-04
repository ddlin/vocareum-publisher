/**
 * Regression: Elite workspaces have no /voc — every directory is under /resource.
 *
 * `toApiDirPath` accepted an `architecture` argument and ignored it, routing only
 * `asnlib`/`lib` to /resource and everything else to /voc. On an Elite course
 * that meant `scripts` and `startercode` were requested at paths that cannot
 * exist, the API answered "doesn't exist", and the missing-optional-directory
 * swallow turned that into an empty result. Pulls reported success with the
 * content silently absent — on course 102668 that was 36 shell scripts
 * (build/grade/run/submit across 9 assignments).
 *
 * Confirmed against the live API on two Elite courses (102668, 227714):
 *   /                     -> ['resource', 'work']        <- no 'voc' at all
 *   /resource             -> ['asnlib','lib','scripts','startercode']
 *   /resource/scripts     -> ['build.sh','grade.sh','run.sh','submit.sh']
 *   /voc/scripts          -> "doesn't exist"
 *   /resource/docs        -> "doesn't exist"             <- Elite has no docs dir
 */

import { describe, it, expect, vi } from 'vitest';
import { toApiDirPath, listFiles } from '../../src/api/content';
import { VocareumClient } from '../../src/api/client';

describe('toApiDirPath (architecture-aware)', () => {
  it('routes every directory under /resource on Elite', () => {
    for (const dir of ['asnlib', 'lib', 'scripts', 'startercode', 'docs'] as const) {
      expect(toApiDirPath(dir, 'elite')).toBe(`/resource/${dir}`);
    }
  });

  it('keeps the split mapping on Container', () => {
    // Container workspaces have both trees: instructor content under /resource,
    // the student workspace under /voc.
    expect(toApiDirPath('asnlib', 'container')).toBe('/resource/asnlib');
    expect(toApiDirPath('lib', 'container')).toBe('/resource/lib');
    expect(toApiDirPath('scripts', 'container')).toBe('/voc/scripts');
    expect(toApiDirPath('startercode', 'container')).toBe('/voc/startercode');
    expect(toApiDirPath('docs', 'container')).toBe('/voc/docs');
    expect(toApiDirPath('data', 'container')).toBe('/voc/data');
    expect(toApiDirPath('private', 'container')).toBe('/voc/private');
  });

  it('defaults to the Container mapping when architecture is unknown', () => {
    // Backward compatibility: configs predating the architecture field, and the
    // many call sites that pass nothing, must behave exactly as before.
    expect(toApiDirPath('scripts')).toBe('/voc/scripts');
    expect(toApiDirPath('asnlib')).toBe('/resource/asnlib');
  });
});

describe('listFiles honours architecture', () => {
  const mkClient = () => {
    const requestMock = vi.fn().mockResolvedValue({ files: [] });
    const client = {
      request: requestMock,
      events: { emit: vi.fn() },
    } as unknown as VocareumClient;
    return { client, requestMock };
  };

  it('asks for /resource/scripts on an Elite part', async () => {
    const { client, requestMock } = mkClient();
    await listFiles(client, 'c1', 'a1', 'p1', 'scripts', 'elite');
    expect(requestMock.mock.calls[0][0].params.dir).toBe('/resource/scripts');
  });

  it('still asks for /voc/scripts on a Container part', async () => {
    const { client, requestMock } = mkClient();
    await listFiles(client, 'c1', 'a1', 'p1', 'scripts', 'container');
    expect(requestMock.mock.calls[0][0].params.dir).toBe('/voc/scripts');
  });
});

describe('a declared directory that does not exist is reported, not swallowed', () => {
  it('warns when the API says the requested directory is absent', async () => {
    const err = Object.assign(new Error("/voc/scripts doesn't exist"), {
      statusCode: 400,
    });
    const emit = vi.fn();
    const client = {
      request: vi.fn().mockRejectedValue(err),
      events: { emit },
    } as unknown as VocareumClient;

    const result = await listFiles(client, 'c1', 'a1', 'p1', 'scripts', 'container');

    // Still returns empty — an absent optional directory is not an error, and
    // throwing here would make pull treat it as remote deletions.
    expect(result).toEqual([]);

    // But it must not be silent. Both data-loss bugs found in this tool so far
    // (this one and the MAX_DOWNLOAD_DEPTH truncation) were invisible because
    // content vanished with exit code 0.
    const warnings = emit.mock.calls
      .map((c) => c[0])
      .filter((e: { level: string }) => e.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('scripts');
    expect(warnings[0].message).toContain('/voc/scripts');
  });
});
