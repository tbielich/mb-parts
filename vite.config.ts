import { defineConfig } from 'vite';
import * as cheerio from 'cheerio';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

type Availability = {
  status: 'in_stock' | 'out_of_stock' | 'unknown';
  label: string;
};

type PartItem = {
  partNumber: string;
  name: string;
  price?: string;
  url: string;
  availability: Availability;
};

const MB_SEARCH_BASE = 'https://originalteile.mercedes-benz.de/search';
const DEFAULT_SYNC_PREFIXES: string[] = ['A309', 'A310'];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 5000;
const MAX_PAGES = 500;
const AVAILABILITY_FETCH_CONCURRENCY = 8;
const BASE_SNAPSHOT_JSON_PATH = resolve(process.cwd(), 'public/data/parts-base.json');
const PRICE_SNAPSHOT_JSON_PATH = resolve(process.cwd(), 'public/data/parts-price.json');
const PRICE_SNAPSHOT_STATE_JSON_PATH = resolve(process.cwd(), 'public/data/parts-price-state.json');

type ProductDetailMeta = {
  availability: Availability;
  price?: string;
};

type PartsSnapshot = {
  prefixes: string[];
  limit: number;
  count: number;
  generatedAt: string;
  items: PartItem[];
};

type PriceEntry = {
  price?: string;
  availability?: Availability;
  updatedAt: string;
};

type PriceSnapshot = {
  updatedAt: string;
  count: number;
  prices: Record<string, PriceEntry>;
};

const productDetailCache = new Map<string, ProductDetailMeta>();
let baseSnapshotCache: PartsSnapshot | null = null;

function parseLimit(value: string | null): number {
  if (value?.toLowerCase() === 'all') {
    return MAX_LIMIT;
  }
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
}

function parseSyncLimit(value: string | null): number {
  if (value?.toLowerCase() === 'all') {
    return Number.MAX_SAFE_INTEGER;
  }
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return parsed;
}

function parsePrefixes(prefixParam: string | null): string[] {
  return (prefixParam ?? '')
    .split('|')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
}

