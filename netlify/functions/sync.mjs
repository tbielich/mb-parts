import { URL } from 'node:url';
import {
  DEFAULT_PREFIXES,
  filterSnapshotItems,
  jsonResponse,
  parseLimit,
  parsePrefixes,
  readBaseSnapshotWithFallback,
} from './_parts-utils.mjs';

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method not allowed' });
  }

  try {
    const rawUrl = event.rawUrl ?? `https://local.invalid${event.path ?? '/api/sync'}${event.rawQuery ? `?${event.rawQuery}` : ''}`;
    const url = new URL(rawUrl);
    const prefixes = parsePrefixes(url.searchParams.get('prefix'));
    const effectivePrefixes = prefixes.length > 0 ? prefixes : DEFAULT_PREFIXES;
    const limit = parseLimit(url.searchParams.get('limit'));

    const snapshot = await readBaseSnapshotWithFallback(event);
    const items = filterSnapshotItems(snapshot.items, effectivePrefixes, limit);

    return jsonResponse(200, {
      ok: true,
      prefixes: effectivePrefixes,
      limit,
      count: items.length,
      generatedAt: new Date().toISOString(),
      items,
    });
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
