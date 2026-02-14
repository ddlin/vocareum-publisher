
import { describe, it, expect } from 'vitest';
import { createZipBuffer, crc32 } from '../../src/api/content';
import type { FileMap } from '../../src/types/api';

describe('Content API', () => {
    describe('crc32', () => {
        it('should calculate correct CRC32 for empty buffer', () => {
            const input = Buffer.from('');
            expect(crc32(input)).toBe(0);
        });

        it('should calculate correct CRC32 for simple string', () => {
            const input = Buffer.from('hello world');
            // 0x0d4a1185 = 222957957
            expect(crc32(input)).toBe(222957957);
        });
    });

    describe('createZipBuffer', () => {
        it('should throw error if files map is empty', () => {
            expect(() => createZipBuffer({})).toThrow('Cannot create ZIP: no files provided');
        });

        it('should create a valid ZIP structure for a single file', () => {
            const files: FileMap = {
                'hello.txt': 'Hello World',
            };

            const zip = createZipBuffer(files);

            // ZIP file signature is PK\x03\x04
            expect(zip.readUInt32LE(0)).toBe(0x04034b50);

            // Check for filename in local header
            const filenameIndex = zip.indexOf('hello.txt');
            expect(filenameIndex).toBeGreaterThan(0);

            // Check for content
            const contentIndex = zip.indexOf('Hello World');
            expect(contentIndex).toBeGreaterThan(0);
        });

        it('should handle binary buffers', () => {
            const files: FileMap = {
                'binary.bin': Buffer.from([1, 2, 3, 4]),
            };

            const zip = createZipBuffer(files);
            const contentIndex = zip.indexOf(Buffer.from([1, 2, 3, 4]));
            expect(contentIndex).toBeGreaterThan(0);
        });

        it('should handle multiple files and sort them', () => {
            const files: FileMap = {
                'b.txt': 'file b',
                'a.txt': 'file a',
            };

            const zip = createZipBuffer(files);

            const indexA = zip.indexOf('a.txt');
            const indexB = zip.indexOf('b.txt');

            // In the zip buffer, local headers come in order.
            // Since createZipBuffer sorts keys, 'a.txt' should appear before 'b.txt' (in their respective headers).
            // Note: filenames appear in both local headers and central directory. 
            // The first occurrence of 'a.txt' (local header 1) should be before first occurrence of 'b.txt' (local header 2).
            expect(indexA).toBeLessThan(indexB);
        });

        it('should normalize paths to forward slashes', () => {
            const files: FileMap = {
                'dir\\test.txt': 'content',
            };

            const zip = createZipBuffer(files);
            // Should contain normalized path
            expect(zip.indexOf('dir/test.txt')).toBeGreaterThan(-1);
            // Should NOT contain backslash path in the standard header name fields (though technically data is arbitrary, strict check might depend on impl)
            expect(zip.indexOf('dir\\test.txt')).toBe(-1);
        });
    });
});
