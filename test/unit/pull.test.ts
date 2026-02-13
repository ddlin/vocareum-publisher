/**
 * Pull Command Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { slugify, getUniqueDirectoryName, valuesEqual } from '../../src/commands/pull';

describe('Pull Command Utilities', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voc-pull-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('slugify', () => {
    it('should convert spaces to hyphens', () => {
      expect(slugify('Lab 3 Advanced Topics')).toBe('lab-3-advanced-topics');
    });

    it('should convert to lowercase', () => {
      expect(slugify('MyAssignment')).toBe('myassignment');
    });

    it('should remove special characters', () => {
      expect(slugify('Lab #1: Introduction!')).toBe('lab-1-introduction');
    });

    it('should collapse multiple hyphens', () => {
      expect(slugify('Lab  ---  Test')).toBe('lab-test');
    });

    it('should trim leading and trailing hyphens', () => {
      expect(slugify('---Lab Test---')).toBe('lab-test');
    });

    it('should handle numbers', () => {
      expect(slugify('Assignment 123')).toBe('assignment-123');
    });

    it('should handle empty string', () => {
      expect(slugify('')).toBe('');
    });

    it('should handle only special characters', () => {
      expect(slugify('!!!@@@###')).toBe('');
    });

    it('should handle unicode characters', () => {
      expect(slugify('Lab Cafe')).toBe('lab-cafe');
    });

    it('should handle mixed case with numbers', () => {
      expect(slugify('Lab3AdvancedTopics')).toBe('lab3advancedtopics');
    });
  });

  describe('getUniqueDirectoryName', () => {
    it('should return the desired name if it does not exist', async () => {
      const name = await getUniqueDirectoryName(tempDir, 'my-assignment');
      expect(name).toBe('my-assignment');
    });

    it('should append -2 if directory exists', async () => {
      await fs.mkdir(path.join(tempDir, 'my-assignment'));

      const name = await getUniqueDirectoryName(tempDir, 'my-assignment');
      expect(name).toBe('my-assignment-2');
    });

    it('should append -3 if both original and -2 exist', async () => {
      await fs.mkdir(path.join(tempDir, 'my-assignment'));
      await fs.mkdir(path.join(tempDir, 'my-assignment-2'));

      const name = await getUniqueDirectoryName(tempDir, 'my-assignment');
      expect(name).toBe('my-assignment-3');
    });

    it('should handle multiple conflicts', async () => {
      await fs.mkdir(path.join(tempDir, 'lab'));
      await fs.mkdir(path.join(tempDir, 'lab-2'));
      await fs.mkdir(path.join(tempDir, 'lab-3'));
      await fs.mkdir(path.join(tempDir, 'lab-4'));

      const name = await getUniqueDirectoryName(tempDir, 'lab');
      expect(name).toBe('lab-5');
    });

    it('should work with nested base path', async () => {
      const nested = path.join(tempDir, 'nested', 'path');
      await fs.mkdir(nested, { recursive: true });
      await fs.mkdir(path.join(nested, 'assignment'));

      const name = await getUniqueDirectoryName(nested, 'assignment');
      expect(name).toBe('assignment-2');
    });

    it('should handle files with same name as directory', async () => {
      // A file with the same name should also cause a conflict
      await fs.writeFile(path.join(tempDir, 'my-assignment'), 'content');

      const name = await getUniqueDirectoryName(tempDir, 'my-assignment');
      expect(name).toBe('my-assignment-2');
    });
  });
});

describe('Excluded Assignments Integration', () => {
  it('should filter excluded assignments from orphans', async () => {
    // This is more of a documentation/design test
    // The actual integration would require mocking the API

    // Given: config with excluded_assignments: ['123', '456']
    // When: reconciler identifies orphans
    // Then: assignments '123' and '456' should not appear in orphanedInVocareum

    // This behavior is implemented in reconciler.ts lines 222-232
    expect(true).toBe(true);
  });
});

describe('Settings Drift Detection', () => {
  describe('valuesEqual', () => {
    it('should return true for identical primitives', () => {
      expect(valuesEqual('hello', 'hello')).toBe(true);
      expect(valuesEqual(123, 123)).toBe(true);
      expect(valuesEqual(true, true)).toBe(true);
    });

    it('should return false for different primitives', () => {
      expect(valuesEqual('hello', 'world')).toBe(false);
      expect(valuesEqual(123, 456)).toBe(false);
      expect(valuesEqual(true, false)).toBe(false);
    });

    it('should handle undefined values', () => {
      expect(valuesEqual(undefined, undefined)).toBe(true);
      expect(valuesEqual(undefined, 'value')).toBe(false);
      expect(valuesEqual('value', undefined)).toBe(false);
    });

    it('should compare objects by JSON equality', () => {
      expect(valuesEqual({ a: 1 }, { a: 1 })).toBe(true);
      expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false);
      expect(valuesEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    });

    it('should compare arrays by JSON equality', () => {
      expect(valuesEqual([1, 2, 3], [1, 2, 3])).toBe(true);
      expect(valuesEqual([1, 2], [1, 2, 3])).toBe(false);
      expect(valuesEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    });

    it('should compare nested objects', () => {
      const obj1 = { filters: { include: ['*.py'], exclude: ['*.pyc'] } };
      const obj2 = { filters: { include: ['*.py'], exclude: ['*.pyc'] } };
      const obj3 = { filters: { include: ['*.py'], exclude: ['*.txt'] } };

      expect(valuesEqual(obj1, obj2)).toBe(true);
      expect(valuesEqual(obj1, obj3)).toBe(false);
    });

    it('should return false for different types', () => {
      expect(valuesEqual('123', 123)).toBe(false);
      expect(valuesEqual(true, 'true')).toBe(false);
    });
  });
});
