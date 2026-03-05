import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_INPUT_DIR = 'public/data/diagrams-960';
const FALLBACK_INPUT_DIRS = ['public/data/diagrams'];
const DEFAULT_OUTPUT_DIR = 'public/data/diagrams-svg';
const DEFAULT_ENGINE = 'auto';
const DEFAULT_OCR_THRESHOLD = 60;
const SVG_WIDTH = 960;
const SVG_HEIGHT = 640;

function parseArgs(argv) {
  const options = {
    inputDir: DEFAULT_INPUT_DIR,
    inputDirExplicit: false,
    outputDir: DEFAULT_OUTPUT_DIR,
    engine: DEFAULT_ENGINE,
    ocrThreshold: DEFAULT_OCR_THRESHOLD,
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
    if (token === '--engine' && argv[i + 1]) {
      options.engine = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--ocr-threshold' && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid value for --ocr-threshold: ${argv[i + 1]}`);
      }
      options.ocrThreshold = parsed;
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
    `  --engine <mode>        auto|vtracer|potrace (default: ${DEFAULT_ENGINE})\n` +
    `  --ocr-threshold <num>  OCR confidence threshold (default: ${DEFAULT_OCR_THRESHOLD})\n`);
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

function buildLabelsSvg(labels) {
  if (labels.length === 0) {
    return '<g id="labels" font-family="Helvetica, Arial, sans-serif" fill="#111" font-size="14"></g>';
  }

  const lines = labels.map((label) => {
    const posId = `pos-${label.pos}`;
    return `    <a id="${escapeXml(posId)}" href="#${escapeXml(posId)}">` +
      `<text data-pos="${escapeXml(label.pos)}" x="${label.x}" y="${label.y}">${escapeXml(label.pos)}</text></a>`;
  });

  return [
    '<g id="labels" font-family="Helvetica, Arial, sans-serif" fill="#111" font-size="14" text-rendering="geometricPrecision">',
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

function parseTsv(tsvContent, confidenceThreshold) {
  const lines = String(tsvContent).split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length <= 1) {
    return [];
  }

  const headers = lines[0].split('\t');
  const col = {
    left: headers.indexOf('left'),
    top: headers.indexOf('top'),
    width: headers.indexOf('width'),
    height: headers.indexOf('height'),
    conf: headers.indexOf('conf'),
    text: headers.indexOf('text'),
  };

  if (Object.values(col).some((index) => index < 0)) {
    return [];
  }

  const byPos = new Map();

  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i].split('\t');
    const conf = Number.parseFloat(cells[col.conf]);
    if (!Number.isFinite(conf) || conf < confidenceThreshold) {
      continue;
    }

    const rawText = String(cells[col.text] ?? '').trim();
    const pos = rawText.replace(/[^0-9]/g, '');
    if (!pos) {
      continue;
    }

    const left = Number.parseInt(cells[col.left], 10);
    const top = Number.parseInt(cells[col.top], 10);
    const width = Number.parseInt(cells[col.width], 10);
    const height = Number.parseInt(cells[col.height], 10);
    if (![left, top, width, height].every(Number.isFinite)) {
      continue;
    }

    const label = {
      pos,
      conf,
      x: clamp(Math.round(left + width * 0.5), 0, SVG_WIDTH - 1),
      y: clamp(Math.round(top + height - 2), 0, SVG_HEIGHT - 1),
    };

    const existing = byPos.get(pos);
    if (!existing || label.conf > existing.conf || (label.conf === existing.conf && (label.y < existing.y || (label.y === existing.y && label.x < existing.x)))) {
      byPos.set(pos, label);
    }
  }

  return Array.from(byPos.values()).sort((a, b) => {
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
  });
}

async function extractOcrLabels(inputPath, confidenceThreshold) {
  const { stdout } = await runCommand('tesseract', [
    inputPath,
    'stdout',
    'tsv',
    '--psm',
    '11',
    '-c',
    'tessedit_char_whitelist=0123456789',
  ]);
  return parseTsv(stdout, confidenceThreshold);
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
  const warnings = [];

  const inputDir = await resolveInputDir(options, warnings);

  const fileNames = (await readdir(inputDir))
    .filter((name) => extname(name).toLowerCase() === '.png')
    .sort((a, b) => a.localeCompare(b));

  if (fileNames.length === 0) {
    console.log(`[render:svg] no PNG files found in ${inputDir}`);
    console.log('[render:svg] summary processed=0 skipped=0 ocr_labels=0 missing_binaries=none');
    return;
  }

  const binaries = {
    vtracer: await hasBinary('vtracer'),
    potrace: await hasBinary('potrace'),
    magick: await hasBinary('magick'),
    tesseract: await hasBinary('tesseract'),
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
    console.log(`[render:svg] summary processed=0 skipped=${fileNames.length} ocr_labels=0 missing_binaries=${missingSummary}`);
    console.log('[render:svg] warnings:');
    for (const warning of warnings) {
      console.log(`  - ${warning}`);
    }
    process.exitCode = 1;
    return;
  }
  if (!binaries.tesseract) {
    warnings.push('tesseract is required for OCR labels but is missing.');
    const missingSummary = missingBinaries.length > 0 ? missingBinaries.join(',') : 'none';
    console.log(`[render:svg] summary processed=0 skipped=${fileNames.length} ocr_labels=0 missing_binaries=${missingSummary}`);
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
  let ocrLabelCount = 0;

  console.log(`[render:svg] input=${inputDir}`);
  console.log(`[render:svg] output=${outputDir}`);
  console.log(`[render:svg] engine=${engine}`);

  for (const fileName of fileNames) {
    const fileStem = basename(fileName, '.png');
    const inputPath = join(inputDir, fileName);
    const outputPath = join(outputDir, `${fileStem}.svg`);
    const tempDir = await mkdtemp(join(tmpdir(), 'mb-svg-'));
    const tracedSvgPath = join(tempDir, `${fileStem}.traced.svg`);

    try {
      if (engine === 'vtracer') {
        await vectorizeWithVtracer(inputPath, tracedSvgPath, warnings);
      } else {
        await vectorizeWithPotrace(inputPath, tracedSvgPath, tempDir);
      }

      const tracedSvg = await readFile(tracedSvgPath, 'utf8');
      const artInner = extractSvgInner(tracedSvg);

      const labels = await extractOcrLabels(inputPath, options.ocrThreshold);

      const finalSvg = buildFinalSvg(fileStem, artInner, labels);
      await writeFile(outputPath, finalSvg, 'utf8');

      processed += 1;
      ocrLabelCount += labels.length;
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
  console.log(`[render:svg] summary processed=${processed} skipped=${skipped} ocr_labels=${ocrLabelCount} missing_binaries=${missingSummary}`);

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
