import './style.css';

type AvailabilityStatus = 'in_stock' | 'out_of_stock' | 'unknown';

type Availability = {
  status: AvailabilityStatus;
  label: string;
};

type PartItem = {
  partNumber: string;
  name: string;
  price?: string;
  url: string;
  availability?: Availability;
};

type EnrichVisibleResponse = {
  ok: boolean;
  updated: number;
  entries: Record<
    string,
    {
      price?: string;
      availability?: Availability;
      updatedAt: string;
    }
  >;
};

type SyncBaseResponse = {
  ok: boolean;
  prefixes?: string[];
  count?: number;
  generatedAt?: string;
  items?: Array<Record<string, unknown>>;
};

type SyncPricesResponse = {
  ok: boolean;
  updated: number;
  pricedCount?: number;
  validatedCount?: number;
  missingCount?: number;
  nextCursor?: number;
  entries?: EnrichVisibleResponse['entries'];
};

type ChunkMeta = {
  id: number;
  file: string;
  count: number;
  firstPartNumber: string;
  lastPartNumber: string;
};

type ChunkManifest = {
  vehicleKey: string;
  generatedAt: string;
  source: string;
  chunkSizeLines: number;
  chunkCount: number;
  totalParts: number;
  chunks: ChunkMeta[];
};

type ChunkMap = {
  vehicleKey: string;
  generatedAt: string;
  byPartPrefix4: Record<string, number[]>;
  byNamePrefix3: Record<string, number[]>;
};

type SortKey = 'partNumber' | 'price' | 'availability';
type SortDirection = 'asc' | 'desc';

const allowedPartPrefixes: string[] = ['A309', 'A310'];
const syncPrefixes: string[] = [...allowedPartPrefixes];
const pageSize = 50;
const vehicleKey = 'default';
const chunksBasePath = `/data/vehicles/${vehicleKey}/index/chunks`;

function getRequiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Required DOM element not found: ${selector}`);
  }
  return element;
}

const tbody = getRequiredElement<HTMLTableSectionElement>('#parts-tbody');
const statusLine = getRequiredElement<HTMLParagraphElement>('#status');
const syncButton = getRequiredElement<HTMLButtonElement>('#reload-btn');
const inStockOnlyCheckbox = getRequiredElement<HTMLInputElement>('#in-stock-only');
const prevPageButton = getRequiredElement<HTMLButtonElement>('#prev-page-btn');
const nextPageButton = getRequiredElement<HTMLButtonElement>('#next-page-btn');
const pageInfo = getRequiredElement<HTMLParagraphElement>('#page-info');
const searchInput = getRequiredElement<HTMLInputElement>('#search-input');
const sortButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.sort-btn'));

let allItems: PartItem[] = [];
let initialChunkItems: PartItem[] = [];
let currentPage = 1;
let sortKey: SortKey = 'partNumber';
let sortDirection: SortDirection = 'asc';
let inStockOnly = false;
let searchQuery = '';

const inStockSyncBatchSize = 100;

const lazyLoadingPartNumbers = new Set<string>();
const lazyLoadedPartNumbers = new Set<string>();
const chunkCache = new Map<number, PartItem[]>();
let chunkManifestCache: ChunkManifest | null = null;
let chunkMapCache: ChunkMap | null = null;

function setStatus(text: string): void {
  statusLine.textContent = text;
}

function setInStockSyncButtonState(isLoading: boolean): void {
  if (isLoading) {
    inStockOnlyCheckbox.disabled = true;
    return;
  }

  inStockOnlyCheckbox.disabled = allItems.length === 0;
  inStockOnlyCheckbox.checked = inStockOnly;
}

function getAvailabilitySummary(items: PartItem[]): { inStock: number; outOfStock: number; unknown: number } {
  let inStock = 0;
  let outOfStock = 0;
  let unknown = 0;

  for (const item of items) {
    const status = getAvailability(item).status;
    if (status === 'in_stock') {
      inStock += 1;
      continue;
    }
    if (status === 'out_of_stock') {
      outOfStock += 1;
      continue;
    }
    unknown += 1;
  }

  return { inStock, outOfStock, unknown };
}

function getAvailability(item: PartItem): Availability {
  return item.availability ?? { status: 'unknown', label: 'Unknown' };
}

function getPriceValue(price: string | undefined): number {
  if (!price) {
    return Number.POSITIVE_INFINITY;
  }
  const normalized = price.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function normalizePriceLabel(price: string | undefined): string {
  if (!price) {
    return 'N/A';
  }
  return price.replaceAll('*', '').trim() || 'N/A';
}

function getAvailabilityRank(status: AvailabilityStatus): number {
  if (status === 'in_stock') {
    return 0;
  }
  if (status === 'unknown') {
    return 1;
  }
  return 2;
}

function applySort(items: PartItem[]): void {
  const directionFactor = sortDirection === 'asc' ? 1 : -1;
  items.sort((left, right) => {
    if (sortKey === 'partNumber') {
      return left.partNumber.localeCompare(right.partNumber) * directionFactor;
    }
    if (sortKey === 'price') {
      const priceDiff = getPriceValue(left.price) - getPriceValue(right.price);
      if (priceDiff !== 0) {
        return priceDiff * directionFactor;
      }
      return left.partNumber.localeCompare(right.partNumber);
    }

    const leftAvailability = getAvailability(left);
    const rightAvailability = getAvailability(right);
    const rankDiff =
      getAvailabilityRank(leftAvailability.status) - getAvailabilityRank(rightAvailability.status);
    if (rankDiff !== 0) {
      return rankDiff * directionFactor;
    }
    return left.partNumber.localeCompare(right.partNumber);
  });
}

function updateSortButtonLabels(): void {
  sortButtons.forEach((button) => {
    const buttonKey = button.dataset.sortKey as SortKey | undefined;
    if (!buttonKey) {
      return;
    }
    const baseLabel = button.textContent?.replace(/\s+[↑↓]$/, '') ?? '';
    if (buttonKey === sortKey) {
      button.textContent = `${baseLabel} ${sortDirection === 'asc' ? '↑' : '↓'}`;
      return;
    }
    button.textContent = baseLabel;
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeSearchValue(raw: string): string {
  return raw.trim().toLowerCase();
}

function isAllowedPartNumber(partNumber: string): boolean {
  return allowedPartPrefixes.some((prefix) => partNumber.startsWith(prefix));
}

function isExcludedPartNumber(partNumber: string): boolean {
  return /^A0{10,}$/.test(partNumber);
}

function matchesSearch(item: PartItem, query: string): boolean {
  const normalized = normalizeSearchValue(query);
  if (!normalized) {
    return true;
  }
  return (
    item.partNumber.toLowerCase().includes(normalized) ||
    item.name.toLowerCase().includes(normalized)
  );
}

function getVisibleItems(): PartItem[] {
  return allItems.filter((item) => {
    if (inStockOnly && getAvailability(item).status === 'out_of_stock') {
      return false;
    }
    return matchesSearch(item, searchQuery);
  });
}

function getPageCountForVisibleCount(visibleCount: number): number {
  if (visibleCount === 0) {
    return 0;
  }
  return Math.ceil(visibleCount / pageSize);
}

function getPageCount(): number {
  return getPageCountForVisibleCount(getVisibleItems().length);
}

function updatePaginationControls(pageCount: number): void {
  pageInfo.textContent = pageCount === 0 ? 'Seite 0 / 0' : `Seite ${currentPage} / ${pageCount}`;

  prevPageButton.disabled = pageCount === 0 || currentPage <= 1;
  nextPageButton.disabled = pageCount === 0 || currentPage >= pageCount;
}

function renderTable(items: PartItem[]): void {
  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Keine Treffer</td></tr>';
    return;
  }

  tbody.innerHTML = items
    .map((item) => {
      const availability = getAvailability(item);
      const isLazyLoading = lazyLoadingPartNumbers.has(item.partNumber);
      const price = normalizePriceLabel(item.price);
      const name = item.name?.trim() || 'N/A';
      const badgeClass = `badge badge-${availability.status}`;
      const priceCell = isLazyLoading
        ? '<span class="skeleton skeleton-text" aria-label="Loading price"></span>'
        : escapeHtml(price);
      const availabilityCell = isLazyLoading
        ? '<span class="skeleton skeleton-pill" aria-label="Loading availability"></span>'
        : `<span class="${badgeClass}">${escapeHtml(availability.label)}</span>`;
      const linkLabel = `${item.partNumber} in neuem Tab öffnen`;

      return `
        <tr>
          <td data-label="Artikelnummer">${escapeHtml(item.partNumber)}</td>
          <td data-label="Name">${escapeHtml(name)}</td>
          <td data-label="Preis">${priceCell}</td>
          <td data-label="Verfügbarkeit">${availabilityCell}</td>
          <td data-label="Link"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" aria-label="${escapeHtml(linkLabel)}" title="${escapeHtml(linkLabel)}">Prüfen</a></td>
        </tr>
      `;
    })
    .join('');
}

function shouldLazyEnrich(item: PartItem): boolean {
  const availability = getAvailability(item);
  return !item.price || availability.status === 'unknown';
}

async function lazyEnrichVisibleItems(items: PartItem[]): Promise<void> {
  const candidates = items.filter(
    (item) =>
      shouldLazyEnrich(item) &&
      !lazyLoadingPartNumbers.has(item.partNumber) &&
      !lazyLoadedPartNumbers.has(item.partNumber),
  );

  if (candidates.length === 0) {
    return;
  }

  const partNumbers = candidates.map((item) => item.partNumber);
  partNumbers.forEach((partNumber) => lazyLoadingPartNumbers.add(partNumber));
  renderCurrentPage({ triggerLazy: false });

  try {
    const response = await fetch('/api/enrich-visible', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partNumbers }),
    });
    if (!response.ok) {
      throw new Error(`Lazy enrich failed (${response.status})`);
    }

    const payload = (await response.json()) as EnrichVisibleResponse;
    for (const item of allItems) {
      const entry = payload.entries[item.partNumber];
      if (!entry) {
        continue;
      }
      if (entry.price) {
        item.price = entry.price;
      }
      if (entry.availability) {
        item.availability = entry.availability;
      }
    }

    if (sortKey === 'price' || sortKey === 'availability') {
      applySort(allItems);
    }
  } catch (error) {
    console.error('Lazy enrichment failed', error);
  } finally {
    partNumbers.forEach((partNumber) => {
      lazyLoadingPartNumbers.delete(partNumber);
      lazyLoadedPartNumbers.add(partNumber);
    });
    renderCurrentPage({ triggerLazy: false });
  }
}

function renderCurrentPage(options: { triggerLazy?: boolean } = {}): void {
  const { triggerLazy = true } = options;
  const visibleItems = getVisibleItems();
  const pageCount = getPageCountForVisibleCount(visibleItems.length);
  if (pageCount === 0) {
    renderTable([]);
    updatePaginationControls(0);
    return;
  }

  if (currentPage > pageCount) {
    currentPage = pageCount;
  }

  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const pageItems = visibleItems.slice(startIndex, endIndex);
  renderTable(pageItems);
  updatePaginationControls(pageCount);

  if (triggerLazy) {
    void lazyEnrichVisibleItems(pageItems);
  }
}

function clearResultState(): void {
  allItems = [];
  currentPage = 1;
  lazyLoadingPartNumbers.clear();
  lazyLoadedPartNumbers.clear();
  setInStockSyncButtonState(false);
  renderCurrentPage({ triggerLazy: false });
}

function applyResultItems(items: PartItem[]): void {
  allItems = [...items];
  lazyLoadingPartNumbers.clear();
  lazyLoadedPartNumbers.clear();
  applySort(allItems);
  currentPage = 1;
  updateSortButtonLabels();
  setInStockSyncButtonState(false);
  renderCurrentPage();
}

function showInitialChunkResults(statusPrefix = 'fertig'): void {
  applyResultItems(initialChunkItems);
  const visibleCount = getVisibleItems().length;
  setStatus(`${statusPrefix}: ${visibleCount}/${allItems.length} (${allowedPartPrefixes.join('|')})`);
  console.log(
    `[MB Parts] loaded ${allItems.length} items (${allowedPartPrefixes.join('|')})`,
  );
  console.table(
    allItems.map((item) => ({
      partNumber: item.partNumber,
      name: item.name,
      price: item.price ?? 'N/A',
      availability: getAvailability(item).label,
      url: item.url,
    })),
  );
}

function normalizePartRecord(parsed: Record<string, unknown>): PartItem | null {
  const partNumber = String(parsed.partNumber ?? '').toUpperCase();
  if (!partNumber) {
    return null;
  }
  if (!isAllowedPartNumber(partNumber)) {
    return null;
  }
  if (isExcludedPartNumber(partNumber)) {
    return null;
  }

  const availabilityFromRoot = parsed.availability as Availability | undefined;
  const enrichment = parsed.enrichment as Record<string, unknown> | undefined;
  const availabilityFromEnrichment = enrichment?.availability as Availability | undefined;
  const availability = availabilityFromRoot ?? availabilityFromEnrichment ?? { status: 'unknown', label: 'Unknown' };
  const enrichmentPrice = enrichment?.price;
  const normalizedEnrichmentPrice = typeof enrichmentPrice === 'string' ? enrichmentPrice : undefined;

  return {
    partNumber,
    name: String(parsed.name ?? ''),
    price: typeof parsed.price === 'string' ? parsed.price : normalizedEnrichmentPrice,
    url: String(parsed.url ?? ''),
    availability,
  };
}

function applyEnrichmentEntries(entries: EnrichVisibleResponse['entries'] | undefined): void {
  if (!entries) {
    return;
  }

  const mergeAvailability = (current: Availability, incoming?: Availability): Availability => {
    if (!incoming) {
      return current;
    }
    if (incoming.status === 'unknown' && current.status !== 'unknown') {
      return current;
    }
    return incoming;
  };

  const applyTo = (items: PartItem[]) => {
    for (const item of items) {
      const entry = entries[item.partNumber];
      if (!entry) {
        continue;
      }
      if (entry.price) {
        item.price = entry.price;
      }
      item.availability = mergeAvailability(getAvailability(item), entry.availability);
    }
  };

  applyTo(allItems);
  applyTo(initialChunkItems);
}

async function validateUnknownAvailability(): Promise<number> {
  const unknownPartNumbers = Array.from(
    new Set(
      allItems
        .filter((item) => getAvailability(item).status === 'unknown')
        .map((item) => item.partNumber),
    ),
  );
  const total = unknownPartNumbers.length;
  if (total === 0) {
    return 0;
  }

  let processed = 0;
  let validatedTotal = 0;

  for (let i = 0; i < unknownPartNumbers.length; i += inStockSyncBatchSize) {
    const batchPartNumbers = unknownPartNumbers.slice(i, i + inStockSyncBatchSize);
    const response = await fetch(`/api/sync-prices?batch=${batchPartNumbers.length}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partNumbers: batchPartNumbers }),
    });
    if (!response.ok) {
      throw new Error(`Availability sync failed (${response.status})`);
    }

    const payload = (await response.json()) as SyncPricesResponse;
    applyEnrichmentEntries(payload.entries);
    validatedTotal += payload.validatedCount ?? batchPartNumbers.length;
    processed += batchPartNumbers.length;

    if (sortKey === 'availability' || sortKey === 'price') {
      applySort(allItems);
    }
    renderCurrentPage({ triggerLazy: false });
    setStatus(`Verfügbarkeit wird geprüft... ${processed}/${total}`);
  }

  return validatedTotal;
}

