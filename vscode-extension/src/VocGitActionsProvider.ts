import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class VocGitActionsProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vocgit.actionsView';
    private _view?: vscode.WebviewView;
    private _hasConfig: boolean = false;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _workspaceRoot: string | undefined
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
            this._view.webview.html = this._getHtmlContent();
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

        webviewView.webview.html = this._getHtmlContent();

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
            }
        });
    }

    private _getHtmlContent(): string {
        if (!this._hasConfig) {
            return this._getInitHtml();
        }
        return this._getActionsHtml();
    }

    private _getInitHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
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
    </style>
</head>
<body>
    <p class="message">No vocareum.yaml found in this workspace.</p>
    <button class="init-button" onclick="sendCommand('init')">
        Initialize Course Repo
    </button>
    <script>
        const vscode = acquireVsCodeApi();
        function sendCommand(cmd) {
            vscode.postMessage({ command: cmd });
        }
    </script>
</body>
</html>`;
    }

    private _getActionsHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
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
    </style>
</head>
<body>
    <div class="button-grid">
        <button class="action-button push-btn" onclick="sendCommand('push')">
            <span class="label">Push to Vocareum</span>
        </button>
        <button class="action-button pull-btn" onclick="sendCommand('pull')">
            <span class="label">Pull from Vocareum</span>
        </button>
        <button class="action-button status-btn" onclick="sendCommand('status')">
            <span class="label">Check Status</span>
        </button>
        <button class="action-button validate-btn" onclick="sendCommand('validate')">
            <span class="label">Validate Configuration</span>
        </button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        function sendCommand(cmd) {
            vscode.postMessage({ command: cmd });
        }
    </script>
</body>
</html>`;
    }
}
