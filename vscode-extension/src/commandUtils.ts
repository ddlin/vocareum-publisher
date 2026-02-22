/**
 * Escape a shell argument using single-quote strategy.
 */
export function shellEscape(value: string): string {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * Build a shell-safe vocgit command string from argument list.
 */
export function buildVocGitCommand(args: string[]): string {
    return ['vocgit', ...args.map(shellEscape)].join(' ');
}

/**
 * Extracts a folder path from either a direct string or a tree item payload.
 */
export function extractOpenPath(argument: unknown): string | undefined {
    if (typeof argument === 'string' && argument.trim() !== '') {
        return argument;
    }

    if (typeof argument === 'object' && argument !== null) {
        const candidate = argument as { data?: { fullPath?: unknown } };
        if (typeof candidate.data?.fullPath === 'string' && candidate.data.fullPath.trim() !== '') {
            return candidate.data.fullPath;
        }
    }

    return undefined;
}

/**
 * Extracts assignment path from a tree item payload.
 */
export function extractAssignmentPath(argument: unknown): string | undefined {
    if (typeof argument === 'object' && argument !== null) {
        const candidate = argument as { data?: { assignmentPath?: unknown } };
        if (typeof candidate.data?.assignmentPath === 'string' && candidate.data.assignmentPath.trim() !== '') {
            return candidate.data.assignmentPath;
        }
    }

    return undefined;
}
