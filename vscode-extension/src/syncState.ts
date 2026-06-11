/**
 * Sync status for the sidebar views.
 *
 * The extension does NOT compute change detection itself: it shells out to
 * `vocgit status --json` so badges reflect the CONTENT change detection the
 * user's installed CLI uses on `vocgit push`. Scope caveat: settings drift
 * requires API calls and is not part of the report — a green "synced" badge
 * means no content changes, but push may still apply settings updates.
 * (A previous in-extension reimplementation of the hashing engine drifted
 * from the CLI — directory sets, architecture awareness — and showed wrong
 * badges. Do not bring it back; extend the CLI's JSON report instead.)
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type AssignmentSyncStatus = 'synced' | 'needs_publish' | 'unknown' | 'error';

export interface SyncSnapshot {
    assignmentStatuses: Map<string, AssignmentSyncStatus>;
    partStatuses: Map<string, AssignmentSyncStatus>;
    directoryStatuses: Map<string, AssignmentSyncStatus>;
    latestLocalChangeAt?: Date;
    lastRemoteCheckAt?: Date;
    hasPendingLocalChanges: boolean;
    hasUnknownAssignments: boolean;
}

/** `vocgit status --json` schema this extension understands. */
const SUPPORTED_SCHEMA_VERSION = 1;

type CliSyncStatus = 'synced' | 'needs_publish' | 'unknown' | 'pending_create' | 'unlinked' | 'error';

interface CliDirectoryScan {
    directory: string;
    status: CliSyncStatus;
}

interface CliPartScan {
    path: string;
    part_id: string | null;
    status: CliSyncStatus;
    directories: CliDirectoryScan[];
}

interface CliAssignmentScan {
    path: string;
    name: string;
    assignment_id: string | null;
    status: CliSyncStatus;
    parts: CliPartScan[];
}

export interface CliStatusReport {
    schema_version: number;
    last_push: { timestamp: string } | null;
    assignments: CliAssignmentScan[];
    summary: Record<string, number>;
}

export type StatusErrorKind = 'cli-not-found' | 'cli-too-old' | 'cli-failed' | 'bad-schema';

export interface StatusError {
    kind: StatusErrorKind;
    detail?: string;
}

