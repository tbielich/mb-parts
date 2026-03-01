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
const prevPageButton = getRequiredElement<HTMLButtonElement>('#prev-page-btn');
const nextPageButton = getRequiredElement<HTMLButtonElement>('#next-page-btn');
const pageInfo = getRequiredElement<HTMLParagraphElement>('#page-info');
const searchInput = getRequiredElement<HTMLInputElement>('#search-input');
const inStockOnlyCheckbox = getRequiredElement<HTMLInputElement>('#in-stock-only');
const sortButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.sort-btn'));

let allItems: PartItem[] = [];
let initialChunkItems: PartItem[] = [];
let currentPage = 1;
let sortKey: SortKey = 'partNumber';
let sortDirection: SortDirection = 'asc';
let inStockOnly = false;
let searchQuery = '';

const lazyLoadingPartNumbers = new Set<string>();
const lazyLoadedPartNumbers = new Set<string>();
const chunkCache = new Map<number, PartItem[]>();
let chunkManifestCache: ChunkManifest | null = null;
let chunkMapCache: ChunkMap | null = null;

function setStatus(text: string): void {
  statusLine.textContent = text;
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
    if (inStockOnly && getAvailability(item).status !== 'in_stock') {
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
  pageInfo.textContent = pageCount === 0 ? 'Page 0 / 0' : `Page ${currentPage} / ${pageCount}`;

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
      const price = item.price?.trim() || 'N/A';
      const name = item.name?.trim() || 'N/A';
      const badgeClass = `badge badge-${availability.status}`;
      const priceCell = isLazyLoading
        ? '<span class="skeleton skeleton-text" aria-label="Loading price"></span>'
        : escapeHtml(price);
      const availabilityCell = isLazyLoading
        ? '<span class="skeleton skeleton-pill" aria-label="Loading availability"></span>'
        : `<span class="${badgeClass}">${escapeHtml(availability.label)}</span>`;

      return `
        <tr>
          <td data-label="Artikelnummer">${escapeHtml(item.partNumber)}</td>
          <td data-label="Name">${escapeHtml(name)}</td>
          <td data-label="Preis">${priceCell}</td>
          <td data-label="Verfügbarkeit">${availabilityCell}</td>
          <td data-label="Link"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Open</a></td>
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
  renderCurrentPage({ triggerLazy: false });
}

function applyResultItems(items: PartItem[]): void {
  allItems = [...items];
  lazyLoadingPartNumbers.clear();
  lazyLoadedPartNumbers.clear();
  applySort(allItems);
  currentPage = 1;
  updateSortButtonLabels();
  renderCurrentPage();
}

function showInitialChunkResults(statusPrefix = 'done'): void {
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
  setStatus(`loading catalog (${allowedPartPrefixes.join('|')})...`);

  try {
    const { manifest, map } = await loadChunkArtifacts();
    const chunkIds = getCatalogChunkIds(manifest, map);
    if (chunkIds.length === 0) {
      initialChunkItems = [];
      clearResultState();
      setStatus(`No chunks found for ${allowedPartPrefixes.join('|')}`);
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
    const message = error instanceof Error ? error.message : 'Unknown error';
    clearResultState();
    setStatus(`error: ${message}`);
    console.error('Catalog load failed', error);
  }
}

async function syncAndReload(): Promise<void> {
  setStatus('syncing base...');
  syncButton.disabled = true;

  try {
    const prefixParam = syncPrefixes.length > 0 ? `prefix=${encodeURIComponent(syncPrefixes.join('|'))}&` : '';
    const baseResponse = await fetch(`/api/sync?${prefixParam}limit=all`, {
      method: 'POST',
    });
    if (!baseResponse.ok) {
      throw new Error(`Base sync failed (${baseResponse.status})`);
    }

    setStatus('syncing prices...');
    const priceResponse = await fetch('/api/sync-prices?batch=500', {
      method: 'POST',
    });
    if (!priceResponse.ok) {
      throw new Error(`Price sync failed (${priceResponse.status})`);
    }

    setStatus('sync done. Re-run chunk:index for fresh search index.');
    chunkCache.clear();
    chunkManifestCache = null;
    chunkMapCache = null;
    initialChunkItems = [];
    await loadInitialChunk();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    setStatus(`error: ${message}`);
    console.error('Sync failed', error);
  } finally {
    syncButton.disabled = false;
  }
}

syncButton.addEventListener('click', () => {
  void syncAndReload();
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

inStockOnlyCheckbox.addEventListener('change', () => {
  inStockOnly = inStockOnlyCheckbox.checked;
  currentPage = 1;
  renderCurrentPage();
  const visibleCount = getVisibleItems().length;
  if (allItems.length > 0) {
    setStatus(`done: ${visibleCount}/${allItems.length}`);
  }
});

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  currentPage = 1;
  renderCurrentPage();
  if (allItems.length > 0) {
    const visibleCount = getVisibleItems().length;
    setStatus(`done: ${visibleCount}/${allItems.length}`);
  }
});

updateSortButtonLabels();
renderCurrentPage({ triggerLazy: false });
void loadInitialChunk();
