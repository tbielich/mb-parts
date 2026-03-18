import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const INPUT_PATH = resolve(process.cwd(), 'static/data/parts-diagram-map.json');
const OUTPUT_DIR = resolve(process.cwd(), 'static/data/diagrams/ikea-svg');

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseRectCoords(coords) {
  const values = normalizeText(coords)
    .split(',')
    .map((v) => Number.parseFloat(v))
    .filter((v) => Number.isFinite(v));
  if (values.length < 4) {
    return null;
  }
  const [x1, y1, x2, y2] = values;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
    cx: (x1 + x2) / 2,
    cy: (y1 + y2) / 2,
  };
}

function parseCircleCoords(coords) {
  const values = normalizeText(coords)
    .split(',')
    .map((v) => Number.parseFloat(v))
    .filter((v) => Number.isFinite(v));
  if (values.length < 3) {
    return null;
  }
  const [cx, cy, r] = values;
  return { cx, cy, r };
}

function parsePolyCoords(coords) {
  const values = normalizeText(coords)
    .split(',')
    .map((v) => Number.parseFloat(v))
    .filter((v) => Number.isFinite(v));
  if (values.length < 6 || values.length % 2 !== 0) {
    return null;
  }
  const points = [];
  for (let i = 0; i < values.length; i += 2) {
    points.push({ x: values[i], y: values[i + 1] });
  }

  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));

  return {
    points,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    minX,
    minY,
    maxX,
    maxY,
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function getImageKey(imageUrl) {
  const raw = normalizeText(imageUrl);
  if (!raw) {
    return '';
  }
  return basename(raw).replace(/\.png$/i, '');
}

function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
    return null;
  }
  const signature = buffer.subarray(0, 8);
  const expected = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!signature.equals(expected)) {
    return null;
  }
  const chunkType = buffer.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') {
    return null;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function buildSvgForImage(imageKey, entries, imageSize) {
  const uniqueByPosition = new Map();
  for (const entry of entries) {
    const position = normalizeText(entry.position);
    if (!position || !entry.coords) {
      continue;
    }
    if (!uniqueByPosition.has(position)) {
      uniqueByPosition.set(position, entry);
    }
  }

  const labels = [];
  let maxX = 0;
  let maxY = 0;

  for (const [position, entry] of uniqueByPosition) {
    const shape = normalizeText(entry.shape).toLowerCase() || 'rect';
    if (shape === 'rect') {
      const rect = parseRectCoords(entry.coords);
      if (!rect) {
        continue;
      }
      maxX = Math.max(maxX, rect.x + rect.w);
      maxY = Math.max(maxY, rect.y + rect.h);
      labels.push({ position, cx: rect.cx, cy: rect.cy });
      continue;
    }

    if (shape === 'circle') {
      const circle = parseCircleCoords(entry.coords);
      if (!circle) {
        continue;
      }
      maxX = Math.max(maxX, circle.cx + circle.r);
      maxY = Math.max(maxY, circle.cy + circle.r);
      labels.push({ position, cx: circle.cx, cy: circle.cy });
      continue;
    }

    if (shape === 'poly' || shape === 'polygon') {
      const poly = parsePolyCoords(entry.coords);
      if (!poly) {
        continue;
      }
      maxX = Math.max(maxX, poly.maxX);
      maxY = Math.max(maxY, poly.maxY);
      labels.push({ position, cx: poly.cx, cy: poly.cy });
      continue;
    }

    const rect = parseRectCoords(entry.coords);
    if (!rect) {
      continue;
    }
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
    labels.push({ position, cx: rect.cx, cy: rect.cy });
  }

  if (labels.length === 0) {
    return null;
  }

  const padding = 16;
  const width = Math.max(320, imageSize?.width ?? Math.ceil(maxX + padding));
  const height = Math.max(240, imageSize?.height ?? Math.ceil(maxY + padding));
  const imageHref = `../${imageKey}.png`;

  const body = labels
    .map((label) => {
      const bubbleRadius = 9;
      return `<g class="label">\n  <circle cx="${label.cx}" cy="${label.cy}" r="${bubbleRadius}"/>\n  <text x="${label.cx}" y="${label.cy}" text-anchor="middle" dominant-baseline="middle">${escapeXml(label.position)}</text>\n</g>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Line drawing ${escapeXml(imageKey)}">
  <style>
    .frame { fill: #fff; stroke: #111; stroke-width: 1; }
    .baseart { image-rendering: auto; opacity: 1; }
    .edgeart { image-rendering: auto; opacity: 0.18; mix-blend-mode: multiply; }
    .label circle { fill: #fff; stroke: #111; stroke-width: 1; }
    .label text { font-family: 'IBM Plex Sans', Arial, sans-serif; font-size: 9px; font-weight: 700; fill: #111; }
  </style>
  <defs>
    <filter id="lineart" x="-5%" y="-5%" width="110%" height="110%">
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer>
        <feFuncR type="gamma" amplitude="1.15" exponent="1.18" offset="0"/>
        <feFuncG type="gamma" amplitude="1.15" exponent="1.18" offset="0"/>
        <feFuncB type="gamma" amplitude="1.15" exponent="1.18" offset="0"/>
      </feComponentTransfer>
      <feConvolveMatrix order="3" kernelMatrix="-1 -1 -1 -1 8 -1 -1 -1 -1" divisor="1" bias="0"/>
      <feComponentTransfer>
        <feFuncR type="table" tableValues="0 0.2 0.4 0.65 1"/>
        <feFuncG type="table" tableValues="0 0.2 0.4 0.65 1"/>
        <feFuncB type="table" tableValues="0 0.2 0.4 0.65 1"/>
      </feComponentTransfer>
    </filter>
  </defs>
  <rect class="frame" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}"/>
  <image class="baseart" href="${escapeXml(imageHref)}" x="0" y="0" width="${width}" height="${height}"/>
  <image class="edgeart" href="${escapeXml(imageHref)}" x="0" y="0" width="${width}" height="${height}" filter="url(#lineart)"/>
${body}
</svg>
`;
}

async function main() {
  const raw = await readFile(INPUT_PATH, 'utf-8');
  const data = JSON.parse(raw);
  const byImage = new Map();

  for (const entries of Object.values(data.mappingsByPartNumber ?? {})) {
    for (const entry of entries) {
      const key = getImageKey(entry.imageUrl);
      if (!key) {
        continue;
      }
      const list = byImage.get(key) ?? [];
      list.push(entry);
      byImage.set(key, list);
    }
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  let written = 0;
  for (const [imageKey, entries] of byImage.entries()) {
    const pngPath = resolve(process.cwd(), 'static/data/diagrams', `${imageKey}.png`);
    let imageSize;
    try {
      const pngBinary = await readFile(pngPath);
      imageSize = readPngDimensions(pngBinary);
    } catch {
      imageSize = null;
    }

    const svg = buildSvgForImage(imageKey, entries, imageSize);
    if (!svg) {
      continue;
    }
    const outputPath = resolve(OUTPUT_DIR, `${imageKey}.svg`);
    await writeFile(outputPath, svg, 'utf-8');
    written += 1;
  }

  console.log(`[ikea-svg] input images: ${byImage.size}`);
  console.log(`[ikea-svg] written svg files: ${written}`);
  console.log(`[ikea-svg] output dir: ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error('[ikea-svg] failed', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
