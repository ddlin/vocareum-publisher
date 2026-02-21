# VocGit Studio

A VS Code extension providing an integrated GUI for [Vocareum Publisher (vocgit)](https://github.com/ddlin/vocareum-publisher) - the CLI tool for publishing course content to Vocareum.

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

- **Configuration Tree View** - Visual representation of your `vocareum.yaml`:
  - Browse courses, assignments, and parts
  - Click to open folders in Explorer
  - Right-click assignments to push individually
  - Expand parts to see files (startercode, scripts, etc.)

- **YAML Schema Validation** - Autocomplete and error checking for `vocareum.yaml`

- **Secure API Key Handling** - API key is passed via environment variables, not displayed in terminal

## Setup

1. **Install the vocgit CLI**: `npm install -g vocareum-publisher`

2. **Configure your API key** in VS Code settings:
   - Open Settings (Cmd+,)
   - Search for "vocgit"
   - Enter your Vocareum API key

   Or add to `.vscode/settings.json`:
   ```json
   {
     "vocgit.apiKey": "your-api-key-here"
   }
   ```

3. **Create a `vocareum.yaml`** in your project root (see [vocgit documentation](https://github.com/ddlin/vocareum-publisher) for schema)

## Usage

1. Click the VocGit icon in the Activity Bar (left sidebar)
2. Use the action buttons to push, pull, check status, or validate
3. Browse your course structure in the Configuration tree
4. Right-click an assignment to push just that assignment

## Extension Settings

| Setting | Description |
|---------|-------------|
| `vocgit.apiKey` | Your Vocareum API key for authentication |

## Requirements

- VS Code 1.80.0 or higher
- vocgit CLI installed and available in PATH
- A valid `vocareum.yaml` configuration file

## Links

- [vocgit CLI Documentation](https://github.com/ddlin/vocareum-publisher)
- [Report Issues](https://github.com/ddlin/vocareum-publisher/issues)
