/**
 * Directory listings are paged, and listDirectory reads until an empty page.
 * Tests written against a single listing response queue one answer per
 * directory; this wrapper answers every later-page request (`page >= 1`) with
 * the empty page that ends a listing, so those queues stay as they were.
 */
type RequestFn = (config: { params?: Record<string, unknown> }) => unknown;

export function withEmptyLaterPages<F extends RequestFn>(request: F): F {
  return ((config: { params?: Record<string, unknown> }) => {
    const params = config?.params;
    if (params?.list === true && typeof params.page === 'number' && params.page >= 1) {
      return Promise.resolve({ files: [] });
    }
    return request(config);
  }) as F;
}
