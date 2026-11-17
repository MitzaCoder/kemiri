/** Synthetic terminal fixture. Run under env -i with temporary HOME/XDG; never uses live terminal sockets. */
import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createSetup, TestClient } from '../test/support.ts';

const root = await mkdtemp(join(tmpdir(), 'terminal-freeze-'));
await mkdir(join(root, 'home'), { recursive: true });
const setup = await createSetup({ allowedOrigins: ['http://localhost:5295'],
  terminals: { multiplexer: 'zellij', survive: 'off', configFile: join(root, 'terminal.kdl'),
    env: { PATH: process.env.PATH, USER: process.env.USER, HOME: join(root, 'home'),
      SHELL: Bun.which('bash')!, PS1: '$ ', ZELLIJ_SOCKET_DIR: join(root, 'sockets'),
      XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'),
      XDG_RUNTIME_DIR: join(root, 'runtime') } }, log: console.log,
});
await Bun.write('/tmp/terminal-freeze-demo.json', JSON.stringify({ url: setup.server.url, root, pid: process.pid }));
console.log('Terminal fixture ready');
process.on('SIGTERM', async () => {
  // This server can only list/kill sessions under the fixture's private socket directory.
  const client = await TestClient.open(setup.server);
  await client.hello();
  const listing = await client.request({ type: 'terminal.list' });
  if (listing.type === 'terminal.list') for (const session of listing.sessions) {
    await client.request({ type: 'terminal.kill', session: session.name });
  }
  client.close();
  await setup.cleanup();
  await rm(root, { recursive: true, force: true });
  process.exit();
});
await new Promise(() => {});
