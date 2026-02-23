import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const DEFAULT_PART_DIRECTORIES = ['startercode', 'scripts', 'docs', 'data'];
const BASE_EXCLUDE_PATTERNS = ['.gitkeep', '**/.gitkeep'];

interface VocareumPart {
    path: string;
    directories?: string[];
}

interface VocareumAssignment {
    path: string;
    parts?: VocareumPart[];
}

interface PublishOptions {
    exclude_patterns?: string[];
}

interface PublishHistoryEntry {
    timestamp?: string;
    content_state?: Record<string, string>;
}

interface VocareumConfig {
    assignments?: VocareumAssignment[];
    publish_options?: PublishOptions;
    publish_history?: PublishHistoryEntry[];
}

export type AssignmentSyncStatus = 'synced' | 'needs_publish' | 'unknown' | 'error';

export interface SyncSnapshot {
    assignmentStatuses: Map<string, AssignmentSyncStatus>;
    latestLocalChangeAt?: Date;
    lastRemoteCheckAt?: Date;
    hasPendingLocalChanges: boolean;
    hasUnknownAssignments: boolean;
}

function parseYamlConfig(raw: string): VocareumConfig {
    const parsed = yaml.load(raw);
    if (typeof parsed !== 'object' || parsed === null) {
        return {};
    }
    return parsed as VocareumConfig;
}

function getLatestHistoryEntry(history: PublishHistoryEntry[] | undefined): PublishHistoryEntry | undefined {
    if (!Array.isArray(history) || history.length === 0) {
        return undefined;
    }

    let latest = history[0];
    let latestTime = Date.parse(history[0].timestamp ?? '');

    for (let i = 1; i < history.length; i += 1) {
        const current = history[i];
        const currentTime = Date.parse(current.timestamp ?? '');
        if (!Number.isNaN(currentTime) && (Number.isNaN(latestTime) || currentTime > latestTime)) {
            latest = current;
            latestTime = currentTime;
        }
    }

    return latest;
}

function partDirectories(part: VocareumPart): string[] {
    if (Array.isArray(part.directories) && part.directories.length > 0) {
        return part.directories;
    }
    return DEFAULT_PART_DIRECTORIES;
}

function globToRegex(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '<<<DOUBLE>>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<<DOUBLE>>>/g, '.*');
    return new RegExp(`^${escaped}$`);
}

function shouldExclude(relativePath: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
        if (globToRegex(pattern).test(relativePath)) {
            return true;
        }
    }
    return false;
}

async function readDirectory(dirPath: string, excludePatterns: string[]): Promise<Record<string, Buffer>> {
    const files: Record<string, Buffer> = {};

    async function walk(currentPath: string, basePath: string): Promise<void> {
        const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            const relativePath = path.relative(basePath, fullPath);

            if (shouldExclude(relativePath, excludePatterns)) {
                continue;
            }

            if (entry.isDirectory()) {
                await walk(fullPath, basePath);
                continue;
            }

            if (entry.isFile()) {
                files[relativePath] = await fs.promises.readFile(fullPath);
            }
        }
    }

    try {
        await walk(dirPath, dirPath);
    } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== 'ENOENT') {
            throw error;
        }
    }

    return files;
}

async function calculateDirectoryHash(dirPath: string, excludePatterns: string[]): Promise<string> {
    const files = await readDirectory(dirPath, excludePatterns);
    const sortedPaths = Object.keys(files).sort();

    if (sortedPaths.length === 0) {
        return crypto.createHash('sha256').update('empty').digest('hex');
    }

    const fileHashes: string[] = [];
    for (const filePath of sortedPaths) {
        const fileHash = crypto.createHash('sha256').update(files[filePath]).digest('hex');
        fileHashes.push(`${filePath}:${fileHash}`);
    }

    return crypto.createHash('sha256').update(fileHashes.join(':')).digest('hex');
}

