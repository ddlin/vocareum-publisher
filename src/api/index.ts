/**
 * API module exports
 */

export {
  VocareumClient,
  VocareumError,
  APIError,
  AuthenticationError,
  RateLimitError,
  NotFoundError,
} from './client';

export * as courses from './courses';
export * as assignments from './assignments';
export * as parts from './parts';
export * as content from './content';
export * from './rubrics';