function normalizePartNumber(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function extractPrice(text: string): string | undefined {
  const match = text.match(/\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s?(?:€|EUR)\b/i);
  return match?.[0]?.trim();
}

function extractAvailability(text: string): Availability {
  const normalized = text.toLowerCase();

  if (/nicht\s+verf\u00fcgbar|out\s+of\s+stock|sold\s+out/.test(normalized)) {
    return { status: 'out_of_stock', label: 'Out of stock' };
  }

  if (/verf\u00fcgbar|lieferbar|in\s+stock|sofort\s+lieferbar/.test(normalized)) {
    return { status: 'in_stock', label: 'In stock' };
  }

  if (/vorbestell|preorder/.test(normalized)) {
    return { status: 'unknown', label: 'Preorder' };
  }

  return { status: 'unknown', label: 'Unknown' };
}

function findPartNumber(text: string, prefixes: string[]): string | null {
  for (const prefix of prefixes) {
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escapedPrefix}[A-Z0-9\\s-]{0,30}\\b`, 'gi');
    const matches = text.match(regex) ?? [];

    for (const rawMatch of matches) {
      const normalized = normalizePartNumber(rawMatch);
      if (normalized.startsWith(prefix) && normalized.length >= prefix.length) {
        return normalized;
      }
    }
  }

  return null;
}

function extractPartNumberFromHref(href: string, prefixes: string[]): string | null {
  const normalizedHref = href.toUpperCase();
  if (prefixes.length === 0) {
    const genericMatches = normalizedHref.match(/A\d{9,14}/g) ?? [];
    const firstMatch = genericMatches[0];
    if (firstMatch) {
      return normalizePartNumber(firstMatch);
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

function toStringIfDefined(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

function extractItemsFromStructuredScripts(html: string, baseUrl: string, prefixes: string[]): PartItem[] {
  const $ = cheerio.load(html);
  const extracted: PartItem[] = [];

  const scriptContents: string[] = [];
  $('script:not([src])').each((_, node) => {
    const content = $(node).contents().text().trim();
    if (content) {
      scriptContents.push(content);
    }
  });

  const jsonCandidates: unknown[] = [];
  for (const content of scriptContents) {
    if (content.startsWith('{') || content.startsWith('[')) {
      try {
        jsonCandidates.push(JSON.parse(content));
      } catch {
        // ignore
      }
    }

    const assignMatch = content.match(/(?:__NEXT_DATA__|INITIAL_STATE|__INITIAL_STATE__|__STATE__)\s*=\s*(\{[\s\S]*\})\s*;?/);
    if (assignMatch?.[1]) {
      try {
        jsonCandidates.push(JSON.parse(assignMatch[1]));
      } catch {
        // ignore
      }
    }
  }

  for (const candidate of jsonCandidates) {
    const queue: unknown[] = [candidate];
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) {
        continue;
      }
      if (Array.isArray(item)) {
        queue.push(...item);
        continue;
      }
      if (typeof item !== 'object') {
        continue;
      }

      const record = item as Record<string, unknown>;
      const rawPartNumber =
        toStringIfDefined(record.partNumber) ??
        toStringIfDefined(record.productNumber) ??
        toStringIfDefined(record.articleNumber) ??
        toStringIfDefined(record.sku) ??
        toStringIfDefined(record.productId);

      const resolvedPartNumber = rawPartNumber ? normalizePartNumber(rawPartNumber) : null;
      if (resolvedPartNumber && prefixes.some((prefix) => resolvedPartNumber.startsWith(prefix))) {
        const rawUrl =
          toStringIfDefined(record.url) ??
          toStringIfDefined(record.link) ??
          toStringIfDefined(record.productUrl) ??
          baseUrl;
        const resolvedUrl = new URL(rawUrl, baseUrl).toString();
        const rawPrice =
          toStringIfDefined(record.price) ??
          toStringIfDefined(record.priceValue) ??
          toStringIfDefined(record.formattedPrice);
        const rawAvailability =
          toStringIfDefined(record.availability) ??
          toStringIfDefined(record.stockStatus) ??
          toStringIfDefined(record.deliveryStatus) ??
          '';

        extracted.push({
          partNumber: resolvedPartNumber,
          name:
            toStringIfDefined(record.name) ??
            toStringIfDefined(record.title) ??
            toStringIfDefined(record.productName) ??
            `Part ${resolvedPartNumber}`,
          price: rawPrice ? extractPrice(rawPrice) ?? rawPrice : undefined,
          url: resolvedUrl,
          availability: extractAvailability(rawAvailability),
        });
      }

      for (const value of Object.values(record)) {
        if (value && typeof value === 'object') {
          queue.push(value);
        }
      }
    }
  }

  return extracted;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function extractItemsFromHtml(html: string, baseUrl: string, prefixes: string[]): PartItem[] {
  const $ = cheerio.load(html);
  const extracted: PartItem[] = [];

  // Prefer product-like containers to avoid parsing global navigation links.
  const productNodes = $(
    [
      'article',
      'li.product',
      'li.product-tile',
      'li.result-item',
      '.product',
      '.product-tile',
      '.result-item',
      '[itemtype*="Product"]',
      '[data-product-id]',
      '[data-sku]',
    ].join(','),
  );

  productNodes.each((_, node) => {
    const container = $(node);
    const anchor = container.find('a[href]').first();
    const href = anchor.attr('href');
    if (!href) {
      return;
    }

    const blockText = firstNonEmpty(container.text(), anchor.text()) ?? '';
    const normalizedText = blockText.replace(/\s+/g, ' ').trim();
    if (!normalizedText) {
      return;
    }

    const partNumberCandidate = firstNonEmpty(
      container.attr('data-product-id'),
      container.attr('data-sku'),
      container.find('[data-product-id], [data-sku], .sku, .product-number, [itemprop="sku"]').first().text(),
    );

    const resolvedPartNumber =
      (partNumberCandidate ? normalizePartNumber(partNumberCandidate) : null) ??
      findPartNumber(normalizedText, prefixes) ??
      extractPartNumberFromHref(href, prefixes);

    if (!resolvedPartNumber) {
      return;
    }

    const validPrefix = prefixes.length === 0 || prefixes.some((prefix) => resolvedPartNumber.startsWith(prefix));
    if (!validPrefix) {
      return;
    }

    const name =
      firstNonEmpty(
        container.find('h1, h2, h3, h4, [itemprop="name"], .product-name, .name, .title').first().text(),
        anchor.text(),
      ) ?? `Part ${resolvedPartNumber}`;

    const fullUrl = new URL(href, baseUrl).toString();

    extracted.push({
      partNumber: resolvedPartNumber,
      name,
      price: extractPrice(normalizedText),
      url: fullUrl,
      availability: extractAvailability(normalizedText),
    });
  });

  // Fallback: if no product containers were detected, parse links but skip obvious nav/footer links.
  if (extracted.length === 0) {
    $('a[href]').each((_, node) => {
      const anchor = $(node);
      const href = anchor.attr('href');
      if (!href) {
        return;
      }

      const lowerHref = href.toLowerCase();
      if (
        lowerHref.includes('/konto') ||
        lowerHref.includes('/cart') ||
        lowerHref.includes('/warenkorb') ||
        lowerHref.includes('/service') ||
        lowerHref.includes('/impressum') ||
        lowerHref.includes('/datenschutz')
      ) {
        return;
      }

      const container = anchor.closest('article, li, .product, .product-tile, .result-item, .item');
      const blockText = firstNonEmpty(container.text(), anchor.text()) ?? '';
      const normalizedText = blockText.replace(/\s+/g, ' ').trim();
      if (!normalizedText) {
        return;
      }

      const resolvedPartNumber = findPartNumber(normalizedText, prefixes) ?? extractPartNumberFromHref(href, prefixes);
      if (!resolvedPartNumber) {
        return;
      }

      const name =
        firstNonEmpty(
          container.find('h1, h2, h3, h4, [itemprop="name"], .product-name, .name, .title').first().text(),
          anchor.text(),
        ) ?? `Part ${resolvedPartNumber}`;

      const fullUrl = new URL(href, baseUrl).toString();

      extracted.push({
        partNumber: resolvedPartNumber,
        name,
        price: extractPrice(normalizedText),
        url: fullUrl,
        availability: extractAvailability(normalizedText),
      });
    });
  }

  $('script[type="application/ld+json"]').each((_, node) => {
    const jsonText = $(node).contents().text().trim();
    if (!jsonText) {
      return;
    }

    try {
      const payload = JSON.parse(jsonText);
      const queue = Array.isArray(payload) ? [...payload] : [payload];

      while (queue.length > 0) {
        const item = queue.shift();
        if (!item || typeof item !== 'object') {
          continue;
        }

        if (Array.isArray(item)) {
          queue.push(...item);
          continue;
        }

        const anyItem = item as Record<string, unknown>;
        const type = String(anyItem['@type'] ?? '');
        if (type.toLowerCase() === 'product') {
          const sku = String(anyItem.sku ?? anyItem.productID ?? '');
          const partNumber = normalizePartNumber(sku);
          const validPrefix = prefixes.length === 0 || prefixes.some((prefix) => partNumber.startsWith(prefix));
          if (!partNumber || !validPrefix) {
            continue;
          }

          const offers = anyItem.offers as Record<string, unknown> | Record<string, unknown>[] | undefined;
          const firstOffer = Array.isArray(offers) ? offers[0] : offers;

          extracted.push({
            partNumber,
            name: String(anyItem.name ?? `Part ${partNumber}`),
            price: firstOffer?.price ? `${String(firstOffer.price)}${firstOffer.priceCurrency ? ` ${String(firstOffer.priceCurrency)}` : ''}` : undefined,
            url: String(anyItem.url ?? baseUrl),
            availability: extractAvailability(String(firstOffer?.availability ?? anyItem.availability ?? '')),
          });
        }

        for (const value of Object.values(anyItem)) {
          if (value && typeof value === 'object') {
            queue.push(value);
          }
        }
      }
    } catch {
      // Ignore malformed JSON-LD.
    }
  });

  if (extracted.length < 3) {
    extracted.push(...extractItemsFromStructuredScripts(html, baseUrl, prefixes));
  }

  return extracted;
}

function findNextPageUrl(html: string, currentUrl: string): string | null {
  const $ = cheerio.load(html);
  const current = new URL(currentUrl);

  const candidates = [
    $('link[rel="next"]').attr('href'),
    $('a[rel="next"]').attr('href'),
    $('a[aria-label*="next" i]').attr('href'),
    $('a:contains("Weiter")').attr('href'),
    $('a:contains("Next")').attr('href'),
  ].filter(Boolean) as string[];

  for (const href of candidates) {
    try {
      const nextUrl = new URL(href, currentUrl).toString();
      if (nextUrl !== currentUrl) {
        return nextUrl;
      }
    } catch {
      // Ignore invalid URLs.
    }
  }

  const pageKeys = ['page', 'p', 'paging', 'start', 'offset'];
  const currentPageValue =
    pageKeys
      .map((key) => Number.parseInt(current.searchParams.get(key) ?? '', 10))
      .find((value) => Number.isFinite(value)) ?? 1;

  const numericCandidates: Array<{ href: string; pageValue: number }> = [];
  $('a[href]').each((_, node) => {
    const href = $(node).attr('href');
    if (!href) {
      return;
    }

    try {
      const url = new URL(href, currentUrl);
      if (url.pathname !== current.pathname) {
        return;
      }

      for (const key of pageKeys) {
        const value = Number.parseInt(url.searchParams.get(key) ?? '', 10);
        if (Number.isFinite(value)) {
          numericCandidates.push({ href: url.toString(), pageValue: value });
          return;
        }
      }
    } catch {
      // Ignore malformed candidate links.
    }
  });

  numericCandidates.sort((a, b) => a.pageValue - b.pageValue);
  const nextNumeric = numericCandidates.find((item) => item.pageValue > currentPageValue);
  if (nextNumeric && nextNumeric.href !== currentUrl) {
    return nextNumeric.href;
  }

  return null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function extractLocsFromXml(xml: string): string[] {
  const locs: string[] = [];
  const regex = /<loc>([\s\S]*?)<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    const value = decodeXmlEntities(match[1].trim());
    if (value) {
      locs.push(value);
    }
  }
  return locs;
}

function isSitemapUrl(url: string): boolean {
  return /\.xml(?:\.gz)?(?:$|\?)/i.test(url);
}

async function fetchTextWithGzipSupport(url: string, accept: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'mb-parts-poc/1.0',
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

function guessNameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 0) {
      return 'Unknown';
    }
    const slug = segments.length >= 2 ? segments[segments.length - 2] : segments[segments.length - 1];
    return slug
      .replace(/[-_]+/g, ' ')
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase()) || 'Unknown';
  } catch {
    return 'Unknown';
  }
}

async function fetchProductDetailMeta(url: string): Promise<ProductDetailMeta> {
  const cached = productDetailCache.get(url);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'mb-parts-poc/1.0',
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
      const soldOutMeta: ProductDetailMeta = {
        availability: { status: 'out_of_stock', label: 'Ausverkauft' },
        price: detailPrice,
      };
      productDetailCache.set(url, soldOutMeta);
      return soldOutMeta;
    }

    const infoText = $('.delivery-information').first().text().replace(/\s+/g, ' ').trim();
    const detailMeta: ProductDetailMeta = {
      availability: extractAvailability(infoText),
      price: detailPrice,
    };
    productDetailCache.set(url, detailMeta);
    return detailMeta;
  } catch {
    return { availability: { status: 'unknown', label: 'Unknown' } };
  }
}

async function enrichItemsFromProductPage(items: PartItem[]): Promise<void> {
  const queue = items.filter((item) => item.url);
  for (let i = 0; i < queue.length; i += AVAILABILITY_FETCH_CONCURRENCY) {
    const chunk = queue.slice(i, i + AVAILABILITY_FETCH_CONCURRENCY);
    const results = await Promise.all(chunk.map((item) => fetchProductDetailMeta(item.url)));
    for (let j = 0; j < chunk.length; j += 1) {
      chunk[j].availability = results[j].availability;
      if (results[j].price) {
        chunk[j].price = results[j].price;
      }
    }
  }
}

async function collectPartsFromSitemap(prefixes: string[], limit: number): Promise<PartItem[]> {
  const sitemapQueue = [
    'https://originalteile.mercedes-benz.de/sitemap.xml',
    'https://originalteile.mercedes-benz.de/sitemap_index.xml',
  ];
  const visitedSitemaps = new Set<string>();
  const foundItems: PartItem[] = [];
  const seenPartNumbers = new Set<string>();
  const maxSitemaps = 500;

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
    for (const loc of locs) {
      if (isSitemapUrl(loc)) {
        if (!visitedSitemaps.has(loc)) {
          sitemapQueue.push(loc);
        }
        continue;
      }

      const partNumber = extractPartNumberFromHref(loc, prefixes);
      if (!partNumber) {
        continue;
      }
      if (seenPartNumbers.has(partNumber)) {
        continue;
      }

      seenPartNumbers.add(partNumber);
      foundItems.push({
        partNumber,
        name: guessNameFromUrl(loc),
        url: loc,
        availability: { status: 'unknown', label: 'Unknown' },
      });

      if (foundItems.length >= limit) {
        break;
      }
    }
  }

  return foundItems;
}

async function fetchParts(
  prefixes: string[],
  limit: number,
  options: { enrichDetails?: boolean } = {},
): Promise<{ items: PartItem[] }> {
  const seen = new Set<string>();
  const items: PartItem[] = [];

  for (const searchPrefix of prefixes) {
    if (items.length >= limit) {
      break;
    }

    const searchTerms = [searchPrefix, `${searchPrefix}*`, `${searchPrefix} `];
    for (const searchTerm of searchTerms) {
      if (items.length >= limit) {
        break;
      }

      let pageUrl: string | null = `${MB_SEARCH_BASE}?search=${encodeURIComponent(searchTerm)}`;
      const visited = new Set<string>();
      let pageCount = 0;

      while (pageUrl && !visited.has(pageUrl) && items.length < limit && pageCount < MAX_PAGES) {
        const currentPageUrl: string = pageUrl;
        visited.add(currentPageUrl);
        pageCount += 1;

        const response: Response = await fetch(currentPageUrl, {
          redirect: 'manual',
          headers: {
            'User-Agent': 'mb-parts-poc/1.0',
            Accept: 'text/html',
          },
        });

        if (response.status >= 300 && response.status < 400) {
          const locationHeader: string | null = response.headers.get('location');
          if (!locationHeader) {
            break;
          }
          const redirectUrl: string = new URL(locationHeader, currentPageUrl).toString();
          if (!redirectUrl.includes('/search')) {
            // Skip product-detail redirects and try the next search term variant.
            break;
          }
          pageUrl = redirectUrl;
          continue;
        }

        if (!response.ok) {
          throw new Error(`Upstream request failed: ${response.status} ${response.statusText}`);
        }

        const html = await response.text();
        const extracted = extractItemsFromHtml(html, currentPageUrl, [searchPrefix]);

        for (const item of extracted) {
          const validPrefix = item.partNumber.startsWith(searchPrefix);
          if (!validPrefix) {
            continue;
          }
          if (seen.has(item.partNumber)) {
            continue;
          }

          seen.add(item.partNumber);
          items.push(item);

          if (items.length >= limit) {
            break;
          }
        }

        pageUrl = findNextPageUrl(html, pageUrl);
      }
    }
  }

  if (items.length <= 1 && items.length < limit) {
    const remaining = limit - items.length;
    const sitemapItems = await collectPartsFromSitemap(prefixes, remaining);
    for (const item of sitemapItems) {
      if (seen.has(item.partNumber)) {
        continue;
      }
      seen.add(item.partNumber);
      items.push(item);
      if (items.length >= limit) {
        break;
      }
    }
  }

  if (options.enrichDetails ?? true) {
    await enrichItemsFromProductPage(items);
  }
  return { items };
}

async function readPriceSnapshot(): Promise<PriceSnapshot> {
  try {
    const raw = await readFile(PRICE_SNAPSHOT_JSON_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PriceSnapshot>;
    return {
      updatedAt: parsed.updatedAt ?? '',
      count: parsed.count ?? 0,
      prices: parsed.prices ?? {},
    };
  } catch {
    return { updatedAt: '', count: 0, prices: {} };
  }
}

async function readRequestJson(req: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

async function getBaseSnapshot(): Promise<PartsSnapshot> {
  if (baseSnapshotCache) {
    return baseSnapshotCache;
  }
  const raw = await readFile(BASE_SNAPSHOT_JSON_PATH, 'utf-8');
  const snapshot = JSON.parse(raw) as PartsSnapshot;
  baseSnapshotCache = snapshot;
  return snapshot;
}

async function writeBaseSnapshot(snapshot: PartsSnapshot): Promise<void> {
  await mkdir(dirname(BASE_SNAPSHOT_JSON_PATH), { recursive: true });
  await writeFile(BASE_SNAPSHOT_JSON_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
}

async function syncBaseSnapshot(prefixes: string[], limit: number): Promise<PartsSnapshot> {
  const { items } = await fetchParts(prefixes, limit, { enrichDetails: false });
  const sortedItems = [...items].sort((left, right) => left.partNumber.localeCompare(right.partNumber));
  const snapshot: PartsSnapshot = {
    prefixes,
    limit,
    count: sortedItems.length,
    generatedAt: new Date().toISOString(),
    items: sortedItems,
  };
  await writeBaseSnapshot(snapshot);
  baseSnapshotCache = snapshot;
  return snapshot;
}

async function enrichVisiblePartNumbers(
  partNumbers: string[],
): Promise<{ updated: number; entries: Record<string, PriceEntry> }> {
  const snapshot = await getBaseSnapshot();
  const byPartNumber = new Map(snapshot.items.map((item) => [item.partNumber, item]));
  const uniquePartNumbers = Array.from(
    new Set(
      partNumbers
        .map((partNumber) => normalizePartNumber(partNumber))
        .filter(Boolean),
    ),
  ).slice(0, 100);

  const targets = uniquePartNumbers
    .map((partNumber) => ({ partNumber, item: byPartNumber.get(partNumber) }))
    .filter((entry): entry is { partNumber: string; item: PartItem } => Boolean(entry.item));

  if (targets.length === 0) {
    return { updated: 0, entries: {} };
  }

  const updatedAt = new Date().toISOString();
  const priceSnapshot = await readPriceSnapshot();
  const entries: Record<string, PriceEntry> = {};

  for (let i = 0; i < targets.length; i += AVAILABILITY_FETCH_CONCURRENCY) {
    const chunk = targets.slice(i, i + AVAILABILITY_FETCH_CONCURRENCY);
    const details = await Promise.all(chunk.map((entry) => fetchProductDetailMeta(entry.item.url)));
    for (let j = 0; j < chunk.length; j += 1) {
      const partNumber = chunk[j].partNumber;
      const detail = details[j];
      const value: PriceEntry = {
        price: detail.price,
        availability: detail.availability,
        updatedAt,
      };
      priceSnapshot.prices[partNumber] = value;
      entries[partNumber] = value;
    }
  }

  priceSnapshot.updatedAt = updatedAt;
  priceSnapshot.count = Object.keys(priceSnapshot.prices).length;
  await writeFile(PRICE_SNAPSHOT_JSON_PATH, `${JSON.stringify(priceSnapshot, null, 2)}\n`, 'utf-8');

  return { updated: targets.length, entries };
}

async function syncPriceBatch(batchSize: number): Promise<{ updated: number; pricedCount: number; nextCursor: number }> {
  const normalizedBatch = Math.max(1, Math.min(batchSize, 5000));
  const baseSnapshot = await getBaseSnapshot();
  const items = Array.isArray(baseSnapshot.items) ? baseSnapshot.items : [];

  const priceSnapshot = await readPriceSnapshot();
  let cursor = 0;
  try {
    const stateRaw = await readFile(PRICE_SNAPSHOT_STATE_JSON_PATH, 'utf-8');
    const state = JSON.parse(stateRaw) as { cursor?: number };
    if (typeof state.cursor === 'number' && Number.isFinite(state.cursor)) {
      cursor = Math.max(0, state.cursor % Math.max(items.length, 1));
    }
  } catch {
    // no persisted state yet
  }

  if (items.length === 0) {
    return { updated: 0, pricedCount: 0, nextCursor: 0 };
  }

  const updatedAt = new Date().toISOString();
  const nowMs = Date.now();
  const staleAfterMs = 7 * 24 * 60 * 60 * 1000;
  const candidates: PartItem[] = [];
  const candidateIndexes: number[] = [];

  for (let i = 0; i < items.length && candidates.length < normalizedBatch; i += 1) {
    const idx = (cursor + i) % items.length;
    const item = items[idx];
    const entry = priceSnapshot.prices[item.partNumber];
    const entryTs = Date.parse(entry?.updatedAt ?? '');
    const isStale = !Number.isFinite(entryTs) || nowMs - entryTs > staleAfterMs;
    if (!entry || isStale) {
      candidates.push(item);
      candidateIndexes.push(idx);
    }
  }

  for (let i = 0; i < candidates.length; i += AVAILABILITY_FETCH_CONCURRENCY) {
    const chunk = candidates.slice(i, i + AVAILABILITY_FETCH_CONCURRENCY);
    const meta = await Promise.all(chunk.map((item) => fetchProductDetailMeta(item.url)));
    for (let j = 0; j < chunk.length; j += 1) {
      const price = meta[j].price;
      const availability = meta[j].availability;
      priceSnapshot.prices[chunk[j].partNumber] = { price, availability, updatedAt };
    }
  }

  priceSnapshot.updatedAt = updatedAt;
  priceSnapshot.count = Object.keys(priceSnapshot.prices).length;
  await writeFile(PRICE_SNAPSHOT_JSON_PATH, `${JSON.stringify(priceSnapshot, null, 2)}\n`, 'utf-8');

  const lastIndex = candidateIndexes[candidateIndexes.length - 1] ?? cursor;
  const nextCursor = (lastIndex + 1) % items.length;
  await writeFile(
    PRICE_SNAPSHOT_STATE_JSON_PATH,
    `${JSON.stringify({ cursor: nextCursor, updatedAt }, null, 2)}\n`,
    'utf-8',
  );
  return { updated: candidates.length, pricedCount: priceSnapshot.count, nextCursor };
}

export default defineConfig({
  server: {
    middlewareMode: false,
  },
  plugins: [
    {
      name: 'parts-api-middleware',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url) {
            return next();
          }

          const requestUrl = new URL(req.url, 'http://localhost');
          if (req.method === 'POST' && requestUrl.pathname === '/api/sync') {
            const prefixes = parsePrefixes(requestUrl.searchParams.get('prefix'));
            const effectivePrefixes = prefixes.length > 0 ? prefixes : DEFAULT_SYNC_PREFIXES;
            const limit = parseSyncLimit(requestUrl.searchParams.get('limit') ?? 'all');

            try {
              const snapshot = await syncBaseSnapshot(effectivePrefixes, limit);
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(
                JSON.stringify({
                  ok: true,
                  prefixes: snapshot.prefixes,
                  count: snapshot.count,
                  generatedAt: snapshot.generatedAt,
                  items: snapshot.items,
                }),
              );
            } catch (error) {
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(
                JSON.stringify({
                  ok: false,
                  error: error instanceof Error ? error.message : 'Unknown error',
                }),
              );
            }
            return;
          }

          if (req.method === 'POST' && requestUrl.pathname === '/api/sync-prices') {
            const batchParam = requestUrl.searchParams.get('batch');
            const batch = Number.parseInt(batchParam ?? '500', 10);
            try {
              const result = await syncPriceBatch(batch);
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(
                JSON.stringify({
                  ok: true,
                  updated: result.updated,
                  pricedCount: result.pricedCount,
                  nextCursor: result.nextCursor,
                }),
              );
            } catch (error) {
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(
                JSON.stringify({
                  ok: false,
                  error: error instanceof Error ? error.message : 'Unknown error',
                }),
              );
            }
            return;
          }

          if (req.method === 'POST' && requestUrl.pathname === '/api/enrich-visible') {
            try {
              const body = (await readRequestJson(req)) as { partNumbers?: string[] };
              const partNumbers = Array.isArray(body.partNumbers) ? body.partNumbers : [];
              const result = await enrichVisiblePartNumbers(partNumbers);
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(
                JSON.stringify({
                  ok: true,
                  updated: result.updated,
                  entries: result.entries,
                }),
              );
            } catch (error) {
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(
                JSON.stringify({
                  ok: false,
                  error: error instanceof Error ? error.message : 'Unknown error',
                }),
              );
            }
            return;
          }

          if (req.method !== 'GET' || requestUrl.pathname !== '/api/parts') {
            return next();
          }

          const prefixParam = requestUrl.searchParams.get('prefix');
          const prefixes = parsePrefixes(prefixParam);
          const limit = parseLimit(requestUrl.searchParams.get('limit'));

          if (prefixes.length === 0) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: 'Query parameter "prefix" is required.' }));
            return;
          }

          try {
            const { items } = await fetchParts(prefixes, limit, { enrichDetails: true });

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(
              JSON.stringify({
                prefix: prefixParam ?? '',
                limit,
                count: items.length,
                items,
              }),
            );
          } catch (error) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(
              JSON.stringify({
                prefix: prefixParam ?? '',
                limit,
                count: 0,
                items: [],
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            );
          }
        });
      },
    },
  ],
});
