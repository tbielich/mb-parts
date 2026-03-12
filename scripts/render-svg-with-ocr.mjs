import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_INPUT_DIR = 'public/data/diagrams-960';
const FALLBACK_INPUT_DIRS = ['public/data/diagrams'];
const DEFAULT_OUTPUT_DIR = 'public/data/diagrams-svg';
const DEFAULT_MAP_PATH = 'public/data/parts-diagram-map.json';
const DEFAULT_ENGINE = 'auto';
const MASK_LABELS_BEFORE_TRACING = false;
const OCR_MASK_PADDING = 1;
const LABEL_MASK_CHAR_WIDTH_FACTOR = 0.68;
const LABEL_MASK_HEIGHT_FACTOR = 1.2;
const LABEL_MASK_MIN_WIDTH = 10;
const LABEL_MASK_MIN_HEIGHT = 10;
const SVG_WIDTH = 960;
const SVG_HEIGHT = 640;

function parseArgs(argv) {
  const options = {
    inputDir: DEFAULT_INPUT_DIR,
    inputDirExplicit: false,
    outputDir: DEFAULT_OUTPUT_DIR,
    mapPath: DEFAULT_MAP_PATH,
    engine: DEFAULT_ENGINE,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--in' && argv[i + 1]) {
      options.inputDir = argv[i + 1];
      options.inputDirExplicit = true;
      i += 1;
      continue;
    }
    if (token === '--out' && argv[i + 1]) {
      options.outputDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--map' && argv[i + 1]) {
      options.mapPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--engine' && argv[i + 1]) {
      options.engine = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/render-svg-with-ocr.mjs [options]\n\n` +
    `Options:\n` +
    `  --in <dir>             Input folder with PNG diagrams (default: ${DEFAULT_INPUT_DIR})\n` +
    `  --out <dir>            Output folder for SVG diagrams (default: ${DEFAULT_OUTPUT_DIR})\n` +
    `  --map <file>           Diagram mapping JSON (default: ${DEFAULT_MAP_PATH})\n` +
    `  --engine <mode>        auto|vtracer|potrace (default: ${DEFAULT_ENGINE})\n`);
}

async function runCommand(command, args) {
  return execFileAsync(command, args, {
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function hasBinary(name) {
  try {
    await runCommand('which', [name]);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeEngine(engine) {
  const value = String(engine ?? '').trim().toLowerCase();
  if (value === 'auto' || value === 'vtracer' || value === 'potrace') {
    return value;
  }
  throw new Error(`Unsupported engine: ${engine}. Use auto|vtracer|potrace.`);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function extractSvgInner(rawSvg) {
  const withoutDeclaration = rawSvg.replace(/^\s*<\?xml[^>]*>\s*/i, '');
  const match = withoutDeclaration.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/i);
  if (!match?.[1]) {
    throw new Error('Unable to extract SVG content from traced output.');
  }
  return match[1].trim();
}

function computeLabelFontSize(label) {
  return clamp(Math.round((Number(label.height) || 14) * 0.22), 10, 14);
}

function computeLabelMaskSize(label) {
  const fontSize = computeLabelFontSize(label);
  const charCount = Math.max(1, String(label.pos ?? '').length);
  return {
    width: Math.max(LABEL_MASK_MIN_WIDTH, Math.round(fontSize * charCount * LABEL_MASK_CHAR_WIDTH_FACTOR)),
    height: Math.max(LABEL_MASK_MIN_HEIGHT, Math.round(fontSize * LABEL_MASK_HEIGHT_FACTOR)),
  };
}

function buildLabelsSvg(labels) {
  if (labels.length === 0) {
    return '<g id="labels" font-family="Helvetica, Arial, sans-serif" fill="#111" font-size="14" opacity="0" pointer-events="none"></g>';
  }

  const lines = labels.map((label) => {
    const posId = `pos-${label.pos}`;
    const fontSize = computeLabelFontSize(label);
    return `    <a id="${escapeXml(posId)}" href="#${escapeXml(posId)}">` +
      `<text data-pos="${escapeXml(label.pos)}" x="${label.x}" y="${label.y}" text-anchor="middle" dominant-baseline="middle" font-size="${fontSize}" font-weight="600">${escapeXml(label.pos)}</text></a>`;
  });

  return [
    '<g id="labels" font-family="Helvetica, Arial, sans-serif" fill="#111" font-size="14" text-rendering="geometricPrecision" opacity="0" pointer-events="none">',
    ...lines,
    '</g>',
  ].join('\n');
}

function buildFinalSvg(fileStem, artInner, labels) {
  const title = `Mercedes parts diagram: ${fileStem}`;
  const desc = `Mercedes parts diagram: ${fileStem}`;
  const labelsLayer = buildLabelsSvg(labels);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" role="img" aria-labelledby="title desc">`,
    `  <title id="title">${escapeXml(title)}</title>`,
    `  <desc id="desc">${escapeXml(desc)}</desc>`,
    '  <g id="art">',
    artInner
      .split('\n')
      .map((line) => (line.trim().length > 0 ? `    ${line}` : ''))
      .filter(Boolean)
      .join('\n'),
    '  </g>',
    labelsLayer
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
    '</svg>',
    '',
  ].join('\n');
}

