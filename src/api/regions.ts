/**
 * Vocareum tenants (regions) and v2 base-URL resolution.
 *
 * NA and EU are separate Vocareum tenants with separate API hosts and separate
 * credentials. Course/assignment IDs from one tenant are meaningless on the
 * other, so the host a repo targets is part of its identity — it is written to
 * `vocareum.yaml` (`vocareum.api_base_url`) at init time.
 *
 * This module is pure data + pure functions. It deliberately does NOT import
 * from `./client` (client.ts builds its allowlist from this table, so the
 * reverse import would be circular).
 */

import { getApiBaseUrlEnv } from '../utils/env';

export type VocareumRegion = 'na' | 'eu';

export const VOCAREUM_REGIONS: readonly VocareumRegion[] = ['na', 'eu'];

export const DEFAULT_REGION: VocareumRegion = 'na';

export interface RegionHosts {
  /** Human label for prompts and status output. */
  label: string;
  /** Bare host written to vocareum.yaml `api_base_url` (normalizes to v2BaseUrl). */
  apiBaseUrl: string;
  /** Canonical v2 base URL — the token-auth allowlist entry for this region. */
  v2BaseUrl: string;
  /** Canonical v3 (OAuth) base URL, when the region has a confirmed v3 host. */
  v3BaseUrl?: string;
}

export const REGION_HOSTS: Readonly<Record<VocareumRegion, RegionHosts>> = {
  na: {
    label: 'North America',
    apiBaseUrl: 'https://api.vocareum.com',
    v2BaseUrl: 'https://api.vocareum.com/api/v2',
    v3BaseUrl: 'https://labs.vocareum.com/api/v3',
  },
  eu: {
    label: 'Europe',
    apiBaseUrl: 'https://api.eu.vocareum.com',
    v2BaseUrl: 'https://api.eu.vocareum.com/api/v2',
    // TODO(eu-v3): the EU v3/OAuth API host and token URL are not confirmed.
    // Do not add a v3BaseUrl here (it would become a live allowlist entry)
    // until one is. Until then OAuth mode targets the NA labs host only.
  },
};

/** Default v2 host — the NA tenant. Matches the config schema default. */
export const DEFAULT_API_BASE_URL = REGION_HOSTS[DEFAULT_REGION].apiBaseUrl;

/** Append /api/v2 when the base URL carries no /api/vN version path.
 *  Note: a bare host always normalizes to /api/v2 (the default). The v3 host
 *  (labs.vocareum.com) must be passed with its full /api/v3 path; a bare labs
 *  host would normalize to /api/v2 and then fail assertAllowedBaseUrl. */
export function normalizeApiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/api\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/api/v2`;
}

/** `protocol//host/path` with trailing slashes stripped, or undefined when the
 *  value is not a URL. Lowercases the host and drops a default port (URL does). */
export function canonicalBaseUrl(baseUrl: string): string | undefined {
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

/** Hostname of a base URL for display (never includes credentials), or the raw
 *  value when it does not parse. */
export function displayHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * The region a base URL belongs to, or undefined for a custom/unknown host.
 * Matches the exact (scheme, host, version-path) pair after normalization, so
 * `http://…`, look-alike hosts, and stray paths are never classified as a region.
 */
export function regionForBaseUrl(baseUrl: string): VocareumRegion | undefined {
  const canonical = canonicalBaseUrl(normalizeApiBaseUrl(baseUrl.trim()));
  if (canonical === undefined) {
    return undefined;
  }
  return VOCAREUM_REGIONS.find(r => {
    const hosts = REGION_HOSTS[r];
    return hosts.v2BaseUrl === canonical || hosts.v3BaseUrl === canonical;
  });
}

export type ApiBaseUrlSource = 'flag' | 'env' | 'config' | 'default';

export interface ResolvedApiBaseUrl {
  /** The base URL as supplied (not yet normalized to /api/v2). */
  baseUrl: string;
  source: ApiBaseUrlSource;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed !== '' ? trimmed : undefined;
}

/**
 * Resolve the v2 (token-auth) base URL.
 * Precedence: CLI flag > VOCAREUM_API_BASE_URL > vocareum.yaml > default (NA).
 *
 * Resolution only picks a value — it does not validate it. The caller
 * (TokenAuthProvider) normalizes and runs the v2 allowlist check, so an env or
 * flag value gets exactly the same scrutiny as one from vocareum.yaml.
 */
export function resolveV2ApiBaseUrl(opts: { flag?: string; config?: string }): ResolvedApiBaseUrl {
  const flag = nonEmpty(opts.flag);
  if (flag !== undefined) {
    return { baseUrl: flag, source: 'flag' };
  }
  const env = nonEmpty(getApiBaseUrlEnv());
  if (env !== undefined) {
    return { baseUrl: env, source: 'env' };
  }
  const config = nonEmpty(opts.config);
  if (config !== undefined) {
    return { baseUrl: config, source: 'config' };
  }
  return { baseUrl: DEFAULT_API_BASE_URL, source: 'default' };
}
