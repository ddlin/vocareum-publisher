import type { Config, PublishHistory } from '../../types/config';
import type { ReconciliationPlan } from '../../types/state';
import type { RubricSyncPlan } from '../../types/api';

// Per-invocation options (NOT in the context — the context is the durable
// environment; the request is what this call does). Mirror today's options.
export interface PushRequest {
  dryRun?: boolean; nonInteractive?: boolean; autoCommit?: boolean;
  syncDeletes?: boolean; onMissingId?: 'skip' | 'abort'; abortOnError?: boolean;
  assignment?: string; part?: string; forceAll?: boolean; verbose?: boolean;
  /**
   * Internal single-session compatibility switch. The CLI resolves deletions
   * after upload, preserving its historical API-call order. Detached callers
   * omit this so exact delete paths are captured before confirmation.
   */
  deferDeleteResolution?: boolean;
}
export interface PullRequest {
  batch?: boolean; nonInteractive?: boolean; skipContent?: boolean;
  content?: boolean; assignment?: string[]; part?: string[]; verbose?: boolean;
}

// Canonical, immutable description of EVERY intended mutation (review P0 #1/#3).
// Derived from the reconciliation plan; this — not result types — is what the
// fingerprint hashes and what executePush consumes.
export type AssignmentAction = 'create' | 'update' | 'skip';
export interface PartIntent {
  partId: string | null;                       // null = to be created
  path: string;
  settingsPayload?: Record<string, unknown>;   // canonical settings to PUT
  contentHashes: Record<string, string>;       // per-directory hash of intended upload
  /** Exact `directory/relative-path` files approved for deletion. Empty means none. */
  deletePaths?: string[];
  /** Deletion sets that can only be resolved after a new assignment is copied. */
  reconcileDeleteDirectories?: string[];
  /** Rubric criteria executePush will create/update on this part. Included in the
   *  fingerprint (see plan-fingerprint.ts) so a maxscore change shifts it. */
  rubricPlan?: RubricSyncPlan;
  /** Set when the plan-time rubric read for this part failed. Carried through so
   *  executePush can fail the run instead of reporting success having migrated no
   *  points; included in the fingerprint so a newly-failing/newly-recovering read
   *  shifts it. */
  rubricReadFailed?: string;
}
export interface AssignmentIntent {
  path: string;
  name: string;
  assignmentId: string | null;                 // null = create-from-template
  templateAssignmentId?: string;               // template assignment identity for creation
  templateCourseId?: string;                   // course the template lives in (cross-course creation)
  action: AssignmentAction;
  settingsPayload?: Record<string, unknown>;
  parts: PartIntent[];
}
export interface PushIntent {
  assignments: AssignmentIntent[];
  /** Canonical course-settings payload that executePush will send (populated when coursesToUpdate > 0). */
  courseSettings?: Record<string, unknown>;
}

export interface RemoteAssumption {
  assignmentPath: string;
  assignmentId: string | null;
  exists: boolean;                             // false for a planned create (duplicate guard)
  partIds: string[];
}
export interface PushPreconditions {
  configDigest: string;                        // hash of persisted YAML text
  contentHashes: Record<string, string>;       // local dir hashes plan was computed from
  assignmentIds: string[];
  partIds: string[];
  remoteAssumptions: RemoteAssumption[];
}
export interface PushPlan {
  intent: PushIntent;
  preconditions: PushPreconditions;
  semanticFingerprint: string;                 // hash of the WHOLE intent (Task 9)
  summary: string;
  /** True when there is at least one change to push (course, assignment, part, or ID discovery). */
  hasChanges: boolean;
  /**
   * Plain-data context needed for persistence and result reporting. Remote
   * mutations remain governed by `intent`.
   */
  execution: {
    reconciliation: ReconciliationPlan;
    workingConfig: Config;
    lastHistory?: PublishHistory;
  };
}
