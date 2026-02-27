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

type PartsSnapshot = {
  prefixes: string[];
  limit: number;
  count: number;
  generatedAt: string;
  items: PartItem[];
};

type SortKey = 'partNumber' | 'price' | 'availability';
type SortDirection = 'asc' | 'desc';

const syncPrefixes = ['A309', 'A310'];
const pageSize = 50;

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
const inStockOnlyCheckbox = getRequiredElement<HTMLInputElement>('#in-stock-only');
const sortButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.sort-btn'));

let allItems: PartItem[] = [];
let currentPage = 1;
let sortKey: SortKey = 'partNumber';
let sortDirection: SortDirection = 'asc';
let inStockOnly = false;
let generatedAt = '';

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

function getVisibleItems(): PartItem[] {
  if (!inStockOnly) {
    return allItems;
  }
  return allItems.filter((item) => getAvailability(item).status === 'in_stock');
}

function getPageCount(): number {
  const visibleItems = getVisibleItems();
  if (visibleItems.length === 0) {
    return 0;
  }
  return Math.ceil(visibleItems.length / pageSize);
}

function updatePaginationControls(): void {
  const pageCount = getPageCount();
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
      const price = item.price?.trim() || 'N/A';
      const name = item.name?.trim() || 'N/A';
      const badgeClass = `badge badge-${availability.status}`;

      return `
        <tr>
          <td data-label="Artikelnummer">${escapeHtml(item.partNumber)}</td>
          <td data-label="Name">${escapeHtml(name)}</td>
          <td data-label="Preis">${escapeHtml(price)}</td>
          <td data-label="Verfügbarkeit"><span class="${badgeClass}">${escapeHtml(availability.label)}</span></td>
          <td data-label="Link"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Open</a></td>
        </tr>
      `;
    })
    .join('');
}

function renderCurrentPage(): void {
  const visibleItems = getVisibleItems();
  const pageCount = getPageCount();
  if (pageCount === 0) {
    renderTable([]);
    updatePaginationControls();
    return;
  }

  if (currentPage > pageCount) {
    currentPage = pageCount;
  }

  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  renderTable(visibleItems.slice(startIndex, endIndex));
  updatePaginationControls();
}

async function loadSnapshot(): Promise<PartsSnapshot> {
  const response = await fetch(`/data/parts.json?t=${Date.now()}`);
  if (!response.ok) {
    throw new Error(`Local snapshot not found (${response.status}). Run sync first.`);
  }
  return response.json() as Promise<PartsSnapshot>;
}

function applySnapshot(snapshot: PartsSnapshot): void {
  allItems = [...snapshot.items];
  generatedAt = snapshot.generatedAt;
  applySort(allItems);
  currentPage = 1;
  updateSortButtonLabels();
  renderCurrentPage();

  const visibleCount = getVisibleItems().length;
  const generatedLabel = generatedAt ? new Date(generatedAt).toLocaleString() : 'n/a';
  setStatus(`done: ${visibleCount}/${allItems.length} (sync: ${generatedLabel})`);
}

async function loadPartsFromLocal(): Promise<void> {
  setStatus('loading local snapshot...');
  try {
    const snapshot = await loadSnapshot();
    applySnapshot(snapshot);

    console.table(
      allItems.map((item) => {
        const availability = getAvailability(item);
        return {
          partNumber: item.partNumber,
          name: item.name,
          price: item.price ?? '',
          availability: availability.label,
          url: item.url,
        };
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    setStatus(`error: ${message}`);
    allItems = [];
    currentPage = 1;
    renderCurrentPage();
    console.error('Failed to load local snapshot', error);
  }
}

async function syncAndReload(): Promise<void> {
  setStatus('syncing...');
  syncButton.disabled = true;

  try {
    const prefixParam = encodeURIComponent(syncPrefixes.join('|'));
    const response = await fetch(`/api/sync?prefix=${prefixParam}&limit=all`, {
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error(`Sync failed (${response.status})`);
    }

    await loadPartsFromLocal();
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
  if (allItems.length > 0) {
    const visibleCount = getVisibleItems().length;
    const generatedLabel = generatedAt ? new Date(generatedAt).toLocaleString() : 'n/a';
    setStatus(`done: ${visibleCount}/${allItems.length} (sync: ${generatedLabel})`);
  }
});

updateSortButtonLabels();
void loadPartsFromLocal();
