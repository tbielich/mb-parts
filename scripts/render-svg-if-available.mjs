import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const BINARY_NAMES = ['vtracer', 'potrace', 'magick', 'tesseract'];

function isStrictMode() {
  return String(process.env.RENDER_SVG_STRICT ?? '').trim() === '1';
}

async function hasBinary(name) {
  try {
    await execFileAsync('which', [name]);
    return true;
  } catch {
    return false;
  }
}

function summarizeMissingBinaries(available) {
  return BINARY_NAMES.filter((name) => !available[name]);
}

function hasSupportedVectorEngine(available) {
  return available.vtracer || (available.potrace && available.magick);
}

function logSkipReason(available) {
  const reasons = [];
  if (!hasSupportedVectorEngine(available)) {
    reasons.push('no vector engine (need vtracer or potrace+magick)');
  }
  if (!available.tesseract) {
    reasons.push('missing tesseract');
  }
  return reasons;
}

async function runRenderSvg() {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await new Promise((resolve, reject) => {
    const child = spawn(npmCommand, ['run', 'render:svg'], {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`render:svg exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function main() {
  const available = {};
  for (const binary of BINARY_NAMES) {
    available[binary] = await hasBinary(binary);
  }

  const strict = isStrictMode();
  const skipReasons = logSkipReason(available);

  if (skipReasons.length > 0) {
    const missing = summarizeMissingBinaries(available);
    console.log(`[render:svg:ci] skipping: ${skipReasons.join('; ')}`);
    console.log(`[render:svg:ci] missing_binaries=${missing.length > 0 ? missing.join(',') : 'none'}`);
    if (strict) {
      throw new Error('render:svg strict mode enabled and required binaries are missing.');
    }
    console.log('[render:svg:ci] continuing build with existing SVG files and PNG fallback.');
    return;
  }

  console.log('[render:svg:ci] binaries available, running render:svg');
  await runRenderSvg();
}

main().catch((error) => {
  console.error('[render:svg:ci] failed', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
