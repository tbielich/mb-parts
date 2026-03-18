import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readJson(path, fallback) {
  if (!existsSync(path)) {
    return fallback;
  }

  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizePartNumber(value) {
  return normalizeText(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeGroupLabel(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return 'Unbenannte Gruppe';
  }

  return raw.toLowerCase().replace(/\b\p{L}/gu, (char) => char.toUpperCase());
}

function isHiddenGroupLabel(label) {
  const normalized = normalizeText(label).toLowerCase().replace(/\s+/g, '-');
  return normalized === 'sa-verzeichnis';
}

function normalizePosition(value) {
  const raw = normalizeText(value);
  return raw || '-';
}

function positionKey(value) {
  const normalized = normalizeText(value);
  if (!normalized || normalized === '-') {
    return '';
  }
  return normalized;
}

function normalizePrice(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return '-';
  }
  return raw.replaceAll('*', '').trim() || '-';
}

function normalizePartName(value) {
  const raw = normalizeText(value)
    .replaceAll('_', ' ')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/(\d)\s*[xX]\s*(\d)/g, '$1×$2')
    .replace(/Ersetzt durch:\s*•\s*\+\s*♦\s*Wahlweise mit:/gi, ' (Kein Original)')
    .replace(/•\s*\+\s*♦\s*Wahlweise mit:/gi, ' (Kein Original)')
    .replace(/\s*\(kein original\)/gi, ' (Kein Original)');

  if (!raw || raw === '-') {
    return '-';
  }

  const lower = raw.toLowerCase();
  const withUmlauts = lower
    .replace(/ae/g, 'ä')
    .replace(/(^|[^q])ue/g, (_match, prefix) => `${prefix}ü`);

  return withUmlauts
    .replace(/(^|[\s/(),.-]+)(\p{L})/gu, (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`)
    .replaceAll('Ü', 'ü')
    .replaceAll('Ä', 'ä');
}

function isOriginalteileUrl(value) {
  const url = normalizeText(value);
  if (!url) {
    return false;
  }

  try {
    return new URL(url).hostname === 'originalteile.mercedes-benz.de';
  } catch {
    return false;
  }
}

function resolvePreferredPartUrl(catalogUrl, fallbackUrl) {
  if (isOriginalteileUrl(catalogUrl)) {
    return normalizeText(catalogUrl);
  }

  return normalizeText(fallbackUrl) || '#';
}

function getAvailability(value) {
  return value ?? { status: 'unknown', label: 'Unbekannt' };
}

function resolveDiagramImageSources(imageUrl) {
  const normalized = normalizeText(imageUrl);
  if (!normalized) {
    return { primary: '', fallback: '' };
  }

  const lower = normalized.toLowerCase();
  if (lower.endsWith('.png') && normalized.includes('/data/diagrams/')) {
    return {
      primary: normalized.replace('/data/diagrams/', '/data/diagrams-svg/').replace(/\.png$/i, '.svg'),
      fallback: normalized,
    };
  }

  if (lower.endsWith('.svg') && normalized.includes('/data/diagrams-svg/')) {
    return {
      primary: normalized,
      fallback: normalized.replace('/data/diagrams-svg/', '/data/diagrams/').replace(/\.svg$/i, '.png'),
    };
  }

  return { primary: normalized, fallback: '' };
}

function buildCatalogByPartNumber(baseSnapshot, priceSnapshot) {
  const catalogByPartNumber = new Map();

  for (const item of baseSnapshot.items ?? []) {
    const partNumber = normalizePartNumber(item.partNumber);
    if (!partNumber) {
      continue;
    }

    catalogByPartNumber.set(partNumber, {
      partNumber,
      name: normalizeText(item.name) || '-',
      url: normalizeText(item.url) || '#',
      price: normalizeText(item.price) || undefined,
      availability: getAvailability(item.availability),
    });
  }

  for (const [partNumberRaw, value] of Object.entries(priceSnapshot.prices ?? {})) {
    const partNumber = normalizePartNumber(partNumberRaw);
    if (!partNumber) {
      continue;
    }

    const existing = catalogByPartNumber.get(partNumber);
    if (!existing) {
      catalogByPartNumber.set(partNumber, {
        partNumber,
        name: '-',
        url: '#',
        price: normalizeText(value?.price) || undefined,
        availability: getAvailability(value?.availability),
      });
      continue;
    }

    if (normalizeText(value?.price)) {
      existing.price = normalizeText(value?.price);
    }
    if (value?.availability) {
      existing.availability = getAvailability(value.availability);
    }
  }

  return catalogByPartNumber;
}

function buildSubgroupViews(diagramMap) {
  const bySubgroup = new Map();

  for (const entries of Object.values(diagramMap.mappingsByPartNumber ?? {})) {
    for (const entry of entries) {
      const key = `${entry.group}-${entry.subgroup}`;
      const existing = bySubgroup.get(key);
      if (!existing) {
        bySubgroup.set(key, {
          group: entry.group,
          subgroup: entry.subgroup,
          sourceUrl: entry.sourceUrl,
          imageUrl: entry.imageUrl,
          entries: [entry],
        });
        continue;
      }

      if (!existing.imageUrl && entry.imageUrl) {
        existing.imageUrl = entry.imageUrl;
      }
      existing.entries.push(entry);
    }
  }

  for (const page of diagramMap.subgroupPages ?? []) {
    const key = `${page.group}-${page.subgroup}`;
    if (!bySubgroup.has(key)) {
      bySubgroup.set(key, {
        group: page.group,
        subgroup: page.subgroup,
        sourceUrl: page.url,
        imageUrl: undefined,
        entries: [],
      });
    }
  }

  return bySubgroup;
}

function getCatalogPart(entry, catalogByPartNumber) {
  const normalizedPartNumber = normalizePartNumber(entry.partNumber);
  const fromCatalog = catalogByPartNumber.get(normalizedPartNumber);
  if (fromCatalog) {
    return fromCatalog;
  }

  return {
    partNumber: normalizedPartNumber || entry.partNumber,
    name: '-',
    url: entry.sourceUrl,
    availability: { status: 'unknown', label: 'Unbekannt' },
  };
}

function resolveDisplayPartName(entry, catalogPart) {
  const catalogName = normalizePartName(catalogPart.name);
  if (catalogName !== '-') {
    return catalogName;
  }

  return normalizePartName(entry.description);
}

function buildRows(entries, catalogByPartNumber) {
  if (entries.length === 0) {
    return [];
  }

  const unique = new Map();
  for (const entry of entries) {
    const key = `${entry.partNumber}-${entry.position ?? ''}`;
    if (!unique.has(key)) {
      unique.set(key, entry);
    }
  }

  return Array.from(unique.values())
    .sort((a, b) => {
      const posA = Number.parseInt(a.position ?? '9999', 10);
      const posB = Number.parseInt(b.position ?? '9999', 10);
      if (Number.isFinite(posA) && Number.isFinite(posB) && posA !== posB) {
        return posA - posB;
      }
      return a.partNumber.localeCompare(b.partNumber);
    })
    .map((entry) => {
      const catalogPart = getCatalogPart(entry, catalogByPartNumber);
      const availability = getAvailability(catalogPart.availability);
      const posKey = positionKey(entry.position);
      const hasOriginalLink = isOriginalteileUrl(catalogPart.url);

      return {
        position: normalizePosition(entry.position),
        positionKey: posKey,
        rowId: posKey ? `position-${posKey}` : '',
        partNumber: catalogPart.partNumber,
        displayName: resolveDisplayPartName(entry, catalogPart),
        price: normalizePrice(catalogPart.price),
        availabilityStatus: availability.status,
        availabilityLabel: availability.label,
        hasOriginalLink,
        preferredUrl: hasOriginalLink ? resolvePreferredPartUrl(catalogPart.url, entry.sourceUrl) : '',
        partLabel: `${catalogPart.partNumber} in neuem Tab öffnen`,
        noOriginalLabel: '(Kein Original)',
      };
    });
}

function buildAreas(entries) {
  const byPosition = new Map();

  for (const entry of entries) {
    const pos = positionKey(entry.position);
    if (!pos || !entry.coords) {
      continue;
    }

    if (!byPosition.has(pos)) {
      byPosition.set(pos, {
        shape: entry.shape || 'rect',
        coords: entry.coords,
      });
    }
  }

  return Array.from(byPosition.entries())
    .sort((a, b) => Number.parseInt(a[0], 10) - Number.parseInt(b[0], 10))
    .map(([position, meta]) => ({
      position,
      href: `#position-${position}`,
      shape: meta.shape,
      coords: meta.coords,
      label: `Position ${position} in der Teileliste hervorheben`,
    }));
}

