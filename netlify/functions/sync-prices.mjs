import { URL } from 'node:url';
import {
  DEFAULT_PREFIXES,
  enrichItems,
  filterSnapshotItems,
  jsonResponse,
  normalizePartNumber,
  parseBatch,
  parseJsonBody,
  readBaseSnapshot,
} from './_parts-utils.mjs';

let cursor = 0;

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method not allowed' });
  }

  try {
    const rawUrl =
      event.rawUrl ??
      `https://local.invalid${event.path ?? '/api/sync-prices'}${event.rawQuery ? `?${event.rawQuery}` : ''}`;
    const url = new URL(rawUrl);
    const batchSize = parseBatch(url.searchParams.get('batch'), 100, 300);
    const body = parseJsonBody(event);

    const snapshot = await readBaseSnapshot();
    const baseItems = filterSnapshotItems(snapshot.items, DEFAULT_PREFIXES, Number.MAX_SAFE_INTEGER);
    if (baseItems.length === 0) {
      return jsonResponse(200, { ok: true, updated: 0, pricedCount: 0, nextCursor: 0, entries: {} });
    }

    const byPartNumber = new Map(baseItems.map((item) => [item.partNumber, item]));
    let targetItems = [];

    if (Array.isArray(body.partNumbers) && body.partNumbers.length > 0) {
      const uniquePartNumbers = Array.from(
        new Set(body.partNumbers.map((partNumber) => normalizePartNumber(partNumber)).filter(Boolean)),
      ).slice(0, batchSize);

      targetItems = uniquePartNumbers
        .map((partNumber) => byPartNumber.get(partNumber))
        .filter((item) => Boolean(item));
    } else {
      const selected = [];
      for (let i = 0; i < baseItems.length && selected.length < batchSize; i += 1) {
        const idx = (cursor + i) % baseItems.length;
        selected.push(baseItems[idx]);
      }
      targetItems = selected;
      cursor = (cursor + targetItems.length) % baseItems.length;
    }

    const result = await enrichItems(targetItems);
    return jsonResponse(200, {
      ok: true,
      updated: result.updated,
      pricedCount: result.updated,
      nextCursor: cursor,
      entries: result.entries,
    });
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
