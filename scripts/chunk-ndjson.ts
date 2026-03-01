import { createReadStream, createWriteStream, WriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

type PartItem = {
  partNumber: string;
  name?: string;
  [key: string]: unknown;
};

type ChunkMeta = {
  id: number;
  file: string;
  count: number;
  firstPartNumber: string;
  lastPartNumber: string;
};

type Manifest = {
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

type Args = {
  input: string;
  vehicleKey: string;
  output: string;
  chunkSize: number;
};

const DEFAULT_CHUNK_SIZE = 25000;

function parseArgs(argv: string[]): Args {
  let vehicleKey = 'default';
  let input = resolve(process.cwd(), 'data/vehicles/default/index/parts.ndjson');
  let output = resolve(process.cwd(), 'public/data/vehicles/default/index/chunks');
  let chunkSize = DEFAULT_CHUNK_SIZE;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--vehicleKey' && argv[i + 1]) {
      vehicleKey = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--input' && argv[i + 1]) {
      input = resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--output' && argv[i + 1]) {
      output = resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--chunkSize' && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        chunkSize = parsed;
      }
      i += 1;
      continue;
    }
  }

  return { input, vehicleKey, output, chunkSize };
}

function normalizePartNumber(raw: unknown): string {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function getPartPrefix4(partNumber: string): string | null {
  const normalized = normalizePartNumber(partNumber);
  if (normalized.length < 4) {
    return null;
  }
  return normalized.slice(0, 4);
}

function tokenizeName(name: unknown): string[] {
  return String(name ?? '')
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function addToIndex(index: Map<string, Set<number>>, key: string, chunkId: number): void {
  if (!index.has(key)) {
    index.set(key, new Set<number>());
  }
  index.get(key)?.add(chunkId);
}

async function writeLine(stream: WriteStream, line: string): Promise<void> {
  if (stream.write(line)) {
    return;
  }
  await once(stream, 'drain');
}

function sortedIndexObject(index: Map<string, Set<number>>): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  const keys = Array.from(index.keys()).sort();
  for (const key of keys) {
    result[key] = Array.from(index.get(key) ?? []).sort((left, right) => left - right);
  }
  return result;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.output, { recursive: true });

  const readStream = createReadStream(args.input, { encoding: 'utf-8' });
  const rl = createInterface({ input: readStream, crlfDelay: Infinity });

  const partPrefixIndex = new Map<string, Set<number>>();
  const namePrefixIndex = new Map<string, Set<number>>();
  const chunks: ChunkMeta[] = [];

  let chunkId = -1;
  let chunkCount = 0;
  let currentStream: WriteStream | null = null;
  let currentFile = '';
  let currentFirstPartNumber = '';
  let currentLastPartNumber = '';
  let totalParts = 0;

  async function closeChunk(): Promise<void> {
    if (!currentStream || chunkCount === 0) {
      if (currentStream) {
        currentStream.end();
        await once(currentStream, 'finish');
      }
      currentStream = null;
      return;
    }
    currentStream.end();
    await once(currentStream, 'finish');
    chunks.push({
      id: chunkId,
      file: currentFile,
      count: chunkCount,
      firstPartNumber: currentFirstPartNumber,
      lastPartNumber: currentLastPartNumber,
    });
    currentStream = null;
    chunkCount = 0;
    currentFirstPartNumber = '';
    currentLastPartNumber = '';
  }

  function openChunk(nextChunkId: number): void {
    const file = `parts-${String(nextChunkId).padStart(4, '0')}.ndjson`;
    currentFile = file;
    currentStream = createWriteStream(resolve(args.output, file), { encoding: 'utf-8' });
    chunkId = nextChunkId;
  }

  console.log(`[chunk] input=${args.input}`);
  console.log(`[chunk] output=${args.output}`);
  console.log(`[chunk] chunkSize=${args.chunkSize}`);

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    const parsed = JSON.parse(line) as PartItem;
    const partNumber = normalizePartNumber(parsed.partNumber);
    if (!partNumber) {
      continue;
    }
    if (!currentStream) {
      openChunk(chunkId + 1);
    }

    await writeLine(currentStream, `${line}\n`);
    totalParts += 1;
    chunkCount += 1;
    currentLastPartNumber = partNumber;
    if (!currentFirstPartNumber) {
      currentFirstPartNumber = partNumber;
    }

    const prefix4 = getPartPrefix4(partNumber);
    if (prefix4) {
      addToIndex(partPrefixIndex, prefix4, chunkId);
    }

    const tokenPrefixes = new Set<string>();
    for (const token of tokenizeName(parsed.name)) {
      tokenPrefixes.add(token.slice(0, 3));
      if (tokenPrefixes.size >= 8) {
        break;
      }
    }
    for (const tokenPrefix of tokenPrefixes) {
      addToIndex(namePrefixIndex, tokenPrefix, chunkId);
    }

    if (chunkCount >= args.chunkSize) {
      await closeChunk();
    }

    if (totalParts % 10000 === 0) {
      console.log(`[chunk] processed=${totalParts}`);
    }
  }

  await closeChunk();

  const generatedAt = new Date().toISOString();
  const manifest: Manifest = {
    vehicleKey: args.vehicleKey,
    generatedAt,
    source: args.input,
    chunkSizeLines: args.chunkSize,
    chunkCount: chunks.length,
    totalParts,
    chunks,
  };

  const chunkMap: ChunkMap = {
    vehicleKey: args.vehicleKey,
    generatedAt,
    byPartPrefix4: sortedIndexObject(partPrefixIndex),
    byNamePrefix3: sortedIndexObject(namePrefixIndex),
  };

  await writeFile(resolve(args.output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  await writeFile(resolve(args.output, 'chunk-map.json'), `${JSON.stringify(chunkMap, null, 2)}\n`, 'utf-8');

  console.log(`[chunk] totalParts=${totalParts}`);
  console.log(`[chunk] chunkCount=${chunks.length}`);
  console.log(`[chunk] wrote ${resolve(args.output, 'manifest.json')}`);
  console.log(`[chunk] wrote ${resolve(args.output, 'chunk-map.json')}`);
}

void run().catch((error) => {
  console.error('[chunk] failed', error);
  process.exitCode = 1;
});
