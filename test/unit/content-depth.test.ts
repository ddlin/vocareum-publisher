/**
 * Regression: locale-nested asset directories must survive the download walk.
 *
 * AWS Academy course content nests per-locale image directories five levels
 * below the part root:
 *
 *   asnlib/public/docs/lang/<locale>/images/<file>
 *
 * The walk in downloadDirectoryTree assigns depth 0 to the part directory
 * itself, so `lang/<locale>` is listed at depth 4 and its `images/` child needs
 * a recursion into depth 5. A MAX_DOWNLOAD_DEPTH of 4 silently dropped every
 * one of those directories: the READMEs beside them came through, so the pull
 * looked complete while the images they reference were never fetched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { downloadContent } from '../../src/api/content';
import { VocareumClient } from '../../src/api/client';
import axios from 'axios';

vi.mock('axios');

describe('downloadContent depth (AWS Academy locale-nested assets)', () => {
  let mockClient: VocareumClient;
  let requestMock: ReturnType<typeof vi.fn>;
  const mockedAxios = vi.mocked(axios);

  beforeEach(() => {
    requestMock = vi.fn();
    mockClient = {
      request: requestMock,
      events: { emit: vi.fn() },
    } as unknown as VocareumClient;
    vi.clearAllMocks();
  });

  /** The API's "this path is a directory, not a file" response. */
  const notAFile = (filename: string) => ({
    status: 'error',
    files: [{ filename, download_url: 'specified file does not exist' }],
  });

  it('descends into asnlib/public/docs/lang/<locale>/images', async () => {
    // depth 0: asnlib → [public]
    requestMock.mockResolvedValueOnce({ files: [{ path: 'public', size: 0 }] });
    requestMock.mockResolvedValueOnce(notAFile('asnlib/public'));

    // depth 1: asnlib/public → [docs]
    requestMock.mockResolvedValueOnce({ files: [{ path: 'docs', size: 0 }] });
    requestMock.mockResolvedValueOnce(notAFile('asnlib/public/docs'));

    // depth 2: asnlib/public/docs → [lang]
    requestMock.mockResolvedValueOnce({ files: [{ path: 'lang', size: 0 }] });
    requestMock.mockResolvedValueOnce(notAFile('asnlib/public/docs/lang'));

    // depth 3: asnlib/public/docs/lang → [en-us]
    requestMock.mockResolvedValueOnce({ files: [{ path: 'en-us', size: 0 }] });
    requestMock.mockResolvedValueOnce(notAFile('asnlib/public/docs/lang/en-us'));

    // depth 4: .../lang/en-us → [README.md, images]
    requestMock.mockResolvedValueOnce({
      files: [
        { path: 'README.md', size: 120 },
        { path: 'images', size: 0 },
      ],
    });
    // README.md is a real file
    requestMock.mockResolvedValueOnce({
      status: 'success',
      files: [{
        filename: 'asnlib/public/docs/lang/en-us/README.md',
        download_url: 'https://s3.example.com/readme',
      }],
    });
    mockedAxios.get.mockResolvedValueOnce({ data: Buffer.from('# Lab') });
    // images is a directory → requires descending to depth 5
    requestMock.mockResolvedValueOnce(notAFile('asnlib/public/docs/lang/en-us/images'));

    // depth 5: .../lang/en-us/images → [lab-6-table.png]
    requestMock.mockResolvedValueOnce({ files: [{ path: 'lab-6-table.png', size: 4096 }] });
    requestMock.mockResolvedValueOnce({
      status: 'success',
      files: [{
        filename: 'asnlib/public/docs/lang/en-us/images/lab-6-table.png',
        download_url: 'https://s3.example.com/table',
      }],
    });
    mockedAxios.get.mockResolvedValueOnce({ data: Buffer.from('PNG-BYTES') });

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1', ['asnlib']);

    // The README came through even with the old limit — it is the asset
    // beside it that was lost, which is why the truncation was invisible.
    expect(result['asnlib/public/docs/lang/en-us/README.md'].toString()).toBe('# Lab');
    expect(
      result['asnlib/public/docs/lang/en-us/images/lab-6-table.png']?.toString()
    ).toBe('PNG-BYTES');
  });

  it('stops on a self-repeating path without crying data loss', async () => {
    // Vocareum workspaces carry escaping symlinks such as
    // `publicdata -> /mnt/worktest/<course>/data` (docs/vocareum-api-feedback.md).
    // The files API happily lists the same child under every level of them, so
    // the walk sees lib/publicdata/publicdata/publicdata/... forever. Nothing is
    // below it to lose, so this must not surface as a truncation warning --
    // otherwise the real signal is buried in false alarms.
    for (let level = 0; level <= 12; level++) {
      requestMock.mockResolvedValueOnce({ files: [{ path: 'publicdata', size: 0 }] });
      requestMock.mockResolvedValueOnce(notAFile('lib/publicdata'));
    }

    await downloadContent(mockClient, 'c1', 'a1', 'p1', ['lib']);

    const emit = vi.mocked(mockClient.events.emit);
    const warnings = emit.mock.calls
      .map((c) => c[0])
      .filter((e) => e.level === 'warn');

    expect(warnings.filter((w) => w.message.includes('were NOT downloaded'))).toHaveLength(0);

    // And it must give up quickly rather than burning the full depth budget:
    // one list + one fetch per level, stopping once the repeat is unambiguous.
    expect(requestMock.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it('warns (not debug) when the depth cap truncates the walk', async () => {
    // A chain deep enough to hit the cap. Every entry reports as a directory.
    const chain: string[] = [];
    for (let level = 0; level <= 12; level++) {
      chain.push(String.fromCharCode(97 + level));
      requestMock.mockResolvedValueOnce({
        files: [{ path: chain[chain.length - 1], size: 0 }],
      });
      requestMock.mockResolvedValueOnce(notAFile(`asnlib/${chain.join('/')}`));
    }

    await downloadContent(mockClient, 'c1', 'a1', 'p1', ['asnlib']);

    const emit = vi.mocked(mockClient.events.emit);
    const warnings = emit.mock.calls
      .map((c) => c[0])
      .filter((e) => e.level === 'warn');

    // Silent truncation is the actual defect here: without this the pull
    // reports success while dropping every file below the cap.
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('were NOT downloaded');
  });
});
