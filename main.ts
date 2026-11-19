import { createApp } from './app.ts';

// The environment owns the trial clock and chooses when the entry can stop.
const origin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (!origin) {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const pause = (attempt: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, Math.min(2_000, 250 * 2 ** Math.min(attempt, 8)));
});
const deadline = () => AbortSignal.timeout(30_000);

async function registerPort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: deadline(),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register answered HTTP ')) throw error;
    }
    await pause(attempt);
  }
}

async function pollCompletion(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${origin}/done`, { signal: deadline() });
      if (response.ok && (await response.json()).done === true) return;
    } catch {
      // A failed poll leaves the completion state unknown. Retry on the normal schedule.
    }
    await pause(attempt);
  }
}

try {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, resolve);
  });
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);
  await registerPort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await pollCompletion();
  server.close();
  process.stdout.write('[entry] done\n');
  process.exit(0);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[entry] ${detail}\n`);
  process.exit(1);
}
