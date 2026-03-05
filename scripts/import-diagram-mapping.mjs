import * as cheerio from 'cheerio';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const BASE_URL = 'https://mb-teilekatalog.info';
const OUTPUT_PATH = resolve(process.cwd(), 'public/data/parts-diagram-map.json');
const DIAGRAMS_OUTPUT_DIR = resolve(process.cwd(), 'public/data/diagrams');
const IMAGE_NAME_PREFIX = 'group-';
const TARGET_IMAGE_WIDTH = 960;
const TARGET_IMAGE_HEIGHT = 640;
const BORDER_SIZE = 20;
const TRIM_FUZZ = '5%';
const SHAVE_SIZE = '2x2';
const execFileAsync = promisify(execFile);

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

function buildDiagramFileName(index) {
  return `${IMAGE_NAME_PREFIX}${String(index).padStart(3, '0')}.png`;
}

async function runMagick(args) {
  const { stdout } = await execFileAsync('magick', args, { maxBuffer: 10 * 1024 * 1024 });
  return String(stdout ?? '').trim();
}

function parseTrimMetrics(metrics) {
  const match = String(metrics).trim().match(/^(\d+)x(\d+)\|([+-]\d+)\|([+-]\d+)$/);
  if (!match) {
    throw new Error(`Unexpected trim metrics format: ${metrics}`);
  }

  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10),
    x: Number.parseInt(match[3], 10),
    y: Number.parseInt(match[4], 10),
  };
}

function parseSize(sizeText) {
  const match = String(sizeText).trim().match(/^(\d+)x(\d+)$/);
  if (!match) {
    throw new Error(`Unexpected resize format: ${sizeText}`);
  }
  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10),
  };
}

function parseShaveSize(shaveText) {
  const match = String(shaveText).trim().match(/^(\d+)x(\d+)$/);
  if (!match) {
    throw new Error(`Unexpected shave format: ${shaveText}`);
  }
  return {
    x: Number.parseInt(match[1], 10),
    y: Number.parseInt(match[2], 10),
  };
}

async function processDiagramImage(downloadedBinary, targetPath) {
  const sourcePath = `${targetPath}.source.png`;
  await writeFile(sourcePath, downloadedBinary);

  try {
    const shave = parseShaveSize(SHAVE_SIZE);
    const trimMetricsRaw = await runMagick([
      sourcePath,
      '-bordercolor',
      'white',
      '-border',
      String(BORDER_SIZE),
      '-fuzz',
      TRIM_FUZZ,
      '-trim',
      '-format',
      '%wx%h|%X|%Y',
      'info:',
    ]);
    const trimGeometry = parseTrimMetrics(trimMetricsRaw);

    const preResizeSizeRaw = await runMagick([
      sourcePath,
      '-bordercolor',
      'white',
      '-border',
      String(BORDER_SIZE),
      '-fuzz',
      TRIM_FUZZ,
      '-trim',
      '+repage',
      '-shave',
      SHAVE_SIZE,
      '-format',
      '%wx%h',
      'info:',
    ]);
    const preResizeSize = parseSize(preResizeSizeRaw);

    await runMagick([
      sourcePath,
      '-bordercolor',
      'white',
      '-border',
      String(BORDER_SIZE),
      '-fuzz',
      TRIM_FUZZ,
      '-trim',
      '+repage',
      '-shave',
      SHAVE_SIZE,
      '-resize',
      `${TARGET_IMAGE_WIDTH}x${TARGET_IMAGE_HEIGHT}!`,
      targetPath,
    ]);

    return {
      offsetX: BORDER_SIZE - trimGeometry.x - shave.x,
      offsetY: BORDER_SIZE - trimGeometry.y - shave.y,
      scaleX: preResizeSize.width > 0 ? TARGET_IMAGE_WIDTH / preResizeSize.width : 1,
      scaleY: preResizeSize.height > 0 ? TARGET_IMAGE_HEIGHT / preResizeSize.height : 1,
    };
  } finally {
    try {
      await unlink(sourcePath);
    } catch {
      // ignore temp cleanup failures
    }
  }
}

function transformCoords(coords, shape, transform) {
  if (!coords || !transform) {
    return coords;
  }

  const values = String(coords)
    .split(',')
    .map((part) => Number.parseFloat(part.trim()))
    .filter((value) => Number.isFinite(value));

  if (values.length === 0) {
    return coords;
  }

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const mapPoint = (x, y) => {
    const tx = clamp(Math.round((x + transform.offsetX) * transform.scaleX), 0, TARGET_IMAGE_WIDTH - 1);
    const ty = clamp(Math.round((y + transform.offsetY) * transform.scaleY), 0, TARGET_IMAGE_HEIGHT - 1);
    return [tx, ty];
  };

  const normalizedShape = normalizeText(shape).toLowerCase();
  if (normalizedShape === 'circle' && values.length >= 3) {
    const [cx, cy] = mapPoint(values[0], values[1]);
    const radius = Math.max(1, Math.round(values[2] * ((transform.scaleX + transform.scaleY) / 2)));
    return `${cx},${cy},${radius}`;
  }

  if (values.length < 2) {
    return coords;
  }

  const transformed = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    const [tx, ty] = mapPoint(values[i], values[i + 1]);
    transformed.push(tx, ty);
  }

  return transformed.join(',');
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
  const localImageByRemoteUrl = new Map();
  let nextDiagramIndex = 1;

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
      let coordTransform;

      if (diagram.imageUrl) {
        const cached = localImageByRemoteUrl.get(diagram.imageUrl);
        if (cached) {
          localImageUrl = cached.localImageUrl;
          coordTransform = cached.coordTransform;
        } else {
          const fileName = buildDiagramFileName(nextDiagramIndex);
          nextDiagramIndex += 1;
          const targetPath = resolve(DIAGRAMS_OUTPUT_DIR, fileName);
          const binary = await downloadBinary(diagram.imageUrl);
          coordTransform = await processDiagramImage(binary, targetPath);

          localImageUrl = `/data/diagrams/${fileName}`;
          localImageByRemoteUrl.set(diagram.imageUrl, { localImageUrl, coordTransform });
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
          coords: transformCoords(item.coords, item.shape, coordTransform),
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
