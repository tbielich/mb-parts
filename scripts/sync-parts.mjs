import * as cheerio from 'cheerio';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const PREFIXES = String(process.env.PART_PREFIXES ?? '')
  .split('|')
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean);
const LIMIT = Number.parseInt(process.env.PART_LIMIT ?? '', 10);
const CONCURRENCY = 8;
const MAX_SITEMAPS = Number.parseInt(process.env.PART_MAX_SITEMAPS ?? '20000', 10);
const ENRICH_DETAILS =
  process.env.PART_ENRICH_DETAILS == null
    ? PREFIXES.length > 0
    : ['1', 'true', 'yes'].includes(String(process.env.PART_ENRICH_DETAILS).toLowerCase());
const BASE_JSON_PATH = resolve(process.cwd(), 'public/data/parts-base.json');
const BASE_YAML_PATH = resolve(process.cwd(), 'public/data/parts-base.yaml');
const MERGED_JSON_PATH = resolve(process.cwd(), 'public/data/parts.json');
const PRICE_JSON_PATH = resolve(process.cwd(), 'public/data/parts-price.json');

function normalizePartNumber(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function extractPartNumberFromHref(href, prefixes) {
  const normalizedHref = String(href).toUpperCase();
  if (prefixes.length === 0) {
    const genericMatches = normalizedHref.match(/A\d{9,14}/g) ?? [];
    if (genericMatches.length > 0) {
      return normalizePartNumber(genericMatches[0]);
    }
  }

  for (const prefix of prefixes) {
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`${escapedPrefix}[A-Z0-9-]{2,40}`, 'g');
    const matches = normalizedHref.match(regex) ?? [];
    for (const match of matches) {
      const normalized = normalizePartNumber(match);
      if (normalized.startsWith(prefix)) {
        return normalized;
      }
    }
  }
  return null;
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

function extractPrice(text) {
  const match = String(text ?? '').match(/\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s?(?:€|EUR)\b/i);
  return match?.[0]?.trim();
}

function decodeXmlEntities(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function extractLocsFromXml(xml) {
  const locs = [];
  const regex = /<loc>([\s\S]*?)<\/loc>/gi;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const value = decodeXmlEntities(match[1].trim());
    if (value) {
      locs.push(value);
    }
  }
  return locs;
}

function isSitemapUrl(url) {
  return /\.xml(?:\.gz)?(?:$|\?)/i.test(url);
}

async function fetchTextWithGzipSupport(url, accept) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'mb-parts-sync/1.0',
        Accept: accept,
      },
    });
    if (!response.ok) {
      return null;
    }

    if (url.toLowerCase().includes('.gz')) {
      const buffer = Buffer.from(await response.arrayBuffer());
      try {
        return gunzipSync(buffer).toString('utf-8');
      } catch {
        return buffer.toString('utf-8');
      }
    }

    return await response.text();
  } catch {
    return null;
  }
}

function guessNameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 0) {
      return 'Unknown';
    }
    const slug = segments.length >= 2 ? segments[segments.length - 2] : segments[segments.length - 1];
    return (
      slug
        .replace(/[-_]+/g, ' ')
        .trim()
        .replace(/\b\w/g, (char) => char.toUpperCase()) || 'Unknown'
    );
  } catch {
    return 'Unknown';
  }
}

async function collectPartsFromSitemap(prefixes, limit) {
  const sitemapQueue = [
    'https://originalteile.mercedes-benz.de/sitemap.xml',
    'https://originalteile.mercedes-benz.de/sitemap_index.xml',
  ];
  const visitedSitemaps = new Set();
  const foundItems = [];
  const seenPartNumbers = new Set();
  const maxSitemaps = Number.isFinite(MAX_SITEMAPS) && MAX_SITEMAPS > 0 ? MAX_SITEMAPS : 20000;

  const robotsTxt = await fetchTextWithGzipSupport(
    'https://originalteile.mercedes-benz.de/robots.txt',
    'text/plain,*/*;q=0.8',
  );

  if (robotsTxt) {
    for (const line of robotsTxt.split(/\r?\n/)) {
      const match = line.match(/^\s*Sitemap:\s*(\S+)\s*$/i);
      if (match?.[1]) {
        sitemapQueue.push(match[1]);
      }
    }
  }

  while (sitemapQueue.length > 0 && visitedSitemaps.size < maxSitemaps && foundItems.length < limit) {
    const sitemapUrl = sitemapQueue.shift();
    if (!sitemapUrl || visitedSitemaps.has(sitemapUrl)) {
      continue;
    }

    visitedSitemaps.add(sitemapUrl);
    const xml = await fetchTextWithGzipSupport(sitemapUrl, 'application/xml,text/xml;q=0.9,*/*;q=0.8');
    if (!xml) {
      continue;
    }

    const locs = extractLocsFromXml(xml);
    if (visitedSitemaps.size % 100 === 0) {
      console.log(
        `[sync] sitemaps=${visitedSitemaps.size} queue=${sitemapQueue.length} found=${foundItems.length}`,
      );
    }

    for (const loc of locs) {
      if (isSitemapUrl(loc)) {
        if (!visitedSitemaps.has(loc)) {
          sitemapQueue.push(loc);
        }
        continue;
      }

      const partNumber = extractPartNumberFromHref(loc, prefixes);
      if (!partNumber || seenPartNumbers.has(partNumber)) {
        continue;
      }

      seenPartNumbers.add(partNumber);
      foundItems.push({
        partNumber,
        name: guessNameFromUrl(loc),
        url: loc,
        availability: { status: 'unknown', label: 'Unknown' },
      });
      if (foundItems.length % 100 === 0) {
        console.log(`[sync] found parts=${foundItems.length}`);
      }

      if (foundItems.length >= limit) {
        break;
      }
    }
  }

  return foundItems;
}

