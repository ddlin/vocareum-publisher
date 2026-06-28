// src/core/services/types.ts (Task 7 creates this)

// Per-invocation options (NOT in the context — the context is the durable
// environment; the request is what this call does). Mirror today's options.
export interface PushRequest {
  dryRun?: boolean; nonInteractive?: boolean; autoCommit?: boolean;
  syncDeletes?: boolean; onMissingId?: 'skip' | 'abort'; abortOnError?: boolean;
  assignment?: string; part?: string; forceAll?: boolean; verbose?: boolean;
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
  deletePaths?: string[];                       // files to delete (sync-deletes)
}
export interface AssignmentIntent {
  path: string;
  assignmentId: string | null;                 // null = create-from-template
  templateAssignmentId?: string;               // template identity for creation
  action: AssignmentAction;
  settingsPayload?: Record<string, unknown>;
  parts: PartIntent[];
}
export interface PushIntent { assignments: AssignmentIntent[]; }

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
}
