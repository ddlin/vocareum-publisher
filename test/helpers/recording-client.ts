const VOLATILE = new Set(['client_secret', 'client_id', 'token', 'access_token']);

interface RequestConfig {
  method: string;
  url: string;
}

export class RecordingClient {
  calls: Array<{ method: string; url: string }> = [];
  private responses: unknown[] = [];

  enqueue(response: unknown): void {
    this.responses.push(response);
  }

  async request<T = unknown>(config: RequestConfig): Promise<T> {
    if (this.responses.length === 0) {
      throw new Error(`RecordingClient: no enqueued response for ${config.method} ${config.url}`);
    }

    this.calls.push({ method: config.method, url: config.url });
    return this.responses.shift() as T;
  }

  sequence(): string[] {
    return this.calls.map(call => {
      const normalized = this.normalizeUrl(call.url);
      return `${call.method} ${normalized}`;
    });
  }

  private normalizeUrl(url: string): string {
    const [path, queryString] = url.split('?');

    if (!queryString) {
      return path;
    }

    // Parse query string into key-value pairs
    const params = new URLSearchParams(queryString);

    // Sort keys and replace volatile values
    const sortedKeys = Array.from(params.keys()).sort();
    const normalizedPairs: string[] = [];
    for (const key of sortedKeys) {
      if (VOLATILE.has(key)) {
        normalizedPairs.push(`${key}=<redacted>`);
      } else {
        normalizedPairs.push(`${key}=${params.get(key)!}`);
      }
    }

    // Rebuild query string
    const normalizedQuery = normalizedPairs.join('&');
    return normalizedQuery ? `${path}?${normalizedQuery}` : path;
  }
}
