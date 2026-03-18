import { spawn } from 'node:child_process';

const children = [];
let shuttingDown = false;

function resolveCommand(command) {
  return process.platform === 'win32' ? `${command}.cmd` : command;
}

function shutdownAndExit(code = 1) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
  process.exit(code);
}

function spawnCommand(command, args, label, { tracked = true } = {}) {
  const child = spawn(resolveCommand(command), args, {
    stdio: 'inherit',
    env: process.env,
  });

  if (tracked) {
    children.push(child);
  }

  child.on('exit', (code, signal) => {
    if (!tracked || shuttingDown) {
      return;
    }

    if (signal) {
      console.error(`${label} stopped with signal ${signal}.`);
    } else if (code !== 0) {
      console.error(`${label} exited with code ${code}.`);
    }

    shutdownAndExit(code ?? 1);
  });

  return child;
}

async function runInitialEleventyBuild() {
  await new Promise((resolve, reject) => {
    const child = spawnCommand('npm', ['run', 'build:data'], 'build:data', { tracked: false });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`build:data failed with code ${code ?? 1}`));
    });
  });

  await new Promise((resolve, reject) => {
    const child = spawnCommand('npm', ['run', 'build:browser'], 'browser build', { tracked: false });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`build:browser failed with code ${code ?? 1}`));
    });
  });

  await new Promise((resolve, reject) => {
    const child = spawnCommand('eleventy', [], '11ty initial build', { tracked: false });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`11ty initial build failed with code ${code ?? 1}`));
    });
  });
}

function registerSignalHandlers() {
  const handleSignal = () => shutdownAndExit(0);
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
}

try {
  await runInitialEleventyBuild();
  registerSignalHandlers();

  spawnCommand('tsc', ['-p', 'tsconfig.browser.json', '--watch', '--preserveWatchOutput'], 'browser watch');
  spawnCommand('eleventy', ['--serve'], '11ty serve');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
