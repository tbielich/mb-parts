type Area = {
  position: string;
  href: string;
  shape: string;
  coords: string;
  label: string;
};

type Row = {
  position: string;
  positionKey: string;
  rowId: string;
  partNumber: string;
  displayName: string;
  price: string;
  availabilityStatus: 'in_stock' | 'out_of_stock' | 'unknown';
  availabilityLabel: string;
  hasOriginalLink: boolean;
  preferredUrl: string;
  partLabel: string;
  noOriginalLabel: string;
};

type GroupView = {
  group: string;
  subgroup: string;
  groupLabel: string;
  sourceUrl: string;
  imagePrimary: string;
  imageFallback: string;
  imageAlt: string;
  rows: Row[];
  areas: Area[];
  entryCount: number;
};

type GroupEntry = {
  code: string;
  label: string;
  href: string;
  hasEntries: boolean;
  view: GroupView;
};

type GroupsPageData = {
  initialGroupCode: string;
  groups: GroupEntry[];
};

function getRequiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Required DOM element not found: ${selector}`);
  }
  return element;
}

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseGroupsPageData(): GroupsPageData {
  const element = getRequiredElement<HTMLScriptElement>('#groups-page-data');
  const content = element.textContent?.trim();
  if (!content) {
    throw new Error('Missing groups page data');
  }

  return JSON.parse(content) as GroupsPageData;
}

const statusLine = getRequiredElement<HTMLParagraphElement>('#groups-status');
const groupList = getRequiredElement<HTMLDivElement>('#group-list');
const selectionTitle = getRequiredElement<HTMLHeadingElement>('#selection-title');
const diagramImage = getRequiredElement<HTMLImageElement>('#diagram-image');
const diagramMap = getRequiredElement<HTMLMapElement>('#diagram-map');
const diagramOpenLink = getRequiredElement<HTMLAnchorElement>('#diagram-open-link');
const partsBody = getRequiredElement<HTMLTableSectionElement>('#diagram-parts-body');
const pageData = parseGroupsPageData();
const groupsByCode = new Map(pageData.groups.filter((group) => group.hasEntries).map((group) => [group.code, group]));

let activePosition = '';
let activeGroupCode = pageData.initialGroupCode;

function setStatus(text: string): void {
  statusLine.textContent = text;
}

function bindImageFallback(): void {
  const fallbackSrc = diagramImage.dataset.fallbackSrc ?? '';
  if (!diagramImage.getAttribute('src') || !fallbackSrc) {
    diagramImage.onerror = null;
    return;
  }

  diagramImage.onerror = () => {
    diagramImage.onerror = null;
    diagramImage.src = fallbackSrc;
  };
}

function renderPartRows(rows: Row[]): void {
  if (rows.length === 0) {
    partsBody.innerHTML = '<tr><td colspan="6" class="empty">Keine Teile in dieser Unterseite gefunden</td></tr>';
    return;
  }

  partsBody.innerHTML = rows
    .map((row) => {
      const linkCell = row.hasOriginalLink
        ? `<a href="${escapeHtml(row.preferredUrl)}" target="_blank" rel="noopener" aria-label="${escapeHtml(row.partLabel)}" title="${escapeHtml(row.partLabel)}">Prüfen</a>`
        : `<span class="no-original">${escapeHtml(row.noOriginalLabel)}</span>`;

      return `
        <tr class="parts-row" ${row.rowId ? `id="${escapeHtml(row.rowId)}"` : ''} data-position="${escapeHtml(row.positionKey)}">
          <td>${escapeHtml(row.position)}</td>
          <td>${escapeHtml(row.partNumber)}</td>
          <td>${escapeHtml(row.displayName)}</td>
          <td>${escapeHtml(row.price)}</td>
          <td><span class="badge badge-${escapeHtml(row.availabilityStatus)}">${escapeHtml(row.availabilityLabel)}</span></td>
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

function renderDiagramMap(areas: Area[]): void {
  diagramMap.innerHTML = areas
    .map(
      (area) => `<area
        shape="${escapeHtml(area.shape)}"
        coords="${escapeHtml(area.coords)}"
        href="${escapeHtml(area.href)}"
        data-position="${escapeHtml(area.position)}"
        alt="${escapeHtml(area.position)}"
        title="${escapeHtml(area.label)}"
        aria-label="${escapeHtml(area.label)}"
      >`,
    )
    .join('');

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

function updateActiveNav(groupCode: string): void {
  groupList.querySelectorAll<HTMLAnchorElement>('.group-nav-link[data-group]').forEach((item) => {
    const isActive = (item.dataset.group ?? '') === groupCode;
    item.classList.toggle('is-active', isActive);
    if (isActive) {
      item.setAttribute('aria-current', 'page');
    } else {
      item.removeAttribute('aria-current');
    }
  });
}

function selectGroup(groupCode: string): boolean {
  const group = groupsByCode.get(groupCode);
  if (!group) {
    return false;
  }

  const view = group.view;
  activeGroupCode = groupCode;
  updateActiveNav(groupCode);

  selectionTitle.textContent = view.groupLabel;
  diagramOpenLink.href = view.sourceUrl;

  if (view.imagePrimary) {
    diagramImage.dataset.fallbackSrc = view.imageFallback;
    diagramImage.src = view.imagePrimary;
    diagramImage.alt = view.imageAlt;
    diagramImage.style.display = 'block';
    bindImageFallback();
  } else {
    delete diagramImage.dataset.fallbackSrc;
    diagramImage.removeAttribute('src');
    diagramImage.alt = 'Keine Grafik verfügbar';
    diagramImage.style.display = 'none';
    diagramImage.onerror = null;
  }

  renderDiagramMap(view.areas);
  renderPartRows(view.rows);
  if (activePosition) {
    highlightPosition(activePosition, { scroll: false });
  }
  setStatus(`Fertig: Gruppe ${view.group}, Teile ${view.entryCount}`);
  return true;
}

function buildGroupHash(groupCode: string): string {
  return `#group-${encodeURIComponent(groupCode)}`;
}

function readGroupFromHash(hash: string): string {
  const prefix = '#group-';
  if (!hash.startsWith(prefix)) {
    return '';
  }

  try {
    return decodeURIComponent(hash.slice(prefix.length));
  } catch {
    return '';
  }
}

function applyHashSelection(): void {
  const groupFromHash = readGroupFromHash(window.location.hash);
  if (groupFromHash && selectGroup(groupFromHash)) {
    return;
  }

  if (activeGroupCode && selectGroup(activeGroupCode)) {
    if (!window.location.hash) {
      window.history.replaceState(null, '', buildGroupHash(activeGroupCode));
    }
    return;
  }

  const firstAvailable = pageData.groups.find((group) => group.hasEntries)?.code ?? '';
  if (!firstAvailable || !selectGroup(firstAvailable)) {
    return;
  }

  window.history.replaceState(null, '', buildGroupHash(firstAvailable));
}

bindImageFallback();
partsBody.querySelectorAll<HTMLTableRowElement>('tr.parts-row').forEach((row) => {
  row.addEventListener('click', () => {
    const pos = row.dataset.position ?? '';
    if (!pos) {
      return;
    }
    highlightPosition(pos, { scroll: false });
  });
});
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
window.addEventListener('hashchange', applyHashSelection);
applyHashSelection();
