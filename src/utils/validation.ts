/**
 * Validation Helpers
 *
 * Helper functions for schema validation.
 */

import { ZodError, ZodSchema } from 'zod';

/**
 * Validation error with details
 */
export class SchemaValidationError extends Error {
  constructor(
    message: string,
    public errors: ZodError
  ) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

/**
 * Validate data against a Zod schema
 *
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @returns Validated data
 * @throws SchemaValidationError if validation fails
 */
export function validateSchema<T>(schema: ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    const message = formatZodError(result.error);
    throw new SchemaValidationError(message, result.error);
  }

  return result.data;
}

/**
 * Format Zod errors into a readable message
 */
export function formatZodError(error: ZodError): string {
  const messages = error.errors.map((err) => {
    const path = err.path.join('.');
    return path ? `${path}: ${err.message}` : err.message;
  });

  return messages.join('\n');
}

/**
 * Validate that a value is a non-empty string
 */
export function validateNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Validate that a value is a valid ID string (non-empty or null)
 */
export function validateId(value: unknown, fieldName: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string or null, got ${typeof value}`);
  }
  return value;
}
