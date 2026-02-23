import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SyncSnapshot, computeSyncSnapshot } from './syncState';

interface StatusLineViewModel {
    indicatorClass: 'ok' | 'warn' | 'stale' | 'unknown';
    value: string;
}

export class VocGitActionsProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vocgit.actionsView';
    private _view?: vscode.WebviewView;
    private _hasConfig: boolean = false;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _workspaceRoot: string | undefined,
        private readonly _isApiKeyConfigured: () => Promise<boolean>
    ) {
        this._checkConfig();
    }

    private _checkConfig(): void {
        if (this._workspaceRoot) {
            const yamlPath = path.join(this._workspaceRoot, 'vocareum.yaml');
            this._hasConfig = fs.existsSync(yamlPath);
        } else {
            this._hasConfig = false;
        }
    }

    public refresh(): void {
        this._checkConfig();
        if (this._view) {
            void this._render();
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        void this._render();

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(data => {
            switch (data.command) {
                case 'push':
                    vscode.commands.executeCommand('vocgit.push');
                    break;
                case 'pull':
                    vscode.commands.executeCommand('vocgit.pull');
                    break;
                case 'status':
                    vscode.commands.executeCommand('vocgit.status');
                    break;
                case 'validate':
                    vscode.commands.executeCommand('vocgit.validate');
                    break;
                case 'init':
                    vscode.commands.executeCommand('vocgit.init');
                    break;
                case 'setApiKey':
                    vscode.commands.executeCommand('vocgit.setApiKey');
                    break;
                case 'clearApiKey':
                    vscode.commands.executeCommand('vocgit.clearApiKey');
                    break;
            }
        });
    }

    private async _render(): Promise<void> {
        if (!this._view) {
            return;
        }
        this._view.webview.html = await this._getHtmlContent();
    }

    private async _getHtmlContent(): Promise<string> {
        const apiKeyConfigured = await this._isApiKeyConfigured();
        if (!this._hasConfig) {
            return this._getInitHtml(apiKeyConfigured);
        }
        return this._getActionsHtml(await computeSyncSnapshot(this._workspaceRoot), apiKeyConfigured);
    }

    private _getInitHtml(apiKeyConfigured: boolean): string {
        const apiKeyButtonLabel = apiKeyConfigured ? 'Update VOC API KEY' : 'Set VOCAREUM_API_KEY';
        const nonce = this._getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <style nonce="${nonce}">
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        body {
            padding: 16px;
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
        }
        .message {
            text-align: center;
            margin-bottom: 16px;
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        .init-button {
            display: block;
            width: 100%;
            padding: 12px 16px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
            text-align: center;
            color: white;
            background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
            transition: all 0.15s ease;
        }
        .init-button:hover {
            background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%);
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
        .init-button:active {
            transform: translateY(0);
        }
        .secondary-button {
            margin-top: 8px;
            background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
        }
        .secondary-button:hover {
            background: linear-gradient(135deg, #38bdf8 0%, #0ea5e9 100%);
        }
    </style>
</head>
<body>
    <p class="message">No vocareum.yaml found in this workspace.</p>
    <button id="init-button" class="init-button">
        Initialize Course Repo
    </button>
    <button id="set-key-button" class="init-button secondary-button">
        ${apiKeyButtonLabel}
    </button>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const initButton = document.getElementById('init-button');
        const setKeyButton = document.getElementById('set-key-button');
        if (initButton) {
            initButton.addEventListener('click', () => {
                vscode.postMessage({ command: 'init' });
            });
        }
        if (setKeyButton) {
            setKeyButton.addEventListener('click', () => {
                vscode.postMessage({ command: 'setApiKey' });
            });
        }
    </script>
</body>
</html>`;
    }

    private _formatTimestamp(date?: Date): string {
        if (!date) {
            return 'Never';
        }
        return date.toLocaleString();
    }

    private _formatRelativeAge(date?: Date): string {
        if (!date) {
            return 'not recorded';
        }
        const ageMs = Date.now() - date.getTime();
        const ageMinutes = Math.floor(ageMs / 60000);
        if (ageMinutes < 1) {
            return 'just now';
        }
        if (ageMinutes < 60) {
            return `${ageMinutes}m ago`;
        }

        const ageHours = Math.floor(ageMinutes / 60);
        if (ageHours < 24) {
            return `${ageHours}h ago`;
        }

        const ageDays = Math.floor(ageHours / 24);
        return `${ageDays}d ago`;
    }

    private _localStatusLine(snapshot: SyncSnapshot | undefined): StatusLineViewModel {
        if (!snapshot || !snapshot.latestLocalChangeAt) {
            return { indicatorClass: 'unknown', value: 'Never' };
        }

        if (snapshot.hasUnknownAssignments) {
            return {
                indicatorClass: 'unknown',
                value: `${this._formatTimestamp(snapshot.latestLocalChangeAt)} (baseline missing)`
            };
        }

        if (snapshot.hasPendingLocalChanges) {
            return {
                indicatorClass: 'warn',
                value: `${this._formatTimestamp(snapshot.latestLocalChangeAt)} (pending publish)`
            };
        }

        return {
            indicatorClass: 'ok',
            value: `${this._formatTimestamp(snapshot.latestLocalChangeAt)} (in sync)`
        };
    }

    private _remoteStatusLine(snapshot: SyncSnapshot | undefined): StatusLineViewModel {
        if (!snapshot || !snapshot.lastRemoteCheckAt) {
            return { indicatorClass: 'unknown', value: 'Never' };
        }

        const ageMs = Date.now() - snapshot.lastRemoteCheckAt.getTime();
        const ageHours = ageMs / (60 * 60 * 1000);
        let indicatorClass: StatusLineViewModel['indicatorClass'] = 'ok';
        if (ageHours > 72) {
            indicatorClass = 'stale';
        } else if (ageHours > 24) {
            indicatorClass = 'warn';
        }

        return {
            indicatorClass,
            value: `${this._formatTimestamp(snapshot.lastRemoteCheckAt)} (${this._formatRelativeAge(snapshot.lastRemoteCheckAt)})`
        };
    }

    private _getActionsHtml(snapshot: SyncSnapshot | undefined, apiKeyConfigured: boolean): string {
        const localLine = this._localStatusLine(snapshot);
        const remoteLine = this._remoteStatusLine(snapshot);
        const apiKeyButtonLabel = apiKeyConfigured ? 'Update VOC API KEY' : 'Set VOCAREUM_API_KEY';
        const nonce = this._getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <style nonce="${nonce}">
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        body {
            padding: 10px;
            font-family: var(--vscode-font-family);
        }
        .button-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            margin-bottom: 10px;
        }
        .button-wide {
            grid-column: 1 / span 2;
        }
        .action-button {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 12px 8px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            transition: all 0.15s ease;
            text-align: center;
            color: white;
        }
        .action-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
        .action-button:active {
            transform: translateY(0);
        }
        .action-button .label {
            font-size: 12px;
            letter-spacing: 0.3px;
        }

        .push-btn {
            background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
        }
        .push-btn:hover {
            background: linear-gradient(135deg, #4ade80 0%, #22c55e 100%);
        }

        .status-btn {
            background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
        }
        .status-btn:hover {
            background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%);
        }

        .pull-btn {
            background: linear-gradient(135deg, #a855f7 0%, #9333ea 100%);
        }
        .pull-btn:hover {
            background: linear-gradient(135deg, #c084fc 0%, #a855f7 100%);
        }

        .validate-btn {
            background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
        }
        .validate-btn:hover {
            background: linear-gradient(135deg, #fb923c 0%, #f97316 100%);
        }

        .apikey-btn {
            background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
        }
        .apikey-btn:hover {
            background: linear-gradient(135deg, #38bdf8 0%, #0ea5e9 100%);
        }
        .status-lines {
            border: 1px solid var(--vscode-widget-border);
            border-radius: 6px;
            padding: 8px;
            background: var(--vscode-editorWidget-background);
        }
        .status-line {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            line-height: 1.5;
        }
        .status-line + .status-line {
            margin-top: 4px;
        }
        .status-label {
            min-width: 112px;
            color: var(--vscode-foreground);
        }
        .status-value {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            flex: 0 0 8px;
            background: var(--vscode-disabledForeground);
        }
        .status-dot.ok {
            background: #22c55e;
        }
        .status-dot.warn {
            background: #f59e0b;
        }
        .status-dot.stale {
            background: #ef4444;
        }
        .status-dot.unknown {
            background: var(--vscode-disabledForeground);
        }
    </style>
</head>
<body>
    <div class="button-grid">
        <button id="push-button" class="action-button push-btn">
            <span class="label">Push to Vocareum</span>
        </button>
        <button id="pull-button" class="action-button pull-btn">
            <span class="label">Pull from Vocareum</span>
        </button>
        <button id="status-button" class="action-button status-btn">
            <span class="label">Check Status</span>
        </button>
        <button id="validate-button" class="action-button validate-btn">
            <span class="label">Validate Configuration</span>
        </button>
        <button id="set-key-button" class="action-button apikey-btn button-wide">
            <span class="label">${apiKeyButtonLabel}</span>
        </button>
    </div>
    <div class="status-lines">
        <div class="status-line">
            <span class="status-dot ${localLine.indicatorClass}"></span>
            <span class="status-label">Last local change</span>
            <span class="status-value">${localLine.value}</span>
        </div>
        <div class="status-line">
            <span class="status-dot ${remoteLine.indicatorClass}"></span>
            <span class="status-label">Last remote check</span>
            <span class="status-value">${remoteLine.value}</span>
        </div>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        const commands = [
            ['push-button', 'push'],
            ['pull-button', 'pull'],
            ['status-button', 'status'],
            ['validate-button', 'validate'],
            ['set-key-button', 'setApiKey']
        ];

        for (const [id, command] of commands) {
            const button = document.getElementById(id);
            if (!button) {
                continue;
            }
            button.addEventListener('click', () => {
                vscode.postMessage({ command });
            });
        }
    </script>
</body>
</html>`;
    }

    private _getNonce(): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let nonce = '';
        for (let i = 0; i < 32; i++) {
            nonce += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return nonce;
    }
}