function toClientView(view, groupLabel, catalogByPartNumber) {
  const image = resolveDiagramImageSources(view.imageUrl);
  const rows = buildRows(view.entries, catalogByPartNumber);
  const areas = buildAreas(view.entries);

  return {
    group: view.group,
    subgroup: view.subgroup,
    groupLabel,
    sourceUrl: view.sourceUrl,
    imagePrimary: image.primary,
    imageFallback: image.fallback,
    imageAlt: `Teilegrafik Gruppe ${view.group} Unterseite ${view.subgroup}`,
    rows,
    areas,
    entryCount: view.entries.length,
  };
}

export default (() => {
  const diagramMapPath = resolve(process.cwd(), 'static/data/parts-diagram-map.json');
  const basePath = resolve(process.cwd(), 'static/data/parts-base.json');
  const pricePath = resolve(process.cwd(), 'static/data/parts-price.json');

  const diagramMap = readJson(diagramMapPath, {
    stats: { groups: 0, subgroupPages: 0, uniquePartNumbers: 0 },
    subgroupPages: [],
    groupMeta: {},
    mappingsByPartNumber: {},
  });
  const baseSnapshot = readJson(basePath, { items: [] });
  const priceSnapshot = readJson(pricePath, { prices: {} });
  const catalogByPartNumber = buildCatalogByPartNumber(baseSnapshot, priceSnapshot);
  const subgroupViews = buildSubgroupViews(diagramMap);
  const grouped = new Map();

  for (const view of subgroupViews.values()) {
    const pages = grouped.get(view.group) ?? [];
    pages.push(view);
    grouped.set(view.group, pages);
  }

  const groups = Array.from(grouped.keys())
    .map((groupCode) => {
      const pages = (grouped.get(groupCode) ?? []).sort((a, b) => a.subgroup.localeCompare(b.subgroup));
      const label = normalizeGroupLabel(diagramMap.groupMeta?.[groupCode]);
      const firstWithEntries = pages.find((page) => page.entries.length > 0) ?? pages[0] ?? null;
      const hasEntries = pages.some((page) => page.entries.length > 0);

      return {
        code: groupCode,
        label,
        href: `#group-${encodeURIComponent(groupCode)}`,
        hasEntries,
        view: firstWithEntries ? toClientView(firstWithEntries, label, catalogByPartNumber) : null,
      };
    })
    .filter((group) => !isHiddenGroupLabel(group.label))
    .sort((a, b) => Number.parseInt(a.code, 10) - Number.parseInt(b.code, 10));

  const availableGroups = groups.filter((group) => group.hasEntries && group.view);
  const initialGroup = availableGroups[0] ?? null;
  const initialView = initialGroup?.view ?? {
    group: '',
    subgroup: '',
    groupLabel: 'Bitte Gruppe wählen',
    sourceUrl: '#',
    imagePrimary: '',
    imageFallback: '',
    imageAlt: 'Keine Grafik verfügbar',
    rows: [],
    areas: [],
    entryCount: 0,
  };

  return {
    stats: diagramMap.stats ?? { groups: 0, subgroupPages: 0, uniquePartNumbers: 0 },
    groups: groups.map((group) => ({
      ...group,
      isActive: group.code === initialGroup?.code,
    })),
    initialGroupCode: initialGroup?.code ?? '',
    initialView,
    initialStatus:
      initialGroup && initialView
        ? `Fertig: Gruppe ${initialView.group}, Teile ${initialView.entryCount}`
        : 'Keine Gruppen verfügbar',
    clientJson: JSON.stringify({
      initialGroupCode: initialGroup?.code ?? '',
      groups: groups
        .filter((group) => group.view)
        .map((group) => ({
          code: group.code,
          label: group.label,
          href: group.href,
          hasEntries: group.hasEntries,
          view: group.view,
        })),
    }),
  };
})();
