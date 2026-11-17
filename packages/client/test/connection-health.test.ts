import { afterEach, expect, it } from 'bun:test';
import { PROTOCOL_VERSION, TERMINAL_FRAME, encodeTerminalFrame } from '@kemiri/protocol';
import { HarnessClient } from '../src/client.ts';
import type { HarnessWebSocket } from '../src/websocket.ts';

/** A browser-shaped socket: a black hole neither responds nor delivers a close event. */
class SilentSocket implements HarnessWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  silent = false;
  closed = false;
  checks = 0;
  openedSession: string | undefined;
  inputs = 0;
  constructor() { queueMicrotask(() => this.onopen?.()); }
  send(data: string | Uint8Array): void {
    if (this.silent) return;
    if (typeof data !== 'string') { this.inputs++; return; }
    const request = JSON.parse(data);
    if (request.type === 'server.status') this.checks++;
    if (request.type === 'terminal.open') this.openedSession = request.session ?? 'demo-1';
    const response = request.type === 'hello'
      ? { protocolVersion: PROTOCOL_VERSION, server: { name: 'test', version: 'test' }, features: ['terminal'] }
      : request.type === 'terminal.open'
        ? { terminalId: 1, session: this.openedSession, created: request.session === undefined, cols: request.cols, rows: request.rows }
        // Even an old backend's unknown_request response proves liveness.
        : request.type === 'server.status' ? { type: 'error', error: { code: 'unknown_request', message: 'Unsupported' } } : {};
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ ...request, ...response }) }));
  }
  close(): void { this.closed = true; /* deliberately no close event */ }
}
const clients: HarnessClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function setup(intervalMs = 20, timeoutMs = 30) {
  const sockets: SilentSocket[] = [];
  const client = new HarnessClient({ url: 'ws://localhost/ws',
    heartbeat: { intervalMs, timeoutMs }, reconnect: { initialDelayMs: 10, maxDelayMs: 10, jitter: 0 },
    webSocketFactory: () => { const socket = new SilentSocket(); sockets.push(socket); return socket; },
  });
  clients.push(client);
  return { client, sockets };
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out'); await Bun.sleep(5); }
}

it('recovers a silent socket without a close event and reattaches the same terminal', async () => {
  const { client, sockets } = setup();
  const terminal = client.openTerminal({ cols: 80, rows: 24 });
  const states: string[] = [];
  terminal.onState(state => states.push(state.status));
  let resets = 0;
  let output = 0;
  terminal.onReset(() => resets++);
  terminal.onOutput(bytes => { output += bytes.length; });
  await waitFor(() => terminal.state.status === 'attached');
  const first = sockets[0]!;
  first.silent = true;
  // Unrelated incoming output must not hide a broken outgoing/request path.
  const chatter = setInterval(() => first.onmessage?.({ data: encodeTerminalFrame(TERMINAL_FRAME.output, 1, new Uint8Array([65])) }), 5);
  try {
    await waitFor(() => sockets.length === 2 && terminal.state.status === 'attached');
  } finally { clearInterval(chatter); }
  expect(first.closed).toBe(true);
  expect(states).toContain('reconnecting');
  expect(sockets[1]!.openedSession).toBe('demo-1');
  expect(resets).toBe(1);
  const previousOutput = output;
  first.onmessage?.({ data: encodeTerminalFrame(TERMINAL_FRAME.output, 1, new Uint8Array([65])) });
  first.onclose?.({ code: 1006 });
  expect(output).toBe(previousOutput);
  expect(client.state.status).toBe('ready');
  expect(terminal.write('echo recovered\r')).toBe(true);
  expect(sockets[1]!.inputs).toBe(1);
  await terminal.detach();
});

it('accepts a correlated error as a live round trip, and coalesces resume checks', async () => {
  const { client, sockets } = setup(10000);
  await client.whenReady();
  await Promise.all([client.checkConnection(), client.checkConnection()]);
  expect(sockets[0]!.checks).toBe(1);
  expect(client.state.status).toBe('ready');
  expect(sockets.length).toBe(1);
});

it('does not reconnect after the user closes during a pending check', async () => {
  const { client, sockets } = setup(10000);
  await client.whenReady();
  sockets[0]!.silent = true;
  const checking = client.checkConnection();
  client.close();
  await checking;
  await Bun.sleep(80);
  expect(client.state.status).toBe('closed');
  expect(sockets.length).toBe(1);
});
