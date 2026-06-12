# VocGit Studio

A VS Code extension providing an integrated GUI for [Vocareum Publisher (vocgit)](https://github.com/ddlin/vocareum-publisher) - the CLI tool for publishing course content to Vocareum.

## Installation

The extension is currently distributed as a `.vsix` package (not yet on the
Visual Studio Marketplace). Either obtain `vocgit-<version>.vsix` from the
maintainers, or build it from this repository:

```bash
cd vscode-extension
npm install
npm run package        # produces vocgit-<version>.vsix
```

Then install it into VS Code:

```bash
code --install-extension vocgit-<version>.vsix
```

(Or in VS Code: Extensions view → `…` menu → **Install from VSIX…**)

Because vsix installs do not auto-update, re-install a new vsix when you
update the CLI — the sidebar badges work best with matching versions (see
Requirements below).

## Prerequisites

**You must install the vocgit CLI separately before using this extension:**

```bash
npm install -g vocareum-publisher
```

Or if using the GitHub Action workflow, vocgit is installed automatically in CI/CD.

## Features

- **Quick Actions Panel** - One-click buttons for common operations:
  - Push to Vocareum
  - Pull from Vocareum
  - Check Status
  - Validate Configuration
  - Set `VOCAREUM_API_KEY`

- **Configuration Tree View** - Visual representation of your `vocareum.yaml`:
  - Browse courses, assignments, and parts
  - Click to open folders in Explorer
  - Right-click assignments to push individually
  - Inline "Go to Teacher IDE" action on each part (opens Vocareum teacher editor in browser)
  - Expand parts to see files (startercode, scripts, etc.)
  - Sync status indicators in the tree:
    - assignment-level pending publish marker
    - part-level inherited pending marker
    - directory-level changed/unknown/error marker

- **YAML Schema Validation** - Autocomplete and error checking for `vocareum.yaml`

- **Secure API Key Handling** - API keys are stored in VS Code Secret Storage and passed via environment variables

## Setup

1. **Install the vocgit CLI**: `npm install -g vocareum-publisher`

2. **Configure your API key** using Command Palette:
   - Run `VocGit: Set VOCAREUM_API_KEY`
   - Enter your Vocareum API key when prompted

   Legacy `vocgit.apiKey` settings are still read for backward compatibility, but are deprecated.

3. **Create a `vocareum.yaml`** in your project root (see [vocgit documentation](https://github.com/ddlin/vocareum-publisher) for schema)

## Usage

1. Click the VocGit icon in the Activity Bar (left sidebar)
2. Use the action buttons to push, pull, check status, validate, or set `VOCAREUM_API_KEY`
3. Browse your course structure in the Configuration tree
4. Right-click an assignment to push just that assignment

## Extension Settings

| Setting | Description |
|---------|-------------|
| `vocgit.cliPath` | Path to the vocgit CLI binary. Leave empty to use `vocgit` from PATH. |
| `vocgit.apiKey` | Deprecated fallback setting (use `VocGit: Set VOCAREUM_API_KEY`) |

## Requirements

- VS Code 1.80.0 or higher
- vocgit CLI installed and available in PATH (or set `vocgit.cliPath`)
- **vocgit CLI 1.2.0 or newer for sidebar sync badges** — the extension runs
  `vocgit status --json` so badges always reflect the content change detection
  `vocgit push` uses. With an older CLI, commands still work but badges show
  "unknown" and the extension prompts you to update.
- A valid `vocareum.yaml` configuration file

## Links

- [vocgit CLI Documentation](https://github.com/ddlin/vocareum-publisher)
- [Report Issues](https://github.com/ddlin/vocareum-publisher/issues)
