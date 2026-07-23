import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { join, resolve } from 'node:path';

import { DETERMINISTIC_MAX_UPLOAD_BYTES } from './constants/deterministic.ts';
import { appRoot, stagedExecutable } from './stage-runtime.ts';
import { waitForReady } from './deterministic-http.ts';

const workspaceRoot = resolve(appRoot, '..', '..');
const runtimeData = join(
  workspaceRoot,
  'tmp',
  'capture-workbench-desktop',
  'smoke',
  'runtime-data',
);
const maxUploadBytes = DETERMINISTIC_MAX_UPLOAD_BYTES;

export async function launchReadyRuntime() {
  const failures = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const runtimePort = await reservePort();
    const ollamaPort = await reservePort(runtimePort);
    const token = randomBytes(32).toString('hex');
    const host = `127.0.0.1:${runtimePort}`;
    const origin = 'http://tauri.localhost';
    const child = spawn(
      stagedExecutable,
      ['serve', '--host', '127.0.0.1', '--port', String(runtimePort)],
      {
        cwd: resolve(stagedExecutable, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          CAPTURE_HOST: '127.0.0.1',
          CAPTURE_PORT: String(runtimePort),
          CAPTURE_API_TOKEN: token,
          CAPTURE_ALLOWED_HOSTS: host,
          CAPTURE_ALLOWED_ORIGINS: origin,
          CAPTURE_ENABLE_API_DOCS: 'false',
          CAPTURE_APP_DATA_DIR: join(runtimeData, 'capture'),
          CAPTURE_STRUCTURING_PROVIDER: 'fake',
          CAPTURE_RETENTION_HOURS: '24',
          CAPTURE_MAX_UPLOAD_BYTES: String(maxUploadBytes),
          CAPTURE_OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
          CAPTURE_OLLAMA_APP_DATA: join(runtimeData, 'ollama'),
          CAPTURE_OLLAMA_PID_FILE: join(runtimeData, 'ollama', 'ollama.pid'),
          CAPTURE_OLLAMA_MODEL: 'qwen3.5:4b',
          CAPTURE_OLLAMA_PROFILE_ID:
            'capture-workbench-qwen3.5-4b-structure-v1',
          OLLAMA_HOST: `127.0.0.1:${ollamaPort}`,
          OLLAMA_MODELS: join(runtimeData, 'ollama', 'models'),
        },
      },
    );
    const output = captureChildOutput(child);
    try {
      const ready = await waitForReady({ runtimePort, host, origin, token, child });
      return { child, ready, runtimePort, ollamaPort, token, host, origin };
    } catch (error) {
      await terminateOwnedTree(child);
      const childOutput = redactChildOutput(output.text(), token);
      failures.push(
        `attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}` +
          (childOutput ? `; child output: ${childOutput}` : ''),
      );
    }
  }
  throw new Error(
    `Deterministic runtime failed readiness after 3 owned launch attempts: ${failures.join(' | ')}`,
  );
}

function redactChildOutput(value, token) {
  return value
    .replaceAll(token, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, 'Bearer [redacted]');
}

function captureChildOutput(child) {
  const chunks = [];
  const collect = (chunk) => {
    if (chunks.reduce((total, item) => total + item.length, 0) < 8_192) {
      chunks.push(Buffer.from(chunk));
    }
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  return {
    text: () => Buffer.concat(chunks).toString('utf8').trim().slice(0, 8_192),
  };
}


function reservePort(excluded) {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
        } else if (port === 0 || port === excluded) {
          reservePort(excluded).then(resolvePromise, reject);
        } else {
          resolvePromise(port);
        }
      });
    });
  });
}

export async function terminateOwnedTree(child) {
  if (!child.pid || child.exitCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    child.kill('SIGTERM');
  }
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
  ]);
}
