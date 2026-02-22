import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import * as yaml from 'js-yaml';

interface VocareumPart {
    name?: string;
    path: string;
}

interface VocareumAssignment {
    name?: string;
    path: string;
    parts?: VocareumPart[];
}

interface VocareumConfig {
    vocareum?: {
        course_id?: string;
        course_settings?: {
            name?: string;
        };
    };
    assignments?: VocareumAssignment[];
}

type NodeType = 'course' | 'assignment' | 'part' | 'directory' | 'file' | 'welcome' | 'info' | 'error';

interface NodeData {
    assignments?: VocareumAssignment[];
    parts?: VocareumPart[];
    path?: string;
    fullPath?: string;
    assignmentPath?: string;
}

export class VocGitTreeDataProvider implements vscode.TreeDataProvider<VocGitTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<VocGitTreeItem | undefined | null | void> = new vscode.EventEmitter<VocGitTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<VocGitTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private workspaceRoot: string | undefined) { }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: VocGitTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: VocGitTreeItem): Promise<VocGitTreeItem[]> {
        if (!this.workspaceRoot) {
            return [
                new VocGitTreeItem('Open a folder to get started', vscode.TreeItemCollapsibleState.None, 'welcome')
            ];
        }

        const yamlPath = path.join(this.workspaceRoot, 'vocareum.yaml');

        // Root level - show course
        if (!element) {
            if (!this.pathExists(yamlPath)) {
                return [new VocGitTreeItem('No vocareum.yaml found', vscode.TreeItemCollapsibleState.None, 'info')];
            }

            try {
                const fileContent = await fs.promises.readFile(yamlPath, 'utf8');
                const config = yaml.load(fileContent) as VocareumConfig;
                const courseId = config.vocareum?.course_id || 'Unknown';
                const courseName = config.vocareum?.course_settings?.name || 'Course';

                return [new VocGitTreeItem(
                    `${courseName} (${courseId})`,
                    vscode.TreeItemCollapsibleState.Expanded,
                    'course',
                    { assignments: config.assignments || [] }
                )];
            } catch (e) {
                return [new VocGitTreeItem('Invalid YAML Format', vscode.TreeItemCollapsibleState.None, 'error')];
            }
        }

        // Assignments under course
        if (element.contextValue === 'course') {
            const assignments = element.data?.assignments as VocareumAssignment[] || [];
            return assignments.map((asn) => {
                const assignmentPath = path.join(this.workspaceRoot!, asn.path);
                const hasLocalChanges = this.hasModifiedFiles(asn.path, assignmentPath);
                return new VocGitTreeItem(
                    asn.name || 'Unnamed Assignment',
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'assignment',
                    {
                        parts: asn.parts,
                        path: asn.path,
                        fullPath: assignmentPath,
                        assignmentPath: asn.path
                    },
                    hasLocalChanges ? 'modified' : 'synced'
                );
            });
        }

        // Parts under assignment
        if (element.contextValue === 'assignment') {
            const parts = element.data?.parts as VocareumPart[] || [];
            const assignmentPath = element.data?.fullPath as string;

            return parts.map((part) => {
                const partPath = path.join(assignmentPath, part.path);
                return new VocGitTreeItem(
                    part.name || 'Unnamed Part',
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'part',
                    {
                        path: part.path,
                        fullPath: partPath,
                        assignmentPath: element.data?.assignmentPath
                    }
                );
            });
        }

        // Directories under part (startercode, scripts, etc.)
        if (element.contextValue === 'part') {
            const partPath = element.data?.fullPath as string;
            if (!this.pathExists(partPath)) {
                return [];
            }

            const knownDirs = ['startercode', 'scripts', 'lib', 'asnlib', 'docs', 'data', 'private'];
            const items: VocGitTreeItem[] = [];

            for (const dir of knownDirs) {
                const dirPath = path.join(partPath, dir);
                if (this.pathExists(dirPath)) {
                    items.push(new VocGitTreeItem(
                        dir,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'directory',
                        { fullPath: dirPath }
                    ));
                }
            }

            return items;
        }

