// One lock per user and installed product, held by every installed QA check
// (smoke-installed-deterministic and the capture-lifecycle check) from its
// preflight through its cleanup, so two checks in any worktrees never install
// the same product's registry keys at once.
//
// The pipe's name comes from the SID of the user of the process's access
// token and the product name, never from USERNAME, USERDOMAIN or any other
// environment variable: two processes of one Windows account always meet on
// the same pipe, however they were started.
//
// The lock is a named pipe the holder listens on. Windows frees the pipe when
// the holder's process ends, normally or not, so the lock leaves nothing on
// disk and a dead holder never blocks the next run. A run that finds the pipe
// taken asks the holder which check, process ID and process start time hold
// it, and names them in its refusal.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { isAbsolute, join } from 'node:path';

import { Observable } from 'rxjs';

export interface InstalledProductLock {
  readonly name: string;
  readonly release: () => Observable<undefined>;
}

/** The user SID in the answer of `whoami /user /fo csv /nh`: `"domain\\user","S-1-5-21-..."`. */
export function parseWhoamiUserSid(output: string): string {
  const sid = /,"(S-1-[0-9]+(?:-[0-9]+)+)"$/u.exec(output.trim())?.[1];
  if (!sid) throw new Error('The current user\'s SID could not be read, so the installed product lock is not taken.');
  return sid;
}

let userSid: string | undefined;

/**
 * The SID of the user of this process's access token, asked from Windows
 * (whoami.exe in the Windows directory). The environment only says where the
 * Windows directory is; without it there is no SID and no lock, never a
 * different lock.
 */
export function currentUserSid(): string {
  if (userSid !== undefined) return userSid;
  const systemRoot = Object.entries(process.env).find(([name]) => name.toUpperCase() === 'SYSTEMROOT')?.[1];
  if (!systemRoot || !isAbsolute(systemRoot)) {
    throw new Error('The Windows directory is not known (SystemRoot), so the installed product lock is not taken.');
  }
  const answer = execFileSync(join(systemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8', env: { SystemRoot: systemRoot }, timeout: 30_000, windowsHide: true,
  });
  userSid = parseWhoamiUserSid(answer);
  return userSid;
}

/** The pipe of the lock: the same for one user (by SID) and product in every worktree and environment. */
export function installedProductLockName(productName: string, sid = currentUserSid()): string {
  if (!productName.trim()) throw new Error('An installed product lock needs the product name.');
  if (!/^S-1-[0-9]+(?:-[0-9]+)+$/u.test(sid)) throw new Error('An installed product lock needs the user\'s SID.');
  const key = createHash('sha256').update(`${sid}\n${productName}`).digest('hex').slice(0, 32);
  return `\\\\.\\pipe\\capture-installed-check-${key}`;
}

/** What the holder answers: which check holds the lock, and its process. */
export function lockHolderAnswer(check: string, pid = process.pid, startedAt = processStartedAt()): string {
  return `${JSON.stringify({ check, pid, startedAt })}\n`;
}

function processStartedAt(): string {
  return new Date(Date.now() - process.uptime() * 1_000).toISOString();
}

/** The refusal of a run that found the lock taken, from the holder's answer if it gave one. */
export function lockTakenMessage(productName: string, answer: string | null): string {
  let holder = 'another process';
  try {
    const value = answer ? JSON.parse(answer) as { check?: unknown; pid?: unknown; startedAt?: unknown } : null;
    if (value && typeof value.check === 'string' && Number.isSafeInteger(value.pid) && typeof value.startedAt === 'string') {
      holder = `${value.check} (process ${value.pid}, started ${value.startedAt})`;
    }
  } catch {
    // An unreadable answer names no holder.
  }
  return `Another installed QA check holds the lock for "${productName}": ${holder}. Wait until it ends; the lock is freed when its process ends.`;
}

function askHolder(name: string): Observable<string | null> {
  return new Observable<string | null>((subscriber) => {
    let answer = '';
    const socket = net.connect(name);
    const finish = (value: string | null) => {
      socket.destroy();
      subscriber.next(value);
      subscriber.complete();
    };
    socket.setTimeout(2_000, () => finish(null));
    socket.on('data', (chunk: Buffer) => {
      answer += chunk.toString('utf8');
      if (answer.length > 4_096) finish(null);
    });
    socket.once('end', () => finish(answer.trim() || null));
    socket.once('error', () => finish(null));
    return () => socket.destroy();
  });
}

export function acquireInstalledProductLock(
  productName: string,
  check: string,
  name = installedProductLockName(productName),
): Observable<InstalledProductLock> {
  return new Observable<InstalledProductLock>((subscriber) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => undefined);
      socket.end(lockHolderAnswer(check));
    });
    // The lock must not keep the process alive; its owner does.
    server.unref();
    let held = false;
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EADDRINUSE') {
        subscriber.error(new Error(`The installed product lock could not be taken: ${error.message}`));
        return;
      }
      askHolder(name).subscribe((answer) => subscriber.error(new Error(lockTakenMessage(productName, answer))));
    });
    server.listen(name, () => {
      held = true;
      subscriber.next({
        name,
        release: () => new Observable<undefined>((released) => {
          const done = () => {
            released.next(undefined);
            released.complete();
          };
          if (server.listening) server.close(done);
          else done();
        }),
      });
      subscriber.complete();
    });
    return () => {
      if (!held) server.close();
    };
  });
}
