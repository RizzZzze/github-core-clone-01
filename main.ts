// The entry's life: bind an ephemeral port, register it with the env, wait until
// the env says the trial is done, then exit 0. The server itself lives in app.ts;
// this file only owns the conversation with the env.
//
//   MAKEFUN_ENV_URL names the env's origin. Without it there is nothing to talk
//   to, so the process exits 1 at once. The port is always 0 (kernel-chosen);
//   8080 belongs to the env and is never bound here.

import { createApp } from './app.ts';

const ENV = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set: no env to register with\n');
  process.exit(1);
}

const CALL_TIMEOUT_MS = 30_000;
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_FIRST_MS * 2 ** Math.min(attempt, 8));
}

async function postRegister(port: number): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(`${ENV}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await wait(backoffMs(attempt));
    attempt += 1;
  }
}

async function pollDone(): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(`${ENV}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet: not done, poll again.
    }
    await wait(backoffMs(attempt));
    attempt += 1;
  }
}

async function boot(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Error('server did not bind a TCP port');
  process.stdout.write(`[forge] listening on ${bound.port}\n`);
  await postRegister(bound.port);
  process.stdout.write('[forge] registered; waiting for done\n');
  await pollDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await boot();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
