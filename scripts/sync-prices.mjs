import * as cheerio from 'cheerio';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const BASE_JSON_PATH = resolve(process.cwd(), 'public/data/parts-base.json');
const PRICE_JSON_PATH = resolve(process.cwd(), 'public/data/parts-price.json');
const STATE_JSON_PATH = resolve(process.cwd(), 'public/data/parts-price-state.json');
const MERGED_JSON_PATH = resolve(process.cwd(), 'public/data/parts.json');

const BATCH_SIZE = Number.parseInt(process.env.PART_PRICE_BATCH ?? '1000', 10);
const CONCURRENCY = Number.parseInt(process.env.PART_PRICE_CONCURRENCY ?? '6', 10);
const STALE_DAYS = Number.parseInt(process.env.PART_PRICE_STALE_DAYS ?? '7', 10);

function normalizeBatch(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return 1000;
  }
  return Math.min(value, 20000);
}

function extractPrice(text) {
  const match = String(text ?? '').match(/\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s?(?:€|EUR)\b/i);
  return match?.[0]?.trim();
}

function extractAvailability(text) {
  const normalized = String(text ?? '').toLowerCase();
  if (/nicht\s+verf\u00fcgbar|out\s+of\s+stock|sold\s+out/.test(normalized)) {
    return { status: 'out_of_stock', label: 'Out of stock' };
  }
  if (/verf\u00fcgbar|lieferbar|in\s+stock|sofort\s+lieferbar/.test(normalized)) {
    return { status: 'in_stock', label: 'In stock' };
  }
  return { status: 'unknown', label: 'Unknown' };
}

function shouldRefresh(entry, nowMs) {
  if (!entry || !entry.updatedAt) {
    return true;
  }
  const ts = Date.parse(entry.updatedAt);
  if (!Number.isFinite(ts)) {
    return true;
  }
  const ageMs = nowMs - ts;
  return ageMs > STALE_DAYS * 24 * 60 * 60 * 1000;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function fetchDetailMeta(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'mb-parts-price-sync/1.0',
        Accept: 'text/html',
      },
    });
    if (!response.ok) {
      return { price: undefined, availability: { status: 'unknown', label: 'Unknown' } };
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const rawPriceText = $('.product-detail-price').first().text().replace(/\s+/g, ' ').trim();
    const price = rawPriceText ? extractPrice(rawPriceText) ?? rawPriceText : undefined;
    if ($('.delivery-information.delivery-soldout').length > 0) {
      return { price, availability: { status: 'out_of_stock', label: 'Ausverkauft' } };
    }
    const availabilityText = $('.delivery-information').first().text().replace(/\s+/g, ' ').trim();
    return { price, availability: extractAvailability(availabilityText) };
  } catch {
    return { price: undefined, availability: { status: 'unknown', label: 'Unknown' } };
  }
}

async function main() {
  const batchSize = normalizeBatch(BATCH_SIZE);
  const base = await readJson(BASE_JSON_PATH, null);
  if (!base?.items || !Array.isArray(base.items)) {
    throw new Error(`Base snapshot missing: ${BASE_JSON_PATH}`);
  }

  const priceSnapshot = await readJson(PRICE_JSON_PATH, {
    updatedAt: '',
    count: 0,
    prices: {},
  });
  const state = await readJson(STATE_JSON_PATH, { cursor: 0 });

  const prices = priceSnapshot.prices ?? {};
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const items = base.items;
  const total = items.length;
  const startCursor = Number.isFinite(state.cursor) ? Math.max(0, state.cursor) : 0;

  console.log(`[prices] start total=${total} batch=${batchSize} concurrency=${CONCURRENCY} staleDays=${STALE_DAYS}`);

  const candidates = [];
  for (let i = 0; i < total && candidates.length < batchSize; i += 1) {
    const idx = (startCursor + i) % total;
    const item = items[idx];
    const entry = prices[item.partNumber];
    if (shouldRefresh(entry, nowMs)) {
      candidates.push({ idx, item });
    }
  }

  if (candidates.length === 0) {
    console.log('[prices] nothing to refresh');
    return;
  }

  let processed = 0;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const chunk = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(({ item }) => fetchDetailMeta(item.url)));

    for (let j = 0; j < chunk.length; j += 1) {
      const { item } = chunk[j];
      const { price, availability } = results[j];
      prices[item.partNumber] = {
        price,
        availability,
        updatedAt: nowIso,
      };
    }

    processed += chunk.length;
    if (processed % 50 === 0 || processed === candidates.length) {
      console.log(`[prices] processed=${processed}/${candidates.length}`);
    }
  }

  const lastIdx = candidates[candidates.length - 1]?.idx ?? startCursor;
  const nextCursor = (lastIdx + 1) % total;

  const nextPriceSnapshot = {
    updatedAt: nowIso,
    count: Object.keys(prices).length,
    prices,
  };

  const mergedItems = items.map((item) => {
    const entry = prices[item.partNumber];
    if (entry?.price) {
      return { ...item, price: entry.price, availability: entry.availability ?? item.availability };
    }
    if (entry?.availability) {
      return { ...item, availability: entry.availability };
    }
    return item;
  });

  const mergedPayload = {
    ...base,
    generatedAt: nowIso,
    items: mergedItems,
  };

  await writeFile(PRICE_JSON_PATH, `${JSON.stringify(nextPriceSnapshot, null, 2)}\n`, 'utf-8');
  await writeFile(STATE_JSON_PATH, `${JSON.stringify({ cursor: nextCursor, updatedAt: nowIso }, null, 2)}\n`, 'utf-8');
  await writeFile(MERGED_JSON_PATH, `${JSON.stringify(mergedPayload, null, 2)}\n`, 'utf-8');

  const remainingEstimate = Math.max(0, total - Object.keys(prices).length);
  console.log(`[prices] done updated=${candidates.length} nextCursor=${nextCursor} priced=${Object.keys(prices).length} remaining~=${remainingEstimate}`);
}

main().catch((error) => {
  console.error('sync-prices failed', error);
  process.exitCode = 1;
});
