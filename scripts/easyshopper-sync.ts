#!/usr/bin/env node
/**
 * EASY Shopper sync worker (runs on the laptop that has the phone).
 *
 * Watches the groceries backend for a "Sync now" request, runs the UI capture and
 * uploads the result. This is what makes the button in the web UI mean something:
 * the server can never reach the phone, but it can leave a flag for this worker.
 *
 *   npx tsx scripts/easyshopper-sync.ts --once          # one pass, then exit
 *   npx tsx scripts/easyshopper-sync.ts                 # loop (default every 60 s)
 *   GROCERIES_URL=http://localhost:3000 GROCERIES_EMAIL=… GROCERIES_PASSWORD=… \
 *     npx tsx scripts/easyshopper-sync.ts --interval 120
 *
 * Credentials are the groceries account's own; nothing extra to provision.
 */
import { readFileSync } from 'node:fs';
import { capture } from './easyshopper-capture';
import type { CapturedSession } from '../src/lib/easyshopper/capture-parse';

interface SyncStatus {
  requestedAt: string | null;
  lastImportAt: string | null;
  lastPurchaseAt: string | null;
  sessions: number;
}

interface Args {
  server: string;
  email: string;
  password: string;
  /** Session JWT from the browser's `token` cookie; avoids handling a password. */
  token: string;
  intervalSeconds: number;
  once: boolean;
  serial?: string;
  /** Upload an existing capture instead of reading the phone again. */
  fromFile?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    server: process.env.GROCERIES_URL ?? 'http://localhost:3000',
    email: process.env.GROCERIES_EMAIL ?? '',
    password: process.env.GROCERIES_PASSWORD ?? '',
    token: process.env.GROCERIES_TOKEN ?? '',
    intervalSeconds: 60,
    once: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--once') args.once = true;
    else if (arg === '--server') args.server = argv[++i];
    else if (arg === '--email') args.email = argv[++i];
    else if (arg === '--password') args.password = argv[++i];
    else if (arg === '--token') args.token = argv[++i];
    else if (arg === '--interval') args.intervalSeconds = Number(argv[++i]);
    else if (arg === '--serial') args.serial = argv[++i];
    else if (arg === '--from-file') args.fromFile = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`
EASY Shopper sync worker

  --once                run a single pass and exit
  --interval <seconds>  poll interval in loop mode (default 60)
  --server <url>        groceries backend (default $GROCERIES_URL or http://localhost:3000)
  --token <jwt>         session token from the browser 'token' cookie (no password)
  --email / --password  groceries login (default $GROCERIES_EMAIL / $GROCERIES_PASSWORD)
  --serial <host:port>  adb serial for the phone
  --from-file <path>    upload a capture already on disk (no phone needed), e.g.
                        ~/.local/share/groceries/easyshopper/purchases.json
`);
      process.exit(0);
    }
  }
  if (!args.token && (!args.email || !args.password)) {
    throw new Error(
      'authenticate with --token <jwt> or --email/--password (or GROCERIES_TOKEN / GROCERIES_EMAIL+GROCERIES_PASSWORD)'
    );
  }
  return args;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cookieHeader(response: Response): string {
  const raw = response.headers.getSetCookie?.() ?? [];
  return raw.map((cookie) => cookie.split(';')[0]).join('; ');
}

class Backend {
  private readonly server: string;
  private cookies = '';
  private csrf = '';

  constructor(server: string) {
    this.server = server.replace(/\/+$/, '');
  }

  /** Reuse a browser session: the API only needs the `token` cookie plus CSRF. */
  async useToken(token: string): Promise<void> {
    this.cookies = `token=${token}`;
    const res = await fetch(`${this.server}/api/session`, { headers: { Cookie: this.cookies } });
    if (!res.ok) throw new Error(`session token rejected (${res.status}) — copy a fresh one from the browser`);
    await this.refreshCsrf();
  }

  async login(email: string, password: string): Promise<void> {
    await this.refreshCsrf();
    const res = await fetch(`${this.server}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: this.cookies, 'x-csrf-token': this.csrf },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
    const setCookies = cookieHeader(res);
    this.cookies = [this.cookies, setCookies].filter(Boolean).join('; ');
    await this.refreshCsrf();
  }

  async refreshCsrf(): Promise<void> {
    const res = await fetch(`${this.server}/api/csrf-token`, { headers: { Cookie: this.cookies } });
    if (!res.ok) throw new Error(`csrf token failed: ${res.status}`);
    this.csrf = ((await res.json()) as { token: string }).token;
    const setCookies = cookieHeader(res);
    if (setCookies) this.cookies = [this.cookies, setCookies].filter(Boolean).join('; ');
  }

  async status(): Promise<SyncStatus> {
    const res = await fetch(`${this.server}/api/easyshopper/sync/status`, { headers: { Cookie: this.cookies } });
    if (!res.ok) throw new Error(`status failed: ${res.status}`);
    return (await res.json()) as SyncStatus;
  }

  async upload(sessions: unknown[]): Promise<{ inserted?: number; updated?: number }> {
    await this.refreshCsrf();
    const res = await fetch(`${this.server}/api/easyshopper/import-purchases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: this.cookies, 'x-csrf-token': this.csrf },
      body: JSON.stringify({ sessions }),
    });
    if (!res.ok) throw new Error(`import failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as { inserted?: number; updated?: number };
  }
}

function readCapture(path: string): CapturedSession[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sessions?: CapturedSession[] };
  const sessions = (parsed.sessions ?? []).filter((session) => session.items?.length > 0);
  if (sessions.length === 0) throw new Error(`no captured sessions in ${path}`);
  return sessions;
}

async function runPass(backend: Backend, args: Args): Promise<boolean> {
  const status = await backend.status();
  if (!status.requestedAt) return false;

  const sessions = args.fromFile
    ? readCapture(args.fromFile)
    : await capture({ serial: args.serial ?? null });
  process.stdout.write(
    args.fromFile
      ? `sync requested at ${status.requestedAt} — uploading ${sessions.length} sessions from ${args.fromFile}\n`
      : `sync requested at ${status.requestedAt} — reading the phone…\n`
  );
  const result = await backend.upload(
    sessions.map((session) => ({
      key: session.key,
      displayWhen: session.displayWhen,
      purchasedAt: session.purchasedAt,
      store: session.store,
      type: session.type,
      paymentMode: session.paymentMode,
      receiptBarcode: session.receiptBarcode,
      itemCount: session.itemCount,
      total: session.total,
      items: session.items,
    }))
  );
  process.stdout.write(
    `uploaded ${sessions.length} sessions (inserted ${result.inserted ?? 0}, updated ${result.updated ?? 0})\n`
  );
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const backend = new Backend(args.server);
  if (args.token) await backend.useToken(args.token);
  else await backend.login(args.email, args.password);
  process.stdout.write(`sync worker ready for ${args.server}\n`);

  if (args.once) {
    const ran = await runPass(backend, args);
    if (!ran) process.stdout.write('nothing requested\n');
    return;
  }

  for (;;) {
    try {
      await runPass(backend, args);
    } catch (error) {
      process.stderr.write(`sync pass failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    await sleep(args.intervalSeconds * 1000);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
