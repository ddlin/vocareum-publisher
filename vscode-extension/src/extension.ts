import * as vscode from 'vscode';
import { VocGitTreeDataProvider } from './VocGitTreeDataProvider';
import { VocGitActionsProvider } from './VocGitActionsProvider';

// Output channel for logging
let outputChannel: vscode.OutputChannel;

function log(message: string) {
    const timestamp = new Date().toISOString();
    outputChannel.appendLine(`[${timestamp}] ${message}`);
    console.log(`[VocGit] ${message}`);
}

// Store terminal reference with API key baked into env
let vocgitTerminal: vscode.Terminal | undefined;
let terminalApiKey: string | undefined;

function getVocGitTerminal(): vscode.Terminal {
    // Get current API key from settings
    const config = vscode.workspace.getConfiguration('vocgit');
    const apiKey = config.get<string>('apiKey')?.trim() || '';

    // Check if existing terminal is still alive AND has the same API key
    if (vocgitTerminal && vscode.window.terminals.includes(vocgitTerminal) && terminalApiKey === apiKey) {
        return vocgitTerminal;
    }

    // Close any old VocGit terminals (including ones not created by us)
    vscode.window.terminals.forEach(t => {
        if (t.name === 'VocGit') {
            t.dispose();
        }
    });
    vocgitTerminal = undefined;

    // Create terminal with API key in environment (hidden from display)
    const env: { [key: string]: string } = {};
    if (apiKey) {
        env['VOCAREUM_API_KEY'] = apiKey;
    }

    vocgitTerminal = vscode.window.createTerminal({
        name: 'VocGit',
        env: env
    });
    terminalApiKey = apiKey;

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
    const actionsProvider = new VocGitActionsProvider(context.extensionUri, workspaceFolder);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('vocgit.actionsView', actionsProvider)
    );

    // Register the sidebar tree view
    const treeDataProvider = new VocGitTreeDataProvider(workspaceFolder);
    vscode.window.registerTreeDataProvider('vocgit.yamlView', treeDataProvider);

    log('Views registered');

    // Watch for changes to vocareum.yaml to automatically refresh views
    const yamlWatcher = vscode.workspace.createFileSystemWatcher('**/vocareum.yaml');
    yamlWatcher.onDidChange(() => {
        treeDataProvider.refresh();
        actionsProvider.refresh();
    });
    yamlWatcher.onDidCreate(() => {
        treeDataProvider.refresh();
        actionsProvider.refresh();
    });
    yamlWatcher.onDidDelete(() => {
        treeDataProvider.refresh();
        actionsProvider.refresh();
    });
    context.subscriptions.push(yamlWatcher);

    // Helper to run commands in the integrated terminal
    function runVocGitCommand(args: string) {
        const terminal = getVocGitTerminal();
        terminal.show();
        terminal.sendText(`vocgit ${args}`);
    }

    // Register vocgit CLI commands
    context.subscriptions.push(
        vscode.commands.registerCommand('vocgit.push', () => runVocGitCommand('push')),
        vscode.commands.registerCommand('vocgit.pull', () => runVocGitCommand('pull')),
        vscode.commands.registerCommand('vocgit.status', () => runVocGitCommand('status')),
        vscode.commands.registerCommand('vocgit.validate', () => runVocGitCommand('validate'))
    );

    // Push specific assignment
    context.subscriptions.push(
        vscode.commands.registerCommand('vocgit.pushAssignment', (item: any) => {
            if (item?.data?.assignmentPath) {
                log(`Pushing assignment: ${item.data.assignmentPath}`);
                runVocGitCommand(`push --assignment "${item.data.assignmentPath}"`);
            } else {
                vscode.window.showWarningMessage('No assignment path found');
            }
        })
    );

    // Open folder in explorer
    context.subscriptions.push(
        vscode.commands.registerCommand('vocgit.openFolder', (folderPath: string) => {
            if (folderPath) {
                const uri = vscode.Uri.file(folderPath);
                vscode.commands.executeCommand('revealInExplorer', uri);
                log(`Opened folder: ${folderPath}`);
            }
        })
    );

    // Refresh tree view
    context.subscriptions.push(
        vscode.commands.registerCommand('vocgit.refresh', () => {
            treeDataProvider.refresh();
            log('Tree view refreshed');
        })
    );

    // Open vocareum.yaml
    context.subscriptions.push(
        vscode.commands.registerCommand('vocgit.openConfig', () => {
            if (workspaceFolder) {
                const yamlPath = vscode.Uri.file(`${workspaceFolder}/vocareum.yaml`);
                vscode.window.showTextDocument(yamlPath);
            }
        })
    );

    // Initialize course repo
    context.subscriptions.push(
        vscode.commands.registerCommand('vocgit.init', () => {
            runVocGitCommand('init');
        })
    );

    // Add new assignment
    context.subscriptions.push(
        vscode.commands.registerCommand('vocgit.new', () => {
            runVocGitCommand('new');
        })
    );

    log('Extension activated successfully');
}

export function deactivate() {
    if (vocgitTerminal) {
        vocgitTerminal.dispose();
    }
}
