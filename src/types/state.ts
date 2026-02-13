/**
 * Internal State Types
 *
 * Types used for validation, reconciliation, and publish operations.
 */

import type { Assignment, Part, DirectoryType, Config } from './config';

/**
 * Validation error types
 */
export type ValidationErrorType =
  | 'missing_folder'
  | 'missing_yaml_entry'
  | 'invalid_structure'
  | 'missing_course'
  | 'invalid_id';

/**
 * Validation warning types
 */
export type ValidationWarningType =
  | 'orphaned_folder'
  | 'orphaned_assignment'
  | 'optional_dir_missing';

/**
 * Validation error with fix suggestion
 */
export interface ValidationError {
  type: ValidationErrorType;
  path: string;
  message: string;
  fix?: string;
}

/**
 * Validation warning
 */
export interface ValidationWarning {
  type: ValidationWarningType;
  path: string;
  message: string;
}

/**
 * Result of validation operation
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/**
 * Action types for reconciliation
 */
export type ActionType = 'create' | 'update' | 'skip' | 'error';

/**
 * Part action in reconciliation plan
 */
export interface PartAction {
  type: ActionType;
  part: Part;
  contentChanged: boolean;
  changedDirectories?: DirectoryType[];
  reason?: string;
}

/**
 * Assignment action in reconciliation plan
 */
export interface AssignmentAction {
  type: ActionType;
  assignment: Assignment;
  parts: PartAction[];
  reason?: string;
  willCreate?: boolean;
  templateId?: string;
}

/**
 * Course action in reconciliation plan
 */
export interface CourseAction {
  type: ActionType;
  reason?: string;
}

/**
 * Summary of reconciliation plan
 */
export interface ReconciliationSummary {
  assignmentsToCreate: number;
  assignmentsToUpdate: number;
  assignmentsToSkip: number;
  partsToCreate: number;
  partsToUpdate: number;
  estimatedApiCalls: number;
}

/**
 * Full reconciliation plan
 */
export interface ReconciliationPlan {
  config: Config;
  course: CourseAction;
  assignments: AssignmentAction[];
  summary: ReconciliationSummary;
  orphanedInVocareum: OrphanedEntity[];
}

/**
 * Part mapping between config and API
 */
export interface PartMapping {
  configPart: Part;
  apiPartId: string;
  seqnum: string;
}

/**
 * Created entity record
 */
export interface CreatedEntity {
  type: 'assignment' | 'part';
  id: string;
  parts?: string[];
}

/**
 * Updated entity record
 */
export interface UpdatedEntity {
  type: 'assignment' | 'part';
  id: string;
}

/**
 * Skipped entity record
 */
export interface SkippedEntity {
  type: 'assignment' | 'part';
  id: string;
  reason: string;
}

/**
 * Failed entity record
 */
export interface FailedEntity {
  type: 'assignment' | 'part' | 'file';
  id: string;
  error: unknown;
}

/**
 * Deleted entity record (for sync_deletes)
 */
export interface DeletedEntity {
  type: 'file';
  path: string;
  partId: string;
}

/**
 * Orphaned entity in Vocareum (not in config)
 */
export interface OrphanedEntity {
  type: 'assignment';
  id: string;
  name: string;
  message: string;
}

/**
 * Result of publish operation
 */
export interface PublishResult {
  success: boolean;
  created: CreatedEntity[];
  updated: UpdatedEntity[];
  skipped: SkippedEntity[];
  failed: FailedEntity[];
  deleted?: DeletedEntity[];
  orphanedInVocareum?: OrphanedEntity[];
  configUpdates?: {
    assignments?: Partial<Assignment>[];
  };
  contentState: Record<string, string>;
  summary: string;
}

/**
 * Options for publish operation
 */
export interface PublishOperationOptions {
  dryRun?: boolean;
  nonInteractive?: boolean;
  autoCommit?: boolean;
  syncDeletes?: boolean;
  assignment?: string;
  part?: string;
  forceAll?: boolean;
  verbose?: boolean;
}

/**
 * Options for upload operation
 */
export interface UploadOptions {
  excludePatterns?: string[];
  forceAll?: boolean;
  syncDeletes?: boolean;
  concurrency?: number;
  onProgress?: (progress: UploadProgress) => void;
}

/**
 * Upload progress information
 */
export interface UploadProgress {
  directory: DirectoryType;
  current: number;
  total: number;
  fileName: string;
}

/**
 * Fix action types
 */
export type FixType = 'add_yaml' | 'create_folder' | 'remove_yaml';

/**
 * Fix action to apply
 */
export interface Fix {
  type: FixType;
  path: string;
  assignment?: {
    name: string;
    numParts: number;
  };
}

/**
 * Options for fix operation
 */
export interface FixOptions {
  nonInteractive?: boolean;
  generateYaml?: boolean;
  createFolders?: boolean;
}
