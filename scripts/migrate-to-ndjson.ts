import { createReadStream, createWriteStream, WriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { resolve } from 'node:path';

type Availability = {
  status: 'in_stock' | 'out_of_stock' | 'unknown';
  label: string;
};

type Enrichment = {
  price: null;
  availability: Availability;
  lastCheckedAt: null;
};

type PartRecord = {
  partNumber: string;
  name?: string;
  url?: string;
  hierarchy?: {
    groups?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type MigratedPartRecord = PartRecord & {
  hierarchy: {
    groups: string[];
    [key: string]: unknown;
  };
  enrichment: Enrichment;
};

type GroupIndex = Record<string, Record<string, number>>;

const DEFAULT_PREFIXES = ['A309', 'A310'];
const UNKNOWN_AVAILABILITY: Availability = { status: 'unknown', label: 'Unknown' };

function parseArgs(argv: string[]): {
  inputPath: string;
  vehicleKey: string;
  prefixes: string[];
} {
  let inputPath = resolve(process.cwd(), 'public/data/parts-base.json');
  let vehicleKey = 'default';
  let prefixes = [...DEFAULT_PREFIXES];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' && argv[i + 1]) {
      inputPath = resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--vehicleKey' && argv[i + 1]) {
      vehicleKey = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--prefixes' && argv[i + 1]) {
      prefixes = argv[i + 1]
        .split(',')
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean);
      i += 1;
      continue;
    }
  }

  return { inputPath, vehicleKey, prefixes };
}

function normalizeGroupEntry(raw: string): { group: string; subgroup: string } {
  const normalized = raw.trim();
  if (!normalized) {
    return { group: 'unknown', subgroup: 'unknown' };
  }

  const parts = normalized
    .split(/>|\/|::|:/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return { group: 'unknown', subgroup: 'unknown' };
  }
  if (parts.length === 1) {
    return { group: parts[0], subgroup: '_default' };
  }
  return { group: parts[0], subgroup: parts[1] };
}

function getGroups(rawRecord: PartRecord): string[] {
  const groups = rawRecord.hierarchy?.groups;
  if (!Array.isArray(groups)) {
    return [];
  }
  return groups
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
}

function migrateRecord(rawRecord: PartRecord): MigratedPartRecord {
  const groups = getGroups(rawRecord);
  const existingHierarchy =
    rawRecord.hierarchy && typeof rawRecord.hierarchy === 'object' ? rawRecord.hierarchy : {};

  return {
    ...rawRecord,
    hierarchy: {
      ...existingHierarchy,
      groups,
    },
    enrichment: {
      price: null,
      availability: UNKNOWN_AVAILABILITY,
      lastCheckedAt: null,
    },
  };
}

async function writeLine(stream: WriteStream, line: string): Promise<void> {
  if (stream.write(line)) {
    return;
  }
  await once(stream, 'drain');
}

