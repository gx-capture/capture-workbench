import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import test from 'node:test';
import { defer, firstValueFrom, of, throwError } from 'rxjs';

import { withOwnedRuntime } from './deterministic-smoke.ts';
import { validateReady } from './deterministic-http.ts';

test('a real owned child and its pipe handles stop after a readiness assertion fails', { timeout: 15_000 }, async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.stdout?.destroy();
    child.stderr?.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  await assert.rejects(firstValueFrom(withOwnedRuntime(child, () => {
    validateReady({ status: 200, body: { ready: true } });
    return of(undefined);
  })));
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(child.stdout?.destroyed, true);
  assert.equal(child.stderr?.destroyed, true);
});

test('synchronous readiness assertion stops the owned runtime before reporting failure', async () => {
  const events: string[] = [];
  const child = new ChildProcess();
  const failure = new Error('Readiness keys differ.');
  await assert.rejects(firstValueFrom(withOwnedRuntime(child, () => {
    events.push('validate');
    throw failure;
  }, (owned) => defer(async () => {
    assert.equal(owned, child);
    await Promise.resolve();
    events.push('stopped');
  }))), (error) => error === failure);
  assert.deepEqual(events, ['validate', 'stopped']);
});

test('HTTP failure and evidence-write failure both await runtime cleanup', async () => {
  for (const message of ['HTTP capture failed.', 'Evidence write failed.']) {
    let stopped = false;
    await assert.rejects(firstValueFrom(withOwnedRuntime(new ChildProcess(),
      () => throwError(() => new Error(message)),
      () => defer(async () => { stopped = true; }),
    )), (error) => error instanceof Error && error.message === message);
    assert.equal(stopped, true);
  }
});

test('successful work also stops the runtime before returning evidence', async () => {
  let stopped = false;
  const result = await firstValueFrom(withOwnedRuntime(new ChildProcess(), () => of('report'),
    () => defer(async () => { stopped = true; }),
  ));
  assert.equal(result, 'report');
  assert.equal(stopped, true);
});

test('cleanup failure preserves the original assertion as a nested error', async () => {
  const failure = new Error('Readiness keys differ.');
  const cleanup = new Error('Owned runtime did not stop.');
  await assert.rejects(firstValueFrom(withOwnedRuntime(new ChildProcess(),
    () => { throw failure; }, () => throwError(() => cleanup),
  )), (error) => error instanceof AggregateError && error.errors[0] === failure && error.errors[1] === cleanup);
});
