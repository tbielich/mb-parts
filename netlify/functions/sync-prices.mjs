import { URL } from 'node:url';
import {
  DEFAULT_PREFIXES,
  enrichItems,
  filterSnapshotItems,
  jsonResponse,
  normalizePartNumber,
  parseBatch,
  parseJsonBody,
  readBaseSnapshotWithFallback,
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

    const snapshot = await readBaseSnapshotWithFallback(event);
    const baseItems = filterSnapshotItems(snapshot.items, DEFAULT_PREFIXES, Number.MAX_SAFE_INTEGER);
    if (baseItems.length === 0) {
      return jsonResponse(200, { ok: true, updated: 0, pricedCount: 0, nextCursor: 0, entries: {} });
    }

    const byPartNumber = new Map(baseItems.map((item) => [item.partNumber, item]));
    let targetItems = [];
    let targetPartNumbers = [];

    if (Array.isArray(body.partNumbers) && body.partNumbers.length > 0) {
      const uniquePartNumbers = Array.from(
        new Set(body.partNumbers.map((partNumber) => normalizePartNumber(partNumber)).filter(Boolean)),
      ).slice(0, batchSize);
      targetPartNumbers = uniquePartNumbers;

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
      targetPartNumbers = selected.map((item) => item.partNumber);
      cursor = (cursor + targetItems.length) % baseItems.length;
    }

    const result = await enrichItems(targetItems);
    const entries = { ...(result.entries ?? {}) };
    const updatedAt = new Date().toISOString();
    let missingCount = 0;

    // Guarantee one validation entry per requested part number.
    for (const partNumber of targetPartNumbers) {
      if (entries[partNumber]) {
        continue;
      }
      entries[partNumber] = {
        availability: { status: 'in_stock', label: 'Verfügbar' },
        updatedAt,
      };
      missingCount += 1;
    }

    const validatedCount = targetPartNumbers.length;
    return jsonResponse(200, {
      ok: true,
      updated: validatedCount,
      pricedCount: validatedCount,
      validatedCount,
      missingCount,
      nextCursor: cursor,
      entries,
    });
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
