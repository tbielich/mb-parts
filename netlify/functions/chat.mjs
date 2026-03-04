import {
  DEFAULT_PREFIXES,
  filterSnapshotItems,
  jsonResponse,
  normalizePartNumber,
  parseJsonBody,
  readBaseSnapshotWithFallback,
} from './_parts-utils.mjs';

const MAX_RECOMMENDATIONS = 3;
const STOP_WORDS = new Set([
  'bitte',
  'brauche',
  'suche',
  'teil',
  'teile',
  'passend',
  'finden',
  'haben',
  'hallo',
  'und',
  'oder',
  'mit',
  'für',
  'der',
  'die',
  'das',
  'ein',
  'eine',
  'den',
  'dem',
  'des',
  'von',
  'auf',
  'ist',
  'sind',
  'ich',
  'wir',
  'ihr',
  'du',
  'im',
  'am',
  'zu',
  'in',
]);

function normalizeText(value) {
  return String(value ?? '').toLowerCase();
}

function tokenize(message) {
  const tokens = normalizeText(message)
    .split(/[^a-z0-9äöüß]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));

  return Array.from(new Set(tokens));
}

function extractPartNumberCandidates(message) {
  const matches = String(message ?? '').toUpperCase().match(/\bA[\s-]*\d[\d\s-]{6,20}\b/g) ?? [];
  return Array.from(new Set(matches.map((value) => normalizePartNumber(value)).filter(Boolean)));
}

function parsePriceValue(price) {
  if (!price) {
    return Number.POSITIVE_INFINITY;
  }
  const normalized = String(price).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function wantsLowPrice(message) {
  const text = normalizeText(message);
  return /\b(günstig|guenstig|billig|preiswert|niedrig|preis)\b/.test(text);
}

function wantsAvailability(message) {
  const text = normalizeText(message);
  return /\b(lieferbar|sofort|verfügbar|verfuegbar|lager)\b/.test(text);
}

function scoreItem(item, ctx) {
  const partNumber = item.partNumber;
  const name = normalizeText(item.name);
  const hierarchy = Array.isArray(item.hierarchyGroups)
    ? item.hierarchyGroups.map((group) => normalizeText(group)).join(' ')
    : '';

  let score = 0;
  const reasons = [];

  if (ctx.partNumbers.has(partNumber)) {
    score += 120;
    reasons.push('Exakte Teilenummer erkannt');
  }

  for (const token of ctx.tokens) {
    if (partNumber.toLowerCase().includes(token)) {
      score += 20;
      reasons.push(`Nummer enthält "${token}"`);
      continue;
    }
    if (name.includes(token)) {
      score += 12;
      reasons.push(`Name passt zu "${token}"`);
      continue;
    }
    if (hierarchy.includes(token)) {
      score += 8;
      reasons.push(`Gruppe passt zu "${token}"`);
    }
  }

  if (item.availability?.status === 'in_stock') {
    score += 4;
    if (ctx.availabilityPreference) {
      score += 12;
      reasons.push('Aktuell verfügbar');
    }
  }

  const priceValue = parsePriceValue(item.price);
  if (ctx.lowPricePreference && Number.isFinite(priceValue)) {
    score += Math.max(0, 25 - Math.min(priceValue / 10, 25));
  }

  return { score, reasons: Array.from(new Set(reasons)) };
}

function buildAnswer(recommendations, query) {
  if (recommendations.length === 0) {
    return {
      answer:
        `Ich habe in unserem Katalog aktuell keinen klaren Treffer für "${query}" gefunden. ` +
        'Bitte nenne mir möglichst Teilenummer, Fahrzeugmodell, Baujahr oder die VIN.',
      followUpQuestions: [
        'Welche MB-Baureihe und welches Baujahr hat das Fahrzeug?',
        'Hast du eine OEM-/Teilenummer vom Altteil?',
      ],
    };
  }

  return {
    answer:
      'Ich habe passende Teile aus dem Katalog priorisiert. Bitte vor Bestellung immer mit VIN/FIN gegenprüfen.',
    followUpQuestions: [
      'Soll ich stärker nach Lieferbarkeit oder nach Preis priorisieren?',
      'Wenn du mir Modell + Baujahr nennst, kann ich die Auswahl weiter eingrenzen.',
    ],
  };
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method not allowed' });
  }

  try {
    const body = parseJsonBody(event);
    const message = String(body.message ?? '').trim();
    if (!message) {
      return jsonResponse(400, { ok: false, error: 'message is required' });
    }

    const snapshot = await readBaseSnapshotWithFallback(event);
    const baseItems = filterSnapshotItems(snapshot.items, DEFAULT_PREFIXES, Number.MAX_SAFE_INTEGER);
    const partNumbers = new Set(extractPartNumberCandidates(message));
    const tokens = tokenize(message);

    const scored = baseItems
      .map((item) => {
        const result = scoreItem(item, {
          partNumbers,
          tokens,
          lowPricePreference: wantsLowPrice(message),
          availabilityPreference: wantsAvailability(message),
        });
        return {
          ...item,
          _score: result.score,
          _reasons: result.reasons,
          _priceValue: parsePriceValue(item.price),
        };
      })
      .filter((item) => item._score > 0)
      .sort((left, right) => {
        if (right._score !== left._score) {
          return right._score - left._score;
        }
        if (left._priceValue !== right._priceValue) {
          return left._priceValue - right._priceValue;
        }
        return left.partNumber.localeCompare(right.partNumber);
      })
      .slice(0, MAX_RECOMMENDATIONS);

    const recommendations = scored.map((item) => ({
      partNumber: item.partNumber,
      name: item.name,
      price: item.price,
      url: item.url,
      availability: item.availability,
      hierarchyGroups: item.hierarchyGroups ?? [],
      reason: item._reasons[0] ?? 'Katalog-Match',
      score: item._score,
    }));

    const responseText = buildAnswer(recommendations, message);
    return jsonResponse(200, {
      ok: true,
      answer: responseText.answer,
      followUpQuestions: responseText.followUpQuestions,
      recommendations,
    });
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
