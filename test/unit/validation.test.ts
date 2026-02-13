/**
 * Validation Utilities Tests
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  validateSchema,
  formatZodError,
  validateNonEmptyString,
  validateId,
  SchemaValidationError,
} from '../../src/utils/validation';

describe('validateSchema', () => {
  const TestSchema = z.object({
    name: z.string(),
    age: z.number(),
    email: z.string().email().optional(),
  });

  it('should validate correct data', () => {
    const data = { name: 'John', age: 30 };
    const result = validateSchema(TestSchema, data);

    expect(result.name).toBe('John');
    expect(result.age).toBe(30);
  });

  it('should validate data with optional fields', () => {
    const data = { name: 'John', age: 30, email: 'john@example.com' };
    const result = validateSchema(TestSchema, data);

    expect(result.email).toBe('john@example.com');
  });

  it('should throw SchemaValidationError for invalid data', () => {
    const data = { name: 'John' }; // Missing required 'age'

    expect(() => validateSchema(TestSchema, data)).toThrow(SchemaValidationError);
  });

  it('should include error details in SchemaValidationError', () => {
    const data = { name: 123, age: 'not a number' }; // Wrong types

    try {
      validateSchema(TestSchema, data);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect((error as SchemaValidationError).errors).toBeDefined();
      expect((error as SchemaValidationError).errors.errors).toHaveLength(2);
    }
  });

  it('should handle nested schema validation', () => {
    const NestedSchema = z.object({
      user: z.object({
        name: z.string(),
        profile: z.object({
          bio: z.string(),
        }),
      }),
    });

    const validData = {
      user: {
        name: 'John',
        profile: { bio: 'Hello' },
      },
    };

    const result = validateSchema(NestedSchema, validData);
    expect(result.user.name).toBe('John');
  });
});

describe('formatZodError', () => {
  it('should format single error', () => {
    const schema = z.object({ name: z.string() });

    try {
      schema.parse({ name: 123 });
    } catch (error) {
      if (error instanceof z.ZodError) {
        const formatted = formatZodError(error);
        expect(formatted).toContain('name');
      }
    }
  });

  it('should format multiple errors', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });

    try {
      schema.parse({ name: 123, age: 'not a number' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        const formatted = formatZodError(error);
        expect(formatted).toContain('name');
        expect(formatted).toContain('age');
      }
    }
  });

  it('should format nested path errors', () => {
    const schema = z.object({
      user: z.object({
        email: z.string().email(),
      }),
    });

    try {
      schema.parse({ user: { email: 'invalid' } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        const formatted = formatZodError(error);
        expect(formatted).toContain('user.email');
      }
    }
  });
});

describe('validateNonEmptyString', () => {
  it('should return trimmed string for valid input', () => {
    expect(validateNonEmptyString('  hello  ', 'field')).toBe('hello');
  });

  it('should throw for empty string', () => {
    expect(() => validateNonEmptyString('', 'field')).toThrow('field must be a non-empty string');
  });

  it('should throw for whitespace-only string', () => {
    expect(() => validateNonEmptyString('   ', 'field')).toThrow(
      'field must be a non-empty string'
    );
  });

  it('should throw for non-string values', () => {
    expect(() => validateNonEmptyString(123, 'field')).toThrow('field must be a non-empty string');
    expect(() => validateNonEmptyString(null, 'field')).toThrow('field must be a non-empty string');
    expect(() => validateNonEmptyString(undefined, 'field')).toThrow(
      'field must be a non-empty string'
    );
  });
});

describe('validateId', () => {
  it('should return string for valid string ID', () => {
    expect(validateId('12345', 'id')).toBe('12345');
  });

  it('should return null for null input', () => {
    expect(validateId(null, 'id')).toBeNull();
  });

  it('should throw for non-string, non-null values', () => {
    expect(() => validateId(12345, 'id')).toThrow('id must be a string or null');
    expect(() => validateId(undefined, 'id')).toThrow('id must be a string or null');
    expect(() => validateId({}, 'id')).toThrow('id must be a string or null');
  });

  it('should include type in error message', () => {
    try {
      validateId(12345, 'assignment_id');
    } catch (error) {
      expect((error as Error).message).toContain('assignment_id');
      expect((error as Error).message).toContain('number');
    }
  });
});

describe('SchemaValidationError', () => {
  it('should have correct properties', () => {
    const zodError = new z.ZodError([]);
    const error = new SchemaValidationError('test message', zodError);

    expect(error.message).toBe('test message');
    expect(error.name).toBe('SchemaValidationError');
    expect(error.errors).toBe(zodError);
  });
});
