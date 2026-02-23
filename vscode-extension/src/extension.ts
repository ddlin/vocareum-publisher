import * as vscode from 'vscode';
import { VocGitTreeDataProvider } from './VocGitTreeDataProvider';
import { VocGitActionsProvider } from './VocGitActionsProvider';
import { buildVocGitCommand, extractAssignmentPath, extractOpenPath, extractVocareumLaunchIds, shellEscape } from './commandUtils';

// Output channel for logging
let outputChannel: vscode.OutputChannel;
const API_KEY_SECRET = 'vocgit.apiKey';

function log(message: string) {
    const timestamp = new Date().toISOString();
    outputChannel.appendLine(`[${timestamp}] ${message}`);
}

// Store terminal reference with API key baked into env
let vocgitTerminal: vscode.Terminal | undefined;
let terminalApiKey: string | undefined;
let terminalWorkspaceFolder: string | undefined;
let legacyApiKeyWarningShown = false;

async function clearLegacyApiKeySettings(): Promise<void> {
    const config = vscode.workspace.getConfiguration('vocgit');
    const targets = [
        vscode.ConfigurationTarget.Global,
        vscode.ConfigurationTarget.Workspace,
        vscode.ConfigurationTarget.WorkspaceFolder
    ];

    for (const target of targets) {
        try {
            await config.update('apiKey', '', target);
        } catch {
            // Ignore update failures for unavailable scopes
        }
    }
}

async function getApiKey(context: vscode.ExtensionContext): Promise<string> {
    const stored = (await context.secrets.get(API_KEY_SECRET))?.trim();
    if (stored) {
        return stored;
    }

    // Backward-compatible fallback for existing users
    const config = vscode.workspace.getConfiguration('vocgit');
    const legacyApiKey = config.get<string>('apiKey')?.trim() || '';

    if (legacyApiKey && !legacyApiKeyWarningShown) {
        legacyApiKeyWarningShown = true;
        log('Using deprecated vocgit.apiKey setting fallback');
        void vscode.window.showWarningMessage(
            'VocGit is using an API key from Settings. Run "VocGit: Set VOCAREUM_API_KEY" to move it to Secret Storage.',
            'Set API Key'
        ).then(async (selection) => {
            if (selection === 'Set API Key') {
                await vscode.commands.executeCommand('vocgit.setApiKey');
            }
        });
    }

    return legacyApiKey;
}

async function isApiKeyConfigured(context: vscode.ExtensionContext): Promise<boolean> {
    const stored = (await context.secrets.get(API_KEY_SECRET))?.trim();
    if (stored) {
        return true;
    }

    const legacyApiKey = vscode.workspace.getConfiguration('vocgit').get<string>('apiKey')?.trim() || '';
    return legacyApiKey.length > 0;
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
    const apiKey = await vscode.window.showInputBox({
        title: 'VocGit API Key',
        prompt: 'Enter your Vocareum API key',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'Paste API key'
    });

    if (apiKey === undefined) {
        return;
    }

    const trimmed = apiKey.trim();
    if (!trimmed) {
        vscode.window.showWarningMessage('API key was empty; no changes were made.');
        return;
    }

    await context.secrets.store(API_KEY_SECRET, trimmed);
    await clearLegacyApiKeySettings();
    legacyApiKeyWarningShown = true;

    // Force terminal recreation so the new key is injected into the environment
    if (vocgitTerminal) {
        vocgitTerminal.dispose();
        vocgitTerminal = undefined;
    }
    terminalApiKey = undefined;

    vscode.window.showInformationMessage('VocGit API key saved to VS Code Secret Storage.');
}

async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete(API_KEY_SECRET);
    await clearLegacyApiKeySettings();
    legacyApiKeyWarningShown = true;

    if (vocgitTerminal) {
        vocgitTerminal.dispose();
        vocgitTerminal = undefined;
    }
    terminalApiKey = undefined;

    vscode.window.showInformationMessage('VocGit API key cleared.');
}

