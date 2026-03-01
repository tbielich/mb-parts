import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const DEFAULT_PREFIXES = ['A309', 'A310'];
export const MAX_LIMIT = 5000;
const BASE_SNAPSHOT_JSON_PATH = resolve(process.cwd(), 'public/data/parts-base.json');
const AVAILABILITY_FETCH_CONCURRENCY = 6;

export function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(payload),
  };
}

export function parsePrefixes(prefixParam) {
  return String(prefixParam ?? '')
    .split('|')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
}

export function parseLimit(value) {
  if (String(value ?? '').toLowerCase() === 'all') {
    return MAX_LIMIT;
  }
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 100;
  }
  return Math.min(parsed, MAX_LIMIT);
}

export function parseBatch(value, defaultBatch = 100, maxBatch = 200) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultBatch;
  }
  return Math.min(parsed, maxBatch);
}

export function normalizePartNumber(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isAllowedPartNumber(partNumber, prefixes) {
  return prefixes.some((prefix) => partNumber.startsWith(prefix));
}

function isExcludedPartNumber(partNumber) {
  return /^A0{10,}$/.test(partNumber);
}

export async function readBaseSnapshot() {
  const raw = await readFile(BASE_SNAPSHOT_JSON_PATH, 'utf-8');
  return JSON.parse(raw);
}

function resolveSiteOrigin(event) {
  if (event?.rawUrl) {
    try {
      return new URL(event.rawUrl).origin;
    } catch {
      // ignore
    }
  }

  const headers = event?.headers ?? {};
  const host = headers['x-forwarded-host'] ?? headers.host;
  const proto = headers['x-forwarded-proto'] ?? 'https';
  if (host) {
    return `${proto}://${host}`;
  }

  if (process.env.URL) {
    return process.env.URL;
  }

  throw new Error('Unable to resolve site origin');
}

export async function readBaseSnapshotWithFallback(event) {
  try {
    return await readBaseSnapshot();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('ENOENT')) {
      throw error;
    }
  }

  const origin = resolveSiteOrigin(event);
  const snapshotUrl = new URL('/data/parts-base.json', origin).toString();
  const response = await fetch(snapshotUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'mb-parts-netlify/1.0',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to load snapshot over HTTP (${response.status})`);
  }
  return response.json();
}

export function filterSnapshotItems(items, prefixes, limit) {
  const effectivePrefixes = prefixes.length > 0 ? prefixes : DEFAULT_PREFIXES;
  const dedup = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    const partNumber = normalizePartNumber(item.partNumber);
    if (!partNumber || isExcludedPartNumber(partNumber) || !isAllowedPartNumber(partNumber, effectivePrefixes)) {
      continue;
    }
    if (dedup.has(partNumber)) {
      continue;
    }

    dedup.set(partNumber, {
      partNumber,
      name: String(item.name ?? ''),
      price: typeof item.price === 'string' ? item.price : undefined,
      url: String(item.url ?? ''),
      availability:
        item.availability && typeof item.availability === 'object'
          ? {
              status: item.availability.status ?? 'unknown',
              label: item.availability.label ?? 'Unknown',
            }
          : { status: 'unknown', label: 'Unknown' },
    });

    if (dedup.size >= limit) {
      break;
    }
  }

  return Array.from(dedup.values()).sort((left, right) => left.partNumber.localeCompare(right.partNumber));
}

function extractPrice(text) {
  const match = String(text ?? '').match(/\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s?(?:€|EUR)\b/i);
  return match?.[0]?.trim();
}

function extractAvailability(text) {
  const normalized = String(text ?? '').toLowerCase();

  if (/nicht\s+verf\u00fcgbar|out\s+of\s+stock|sold\s+out|ausverkauft/.test(normalized)) {
    return { status: 'out_of_stock', label: 'Out of stock' };
  }

  if (/verf\u00fcgbar|lieferbar|in\s+stock|sofort\s+lieferbar/.test(normalized)) {
    return { status: 'in_stock', label: 'In stock' };
  }

  return { status: 'unknown', label: 'Unknown' };
}

export async function fetchProductDetailMeta(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'mb-parts-netlify/1.0',
        Accept: 'text/html',
      },
    });
    if (!response.ok) {
      return { availability: { status: 'unknown', label: 'Unknown' } };
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const rawPriceText = $('.product-detail-price').first().text().replace(/\s+/g, ' ').trim();
    const detailPrice = rawPriceText ? extractPrice(rawPriceText) ?? rawPriceText : undefined;

    if ($('.delivery-information.delivery-soldout').length > 0) {
      return {
        availability: { status: 'out_of_stock', label: 'Ausverkauft' },
        price: detailPrice,
      };
    }

    const infoText = $('.delivery-information').first().text().replace(/\s+/g, ' ').trim();
    return {
      availability: extractAvailability(infoText),
      price: detailPrice,
    };
  } catch {
    return { availability: { status: 'unknown', label: 'Unknown' } };
  }
}

export async function enrichItems(items) {
  const entries = {};
  const normalizedItems = Array.isArray(items) ? items.filter((item) => item?.url && item?.partNumber) : [];
  const updatedAt = new Date().toISOString();

  for (let i = 0; i < normalizedItems.length; i += AVAILABILITY_FETCH_CONCURRENCY) {
    const chunk = normalizedItems.slice(i, i + AVAILABILITY_FETCH_CONCURRENCY);
    const results = await Promise.all(chunk.map((item) => fetchProductDetailMeta(item.url)));
    for (let j = 0; j < chunk.length; j += 1) {
      entries[chunk[j].partNumber] = {
        price: results[j].price,
        availability: results[j].availability,
        updatedAt,
      };
    }
  }

  return { updated: Object.keys(entries).length, entries };
}

export function parseJsonBody(event) {
  if (!event?.body) {
    return {};
  }
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
