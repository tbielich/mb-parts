import { defineConfig } from 'vite';
import * as cheerio from 'cheerio';

type Availability = {
  status: string;
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
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_PAGES = 10;

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
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
    return { status: 'unavailable', label: 'Unavailable' };
  }

  if (/verf\u00fcgbar|lieferbar|in\s+stock|sofort\s+lieferbar/.test(normalized)) {
    return { status: 'available', label: 'Available' };
  }

  if (/vorbestell|preorder/.test(normalized)) {
    return { status: 'preorder', label: 'Preorder' };
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

  $('a[href]').each((_, node) => {
    const anchor = $(node);
    const href = anchor.attr('href');
    if (!href) {
      return;
    }

    const container = anchor.closest('article, li, .product, .product-tile, .result-item, .item, div');
    const blockText = firstNonEmpty(container.text(), anchor.text()) ?? '';
    const normalizedText = blockText.replace(/\s+/g, ' ').trim();
    if (!normalizedText) {
      return;
    }

    const partNumber = findPartNumber(normalizedText, prefixes);
    if (!partNumber) {
      return;
    }

    const name =
      firstNonEmpty(
        container.find('h1, h2, h3, h4, [itemprop="name"], .product-name, .name, .title').first().text(),
        anchor.text(),
      ) ?? `Part ${partNumber}`;

    const fullUrl = new URL(href, baseUrl).toString();

    extracted.push({
      partNumber,
      name,
      price: extractPrice(normalizedText),
      url: fullUrl,
      availability: extractAvailability(normalizedText),
    });
  });

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
          const validPrefix = prefixes.some((prefix) => partNumber.startsWith(prefix));
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

  return extracted;
}

function findNextPageUrl(html: string, currentUrl: string): string | null {
  const $ = cheerio.load(html);

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

  return null;
}

async function fetchParts(prefixes: string[], limit: number): Promise<{ items: PartItem[] }> {
  const seen = new Set<string>();
  const items: PartItem[] = [];

  for (const searchPrefix of prefixes) {
    if (items.length >= limit) {
      break;
    }

    let pageUrl: string | null = `${MB_SEARCH_BASE}?search=${encodeURIComponent(searchPrefix)}`;
    const visited = new Set<string>();
    let pageCount = 0;

    while (pageUrl && !visited.has(pageUrl) && items.length < limit && pageCount < MAX_PAGES) {
      visited.add(pageUrl);
      pageCount += 1;

      const response = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'mb-parts-poc/1.0',
          Accept: 'text/html',
        },
      });

      if (!response.ok) {
        throw new Error(`Upstream request failed: ${response.status} ${response.statusText}`);
      }

      const html = await response.text();
      const extracted = extractItemsFromHtml(html, pageUrl, prefixes);

      for (const item of extracted) {
        const validPrefix = prefixes.some((prefix) => item.partNumber.startsWith(prefix));
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

  return { items };
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
            const { items } = await fetchParts(prefixes, limit);

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