export type RunCli = (cmd: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

export interface ComputeOptions {
    /** Explicit CLI binary path; falls back to the configured path, then PATH lookup of `vocgit`. */
    cliPath?: string;
    /** Injectable runner for tests. */
    runCli?: RunCli;
    /** How long a fetched snapshot may be reused (default 3s — coalesces one render pass). */
    cacheTtlMs?: number;
}

let configuredCliPath: string | undefined;
let lastStatusError: StatusError | undefined;
let statusErrorHandler: ((error: StatusError) => void) | undefined;

/** Set from the `vocgit.cliPath` setting at activation / on config change. */
export function configureCliPath(cliPath: string | undefined): void {
    configuredCliPath = cliPath !== undefined && cliPath.trim() !== '' ? cliPath : undefined;
}

/** Last failure from a status fetch, if any. Cleared on success. */
export function getLastStatusError(): StatusError | undefined {
    return lastStatusError;
}

/** Called whenever a status fetch fails; the extension surfaces notifications here. */
export function configureStatusErrorHandler(handler: ((error: StatusError) => void) | undefined): void {
    statusErrorHandler = handler;
}

function normalizeStatusKeySegment(segment: string): string {
    return segment.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

export function buildPartStatusKey(assignmentPath: string, partPath: string): string {
    const normalizedAssignment = normalizeStatusKeySegment(assignmentPath);
    const normalizedPart = normalizeStatusKeySegment(partPath);
    return `${normalizedAssignment}/${normalizedPart}`;
}

export function buildDirectoryStatusKey(assignmentPath: string, partPath: string, directory: string): string {
    return `${buildPartStatusKey(assignmentPath, partPath)}/${normalizeStatusKeySegment(directory)}`;
}

/**
 * Parse and validate `vocgit status --json` output.
 * Throws on malformed JSON or an unsupported schema version.
 */
export function parseStatusReport(stdout: string): CliStatusReport {
    const parsed = JSON.parse(stdout) as Partial<CliStatusReport>;
    if (parsed === null || typeof parsed !== 'object' || parsed.schema_version !== SUPPORTED_SCHEMA_VERSION) {
        throw new Error(`Unsupported vocgit status schema (expected ${SUPPORTED_SCHEMA_VERSION}, got ${String(parsed?.schema_version)})`);
    }
    if (!Array.isArray(parsed.assignments)) {
        throw new Error('Invalid vocgit status report: missing assignments');
    }
    return parsed as CliStatusReport;
}

function toBadgeStatus(status: CliSyncStatus): AssignmentSyncStatus {
    switch (status) {
        // pending_create: push will act (create) — unpublished local work.
        case 'pending_create':
            return 'needs_publish';
        // unlinked: push may link by name, skip, or abort — not locally decidable.
        case 'unlinked':
            return 'unknown';
        default:
            return status;
    }
}

/** Map the CLI report onto the snapshot shape the views consume. */
export function mapReportToSnapshot(report: CliStatusReport, latestLocalChangeAt?: Date): SyncSnapshot {
    const assignmentStatuses = new Map<string, AssignmentSyncStatus>();
    const partStatuses = new Map<string, AssignmentSyncStatus>();
    const directoryStatuses = new Map<string, AssignmentSyncStatus>();

    for (const assignment of report.assignments) {
        assignmentStatuses.set(assignment.path, toBadgeStatus(assignment.status));
        for (const part of assignment.parts) {
            partStatuses.set(buildPartStatusKey(assignment.path, part.path), toBadgeStatus(part.status));
            for (const dir of part.directories) {
                directoryStatuses.set(
                    buildDirectoryStatusKey(assignment.path, part.path, dir.directory),
                    toBadgeStatus(dir.status)
                );
            }
        }
    }

    const statuses = [...assignmentStatuses.values()];
    const remoteTimeMs = Date.parse(report.last_push?.timestamp ?? '');

    return {
        assignmentStatuses,
        partStatuses,
        directoryStatuses,
        hasPendingLocalChanges: statuses.some((s) => s === 'needs_publish'),
        hasUnknownAssignments: statuses.some((s) => s === 'unknown'),
        latestLocalChangeAt,
        lastRemoteCheckAt: Number.isNaN(remoteTimeMs) ? undefined : new Date(remoteTimeMs),
    };
}

const defaultRunCli: RunCli = (cmd, args, cwd) =>
    new Promise((resolve, reject) => {
        execFile(cmd, args, { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                (error as NodeJS.ErrnoException & { stderr?: string }).stderr = String(stderr);
                reject(error);
                return;
            }
            resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
    });

function classifyError(error: unknown): StatusError {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') {
        return { kind: 'cli-not-found', detail: err.message };
    }
    const stderr = err.stderr ?? '';
    if (stderr.includes("unknown option '--json'") || stderr.includes('unknown option --json')) {
        return { kind: 'cli-too-old', detail: stderr };
    }
    if (error instanceof SyntaxError || (error instanceof Error && error.message.includes('schema'))) {
        return { kind: 'bad-schema', detail: error.message };
    }
    return { kind: 'cli-failed', detail: error instanceof Error ? error.message : String(error) };
}

/** Newest mtime under the assignment trees — display-only ("local changes at ..."). */
async function getLatestModifiedTime(targetPath: string): Promise<number> {
    try {
        const stats = await fs.promises.stat(targetPath);
        let latest = stats.mtimeMs;

        if (!stats.isDirectory()) {
            return latest;
        }

        const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
        for (const entry of entries) {
            const childLatest = await getLatestModifiedTime(path.join(targetPath, entry.name));
            if (childLatest > latest) {
                latest = childLatest;
            }
        }

        return latest;
    } catch {
        return 0;
    }
}

/** One tree render fetches the snapshot at several levels — coalesce those
 *  calls into a single CLI run instead of spawning vocgit per tree node. */
let snapshotCache: { root: string; at: number; value: Promise<SyncSnapshot | undefined> } | undefined;

/** Drop the cached snapshot (e.g. when vocareum.yaml changes). */
export function invalidateSnapshotCache(): void {
    snapshotCache = undefined;
}

/**
 * Fetch the sync snapshot by running `vocgit status --json` in the workspace.
 * Returns undefined (views show 'unknown') when there is no workspace/config
 * or the CLI cannot be run — see getLastStatusError() for why.
 */
export function computeSyncSnapshot(
    workspaceRoot: string | undefined,
    options?: ComputeOptions
): Promise<SyncSnapshot | undefined> {
    if (workspaceRoot === undefined || workspaceRoot === '') {
        return Promise.resolve(undefined);
    }

    if (!fs.existsSync(path.join(workspaceRoot, 'vocareum.yaml'))) {
        return Promise.resolve(undefined);
    }

    const ttl = options?.cacheTtlMs ?? 3000;
    if (snapshotCache !== undefined && snapshotCache.root === workspaceRoot && Date.now() - snapshotCache.at < ttl) {
        return snapshotCache.value;
    }

    const value = fetchSnapshot(workspaceRoot, options);
    snapshotCache = { root: workspaceRoot, at: Date.now(), value };
    return value;
}

async function fetchSnapshot(
    workspaceRoot: string,
    options?: ComputeOptions
): Promise<SyncSnapshot | undefined> {
    const cli = options?.cliPath ?? configuredCliPath ?? 'vocgit';
    const run = options?.runCli ?? defaultRunCli;

    try {
        const { stdout } = await run(cli, ['status', '--json'], workspaceRoot);
        const report = parseStatusReport(stdout);
        lastStatusError = undefined;

        let latestLocalChangeMs = 0;
        const workspaceAbs = path.resolve(workspaceRoot);
        for (const assignment of report.assignments) {
            // Assignment paths come from vocareum.yaml (attacker-controlled in a
            // cloned repo). The CLI marks escaping/symlinked paths as 'error';
            // skip those and lexically confine the rest before walking mtimes.
            if (assignment.status === 'error') {
                continue;
            }
            const assignmentAbs = path.resolve(workspaceRoot, assignment.path);
            if (assignmentAbs !== workspaceAbs && !assignmentAbs.startsWith(workspaceAbs + path.sep)) {
                continue;
            }
            const mtime = await getLatestModifiedTime(assignmentAbs);
            if (mtime > latestLocalChangeMs) {
                latestLocalChangeMs = mtime;
            }
        }

        return mapReportToSnapshot(
            report,
            latestLocalChangeMs > 0 ? new Date(latestLocalChangeMs) : undefined
        );
    } catch (error) {
        lastStatusError = classifyError(error);
        statusErrorHandler?.(lastStatusError);
        return undefined;
    }
}
