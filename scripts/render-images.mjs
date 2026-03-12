import 'dotenv/config';

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import fg from 'fast-glob';
import sharp from 'sharp';

const API_URL = 'https://api.openai.com/v1/images/edits';
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1500;
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

function fail(message) {
  throw new Error(message);
}

function parseSize(size) {
  const match = /^(\d+)x(\d+)$/.exec(String(size).trim());
  if (!match) {
    fail(`Invalid api.size value "${size}". Expected WIDTHxHEIGHT.`);
  }

  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10),
  };
}

async function loadJson(filePath) {
  const raw = await readFile(filePath, 'utf8');

  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(
      `Failed to parse JSON at ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function validateConfig(config, configPath) {
  if (!config || typeof config !== 'object') {
    fail(`Invalid config in ${configPath}. Expected an object.`);
  }

  if (!config.model) {
    fail(`Missing "model" in ${configPath}.`);
  }

  if (!config.inputGlob) {
    fail(`Missing "inputGlob" in ${configPath}.`);
  }

  if (!config.outDir) {
    fail(`Missing "outDir" in ${configPath}.`);
  }

  if (!config.promptFile) {
    fail(`Missing "promptFile" in ${configPath}.`);
  }

  if (!config.api?.size) {
    fail(`Missing "api.size" in ${configPath}.`);
  }

  if (!config.post?.finalCanvas?.width || !config.post?.finalCanvas?.height) {
    fail(`Missing "post.finalCanvas" in ${configPath}.`);
  }
}

async function loadPrompt(promptPath) {
  const prompt = (await readFile(promptPath, 'utf8')).trim();
  if (!prompt) {
    fail(`Prompt file is empty: ${promptPath}`);
  }
  return prompt;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseErrorResponse(response) {
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    try {
      const data = await response.json();
      const message = data?.error?.message;
      return message ? `${response.status} ${response.statusText}: ${message}` : JSON.stringify(data);
    } catch {
      return `${response.status} ${response.statusText}`;
    }
  }

  try {
    const text = await response.text();
    return text ? `${response.status} ${response.statusText}: ${text}` : `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

async function requestEditedImage({ apiKey, config, prompt, imagePath }) {
  const imageBuffer = await readFile(imagePath);
  const form = new FormData();

  form.append('model', String(config.model));
  form.append('prompt', prompt);
  form.append('size', String(config.api.size));
  form.append('output_format', String(config.api.output_format));
  form.append('background', String(config.api.background));
  form.append('input_fidelity', String(config.api.input_fidelity));
  form.append('n', String(config.api.n));
  form.append('image', new File([imageBuffer], path.basename(imagePath), { type: 'image/png' }));

  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    attempt += 1;

    let response;

    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
        signal: AbortSignal.timeout(180000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= MAX_RETRIES) {
        fail(`Network error after ${attempt} attempts: ${message}`);
      }

      const delayMs = INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
      console.warn(
        `[render] transient network error for ${path.basename(imagePath)} (attempt ${attempt}/${MAX_RETRIES}): ${message}. Retrying in ${delayMs}ms.`,
      );
      await sleep(delayMs);
      continue;
    }

    if (response.ok) {
      const payload = await response.json();
      const b64 = payload?.data?.[0]?.b64_json;
      if (!b64) {
        fail(`OpenAI response for ${path.basename(imagePath)} did not include data[0].b64_json.`);
      }
      return Buffer.from(b64, 'base64');
    }

    const shouldRetry = response.status === 429 || response.status >= 500;
    const message = await parseErrorResponse(response);

    if (!shouldRetry || attempt >= MAX_RETRIES) {
      fail(`OpenAI Images API request failed for ${path.basename(imagePath)}: ${message}`);
    }

    const delayMs = INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
    console.warn(
      `[render] retrying ${path.basename(imagePath)} after ${message} (attempt ${attempt}/${MAX_RETRIES}, waiting ${delayMs}ms).`,
    );
    await sleep(delayMs);
  }

  fail(`Exhausted retries for ${path.basename(imagePath)}.`);
}

