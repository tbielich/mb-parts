import * as cheerio from 'cheerio';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const BASE_URL = 'https://mb-teilekatalog.info';
const OUTPUT_PATH = resolve(process.cwd(), 'public/data/parts-diagram-map.json');
const DIAGRAMS_OUTPUT_DIR = resolve(process.cwd(), 'public/data/diagrams');

function parseArgs(argv) {
  const args = {
    lang: 'G',
    mode: 'BM',
    class: '3',
    aggtyp: 'FH',
    catalog: '339',
    model: '310500',
    spmno: '0',
    group: '0',
    output: OUTPUT_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      continue;
    }
    if (key in args) {
      args[key] = next;
      i += 1;
    }
  }

  return args;
}

function buildUrl(pathname, params) {
  const url = new URL(pathname, BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'mb-parts-diagram-importer/1.0',
      Accept: 'text/html',
      'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} (${response.status})`);
  }

  return response.text();
}

async function downloadBinary(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'mb-parts-diagram-importer/1.0',
      Accept: 'image/*,*/*;q=0.8',
      Referer: BASE_URL,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${url} (${response.status})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizePartNumber(value) {
  return normalizeText(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function extractGroupIds(groupHtml) {
  const $ = cheerio.load(groupHtml);
  const ids = new Set();

  $('a[href*="view_GroupAction.php"][href*="group="]').each((_, node) => {
    const href = $(node).attr('href') ?? '';
    const match = href.match(/(?:\?|&)group=(\d{1,3})(?:&|$)/);
    if (match?.[1]) {
      ids.add(match[1]);
    }
  });

  return Array.from(ids).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
}

function extractGroupMeta(groupHtml) {
  const $ = cheerio.load(groupHtml);
  const groupMeta = {};

  $('a.btn.btn-default.btn-sm.btn-block[href*="view_GroupAction.php"][href*="group="]').each((_, node) => {
    const href = $(node).attr('href') ?? '';
    const match = href.match(/(?:\?|&)group=(\d{1,3})(?:&|$)/);
    const groupId = match?.[1];
    if (!groupId) {
      return;
    }

    const label = normalizeText($(node).text());
    if (!label) {
      return;
    }
    groupMeta[groupId] = label;
  });

  return groupMeta;
}

function extractSubgroupIds(groupHtml) {
  const $ = cheerio.load(groupHtml);
  const ids = new Set();

  $('a[href*="view_SubGroupAction.php"][href*="subgrp="]').each((_, node) => {
    const href = $(node).attr('href') ?? '';
    const match = href.match(/(?:\?|&)subgrp=(\d{3})(?:&|$)/);
    if (match?.[1]) {
      ids.add(match[1]);
    }
  });

  return Array.from(ids).sort();
}

function extractDiagramData(subgroupHtml) {
  const $ = cheerio.load(subgroupHtml);
  const imageSrc =
    $('img[src*="/images/Imgs/BM_IMAGES_ARC/"]').first().attr('src') ??
    $('img[src*="BM_IMAGES_ARC"]').first().attr('src') ??
    '';
  const imageUrl = imageSrc ? new URL(imageSrc, BASE_URL).toString() : undefined;

  const areasByPosition = new Map();
  $('area').each((_, node) => {
    const href = normalizeText($(node).attr('href'));
    const title = normalizeText($(node).attr('title'));
    const alt = normalizeText($(node).attr('alt'));
    const coords = normalizeText($(node).attr('coords'));
    const shape = normalizeText($(node).attr('shape'));

    const position = (href.startsWith('#') ? href.slice(1) : '') || title || alt;
    if (!position) {
      return;
    }

    areasByPosition.set(position, {
      position,
      coords: coords || undefined,
      shape: shape || undefined,
    });
  });

  const items = [];
  $('table.table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) {
      return;
    }

    const rawPosition = normalizeText($(cells[0]).text());
    const rawPartText = normalizeText($(cells[1]).text());
    const partMatch = rawPartText.match(/[A-Z][0-9\s]{10,20}/i);
    if (!partMatch) {
      return;
    }

    const partNumber = normalizePartNumber(partMatch[0]);
    if (!partNumber) {
      return;
    }

    const description = normalizeText($(cells[2]).text()) || undefined;
    const quantity = normalizeText($(cells[3]).text()) || undefined;
    const version = normalizeText($(cells[4]).text()) || undefined;

    let position = rawPosition;
    if (!position) {
      const anchor = normalizeText($(cells[0]).find('a').attr('name'));
      if (anchor) {
        position = anchor;
      }
    }

    const area = position ? areasByPosition.get(position) : undefined;

    items.push({
      partNumber,
      position: position || undefined,
      description,
      quantity,
      version,
      imageUrl,
      coords: area?.coords,
      shape: area?.shape,
    });
  });

  return {
    imageUrl,
    areaCount: areasByPosition.size,
    items,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const baseParams = {
    lang: args.lang,
    mode: args.mode,
    class: args.class,
    aggtyp: args.aggtyp,
    catalog: args.catalog,
    model: args.model,
    spmno: args.spmno,
  };

  const rootGroupUrl = buildUrl('/view_GroupAction.php', {
    ...baseParams,
    group: args.group,
  });

  console.log(`[diagram-import] loading groups from ${rootGroupUrl}`);
  const rootHtml = await fetchHtml(rootGroupUrl);
  const groupIds = extractGroupIds(rootHtml);
  const groupMeta = extractGroupMeta(rootHtml);
  console.log(`[diagram-import] groups found: ${groupIds.length}`);

  await mkdir(DIAGRAMS_OUTPUT_DIR, { recursive: true });
  const localImagePathByRemoteUrl = new Map();

  const mappingsByPartNumber = {};
  const subgroupPages = [];
  let totalRows = 0;
  let totalMappedRows = 0;
  let totalAreaCount = 0;
  let totalImages = 0;

  for (const groupId of groupIds) {
    const groupUrl = buildUrl('/view_GroupAction.php', {
      ...baseParams,
      group: groupId,
    });

    const groupHtml = await fetchHtml(groupUrl);
    let subgroups = extractSubgroupIds(groupHtml);
    if (subgroups.length === 0) {
      subgroups = ['001'];
    }

    console.log(`[diagram-import] group ${groupId}: subgroups=${subgroups.length}`);

    for (const subgroupId of subgroups) {
      const subgroupUrl = buildUrl('/view_SubGroupAction.php', {
        ...baseParams,
        group: groupId,
        subgrp: subgroupId,
      });
      subgroupPages.push({ group: groupId, subgroup: subgroupId, url: subgroupUrl });

      const subgroupHtml = await fetchHtml(subgroupUrl);
      const diagram = extractDiagramData(subgroupHtml);
      let localImageUrl;

      if (diagram.imageUrl) {
        const cached = localImagePathByRemoteUrl.get(diagram.imageUrl);
        if (cached) {
          localImageUrl = cached;
        } else {
          const urlObj = new URL(diagram.imageUrl);
          const fileName = urlObj.pathname.split('/').pop() ?? `${groupId}-${subgroupId}.png`;
          const targetPath = resolve(DIAGRAMS_OUTPUT_DIR, fileName);
          const binary = await downloadBinary(diagram.imageUrl);

          let shouldWrite = true;
          try {
            const existing = await readFile(targetPath);
            if (Buffer.compare(existing, binary) === 0) {
              shouldWrite = false;
            }
          } catch {
            // file does not exist yet
          }

          if (shouldWrite) {
            await writeFile(targetPath, binary);
          }

          localImageUrl = `/data/diagrams/${fileName}`;
          localImagePathByRemoteUrl.set(diagram.imageUrl, localImageUrl);
        }
      }

      if (diagram.imageUrl) {
        totalImages += 1;
      }
      totalAreaCount += diagram.areaCount;
      totalRows += diagram.items.length;

      for (const item of diagram.items) {
        const enriched = {
          group: groupId,
          subgroup: subgroupId,
          sourceUrl: subgroupUrl,
          sourceImageUrl: item.imageUrl,
          ...item,
          imageUrl: localImageUrl,
        };

        if (item.position && item.imageUrl) {
          totalMappedRows += 1;
        }

        const list = mappingsByPartNumber[item.partNumber] ?? [];
        const duplicate = list.some(
          (entry) =>
            entry.group === enriched.group &&
            entry.subgroup === enriched.subgroup &&
            entry.position === enriched.position &&
            entry.imageUrl === enriched.imageUrl,
        );
        if (!duplicate) {
          list.push(enriched);
          mappingsByPartNumber[item.partNumber] = list;
        }
      }

      console.log(
        `[diagram-import]   subgroup ${subgroupId}: rows=${diagram.items.length} image=${diagram.imageUrl ? 'yes' : 'no'} hotspots=${diagram.areaCount}`,
      );
    }
  }

  const uniquePartNumbers = Object.keys(mappingsByPartNumber).length;
  const result = {
    generatedAt: new Date().toISOString(),
    source: {
      host: BASE_URL,
      path: '/view_GroupAction.php + /view_SubGroupAction.php',
    },
    modelContext: {
      ...baseParams,
    },
    stats: {
      groups: groupIds.length,
      subgroupPages: subgroupPages.length,
      uniquePartNumbers,
      totalRows,
      totalMappedRows,
      totalImages,
      totalAreaCount,
    },
    groups: groupIds,
    groupMeta,
    subgroupPages,
    mappingsByPartNumber,
  };

  const outputPath = resolve(process.cwd(), args.output || OUTPUT_PATH);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');

  console.log(`[diagram-import] written ${outputPath}`);
  console.log(
    `[diagram-import] summary groups=${result.stats.groups} subpages=${result.stats.subgroupPages} uniqueParts=${result.stats.uniquePartNumbers} rows=${result.stats.totalRows} mappedRows=${result.stats.totalMappedRows} images=${result.stats.totalImages}`,
  );
}

main().catch((error) => {
  console.error('[diagram-import] failed', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