async function vectorizeWithVtracer(inputPath, outputPath, warnings) {
  const attempts = [
    [
      '--input',
      inputPath,
      '--output',
      outputPath,
      '--colormode',
      'binary',
      '--mode',
      'polygon',
      '--filter_speckle',
      '4',
      '--corner_threshold',
      '60',
      '--length_threshold',
      '3',
    ],
    ['--input', inputPath, '--output', outputPath, '--colormode', 'binary'],
    ['--input', inputPath, '--output', outputPath],
    [inputPath, outputPath],
  ];

  let lastError;
  for (let index = 0; index < attempts.length; index += 1) {
    try {
      await runCommand('vtracer', attempts[index]);
      return;
    } catch (error) {
      lastError = error;
      if (index < attempts.length - 1) {
        warnings.push(`vtracer attempt ${index + 1} failed for ${basename(inputPath)}; retrying with a simpler argument set.`);
      }
    }
  }

  throw new Error(`vtracer failed for ${basename(inputPath)}: ${String(lastError?.stderr || lastError?.message || lastError)}`);
}

async function vectorizeWithPotrace(inputPath, outputPath, tempDir) {
  const pbmPath = join(tempDir, `${basename(inputPath, extname(inputPath))}.pbm`);
  await runCommand('magick', [
    inputPath,
    '-colorspace',
    'Gray',
    '-threshold',
    '58%',
    '-type',
    'bilevel',
    pbmPath,
  ]);

  await runCommand('potrace', [
    pbmPath,
    '-s',
    '-o',
    outputPath,
    '--turdsize',
    '3',
    '--alphamax',
    '0.8',
    '--opttolerance',
    '0.3',
  ]);
}

function parseCoordinateValues(coords) {
  return String(coords ?? '')
    .split(',')
    .map((value) => Number.parseFloat(value.trim()))
    .filter((value) => Number.isFinite(value));
}

function toBoundingBox(coords, shape) {
  const values = parseCoordinateValues(coords);
  if (values.length < 3) {
    return null;
  }

  const normalizedShape = String(shape ?? 'rect').trim().toLowerCase();
  let minX;
  let minY;
  let maxX;
  let maxY;

  if (normalizedShape === 'circle' && values.length >= 3) {
    const [cx, cy, radius] = values;
    minX = cx - radius;
    minY = cy - radius;
    maxX = cx + radius;
    maxY = cy + radius;
  } else if ((normalizedShape === 'poly' || normalizedShape === 'polygon') && values.length >= 4) {
    const xs = [];
    const ys = [];
    for (let i = 0; i + 1 < values.length; i += 2) {
      xs.push(values[i]);
      ys.push(values[i + 1]);
    }
    if (xs.length === 0 || ys.length === 0) {
      return null;
    }
    minX = Math.min(...xs);
    minY = Math.min(...ys);
    maxX = Math.max(...xs);
    maxY = Math.max(...ys);
  } else if (values.length >= 4) {
    minX = Math.min(values[0], values[2]);
    minY = Math.min(values[1], values[3]);
    maxX = Math.max(values[0], values[2]);
    maxY = Math.max(values[1], values[3]);
  } else {
    return null;
  }

  const left = clamp(Math.round(minX), 0, SVG_WIDTH - 1);
  const top = clamp(Math.round(minY), 0, SVG_HEIGHT - 1);
  const right = clamp(Math.round(maxX), 0, SVG_WIDTH);
  const bottom = clamp(Math.round(maxY), 0, SVG_HEIGHT);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);

  return { left, top, width, height };
}

function normalizePositionValue(value) {
  const normalized = String(value ?? '').trim().replace(/[^0-9]/g, '');
  return normalized;
}

function sortLabelsByPosition(a, b) {
  const an = Number.parseFloat(a.pos);
  const bn = Number.parseFloat(b.pos);
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) {
    return an - bn;
  }
  if (a.y !== b.y) {
    return a.y - b.y;
  }
  if (a.x !== b.x) {
    return a.x - b.x;
  }
  return a.pos.localeCompare(b.pos);
}