async function loadChunkArtifacts(): Promise<{ manifest: ChunkManifest; map: ChunkMap }> {
  if (chunkManifestCache && chunkMapCache) {
    return { manifest: chunkManifestCache, map: chunkMapCache };
  }

  const [manifestResponse, mapResponse] = await Promise.all([
    fetch(`${chunksBasePath}/manifest.json?t=${Date.now()}`),
    fetch(`${chunksBasePath}/chunk-map.json?t=${Date.now()}`),
  ]);

  if (!manifestResponse.ok) {
    throw new Error(`Missing manifest.json (${manifestResponse.status}). Run chunk:index first.`);
  }
  if (!mapResponse.ok) {
    throw new Error(`Missing chunk-map.json (${mapResponse.status}). Run chunk:index first.`);
  }

  chunkManifestCache = (await manifestResponse.json()) as ChunkManifest;
  chunkMapCache = (await mapResponse.json()) as ChunkMap;
  return { manifest: chunkManifestCache, map: chunkMapCache };
}

function getCatalogChunkIds(manifest: ChunkManifest, map: ChunkMap): number[] {
  const ids = new Set<number>();
  for (const prefix of allowedPartPrefixes) {
    for (const chunkId of map.byPartPrefix4[prefix] ?? []) {
      ids.add(chunkId);
    }
  }

  if (ids.size === 0) {
    return [];
  }

  const knownChunkIds = new Set(manifest.chunks.map((chunk) => chunk.id));
  return Array.from(ids)
    .filter((chunkId) => knownChunkIds.has(chunkId))
    .sort((left, right) => left - right);
}