async function fetchProductDetailMeta(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'mb-parts-sync/1.0',
        Accept: 'text/html',
      },
    });
    if (!response.ok) {
      return { availability: { status: 'unknown', label: 'Unknown' }, price: undefined };
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const rawPriceText = $('.product-detail-price').first().text().replace(/\s+/g, ' ').trim();
    const price = rawPriceText ? extractPrice(rawPriceText) ?? rawPriceText : undefined;

    if ($('.delivery-information.delivery-soldout').length > 0) {
      return { availability: { status: 'out_of_stock', label: 'Ausverkauft' }, price };
    }

    const infoText = $('.delivery-information').first().text().replace(/\s+/g, ' ').trim();
    return { availability: extractAvailability(infoText), price };
  } catch {
    return { availability: { status: 'unknown', label: 'Unknown' }, price: undefined };
  }
}

async function enrichItems(items) {
  console.log(`[sync] enrich start total=${items.length} concurrency=${CONCURRENCY}`);
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const chunk = items.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map((item) => fetchProductDetailMeta(item.url)));
    for (let j = 0; j < chunk.length; j += 1) {
      chunk[j].availability = results[j].availability;
      if (results[j].price) {
        chunk[j].price = results[j].price;
      }
    }
    const processed = Math.min(i + CONCURRENCY, items.length);
    if (processed % 50 === 0 || processed === items.length) {
      console.log(`[sync] enriched ${processed}/${items.length}`);
    }
  }
}

async function main() {
  const effectiveLimit = Number.isFinite(LIMIT) && LIMIT > 0 ? LIMIT : Number.MAX_SAFE_INTEGER;
  console.log(
    `[sync] start prefixes=${PREFIXES.length > 0 ? PREFIXES.join(',') : 'ALL'} limit=${
      Number.isFinite(LIMIT) && LIMIT > 0 ? LIMIT : 'unlimited'
    } enrich=${ENRICH_DETAILS ? 'on' : 'off'}`,
  );

  const items = await collectPartsFromSitemap(PREFIXES, effectiveLimit);
  console.log(`[sync] collection done count=${items.length}`);
  if (ENRICH_DETAILS) {
    await enrichItems(items);
  } else {
    console.log('[sync] enrich skipped');
  }
  items.sort((a, b) => a.partNumber.localeCompare(b.partNumber));

  const payload = {
    prefixes: PREFIXES,
    limit: Number.isFinite(LIMIT) && LIMIT > 0 ? LIMIT : 0,
    count: items.length,
    generatedAt: new Date().toISOString(),
    items,
  };

  let priceMap = {};
  try {
    const rawPriceJson = await readFile(PRICE_JSON_PATH, 'utf-8');
    const parsed = JSON.parse(rawPriceJson);
    priceMap = parsed?.prices ?? {};
  } catch {
    // Optional, continue without price map.
  }

  const mergedItems = payload.items.map((item) => {
    const entry = priceMap[item.partNumber];
    if (entry?.price) {
      return { ...item, price: entry.price };
    }
    return item;
  });
  const mergedPayload = { ...payload, items: mergedItems };

  await mkdir(dirname(BASE_JSON_PATH), { recursive: true });
  await writeFile(BASE_JSON_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  await writeFile(BASE_YAML_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  await writeFile(MERGED_JSON_PATH, `${JSON.stringify(mergedPayload, null, 2)}\n`, 'utf-8');

  console.log(`Synced ${payload.count} parts to ${BASE_JSON_PATH}`);
}

main().catch((error) => {
  console.error('sync-parts failed', error);
  process.exitCode = 1;
});
