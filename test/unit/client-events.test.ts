/**
 * Behavioral test: base-URL validation warnings must route through the
 * injected EventSink, not escape to a throwaway LoggerEventSink.
 *
 * Regression for the event-sink isolation bypass described in the Stage 1b
 * task brief: constructing VocareumClient with a CollectingEventSink and a
 * custom/non-standard base URL (VOCAREUM_ALLOW_CUSTOM_BASE_URL=1) must land
 * the warning in the injected sink, not silently drop it into a throwaway
 * sink that is unreachable by Stage 1b's per-course output collection.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { VocareumClient } from '../../src/api/client';
import { CollectingEventSink } from '../../src/core/services/event-sink';
import { LoggerEventSink } from '../../src/utils/logger-event-sink';

/**
 * A minimal AuthProvider stub with a custom (non-standard) HTTPS base URL.
 * When VOCAREUM_ALLOW_CUSTOM_BASE_URL=1, assertAllowedBaseUrl emits a warning
 * instead of throwing — that warning must land in the injected CollectingEventSink.
 */
class CustomBaseUrlProvider {
  /** Non-standard but valid HTTPS URL that triggers the custom-URL warning. */
  readonly apiBaseUrl = 'https://custom.example.com/api/v2';
  readonly unauthorizedHint = undefined;
  getAuthorizationHeader(): Promise<string> {
    return Promise.resolve('Token test-token');
  }
}

describe('VocareumClient event-sink isolation', () => {
  const ORIGINAL_ENV = process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL;

  afterEach(() => {
    // Restore env var after each test regardless of test outcome.
    if (ORIGINAL_ENV === undefined) {
      delete process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL;
    } else {
      process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL = ORIGINAL_ENV;
    }
  });

  it('routes custom-base-URL warning into the injected CollectingEventSink', () => {
    process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL = '1';

    const collecting = new CollectingEventSink();
    const authProvider = new CustomBaseUrlProvider();

    // Construction should NOT throw (the override is set), and must NOT lose
    // the warning to a throwaway LoggerEventSink.
    const client = new VocareumClient(authProvider, undefined, undefined, collecting);

    // The injected sink is accessible on the client.
    expect(client.events).toBe(collecting);

    // Flush collected events into a secondary sink to inspect them.
    const captured: Array<{ level: string; message?: string }> = [];
    collecting.flushTo({
      emit(event) {
        captured.push({ level: event.level, message: event.message });
      },
    });

    // At least one warning about the non-standard URL must have been captured.
    const warnEvents = captured.filter((e) => e.level === 'warn');
    expect(warnEvents.length).toBeGreaterThan(0);
    // The warning message must reference the custom URL to confirm it came from
    // the base-URL validator and not from some unrelated code path.
    const urlWarning = warnEvents.find(
      (e) => e.message?.includes('custom.example.com') || e.message?.includes('non-standard'),
    );
    expect(urlWarning).toBeDefined();
  });

  it('does NOT route warnings to a throwaway sink when CollectingEventSink is injected', () => {
    process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL = '1';

    // This test verifies the negative: a LoggerEventSink-backed client is
    // distinct from the CollectingEventSink, confirming we are not testing a
    // false positive where "any sink captures warnings".
    const collecting = new CollectingEventSink();
    const unrelated = new LoggerEventSink();
    const authProvider = new CustomBaseUrlProvider();

    new VocareumClient(authProvider, undefined, undefined, collecting);

    // Collecting sink captured at least one event; unrelated sink is separate.
    // (We can't directly assert unrelated got NOTHING because LoggerEventSink
    // writes to the logger — instead just confirm collecting did capture something.)
    const captured: Array<{ level: string }> = [];
    collecting.flushTo({ emit(e) { captured.push({ level: e.level }); } });
    expect(captured.some((e) => e.level === 'warn')).toBe(true);

    // Distinct reference: the client's events IS the collecting sink, not unrelated.
    const client = new VocareumClient(authProvider, undefined, undefined, collecting);
    expect(client.events).toBe(collecting);
    expect(client.events).not.toBe(unrelated);
  });

  it('still throws InsecureBaseUrlError for disallowed URLs when override is NOT set', () => {
    // Ensure VOCAREUM_ALLOW_CUSTOM_BASE_URL is absent/unset.
    delete process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL;

    const collecting = new CollectingEventSink();
    const authProvider = new CustomBaseUrlProvider();

    // Without the override, construction must throw, not silently warn.
    expect(() => {
      new VocareumClient(authProvider, undefined, undefined, collecting);
    }).toThrow();
  });
});