async function postprocessImage(buffer, postConfig) {
  const finalCanvas = postConfig.finalCanvas;
  let workingBuffer = buffer;

  if (postConfig.trim) {
    workingBuffer = await sharp(workingBuffer)
      .trim(postConfig.trimThreshold)
      .png()
      .toBuffer();
  }

  if (postConfig.marginPx > 0) {
    workingBuffer = await sharp(workingBuffer)
      .extend({
        top: postConfig.marginPx,
        right: postConfig.marginPx,
        bottom: postConfig.marginPx,
        left: postConfig.marginPx,
        background: WHITE,
      })
      .png()
      .toBuffer();
  }

  const metadata = await sharp(workingBuffer).metadata();
  if (!metadata.width || !metadata.height) {
    fail('Unable to determine post-processed image dimensions.');
  }

  if (metadata.width > finalCanvas.width || metadata.height > finalCanvas.height) {
    fail(
      `Post-processed image is ${metadata.width}x${metadata.height}, which exceeds the final ${finalCanvas.width}x${finalCanvas.height} canvas. Resizing is disabled.`,
    );
  }

  let outputBuffer = await sharp(workingBuffer)
    .resize({
      width: finalCanvas.width,
      height: finalCanvas.height,
      fit: 'contain',
      position: 'centre',
      background: WHITE,
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();

  if (postConfig.enforcePureWhite) {
    outputBuffer = await sharp(outputBuffer)
      .flatten({ background: WHITE })
      .png()
      .toBuffer();
  }

  return outputBuffer;
}

async function ensureInputsDirectory(config) {
  const globBase = path.dirname(config.inputGlob);
  const inputDir = path.resolve(process.cwd(), globBase);
  let created = false;

  try {
    await access(inputDir);
  } catch {
    created = true;
  }

  await mkdir(inputDir, { recursive: true });
  return { created, inputDir };
}

async function main() {
  const configArg = process.argv[2] ?? 'mb_catalog.config.json';
  const configPath = path.resolve(process.cwd(), configArg);
  const config = await loadJson(configPath);
  validateConfig(config, configPath);

  const expectedSize = parseSize(config.api.size);
  const finalCanvas = config.post.finalCanvas;
  if (expectedSize.width !== finalCanvas.width || expectedSize.height !== finalCanvas.height) {
    fail(
      `Config mismatch: api.size is ${config.api.size} but post.finalCanvas is ${finalCanvas.width}x${finalCanvas.height}. They must match.`,
    );
  }

  const { created: createdInputDir, inputDir } = await ensureInputsDirectory(config);
  const inputPaths = await fg(config.inputGlob, {
    absolute: true,
    onlyFiles: true,
    cwd: process.cwd(),
  });

  if (inputPaths.length === 0) {
    console.log(`[render] no input files found for "${config.inputGlob}".`);
    if (createdInputDir) {
      console.log(`[render] created missing input directory: ${inputDir}`);
    }
    console.log(`[render] put source PNGs in ${inputDir} with names like group-001.png, then rerun "npm run render".`);
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    fail('Missing OPENAI_API_KEY. Copy .env.example to .env, set OPENAI_API_KEY, and rerun.');
  }

  const promptPath = path.resolve(process.cwd(), config.promptFile);
  const prompt = await loadPrompt(promptPath);
  const outDir = path.resolve(process.cwd(), config.outDir);
  await mkdir(outDir, { recursive: true });

  let succeeded = 0;
  const failures = [];

  console.log(`[render] starting batch for ${inputPaths.length} file(s).`);
  console.log(`[render] prompt=${promptPath}`);
  console.log(`[render] output=${outDir}`);

  for (const [index, inputPath] of inputPaths.entries()) {
    const basename = path.basename(inputPath);
    const outPath = path.join(outDir, basename);

    console.log(`[render] [${index + 1}/${inputPaths.length}] ${basename}`);

    try {
      const editedBuffer = await requestEditedImage({ apiKey, config, prompt, imagePath: inputPath });
      const finalBuffer = await postprocessImage(editedBuffer, config.post);
      await writeFile(outPath, finalBuffer);
      succeeded += 1;
      console.log(`✅ ${basename} -> ${path.relative(process.cwd(), outPath)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ inputPath, message });
      console.error(`❌ ${basename}: ${message}`);
    }
  }

  console.log(
    `[render] finished: ${succeeded} succeeded, ${failures.length} failed, ${inputPaths.length} total.`,
  );

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`[render] failure ${path.basename(failure.inputPath)}: ${failure.message}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[render] fatal: ${message}`);
  process.exitCode = 1;
});
