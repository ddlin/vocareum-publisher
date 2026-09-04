/**
 * Internal State Types
 *
 * Types used for validation, reconciliation, and publish operations.
 */

import type { Assignment, Part, DirectoryType, Config } from './config';
import type { RubricSyncPlan, RemoteRubric } from './api';

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
  /**
   * Per-directory hashes computed by the reconciler during change detection.
   * Keys are directory names (e.g. 'startercode'); values are the SHA-256
   * hashes produced by calculateDirectoryHash with the effective exclude
   * patterns. planPush reads these instead of recomputing (Stage 1a Fix 3).
   */
  dirHashes?: Record<string, string>;
  /** True when part metadata (name) differs from remote and needs updating */
  metadataChanged?: boolean;
  /** Rubric work this part needs, when rubric sync is enabled and the part has
   *  `rubrics` in config. Present only when non-empty — a part whose rubrics already
   *  match carries no plan and stays a `skip`. */
  rubricPlan?: RubricSyncPlan;
  /** The part's remote rubric rows as read during reconciliation, carried so the push
   *  confirmation can project the point total without a second fetch. */
  remoteRubrics?: RemoteRubric[];
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
  /** Course ID where the template assignment exists (for cross-course templates) */
  templateCourseId?: string;
  /** True when assignment_id was discovered via name lookup and should be persisted */
  idDiscoveredByName?: boolean;
  /** True when part_ids were discovered and should be persisted */
  partIdsDiscovered?: boolean;
  /** True when assignment metadata differs from remote and needs updating */
  assignmentMetadataChanged?: boolean;
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
  coursesToUpdate: number;
  assignmentsToCreate: number;
  assignmentsToUpdate: number;
  assignmentsWithDiscoveredIds: number;
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
  /** Assignments in config but deleted from Vocareum */
  staleInConfig: StaleAssignment[];
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
  parts?: string[];
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
 * Stale assignment in config (deleted from Vocareum)
 */
export interface StaleAssignment {
  assignment_id: string;
  name: string;
  path: string;
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
  onMissingId?: 'skip' | 'abort';
  abortOnError?: boolean;
  configPath?: string;
  /** Absolute directory assignment/part paths resolve against (defaults to cwd) */
  workspaceRoot?: string;
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
  /**
   * Exact remote-relative paths approved by the push intent for this directory.
   * When supplied (including an empty array), syncDirectory must not relist.
   */
  plannedDeletePaths?: string[];
  concurrency?: number;
  /** Absolute confinement boundary for local reads (defaults to cwd) */
  workspaceRoot?: string;
  /** Course workspace architecture — determines API path prefix for file listing */
  architecture?: 'elite' | 'container';
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