function buildLabelsFromEntries(entries) {
  const byPos = new Map();

  for (const entry of entries) {
    const pos = normalizePositionValue(entry.position);
    if (!pos) {
      continue;
    }
    const bbox = toBoundingBox(entry.coords, entry.shape);
    if (!bbox) {
      continue;
    }

    const coordKey = `${bbox.left},${bbox.top},${bbox.width},${bbox.height}`;
    const candidateMap = byPos.get(pos) ?? new Map();
    const existing = candidateMap.get(coordKey);
    if (existing) {
      existing.count += 1;
    } else {
      candidateMap.set(coordKey, {
        pos,
        left: bbox.left,
        top: bbox.top,
        width: bbox.width,
        height: bbox.height,
        area: bbox.width * bbox.height,
        count: 1,
        coordKey,
      });
    }
    byPos.set(pos, candidateMap);
  }

  const labels = [];
  for (const [pos, candidateMap] of byPos.entries()) {
    const best = Array.from(candidateMap.values())
      .sort((a, b) => (
        b.count - a.count ||
        a.area - b.area ||
        a.top - b.top ||
        a.left - b.left ||
        a.coordKey.localeCompare(b.coordKey)
      ))[0];

    labels.push({
      pos,
      left: best.left,
      top: best.top,
      width: best.width,
      height: best.height,
      x: clamp(Math.round(best.left + best.width * 0.5), 0, SVG_WIDTH - 1),
      y: clamp(Math.round(best.top + best.height * 0.5), 0, SVG_HEIGHT - 1),
    });
  }

  return labels.sort(sortLabelsByPosition);
}

function buildLabelIndexFromDiagramMap(diagramMap) {
  const byFile = new Map();
  const mapping = diagramMap?.mappingsByPartNumber ?? {};
  for (const entries of Object.values(mapping)) {
    for (const entry of entries) {
      const fileName = basename(String(entry?.imageUrl ?? '').trim());
      if (!fileName || extname(fileName).toLowerCase() !== '.png') {
        continue;
      }
      const list = byFile.get(fileName) ?? [];
      list.push({
        position: entry.position,
        coords: entry.coords,
        shape: entry.shape,
      });
      byFile.set(fileName, list);
    }
  }

  const labelIndex = new Map();
  for (const [fileName, entries] of byFile.entries()) {
    labelIndex.set(fileName, buildLabelsFromEntries(entries));
  }
  return labelIndex;
}

async function createMaskedPng(inputPath, maskedPath, labels) {
  if (labels.length === 0) {
    await copyFile(inputPath, maskedPath);
    return;
  }

  const args = [inputPath, '-fill', 'white'];
  for (const label of labels) {
    const maskSize = computeLabelMaskSize(label);
    const x1 = clamp(Math.round(label.x - maskSize.width * 0.5) - OCR_MASK_PADDING, 0, SVG_WIDTH - 1);
    const y1 = clamp(Math.round(label.y - maskSize.height * 0.5) - OCR_MASK_PADDING, 0, SVG_HEIGHT - 1);
    const x2 = clamp(Math.round(label.x + maskSize.width * 0.5) + OCR_MASK_PADDING, 0, SVG_WIDTH - 1);
    const y2 = clamp(Math.round(label.y + maskSize.height * 0.5) + OCR_MASK_PADDING, 0, SVG_HEIGHT - 1);
    args.push('-draw', `rectangle ${x1},${y1} ${x2},${y2}`);
  }
  args.push(maskedPath);
  await runCommand('magick', args);
}

function chooseEngine(requestedEngine, binaries) {
  if (requestedEngine === 'vtracer') {
    if (!binaries.vtracer) {
      throw new Error('Engine vtracer requested but binary is missing.');
    }
    return 'vtracer';
  }

  if (requestedEngine === 'potrace') {
    if (!binaries.potrace) {
      throw new Error('Engine potrace requested but binary is missing.');
    }
    if (!binaries.magick) {
      throw new Error('Engine potrace requires imagemagick (magick) for PNG -> PBM conversion.');
    }
    return 'potrace';
  }

  if (binaries.vtracer) {
    return 'vtracer';
  }
  if (binaries.potrace && binaries.magick) {
    return 'potrace';
  }

  throw new Error('No vectorization engine available. Install vtracer or potrace (+ imagemagick).');
}

