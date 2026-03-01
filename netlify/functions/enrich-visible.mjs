import {
  DEFAULT_PREFIXES,
  enrichItems,
  filterSnapshotItems,
  jsonResponse,
  normalizePartNumber,
  parseJsonBody,
  readBaseSnapshot,
} from './_parts-utils.mjs';

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method not allowed' });
  }

  try {
    const body = parseJsonBody(event);
    const requestedPartNumbers = Array.isArray(body.partNumbers) ? body.partNumbers : [];

    const snapshot = await readBaseSnapshot();
    const baseItems = filterSnapshotItems(snapshot.items, DEFAULT_PREFIXES, Number.MAX_SAFE_INTEGER);
    const byPartNumber = new Map(baseItems.map((item) => [item.partNumber, item]));

    const uniquePartNumbers = Array.from(
      new Set(requestedPartNumbers.map((partNumber) => normalizePartNumber(partNumber)).filter(Boolean)),
    ).slice(0, 100);

    const targetItems = uniquePartNumbers
      .map((partNumber) => byPartNumber.get(partNumber))
      .filter((item) => Boolean(item));

    const result = await enrichItems(targetItems);
    return jsonResponse(200, {
      ok: true,
      updated: result.updated,
      entries: result.entries,
    });
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