async function getVocGitTerminal(
    context: vscode.ExtensionContext,
    workspaceFolder: string | undefined
): Promise<vscode.Terminal> {
    // Get current API key from secret storage (with legacy fallback)
    const apiKey = await getApiKey(context);

    // Check if existing terminal is still alive AND has the same API key
    if (
        vocgitTerminal &&
        vscode.window.terminals.includes(vocgitTerminal) &&
        terminalApiKey === apiKey &&
        terminalWorkspaceFolder === workspaceFolder
    ) {
        return vocgitTerminal;
    }

    if (vocgitTerminal && vscode.window.terminals.includes(vocgitTerminal)) {
        vocgitTerminal.dispose();
    }
    vocgitTerminal = undefined;

    // Create terminal with API key in environment (hidden from display)
    const env: Record<string, string> = {};
    if (apiKey) {
        env['VOCAREUM_API_KEY'] = apiKey;
    }

    vocgitTerminal = vscode.window.createTerminal({
        name: 'VocGit',
        env: env,
        cwd: workspaceFolder
    });
    terminalApiKey = apiKey;
    terminalWorkspaceFolder = workspaceFolder;

    return vocgitTerminal;
}

export function activate(context: vscode.ExtensionContext) {
    // Create output channel for debugging
    outputChannel = vscode.window.createOutputChannel('VocGit Studio');
    context.subscriptions.push(outputChannel);

    log('Extension activating...');

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    log(`Workspace folder: ${workspaceFolder || 'NONE'}`);

    // Register the actions webview
    const actionsProvider = new VocGitActionsProvider(
        context.extensionUri,
        workspaceFolder,
        () => isApiKeyConfigured(context)
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('vocgit.actionsView', actionsProvider)
    );

    // Register the sidebar tree view
    const treeDataProvider = new VocGitTreeDataProvider(workspaceFolder);
    vscode.window.registerTreeDataProvider('vocgit.yamlView', treeDataProvider);

    const refreshViews = () => {
        treeDataProvider.refresh();
        actionsProvider.refresh();
    };
    let refreshTimer: NodeJS.Timeout | undefined;
    const scheduleRefresh = () => {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
        }
        refreshTimer = setTimeout(() => {
            refreshViews();
        }, 150);
    };
    context.subscriptions.push(new vscode.Disposable(() => {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
        }
    }));

    log('Views registered');

    // Watch for changes to vocareum.yaml to automatically refresh views
    const yamlWatcher = vscode.workspace.createFileSystemWatcher('**/vocareum.yaml');
    yamlWatcher.onDidChange(() => {
        scheduleRefresh();
    });
    yamlWatcher.onDidCreate(() => {
        scheduleRefresh();
    });
    yamlWatcher.onDidDelete(() => {
        scheduleRefresh();
    });
    context.subscriptions.push(yamlWatcher);

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(() => scheduleRefresh()),
        vscode.workspace.onDidCreateFiles(() => scheduleRefresh()),
        vscode.workspace.onDidDeleteFiles(() => scheduleRefresh()),
        vscode.workspace.onDidRenameFiles(() => scheduleRefresh()),
        vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) {
                scheduleRefresh();
            }
        })
    );

    // Helper to run commands in the integrated terminal with shell-safe arguments
    async function runVocGitCommand(args: string[]) {
        const terminal = await getVocGitTerminal(context, workspaceFolder);
        terminal.show();

        const command = buildVocGitCommand(args);
        if (workspaceFolder) {
            // Always execute from workspace root even if users changed terminal cwd
            terminal.sendText(`cd ${shellEscape(workspaceFolder)} && ${command}`);
            setTimeout(() => scheduleRefresh(), 1500);
            return;
        }

        terminal.sendText(command);
        setTimeout(() => scheduleRefresh(), 1500);
    }

    // Register vocgit CLI commands
    context.subscriptions.push(
        vscode.commands.registerCommand('vocgit.push', async () => runVocGitCommand(['push'])),
        vscode.commands.registerCommand('vocgit.pull', async () => runVocGitCommand(['pull'])),
        vscode.commands.registerCommand('vocgit.status', async () => runVocGitCommand(['status'])),
        vscode.commands.registerCommand('vocgit.validate', async () => runVocGitCommand(['validate']))
    );

    // Push specific assignment
    context.subscriptions.push(
        vscode.commands.registerCommand('vocgit.pushAssignment', async (item: unknown) => {
            const assignmentPath = extractAssignmentPath(item);
            if (assignmentPath) {
                log(`Pushing assignment: ${assignmentPath}`);
                await runVocGitCommand(['push', '--assignment', assignmentPath]);
            } else {
                vscode.window.showWarningMessage('No assignment path found');
            }
        })
    );

    // Open folder in explorer
    context.subscriptions.push(
        vscode.commands.registerCommand('vocgit.openFolder', (folderArg: unknown) => {
            const folderPath = extractOpenPath(folderArg);
            if (folderPath) {
                const uri = vscode.Uri.file(folderPath);
                void vscode.commands.executeCommand('revealInExplorer', uri);
                log(`Opened folder: ${folderPath}`);
            } else {
                vscode.window.showWarningMessage('No folder path found');
            }
        })
    );

    // Open part in Vocareum Teacher IDE (browser)
    context.subscriptions.push(
        vscode.commands.registerCommand('vocgit.goToVocareum', async (item: unknown) => {
            const ids = extractVocareumLaunchIds(item);
            if (!ids) {
                vscode.window.showWarningMessage(
                    'Cannot open Vocareum: missing assignment_id or part_id in vocareum.yaml for this part.'
                );
                return;
            }

            const url = `https://labs.vocareum.com/main/main.php?m=editor&mode=t&asnid=${encodeURIComponent(ids.assignmentId)}&stepid=${encodeURIComponent(ids.partId)}`;
            const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
            if (!opened) {
                vscode.window.showErrorMessage('Failed to open Vocareum URL in browser.');
                return;
            }

            log(`Opened Vocareum Teacher IDE URL: ${url}`);
        })
    );

    // Open part in Vocareum Student View (browser)
    context.subscriptions.push(
        vscode.commands.registerCommand('vocgit.goToStudentView', async (item: unknown) => {
            const ids = extractVocareumLaunchIds(item);
            if (!ids) {
                vscode.window.showWarningMessage(
                    'Cannot open Vocareum: missing assignment_id or part_id in vocareum.yaml for this part.'
                );
                return;
            }

            const url = `https://labs.vocareum.com/main/main.php?m=editor&mode=s&asnid=${encodeURIComponent(ids.assignmentId)}&stepid=${encodeURIComponent(ids.partId)}`;
            const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
            if (!opened) {
                vscode.window.showErrorMessage('Failed to open Vocareum URL in browser.');
                return;
            }

            log(`Opened Vocareum Student View URL: ${url}`);
        })
    );

    // Refresh tree view
    context.subscriptions.push(
        vscode.commands.registerCommand('vocgit.refresh', () => {
            refreshViews();
            log('Tree view refreshed');
        })
    );

    // Open vocareum.yaml
    context.subscriptions.push(
        vscode.commands.registerCommand('vocgit.openConfig', async () => {
            if (workspaceFolder) {
                const yamlPath = vscode.Uri.file(`${workspaceFolder}/vocareum.yaml`);
                await vscode.window.showTextDocument(yamlPath);
            }
        })
    );

    // Initialize course repo
    context.subscriptions.push(
        vscode.commands.registerCommand('vocgit.init', async () => runVocGitCommand(['init']))
    );

    // Add new assignment
    context.subscriptions.push(
        vscode.commands.registerCommand('vocgit.new', async () => runVocGitCommand(['new']))
    );

    // Manage API key with VS Code secret storage
    context.subscriptions.push(
        vscode.commands.registerCommand('vocgit.setApiKey', async () => {
            await setApiKey(context);
            scheduleRefresh();
        }),
        vscode.commands.registerCommand('vocgit.clearApiKey', async () => {
            await clearApiKey(context);
            scheduleRefresh();
        })
    );

    log('Extension activated successfully');
}

export function deactivate() {
    if (vocgitTerminal) {
        vocgitTerminal.dispose();
    }
}
