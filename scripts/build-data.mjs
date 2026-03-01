import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const vehicleKey = process.env.PARTS_VEHICLE_KEY ?? 'default';
const migratedNdjsonPath = resolve(process.cwd(), `data/vehicles/${vehicleKey}/index/parts.ndjson`);
const ndjsonPath = resolve(
  process.cwd(),
  process.env.PARTS_NDJSON_PATH ?? migratedNdjsonPath,
);
const baseJsonPath = resolve(process.cwd(), process.env.PARTS_JSON_PATH ?? 'public/data/parts-base.json');
const chunksOutputPath = resolve(
  process.cwd(),
  process.env.PARTS_CHUNKS_OUTPUT ?? `public/data/vehicles/${vehicleKey}/index/chunks`,
);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function exists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function runNpmScript(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(npmCmd, args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: false,
    });

    child.once('error', (error) => rejectPromise(error));
    child.once('close', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`Command failed: npm ${args.join(' ')} (exit ${code ?? 'unknown'})`));
    });
  });
}

async function main() {
  const hasNdjson = await exists(ndjsonPath);
  const hasBaseJson = await exists(baseJsonPath);
  let chunkInputPath = ndjsonPath;

  console.log(`[build:data] vehicleKey=${vehicleKey}`);
  console.log(`[build:data] ndjson=${ndjsonPath} exists=${hasNdjson}`);
  console.log(`[build:data] baseJson=${baseJsonPath} exists=${hasBaseJson}`);

  if (!hasNdjson && !hasBaseJson) {
    throw new Error(
      [
        'No data source found for build.',
        `Expected one of:`,
        `- ${ndjsonPath}`,
        `- ${baseJsonPath}`,
        'Provide one source file, then run build again.',
      ].join('\n'),
    );
  }

  if (!hasNdjson && hasBaseJson) {
    console.log('[build:data] running migrate...');
    await runNpmScript([
      'run',
      'migrate',
      '--',
      '--input',
      baseJsonPath,
      '--vehicleKey',
      vehicleKey,
    ]);
    chunkInputPath = migratedNdjsonPath;
  }

  console.log('[build:data] running chunk:index...');
  await runNpmScript([
    'run',
    'chunk:index',
    '--',
    '--vehicleKey',
    vehicleKey,
    '--input',
    chunkInputPath,
    '--output',
    chunksOutputPath,
  ]);

  console.log('[build:data] done');
}

main().catch((error) => {
  console.error('[build:data] failed', error);
  process.exitCode = 1;
});