async function resolveInputDir(options, warnings) {
  const preferredPath = resolve(process.cwd(), options.inputDir);
  if (await pathExists(preferredPath)) {
    return preferredPath;
  }

  if (options.inputDirExplicit) {
    throw new Error(`Input directory not found: ${preferredPath}`);
  }

  for (const fallback of FALLBACK_INPUT_DIRS) {
    const fallbackPath = resolve(process.cwd(), fallback);
    if (await pathExists(fallbackPath)) {
      warnings.push(`Input directory not found: ${preferredPath}. Falling back to ${fallbackPath}.`);
      return fallbackPath;
    }
  }

  throw new Error(
    `Input directory not found: ${preferredPath} (checked fallbacks: ${FALLBACK_INPUT_DIRS.join(', ')})`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  options.engine = normalizeEngine(options.engine);

  const outputDir = resolve(process.cwd(), options.outputDir);
  const mapPath = resolve(process.cwd(), options.mapPath);
  const warnings = [];

  const inputDir = await resolveInputDir(options, warnings);

  const fileNames = (await readdir(inputDir))
    .filter((name) => extname(name).toLowerCase() === '.png')
    .sort((a, b) => a.localeCompare(b));

  if (fileNames.length === 0) {
    console.log(`[render:svg] no PNG files found in ${inputDir}`);
    console.log('[render:svg] summary processed=0 skipped=0 map_labels=0 missing_binaries=none');
    return;
  }

  let labelsByFile;
  try {
    const mapContent = await readFile(mapPath, 'utf8');
    labelsByFile = buildLabelIndexFromDiagramMap(JSON.parse(mapContent));
  } catch (error) {
    throw new Error(`Failed to load diagram map from ${mapPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const binaries = {
    vtracer: await hasBinary('vtracer'),
    potrace: await hasBinary('potrace'),
    magick: await hasBinary('magick'),
  };

  const missingBinaries = Object.entries(binaries)
    .filter(([, available]) => !available)
    .map(([name]) => name);

  let engine;
  try {
    engine = chooseEngine(options.engine, binaries);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
    const missingSummary = missingBinaries.length > 0 ? missingBinaries.join(',') : 'none';
    console.log(`[render:svg] summary processed=0 skipped=${fileNames.length} map_labels=0 missing_binaries=${missingSummary}`);
    console.log('[render:svg] warnings:');
    for (const warning of warnings) {
      console.log(`  - ${warning}`);
    }
    process.exitCode = 1;
    return;
  }

  await mkdir(outputDir, { recursive: true });

  let processed = 0;
  let skipped = 0;
  let mapLabelCount = 0;

  console.log(`[render:svg] input=${inputDir}`);
  console.log(`[render:svg] output=${outputDir}`);
  console.log(`[render:svg] map=${mapPath}`);
  console.log(`[render:svg] engine=${engine}`);

  for (const fileName of fileNames) {
    const fileStem = basename(fileName, '.png');
    const inputPath = join(inputDir, fileName);
    const outputPath = join(outputDir, `${fileStem}.svg`);
    const tempDir = await mkdtemp(join(tmpdir(), 'mb-svg-'));
    const maskedPngPath = join(tempDir, `${fileStem}.masked.png`);
    const tracedSvgPath = join(tempDir, `${fileStem}.traced.svg`);

    try {
      const labels = labelsByFile.get(fileName) ?? [];
      const tracingInputPath = MASK_LABELS_BEFORE_TRACING
        ? (await createMaskedPng(inputPath, maskedPngPath, labels), maskedPngPath)
        : inputPath;

      if (engine === 'vtracer') {
        await vectorizeWithVtracer(tracingInputPath, tracedSvgPath, warnings);
      } else {
        await vectorizeWithPotrace(tracingInputPath, tracedSvgPath, tempDir);
      }

      const tracedSvg = await readFile(tracedSvgPath, 'utf8');
      const artInner = extractSvgInner(tracedSvg);

      const finalSvg = buildFinalSvg(fileStem, artInner, labels);
      await writeFile(outputPath, finalSvg, 'utf8');

      processed += 1;
      mapLabelCount += labels.length;
      console.log(`[render:svg] ${fileName} -> ${basename(outputPath)} labels=${labels.length}`);
    } catch (error) {
      skipped += 1;
      warnings.push(`${fileName}: ${error instanceof Error ? error.message : String(error)}`);
      console.warn(`[render:svg] skipped ${fileName}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  const missingSummary = missingBinaries.length > 0 ? missingBinaries.join(',') : 'none';
  console.log(`[render:svg] summary processed=${processed} skipped=${skipped} map_labels=${mapLabelCount} missing_binaries=${missingSummary}`);

  if (warnings.length > 0) {
    console.log('[render:svg] warnings:');
    for (const warning of warnings) {
      console.log(`  - ${warning}`);
    }
  }

  if (processed === 0 || skipped > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[render:svg] failed', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