async function getLatestModifiedTime(targetPath: string): Promise<number> {
    try {
        const stats = await fs.promises.stat(targetPath);
        let latest = stats.mtimeMs;

        if (!stats.isDirectory()) {
            return latest;
        }

        const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(targetPath, entry.name);
            const childLatest = await getLatestModifiedTime(fullPath);
            if (childLatest > latest) {
                latest = childLatest;
            }
        }

        return latest;
    } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === 'ENOENT') {
            return 0;
        }
        throw error;
    }
}

function getPreviousHash(contentState: Record<string, string>, assignmentPath: string, partPath: string, directory: string): string | undefined {
    const nativeKey = path.join(assignmentPath, partPath, directory);
    const posixKey = `${assignmentPath}/${partPath}/${directory}`;

    return contentState[nativeKey]
        ?? contentState[nativeKey.replace(/\\/g, '/')]
        ?? contentState[posixKey];
}

export async function computeSyncSnapshot(workspaceRoot: string | undefined): Promise<SyncSnapshot | undefined> {
    if (!workspaceRoot) {
        return undefined;
    }

    const yamlPath = path.join(workspaceRoot, 'vocareum.yaml');
    if (!fs.existsSync(yamlPath)) {
        return undefined;
    }

    const config = parseYamlConfig(await fs.promises.readFile(yamlPath, 'utf8'));
    const assignments = Array.isArray(config.assignments) ? config.assignments : [];
    const latestHistory = getLatestHistoryEntry(config.publish_history);
    const contentState = latestHistory?.content_state;
    const excludePatterns = [
        ...BASE_EXCLUDE_PATTERNS,
        ...(config.publish_options?.exclude_patterns ?? [])
    ];

    let latestLocalChangeMs = 0;
    const assignmentStatuses = new Map<string, AssignmentSyncStatus>();

    for (const assignment of assignments) {
        if (typeof assignment.path !== 'string' || assignment.path.trim() === '') {
            continue;
        }

        const assignmentRoot = path.join(workspaceRoot, assignment.path);
        const assignmentLatest = await getLatestModifiedTime(assignmentRoot);
        if (assignmentLatest > latestLocalChangeMs) {
            latestLocalChangeMs = assignmentLatest;
        }

        if (!contentState || typeof contentState !== 'object') {
            assignmentStatuses.set(assignment.path, 'unknown');
            continue;
        }

        try {
            const parts = Array.isArray(assignment.parts) ? assignment.parts : [];
            let needsPublish = false;

            for (const part of parts) {
                if (typeof part.path !== 'string' || part.path.trim() === '') {
                    continue;
                }

                for (const directory of partDirectories(part)) {
                    const previousHash = getPreviousHash(contentState, assignment.path, part.path, directory);
                    const fullDirectoryPath = path.join(workspaceRoot, assignment.path, part.path, directory);
                    const currentHash = await calculateDirectoryHash(fullDirectoryPath, excludePatterns);

                    if (previousHash === undefined || currentHash !== previousHash) {
                        needsPublish = true;
                        break;
                    }
                }

                if (needsPublish) {
                    break;
                }
            }

            assignmentStatuses.set(assignment.path, needsPublish ? 'needs_publish' : 'synced');
        } catch {
            assignmentStatuses.set(assignment.path, 'error');
        }
    }

    const hasPendingLocalChanges = [...assignmentStatuses.values()].some(status => status === 'needs_publish');
    const hasUnknownAssignments = [...assignmentStatuses.values()].some(status => status === 'unknown');
    const remoteTimeMs = Date.parse(latestHistory?.timestamp ?? '');

    return {
        assignmentStatuses,
        hasPendingLocalChanges,
        hasUnknownAssignments,
        latestLocalChangeAt: latestLocalChangeMs > 0 ? new Date(latestLocalChangeMs) : undefined,
        lastRemoteCheckAt: Number.isNaN(remoteTimeMs) ? undefined : new Date(remoteTimeMs)
    };
}
