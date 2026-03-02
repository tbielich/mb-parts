import './groups.css';

type DiagramEntry = {
  group: string;
  subgroup: string;
  sourceUrl: string;
  partNumber: string;
  position?: string;
  description?: string;
  quantity?: string;
  imageUrl?: string;
  coords?: string;
  shape?: string;
};

type Availability = {
  status: 'in_stock' | 'out_of_stock' | 'unknown';
  label: string;
};

type BasePartItem = {
  partNumber: string;
  name?: string;
  url?: string;
  price?: string;
  availability?: Availability;
};

type BaseSnapshot = {
  items?: BasePartItem[];
};

type PriceEntry = {
  price?: string;
  availability?: Availability;
};

type PriceSnapshot = {
  prices?: Record<string, PriceEntry>;
};

type CatalogPart = {
  partNumber: string;
  name: string;
  url: string;
  price?: string;
  availability: Availability;
};

type DiagramMap = {
  stats: {
    groups: number;
    subgroupPages: number;
    uniquePartNumbers: number;
  };
  subgroupPages: Array<{
    group: string;
    subgroup: string;
    url: string;
  }>;
  groupMeta?: Record<string, string>;
  mappingsByPartNumber: Record<string, DiagramEntry[]>;
};

type SubgroupView = {
  group: string;
  subgroup: string;
  sourceUrl: string;
  imageUrl?: string;
  entries: DiagramEntry[];
};

function getRequiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Required DOM element not found: ${selector}`);
  }
  return element;
}

const statusLine = getRequiredElement<HTMLParagraphElement>('#groups-status');
const groupList = getRequiredElement<HTMLDivElement>('#group-list');
const selectionTitle = getRequiredElement<HTMLHeadingElement>('#selection-title');
const diagramImage = getRequiredElement<HTMLImageElement>('#diagram-image');
const diagramMap = getRequiredElement<HTMLMapElement>('#diagram-map');
const diagramOpenLink = getRequiredElement<HTMLAnchorElement>('#diagram-open-link');
const partsBody = getRequiredElement<HTMLTableSectionElement>('#diagram-parts-body');

let activePosition = '';
const catalogByPartNumber = new Map<string, CatalogPart>();
const groupLabelByCode = new Map<string, string>();

function setStatus(text: string): void {
  statusLine.textContent = text;
}

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeText(value: string | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizePosition(value: string | undefined): string {
  const raw = normalizeText(value);
  return raw || '-';
}

function positionKey(value: string | undefined): string {
  const normalized = normalizeText(value);
  if (!normalized || normalized === '-') {
    return '';
  }
  return normalized;
}

function normalizePartNumber(value: string | undefined): string {
  return normalizeText(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeGroupLabel(value: string | undefined): string {
  const raw = normalizeText(value);
  if (!raw) {
    return 'Unbenannte Gruppe';
  }
  return raw
    .toLowerCase()
    .replace(/\b\p{L}/gu, (char) => char.toUpperCase());
}

function normalizePrice(value: string | undefined): string {
  const raw = normalizeText(value);
  if (!raw) {
    return '-';
  }
  return raw.replaceAll('*', '').trim() || '-';
}

function isOriginalteileUrl(value: string | undefined): boolean {
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

function resolvePreferredPartUrl(catalogUrl: string | undefined, fallbackUrl: string): string {
  if (isOriginalteileUrl(catalogUrl)) {
    return normalizeText(catalogUrl);
  }
  return normalizeText(fallbackUrl) || '#';
}

function getAvailability(value?: Availability): Availability {
  return value ?? { status: 'unknown', label: 'Unbekannt' };
}

function getCatalogPart(entry: DiagramEntry): CatalogPart {
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

function buildSubgroupViews(data: DiagramMap): Map<string, SubgroupView> {
  const bySubgroup = new Map<string, SubgroupView>();

  for (const entries of Object.values(data.mappingsByPartNumber)) {
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

  for (const page of data.subgroupPages ?? []) {
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

function renderPartRows(entries: DiagramEntry[]): void {
  if (entries.length === 0) {
    partsBody.innerHTML = '<tr><td colspan="6" class="empty">Keine Teile in dieser Unterseite gefunden</td></tr>';
    return;
  }

  const unique = new Map<string, DiagramEntry>();
  for (const entry of entries) {
    const key = `${entry.partNumber}-${entry.position ?? ''}`;
    if (!unique.has(key)) {
      unique.set(key, entry);
    }
  }

  const rows = Array.from(unique.values()).sort((a, b) => {
    const posA = Number.parseInt(a.position ?? '9999', 10);
    const posB = Number.parseInt(b.position ?? '9999', 10);
    if (Number.isFinite(posA) && Number.isFinite(posB) && posA !== posB) {
      return posA - posB;
    }
    return a.partNumber.localeCompare(b.partNumber);
  });

  partsBody.innerHTML = rows
    .map((entry) => {
      const catalogPart = getCatalogPart(entry);
      const partLabel = `${catalogPart.partNumber} in neuem Tab öffnen`;
      const posKey = positionKey(entry.position);
      const availability = getAvailability(catalogPart.availability);
      const hasOriginalLink = isOriginalteileUrl(catalogPart.url);
      const preferredUrl = hasOriginalLink ? resolvePreferredPartUrl(catalogPart.url, entry.sourceUrl) : '';
      const linkCell = hasOriginalLink
        ? `<a href="${escapeHtml(preferredUrl)}" target="_blank" rel="noopener" aria-label="${escapeHtml(partLabel)}" title="${escapeHtml(partLabel)}">Prüfen</a>`
        : '<span class="no-original">Kein Original</span>';
      return `
        <tr class="parts-row" data-position="${escapeHtml(posKey)}">
          <td>${escapeHtml(normalizePosition(entry.position))}</td>
          <td>${escapeHtml(catalogPart.partNumber)}</td>
          <td>${escapeHtml(normalizeText(catalogPart.name) || '-')}</td>
          <td>${escapeHtml(normalizePrice(catalogPart.price))}</td>
          <td><span class="badge badge-${escapeHtml(availability.status)}">${escapeHtml(availability.label)}</span></td>
          <td>${linkCell}</td>
        </tr>
      `;
    })
    .join('');

  partsBody.querySelectorAll<HTMLTableRowElement>('tr.parts-row').forEach((row) => {
    row.addEventListener('click', () => {
      const pos = row.dataset.position ?? '';
      if (!pos) {
        return;
      }
      highlightPosition(pos, { scroll: false });
    });
  });
}

function renderDiagramMap(entries: DiagramEntry[]): void {
  const byPosition = new Map<string, { coords: string; shape: string }>();
  for (const entry of entries) {
    const pos = positionKey(entry.position);
    if (!pos || !entry.coords) {
      continue;
    }
    if (!byPosition.has(pos)) {
      byPosition.set(pos, {
        coords: entry.coords,
        shape: entry.shape || 'rect',
      });
    }
  }

  const areas = Array.from(byPosition.entries())
    .sort((a, b) => Number.parseInt(a[0], 10) - Number.parseInt(b[0], 10))
    .map(([pos, meta]) => {
      const label = `Position ${pos} in der Teileliste hervorheben`;
      return `<area shape="${escapeHtml(meta.shape)}" coords="${escapeHtml(meta.coords)}" href="#position-${escapeHtml(pos)}" data-position="${escapeHtml(pos)}" alt="${escapeHtml(pos)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">`;
    })
    .join('');

  diagramMap.innerHTML = areas;

  diagramMap.querySelectorAll<HTMLAreaElement>('area[data-position]').forEach((area) => {
    area.addEventListener('click', (event) => {
      event.preventDefault();
      const pos = area.dataset.position ?? '';
      if (!pos) {
        return;
      }
      highlightPosition(pos, { scroll: true });
    });
  });
}

function highlightPosition(position: string, options: { scroll: boolean }): void {
  activePosition = position;
  const rows = Array.from(partsBody.querySelectorAll<HTMLTableRowElement>('tr.parts-row'));
  const matchingRows = rows.filter((row) => (row.dataset.position ?? '') === position);

  rows.forEach((row) => row.classList.remove('is-active'));
  matchingRows.forEach((row) => row.classList.add('is-active'));

  if (options.scroll && matchingRows.length > 0) {
    matchingRows[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function selectSubgroup(view: SubgroupView): void {
  const groupLabel = groupLabelByCode.get(view.group) ?? `Unterseite ${view.subgroup}`;
  selectionTitle.textContent = `${groupLabel} · Unterseite ${view.subgroup}`;
  diagramOpenLink.href = view.sourceUrl;

  if (view.imageUrl) {
    diagramImage.src = view.imageUrl;
    diagramImage.alt = `Teilegrafik Gruppe ${view.group} Unterseite ${view.subgroup}`;
    diagramImage.style.display = 'block';
  } else {
    diagramImage.removeAttribute('src');
    diagramImage.alt = 'Keine Grafik verfügbar';
    diagramImage.style.display = 'none';
  }

  renderDiagramMap(view.entries);
  renderPartRows(view.entries);
  if (activePosition) {
    highlightPosition(activePosition, { scroll: false });
  }
  setStatus(`Fertig: Gruppe ${view.group}, Unterseite ${view.subgroup}, Teile ${view.entries.length}`);
}

function renderNavigation(subgroups: Map<string, SubgroupView>, groupMeta: Record<string, string>): void {
  const byGroup = new Map<string, SubgroupView[]>();
  for (const view of subgroups.values()) {
    const list = byGroup.get(view.group) ?? [];
    list.push(view);
    byGroup.set(view.group, list);
  }

  const sortedGroups = Array.from(byGroup.keys()).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

  groupList.innerHTML = sortedGroups
    .map((groupCode) => {
      const pages = (byGroup.get(groupCode) ?? []).sort((a, b) => a.subgroup.localeCompare(b.subgroup));
      const hasEntries = pages.some((page) => page.entries.length > 0);
      const label = normalizeGroupLabel(groupMeta[groupCode]);
      groupLabelByCode.set(groupCode, label);
      return `<button class="group-nav-btn${hasEntries ? '' : ' is-inactive'}" type="button" data-group="${escapeHtml(groupCode)}" ${hasEntries ? '' : 'disabled aria-disabled="true"'}>${escapeHtml(label)}</button>`;
    })
    .join('');

  groupList.querySelectorAll<HTMLButtonElement>('.group-nav-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const group = button.dataset.group ?? '';
      const pages = (byGroup.get(group) ?? []).sort((a, b) => a.subgroup.localeCompare(b.subgroup));
      const selected = pages[0];
      if (!selected) {
        return;
      }

      groupList.querySelectorAll<HTMLButtonElement>('.group-nav-btn').forEach((item) => {
        item.classList.remove('is-active');
      });
      button.classList.add('is-active');
      selectSubgroup(selected);
    });
  });

  const firstButton = groupList.querySelector<HTMLButtonElement>('.group-nav-btn:not(.is-inactive)');
  if (firstButton) {
    firstButton.click();
  }
}

async function loadGroupsPage(): Promise<void> {
  setStatus('Lade Gruppendaten...');

  const [diagramResponse, baseResponse, priceResponse] = await Promise.all([
    fetch('/data/parts-diagram-map.json'),
    fetch('/data/parts-base.json'),
    fetch('/data/parts-price.json'),
  ]);

  if (!diagramResponse.ok) {
    throw new Error(`parts-diagram-map.json nicht gefunden (${diagramResponse.status})`);
  }

  if (baseResponse.ok) {
    const baseData = (await baseResponse.json()) as BaseSnapshot;
    for (const item of baseData.items ?? []) {
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
  }

  if (priceResponse.ok) {
    const priceData = (await priceResponse.json()) as PriceSnapshot;
    for (const [partNumberRaw, value] of Object.entries(priceData.prices ?? {})) {
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
  }

  const data = (await diagramResponse.json()) as DiagramMap;
  const subgroups = buildSubgroupViews(data);
  renderNavigation(subgroups, data.groupMeta ?? {});
  setStatus(`Geladen: Gruppen ${data.stats.groups}, Unterseiten ${data.stats.subgroupPages}, Teile ${data.stats.uniquePartNumbers}`);
}

void loadGroupsPage().catch((error) => {
  setStatus(`Fehler: ${error instanceof Error ? error.message : 'Unbekannter Fehler'}`);
  partsBody.innerHTML = '<tr><td colspan="6" class="empty">Gruppenseite konnte nicht geladen werden</td></tr>';
  console.error('Groups page load failed', error);
});