function parseChunkLine(line: string): PartItem | null {
  if (!line.trim()) {
    return null;
  }

  const parsed = JSON.parse(line) as Record<string, unknown>;
  return normalizePartRecord(parsed);
}

async function loadChunkById(chunkId: number, manifest: ChunkManifest): Promise<PartItem[]> {
  const cached = chunkCache.get(chunkId);
  if (cached) {
    return cached;
  }

  const chunkMeta = manifest.chunks.find((chunk) => chunk.id === chunkId);
  if (!chunkMeta) {
    return [];
  }

  const response = await fetch(`${chunksBasePath}/${chunkMeta.file}`);
  if (!response.ok) {
    throw new Error(`Failed to load chunk ${chunkMeta.file} (${response.status})`);
  }

  const text = await response.text();
  const records = text
    .split(/\r?\n/)
    .map((line) => parseChunkLine(line))
    .filter((item): item is PartItem => Boolean(item));

  chunkCache.set(chunkId, records);
  return records;
}

async function loadInitialChunk(): Promise<void> {
  setStatus(`Katalog wird geladen (${allowedPartPrefixes.join('|')})...`);

  try {
    const { manifest, map } = await loadChunkArtifacts();
    const chunkIds = getCatalogChunkIds(manifest, map);
    if (chunkIds.length === 0) {
      initialChunkItems = [];
      clearResultState();
      setStatus(`Keine Chunks für ${allowedPartPrefixes.join('|')} gefunden`);
      return;
    }

    const chunkResults = await Promise.all(chunkIds.map((chunkId) => loadChunkById(chunkId, manifest)));
    const mergedByPartNumber = new Map<string, PartItem>();
    for (const records of chunkResults) {
      for (const item of records) {
        if (!mergedByPartNumber.has(item.partNumber)) {
          mergedByPartNumber.set(item.partNumber, item);
        }
      }
    }

    initialChunkItems = Array.from(mergedByPartNumber.values());
    showInitialChunkResults('done');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    clearResultState();
    setStatus(`Fehler: ${message}`);
    console.error('Catalog load failed', error);
  }
}