async function run(): Promise<void> {
  const { inputPath, vehicleKey, prefixes } = parseArgs(process.argv.slice(2));
  const baseDir = resolve(process.cwd(), 'data/vehicles', vehicleKey, 'index');
  const prefixDir = resolve(baseDir, 'prefix');
  const partsNdjsonPath = resolve(baseDir, 'parts.ndjson');
  const groupsJsonPath = resolve(baseDir, 'groups.json');

  await mkdir(prefixDir, { recursive: true });

  const partsStream = createWriteStream(partsNdjsonPath, { encoding: 'utf-8' });
  const prefixStreams = new Map<string, WriteStream>();
  for (const prefix of prefixes) {
    prefixStreams.set(prefix, createWriteStream(resolve(prefixDir, `${prefix}.ndjson`), { encoding: 'utf-8' }));
  }

  const prefixCounts: Record<string, number> = Object.fromEntries(prefixes.map((prefix) => [prefix, 0]));
  const groupIndex: GroupIndex = {};
  let totalParts = 0;

  let inItemsArray = false;
  let searchBuffer = '';
  let capturingObject = false;
  let objectBuffer = '';
  let objectDepth = 0;
  let inString = false;
  let escaped = false;

  async function processObject(jsonObjectText: string): Promise<void> {
    const rawRecord = JSON.parse(jsonObjectText) as PartRecord;
    const record = migrateRecord(rawRecord);
    totalParts += 1;

    await writeLine(partsStream, `${JSON.stringify(record)}\n`);

    for (const groupEntryRaw of record.hierarchy.groups) {
      const { group, subgroup } = normalizeGroupEntry(groupEntryRaw);
      if (!groupIndex[group]) {
        groupIndex[group] = {};
      }
      groupIndex[group][subgroup] = (groupIndex[group][subgroup] ?? 0) + 1;
    }

    for (const prefix of prefixes) {
      if (!record.partNumber.startsWith(prefix)) {
        continue;
      }

      prefixCounts[prefix] += 1;
      const prefixStream = prefixStreams.get(prefix);
      if (!prefixStream) {
        continue;
      }
      await writeLine(
        prefixStream,
        `${JSON.stringify({
          partNumber: record.partNumber,
          name: record.name ?? '',
          url: record.url ?? '',
        })}\n`,
      );
    }

    if (totalParts % 10000 === 0) {
      console.log(`[migrate] processed=${totalParts}`);
    }
  }

  async function consumeArrayFragment(fragment: string): Promise<void> {
    for (let i = 0; i < fragment.length; i += 1) {
      const ch = fragment[i];

      if (capturingObject) {
        objectBuffer += ch;

        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (ch === '\\') {
            escaped = true;
            continue;
          }
          if (ch === '"') {
            inString = false;
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === '{') {
          objectDepth += 1;
          continue;
        }
        if (ch === '}') {
          objectDepth -= 1;
          if (objectDepth === 0) {
            capturingObject = false;
            await processObject(objectBuffer);
            objectBuffer = '';
          }
        }
        continue;
      }

      if (ch === '{') {
        capturingObject = true;
        objectBuffer = '{';
        objectDepth = 1;
        inString = false;
        escaped = false;
        continue;
      }

      if (ch === ']') {
        // End of items array.
        return;
      }
    }
  }

  const inputStream = createReadStream(inputPath, { encoding: 'utf-8' });
  console.log(`[migrate] input=${inputPath}`);
  console.log(`[migrate] vehicleKey=${vehicleKey}`);
  console.log(`[migrate] prefixes=${prefixes.join(',')}`);

  for await (const chunk of inputStream) {
    const textChunk = String(chunk);

    if (!inItemsArray) {
      searchBuffer += textChunk;
      const itemsKeyIndex = searchBuffer.indexOf('"items"');
      if (itemsKeyIndex === -1) {
        if (searchBuffer.length > 1024) {
          searchBuffer = searchBuffer.slice(-1024);
        }
        continue;
      }

      const arrayStartIndex = searchBuffer.indexOf('[', itemsKeyIndex);
      if (arrayStartIndex === -1) {
        if (searchBuffer.length > 8192) {
          searchBuffer = searchBuffer.slice(itemsKeyIndex);
        }
        continue;
      }

      inItemsArray = true;
      const afterArrayStart = searchBuffer.slice(arrayStartIndex + 1);
      searchBuffer = '';
      await consumeArrayFragment(afterArrayStart);
      continue;
    }

    await consumeArrayFragment(textChunk);
  }

  partsStream.end();
  for (const stream of prefixStreams.values()) {
    stream.end();
  }

  await Promise.all([finished(partsStream), ...Array.from(prefixStreams.values(), (stream) => finished(stream))]);
  await writeFile(groupsJsonPath, `${JSON.stringify(groupIndex, null, 2)}\n`, 'utf-8');

  console.log(`[migrate] total parts=${totalParts}`);
  for (const prefix of prefixes) {
    console.log(`[migrate] prefix ${prefix}=${prefixCounts[prefix] ?? 0}`);
  }
  console.log(`[migrate] wrote ${partsNdjsonPath}`);
  console.log(`[migrate] wrote ${groupsJsonPath}`);
}

void run().catch((error) => {
  console.error('[migrate] failed', error);
  process.exitCode = 1;
});
