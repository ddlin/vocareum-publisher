import { existsSync, readFileSync } from 'fs';

function normalizeValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function loadDotEnvIfPresent(filePath: string = '.env'): void {
  if (!existsSync(filePath)) {
    return;
  }

  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const idx = trimmed.indexOf('=');
    if (idx <= 0) {
      continue;
    }

    const rawKey = trimmed.slice(0, idx).trim();
    const key = rawKey.replace(/^export\s+/, '');
    const value = normalizeValue(trimmed.slice(idx + 1));

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