async function syncAndReload(): Promise<void> {
  setStatus('Basisdaten werden live synchronisiert...');
  syncButton.disabled = true;
  setInStockSyncButtonState(true);

  try {
    const prefixParam = syncPrefixes.length > 0 ? `prefix=${encodeURIComponent(syncPrefixes.join('|'))}&` : '';
    let baseResponse: Response;
    try {
      baseResponse = await fetch(`/api/sync?${prefixParam}limit=all`, {
        method: 'POST',
      });
    } catch {
      setStatus('Live-Sync nicht erreichbar, lokaler Katalog wird geladen...');
      await loadInitialChunk();
      return;
    }
    if (baseResponse.status === 404) {
      setStatus('Live-Sync nicht verfügbar, lokaler Katalog wird geladen...');
      await loadInitialChunk();
      return;
    }
    if (!baseResponse.ok) {
      throw new Error(`Base sync failed (${baseResponse.status})`);
    }

    const basePayload = (await baseResponse.json()) as SyncBaseResponse;
    const syncItemsRaw = Array.isArray(basePayload.items) ? basePayload.items : [];
    const syncItems = syncItemsRaw
      .map((item) => normalizePartRecord(item))
      .filter((item): item is PartItem => Boolean(item));

    if (syncItems.length === 0) {
      setStatus('Sync abgeschlossen. Für einen frischen Suchindex bitte chunk:index erneut ausführen.');
      chunkCache.clear();
      chunkManifestCache = null;
      chunkMapCache = null;
      initialChunkItems = [];
      await loadInitialChunk();
      return;
    }

    initialChunkItems = syncItems;
    applyResultItems(initialChunkItems);
    setStatus(`Details werden live synchronisiert... 0/${allItems.length}`);

    const allPartNumbers = allItems.map((item) => item.partNumber);
    const total = allPartNumbers.length;
    let processed = 0;
    let validatedTotal = 0;

    for (let i = 0; i < allPartNumbers.length; i += inStockSyncBatchSize) {
      const batchPartNumbers = allPartNumbers.slice(i, i + inStockSyncBatchSize);
      const response = await fetch(`/api/sync-prices?batch=${batchPartNumbers.length}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partNumbers: batchPartNumbers }),
      });
      if (!response.ok) {
        throw new Error(`Details sync failed (${response.status})`);
      }

      const payload = (await response.json()) as SyncPricesResponse;
      applyEnrichmentEntries(payload.entries);
      validatedTotal += payload.validatedCount ?? batchPartNumbers.length;
      processed += batchPartNumbers.length;

      if (sortKey === 'availability' || sortKey === 'price') {
        applySort(allItems);
      }
      renderCurrentPage({ triggerLazy: false });
      setStatus(`Details werden live synchronisiert... ${processed}/${total}`);
    }

    if (sortKey === 'availability' || sortKey === 'price') {
      applySort(allItems);
    }
    renderCurrentPage({ triggerLazy: false });

    const visibleCount = getVisibleItems().length;
    const summary = getAvailabilitySummary(allItems);
    setStatus(
      `Sync abgeschlossen: ${visibleCount}/${allItems.length} (lieferbar:${summary.inStock} ausverkauft:${summary.outOfStock} unbekannt:${summary.unknown}, geprüft ${validatedTotal})`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    setStatus(`Fehler: ${message}`);
    console.error('Sync failed', error);
  } finally {
    syncButton.disabled = false;
    setInStockSyncButtonState(false);
  }
}

syncButton.addEventListener('click', () => {
  void syncAndReload();
});

inStockOnlyCheckbox.addEventListener('change', async () => {
  inStockOnly = inStockOnlyCheckbox.checked;
  currentPage = 1;
  if (inStockOnly) {
    setInStockSyncButtonState(true);
    try {
      await validateUnknownAvailability();
      renderCurrentPage();
      const visibleCount = getVisibleItems().length;
      const summary = getAvailabilitySummary(allItems);
      setStatus(
        `Fertig: ${visibleCount}/${allItems.length} (lieferbar:${summary.inStock} ausverkauft:${summary.outOfStock} unbekannt:${summary.unknown}, Filter blendet nur ausverkauft aus)`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
      setStatus(`Fehler: ${message}`);
      console.error('Availability validation failed', error);
    } finally {
      setInStockSyncButtonState(false);
    }
    return;
  }

  renderCurrentPage();
  setInStockSyncButtonState(false);
  if (allItems.length > 0) {
    const visibleCount = getVisibleItems().length;
    setStatus(`Fertig: ${visibleCount}/${allItems.length}`);
  }
});

prevPageButton.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage -= 1;
    renderCurrentPage();
  }
});

nextPageButton.addEventListener('click', () => {
  const pageCount = getPageCount();
  if (currentPage < pageCount) {
    currentPage += 1;
    renderCurrentPage();
  }
});

sortButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const selectedKey = button.dataset.sortKey as SortKey | undefined;
    if (!selectedKey) {
      return;
    }

    if (sortKey === selectedKey) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = selectedKey;
      sortDirection = 'asc';
    }

    applySort(allItems);
    currentPage = 1;
    updateSortButtonLabels();
    renderCurrentPage();
  });
});

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  currentPage = 1;
  renderCurrentPage();
  if (allItems.length > 0) {
    const visibleCount = getVisibleItems().length;
    setStatus(`Fertig: ${visibleCount}/${allItems.length}`);
  }
});

updateSortButtonLabels();
renderCurrentPage({ triggerLazy: false });
setInStockSyncButtonState(false);
void syncAndReload();