        // Files under directory
        if (element.contextValue === 'directory') {
            const dirPath = element.data?.fullPath as string;
            return this.getFilesInDirectory(dirPath);
        }

        return [];
    }

    private async getFilesInDirectory(dirPath: string): Promise<VocGitTreeItem[]> {
        try {
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            const items: VocGitTreeItem[] = [];

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    items.push(new VocGitTreeItem(
                        entry.name,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'directory',
                        { fullPath }
                    ));
                } else {
                    items.push(new VocGitTreeItem(
                        entry.name,
                        vscode.TreeItemCollapsibleState.None,
                        'file',
                        { fullPath }
                    ));
                }
            }

            return items.sort((a, b) => {
                // Directories first, then files
                if (a.contextValue === 'directory' && b.contextValue !== 'directory') return -1;
                if (a.contextValue !== 'directory' && b.contextValue === 'directory') return 1;
                return a.label!.toString().localeCompare(b.label!.toString());
            });
        } catch (e) {
            return [];
        }
    }

    private hasModifiedFiles(assignmentPath: string, assignmentFullPath: string): boolean {
        // Prefer git status for accurate dirty-state detection
        if (this.workspaceRoot) {
            try {
                const output = execFileSync(
                    'git',
                    ['-C', this.workspaceRoot, 'status', '--porcelain', '--', assignmentPath],
                    { encoding: 'utf8' }
                );
                return output.trim().length > 0;
            } catch {
                // Fall back to a filesystem heuristic when git is unavailable
            }
        }

        try {
            const stats = fs.statSync(assignmentFullPath);
            const hourAgo = Date.now() - (60 * 60 * 1000);
            return stats.mtimeMs > hourAgo;
        } catch {
            return false;
        }
    }

    private pathExists(p: string): boolean {
        try {
            fs.accessSync(p);
            return true;
        } catch (err) {
            return false;
        }
    }
}

export class VocGitTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: NodeType,
        public readonly data?: NodeData,
        public readonly syncStatus?: 'synced' | 'modified' | 'error'
    ) {
        super(label, collapsibleState);

        this.tooltip = this.label;

        // Set icons based on type
        switch (contextValue) {
            case 'course':
                this.iconPath = new vscode.ThemeIcon('mortar-board');
                break;
            case 'assignment':
                this.setAssignmentIcon(syncStatus);
                this.description = data?.path || '';
                // Click to reveal in explorer
                if (data?.fullPath) {
                    this.command = {
                        command: 'vocgit.openFolder',
                        title: 'Open Folder',
                        arguments: [data.fullPath]
                    };
                }
                break;
            case 'part':
                this.iconPath = new vscode.ThemeIcon('symbol-folder');
                this.description = data?.path || '';
                if (data?.fullPath) {
                    this.command = {
                        command: 'vocgit.openFolder',
                        title: 'Open Folder',
                        arguments: [data.fullPath]
                    };
                }
                break;
            case 'directory':
                this.iconPath = new vscode.ThemeIcon('folder');
                if (data?.fullPath) {
                    this.resourceUri = vscode.Uri.file(data.fullPath);
                }
                break;
            case 'file':
                this.iconPath = new vscode.ThemeIcon('file');
                if (data?.fullPath) {
                    this.resourceUri = vscode.Uri.file(data.fullPath);
                    this.command = {
                        command: 'vscode.open',
                        title: 'Open File',
                        arguments: [vscode.Uri.file(data.fullPath)]
                    };
                }
                break;
            case 'error':
                this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
                break;
            case 'welcome':
                this.iconPath = new vscode.ThemeIcon('folder-opened');
                break;
            default:
                this.iconPath = new vscode.ThemeIcon('info');
        }
    }

    private setAssignmentIcon(status?: 'synced' | 'modified' | 'error') {
        switch (status) {
            case 'modified':
                this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
                break;
            case 'error':
                this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
                break;
            default:
                this.iconPath = new vscode.ThemeIcon('book');
        }
    }
}
