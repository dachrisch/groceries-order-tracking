#!/usr/bin/env node
/**
 * EASY Shopper purchase-history capture (sidecar).
 *
 * Drives a USB/wireless-debugging connected Android phone over `adb` and reads the
 * "My Purchases" screen of the EASY Shopper app through `uiautomator dump`.
 *
 * Why the UI: purchase history lives behind the account bearer token in the app's
 * private storage, which is unreachable without root (see docs/easyshopper-api.md).
 * The purchase screens render everything we need, so we read them as text.
 *
 * Read-only: it taps, scrolls and goes back. Nothing is added, changed or bought.
 *
 * Usage:
 *   npx tsx scripts/easyshopper-capture.ts                    # capture all sessions
 *   npx tsx scripts/easyshopper-capture.ts --limit 2          # smoke test
 *   npx tsx scripts/easyshopper-capture.ts --dry-run          # list sessions only
 *   npx tsx scripts/easyshopper-capture.ts --serial 192.168.178.22:39255
 *
 * Requirements: `adb` on PATH, device authorised, phone UNLOCKED with the EASY
 * Shopper app installed. The script navigates to "My Purchases" itself when it can,
 * otherwise open that screen manually and re-run.
 */
import { execFileSync } from 'node:child_process';
import {
  ITEM_ROW,
  childrenOf,
  mergeSessions,
  valueBelow,
  valueBelowMatching,
  parseItemRow,
  parseListRow,
  parseMoney,
  reconcile,
  type CapturedItem,
  type CapturedSession,
  type UiCell,
} from '../src/lib/easyshopper/capture-parse';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const SHOPPING_SCREEN_TITLES = ['My Purchases', 'Meine Einkäufe'];

interface Node extends UiCell {
  text: string;
  desc: string;
  id: string;
  cls: string;
  clickable: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// ---------------------------------------------------------------- adb plumbing

function adb(serial: string | null, args: string[], timeout = 30_000, attempt = 0): string {
  const base = serial ? ['-s', serial] : [];
  try {
    return execFileSync('adb', [...base, ...args], {
      encoding: 'utf8',
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    // Wireless debugging drops when the phone naps: reconnect and retry before giving up.
    if (attempt >= 2) throw error;
    if (serial?.includes(':')) {
      try {
        execFileSync('adb', ['connect', serial], { encoding: 'utf8', timeout: 15_000, stdio: 'ignore' });
      } catch {
        /* the retry below will surface a persistent failure */
      }
    }
    return adb(serial, args, timeout, attempt + 1);
  }
}

function listDevices(): string[] {
  const out = execFileSync('adb', ['devices'], { encoding: 'utf8' });
  return out
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === 'device')
    .map((parts) => parts[0]);
}

/**
 * Wireless debugging picks a new port whenever it restarts, so a saved host:port goes
 * stale. Fall back to the mDNS service record and connect to whatever port it advertises.
 */
function connectViaMdns(): string | null {
  try {
    const out = execFileSync('adb', ['mdns', 'services'], { encoding: 'utf8', timeout: 15_000 });
    const match = /_adb-tls-connect\._tcp\s+(\d{1,3}(?:\.\d{1,3}){3}:\d+)/.exec(out);
    if (!match) return null;
    execFileSync('adb', ['connect', match[1]], { encoding: 'utf8', timeout: 20_000 });
    return match[1];
  } catch {
    return null;
  }
}

function detectSerial(): string {
  let devices = listDevices();
  if (devices.length === 0) {
    const connected = connectViaMdns();
    if (connected) devices = listDevices();
  }
  if (devices.length === 0) {
    throw new Error('No authorised adb device found. Enable wireless/USB debugging and authorise this host.');
  }
  // Prefer a network transport so the sidecar keeps working while the phone roams the LAN.
  return devices.find((d) => d.includes(':')) ?? devices[0];
}

/** Bring EASY Shopper to the foreground; returns false when the device is locked. */
async function ensureAppForeground(serial: string | null): Promise<boolean> {
  const focus = adb(serial, ['shell', 'dumpsys', 'window']).match(/mCurrentFocus=Window\{\S+ \S+ ([\w.]+)\//);
  if (focus && focus[1] === 'com.pentlandfirth.whizcart') return true;

  // Empty hierarchy with no app nodes means the lockscreen is up.
  const nodes = dump(serial);
  if (nodes.length === 0) return false;

  execFileSync('adb', [...(serial ? ['-s', serial] : []), 'shell', 'monkey', '-p', 'com.pentlandfirth.whizcart', '-c', 'android.intent.category.LAUNCHER', '1'], { stdio: 'ignore' });
  await sleep(2500);
  return true;
}

const ATTR = /([\w:-]+)="([^"]*)"/g;

function decode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export function parseNodes(xml: string): Node[] {
  const nodes: Node[] = [];
  const tag = /<node\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml)) !== null) {
    const attrs: Record<string, string> = {};
    ATTR.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = ATTR.exec(m[1])) !== null) attrs[a[1]] = a[2];
    const bounds = (attrs.bounds ?? '').match(/-?\d+/g)?.map(Number) ?? [];
    if (bounds.length !== 4) continue;
    const text = decode(attrs.text ?? '');
    const desc = decode(attrs['content-desc'] ?? '');
    const id = attrs['resource-id'] ?? '';
    if (!text && !desc) continue;
    if (id.includes('com.android.systemui')) continue;
    nodes.push({
      text,
      desc,
      id,
      cls: (attrs.class ?? '').split('.').pop() ?? '',
      clickable: attrs.clickable === 'true',
      x1: bounds[0],
      y1: bounds[1],
      x2: bounds[2],
      y2: bounds[3],
    });
  }
  return nodes.sort((p, q) => p.y1 - q.y1 || p.x1 - q.x1);
}

function dump(serial: string | null): Node[] {
  adb(serial, ['shell', 'uiautomator', 'dump', '/sdcard/groceries-ui.xml'], 60_000);
  const xml = adb(serial, ['shell', 'cat', '/sdcard/groceries-ui.xml'], 60_000);
  return parseNodes(xml);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(serial: string | null, predicate: (nodes: Node[]) => boolean, timeoutMs = 5000): Promise<Node[]> {
  const deadline = Date.now() + timeoutMs;
  let nodes = dump(serial);
  while (!predicate(nodes)) {
    if (Date.now() > deadline) return nodes;
    await sleep(250);
    nodes = dump(serial);
  }
  return nodes;
}

function tap(serial: string | null, node: Node): Promise<void> {
  return tapAt(serial, Math.round((node.x1 + node.x2) / 2), Math.round((node.y1 + node.y2) / 2));
}

async function tapAt(serial: string | null, x: number, y: number): Promise<void> {
  adb(serial, ['shell', 'input', 'tap', String(x), String(y)]);
  await sleep(700);
}

async function swipe(serial: string | null, fromY: number, toY: number, ms = 350): Promise<void> {
  adb(serial, ['shell', 'input', 'swipe', '540', String(fromY), '540', String(toY), String(ms)]);
  await sleep(700);
}

async function back(serial: string | null): Promise<void> {
  adb(serial, ['shell', 'input', 'keyevent', '4']);
  await sleep(700);
}

// -------------------------------------------------------------------- navigation

function listRows(nodes: Node[]): Node[] {
  return nodes.filter((n) => n.desc && parseListRow(n.desc));
}

function itemRowNodes(nodes: Node[]): Node[] {
  return nodes.filter((n) => n.desc && ITEM_ROW.test(n.desc));
}

async function ensurePurchasesScreen(serial: string | null): Promise<Node[]> {
  adb(serial, ['shell', 'cmd', 'statusbar', 'collapse']); // a stray swipe can pull the shade down
  let nodes = await dump(serial);
  if (listRows(nodes).length > 0) return nodes;

  // Leaving a detail screen returns to the list.
  const up = nodes.find((n) => n.desc === 'Navigate up' || n.text === 'Navigate up');
  if (up) {
    await tap(serial, up);
    nodes = await waitFor(serial, (n) => listRows(n).length > 0);
    if (listRows(nodes).length > 0) return nodes;
  }

  // Profile tab -> "My Purchases" row. Matched by text so a language change still works.
  const profileTab = nodes.find((n) => n.clickable && /^(profile|profil)$/i.test(n.text || n.desc));
  if (profileTab) {
    await tap(serial, profileTab);
    nodes = await dump(serial);
    const entry = nodes.find(
      (n) =>
        n.clickable &&
        SHOPPING_SCREEN_TITLES.some((t) => (n.text || n.desc).toLowerCase().startsWith(t.toLowerCase()))
    );
    if (entry) {
      await tap(serial, entry);
      nodes = await waitFor(serial, (n) => listRows(n).length > 0);
      if (listRows(nodes).length > 0) return nodes;
    }
  }

  throw new Error(
    `Could not find the "${SHOPPING_SCREEN_TITLES[0]}" screen. Unlock the phone, open EASY Shopper → Profile → ${SHOPPING_SCREEN_TITLES[0]}, then re-run.`
  );
}

/**
 * Walk the purchases list from the top, paging with "More" until nothing new appears.
 * The list loads lazily, so several consecutive empty sweeps are required before it is
 * safe to call the history complete — two was truncating older sessions.
 */
async function scanSessions(serial: string | null): Promise<Map<string, Node>> {
  const IDLE_LIMIT = 4;
  for (let i = 0; i < 8; i += 1) await swipe(serial, 700, 1900, 200); // rewind
  const seen = new Map<string, Node>();
  let stale = 0;
  let nodes = await dump(serial);
  for (let i = 0; i < 120 && stale < IDLE_LIMIT; i += 1) {
    const before = seen.size;
    for (const row of listRows(nodes)) seen.set(row.desc, row);
    const more = nodes.find((n) => n.clickable && /^(more|mehr)$/i.test(n.text || n.desc));
    if (more) {
      await tap(serial, more);
      nodes = await dump(serial);
      continue;
    }
    stale = seen.size === before ? stale + 1 : 0;
    if (stale >= IDLE_LIMIT) break;
    await swipe(serial, 1900, 700);
    nodes = await dump(serial);
  }
  return seen;
}

/**
 * Scroll the purchases list downwards until the row with this exact description is
 * visible. Going back from a detail screen preserves the list position, so walking
 * forward is enough; hitting the end twice means the row is gone.
 */
async function findRow(serial: string | null, desc: string, maxSweeps = 25): Promise<Node | null> {
  // Rewind to the top (cheap: swipes without dumps), then walk downwards.
  for (let i = 0; i < 7; i += 1) await swipe(serial, 700, 1900, 200);
  let previous = '';
  for (let i = 0; i < maxSweeps; i += 1) {
    const rows = listRows(await dump(serial));
    const hit = rows.find((n) => n.desc === desc);
    if (hit) return hit;
    const signature = rows.map((n) => n.desc).join('|');
    if (signature === previous) return null;
    previous = signature;
    await swipe(serial, 1900, 700);
  }
  return null;
}

// ------------------------------------------------------------------------ driver

async function captureSession(serial: string | null, session: CapturedSession): Promise<CapturedSession> {
  // The detail screen keeps the previous receipt's rows on screen while it loads, and
  // its header is identical apart from the date. Wait for OUR date before reading
  // anything, otherwise items from the previous session leak in.
  const detail = await waitFor(serial, (n) => n.some((x) => x.text === session.displayWhen), 8000);
  if (!detail.some((x) => x.text === session.displayWhen)) {
    throw new Error(`detail screen did not load for ${session.displayWhen} ${session.store}`);
  }

  let paymentMode: string | null = null;
  let receiptBarcode: string | null = null;
  if (detail.some((n) => n.text === 'Payment Mode')) paymentMode = valueBelow(detail, 'Payment Mode');
  if (detail.some((n) => n.text === 'Receipt Barcode')) {
    // The barcode is a long digit string, centred; the surrounding paragraphs are prose.
    receiptBarcode = valueBelowMatching(detail, 'Receipt Barcode', (text) => /^[0-9A-Za-z]{8,}$/.test(text) && /\d/.test(text));
  }

  const itemCountRaw = detail.some((n) => n.text === 'ITEMS') ? valueBelow(detail, 'ITEMS') : null;
  const totalRaw = detail.some((n) => n.text === 'TOTAL') ? valueBelow(detail, 'TOTAL') : null;
  const itemCount = itemCountRaw && /^\d+$/.test(itemCountRaw) ? Number(itemCountRaw) : null;
  const total = totalRaw ? parseMoney(totalRaw) : null;

  // The detail page is a virtualised list: only visible rows are in the tree, the rest
  // arrive behind "More" / by scrolling. Collect by repeatedly dumping, merging new
  // rows (keeping duplicate lines distinct) and paging until nothing new appears.
  const items: CapturedItem[] = [];
  const counted = new Map<string, number>();
  let stagnant = 0;
  let nodes = detail;

  for (let sweep = 0; sweep < 80 && stagnant < 3; sweep += 1) {
    const rows = itemRowNodes(nodes);
    let added = 0;
    const perDump = new Map<string, number>();
    for (const row of rows) {
      const occurrences = (perDump.get(row.desc) ?? 0) + 1;
      perDump.set(row.desc, occurrences);
      if (occurrences <= (counted.get(row.desc) ?? 0)) continue;
      const parsed = parseItemRow(row.desc, childrenOf(row, nodes));
      if (!parsed) continue;
      items.push(parsed);
      added += 1;
    }
    for (const [desc, occurrences] of perDump) {
      counted.set(desc, Math.max(counted.get(desc) ?? 0, occurrences));
    }

    const units = items.reduce((acc, item) => acc + (item.quantity ?? 1), 0);
    if (itemCount !== null && units >= itemCount) break;
    const atFooter = nodes.some((n) => n.text === 'TOTAL') && !nodes.some((n) => /^(more|mehr)$/i.test(n.text || ''));

    const more = nodes.find((n) => n.clickable && /^(more|mehr)$/i.test(n.text || n.desc));
    if (more) {
      await tap(serial, more);
      nodes = await dump(serial);
      continue;
    }

    stagnant = added === 0 ? stagnant + 1 : 0;
    if (stagnant >= 3) break;
    void atFooter;
    await swipe(serial, 1800, 900);
    nodes = await dump(serial);
  }

  const resolvedTotal = total ?? session.total;
  const check = reconcile(items, itemCount, resolvedTotal);
  return {
    ...session,
    total: resolvedTotal,
    paymentMode,
    receiptBarcode,
    itemCount,
    items,
    reconciled: check.reconciled,
    difference: check.difference,
  };
}

export interface CaptureOptions {
  serial?: string | null;
  limit?: number;
  dryRun?: boolean;
  out?: string;
}

export async function capture(options: CaptureOptions = {}): Promise<CapturedSession[]> {
  const serial = options.serial ?? detectSerial();
  adb(serial, ['shell', 'input', 'keyevent', '224']); // wake the screen if it is off
  await sleep(600);

  if (!(await ensureAppForeground(serial))) {
    throw new Error('Phone is locked. Unlock it (the sidecar cannot dismiss a secure lockscreen) and re-run.');
  }
  // A capture run takes minutes; the stock 2-minute screen timeout would kill it mid-way.
  // Wireless debugging also drops when the device sleeps, which silently truncates the
  // history, so hold the screen on while plugged in for the duration of the run.
  const previousTimeout = adb(serial, ['shell', 'settings', 'get', 'system', 'screen_off_timeout']).trim();
  const previousStayOn = adb(serial, ['shell', 'settings', 'get', 'global', 'stay_on_while_plugged_in']).trim();
  adb(serial, ['shell', 'settings', 'put', 'system', 'screen_off_timeout', '1800000']);
  adb(serial, ['shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', '7']);

  await ensurePurchasesScreen(serial);

  const rowMap = await scanSessions(serial);
  const sessions: CapturedSession[] = [];
  const descByKey = new Map<string, string>();
  for (const node of rowMap.values()) {
    const parsed = parseListRow(node.desc);
    if (!parsed) continue;
    sessions.push({
      ...parsed,
      paymentMode: null,
      receiptBarcode: null,
      itemCount: null,
      items: [],
      reconciled: false,
      difference: 0,
    });
    descByKey.set(parsed.key, node.desc);
  }

  const limit = Math.min(options.limit ?? sessions.length, sessions.length);
  const mismatches: string[] = [];
  let capturedCount = 0;
  const outPath = options.out ?? join(homedir(), '.local', 'share', 'groceries', 'easyshopper', 'purchases.json');
  mkdirSync(dirname(outPath), { recursive: true });
  // Persist after every session: a killed run must still leave a usable capture, and a
  // re-scan that fails early must not erase receipts captured by an earlier run.
  const persist = () => {
    let previous: CapturedSession[] = [];
    try {
      const raw = readFileSync(outPath, 'utf8');
      previous = (JSON.parse(raw) as { sessions?: CapturedSession[] }).sessions ?? [];
    } catch {
      previous = [];
    }
    const merged = mergeSessions(previous, sessions);
    writeFileSync(
      outPath,
      `${JSON.stringify({ capturedAt: new Date().toISOString(), device: serial, sessions: merged }, null, 2)}\n`,
      'utf8'
    );
  };
  persist();

  for (let i = 0; i < limit; i += 1) {
    const session = sessions[i];
    if (options.dryRun) {
      process.stderr.write(`[dry] ${session.purchasedAt} ${session.store} €${session.total.toFixed(2)}\n`);
      continue;
    }

    adb(serial, ['shell', 'input', 'keyevent', '224']); // wake if the screen napped
    await ensurePurchasesScreen(serial);
    const desc = descByKey.get(session.key);
    const row = desc ? await findRow(serial, desc) : null;
    if (!row) {
      process.stderr.write(`[skip] ${session.purchasedAt} ${session.store}: row not found\n`);
      continue;
    }

    await tap(serial, row);
    let captured: CapturedSession;
    try {
      captured = await captureSession(serial, session);
    } catch (error) {
      await back(serial);
      await waitFor(serial, (n) => listRows(n).length > 0);
      process.stderr.write(
        `[skip] ${session.displayWhen} ${session.store}: ${error instanceof Error ? error.message : String(error)}\n`
      );
      continue;
    }
    await back(serial);
    await waitFor(serial, (n) => listRows(n).length > 0);

    const sum = captured.items.reduce((acc, item) => acc + (item.lineTotal ?? 0), 0);
    const units = captured.items.reduce((acc, item) => acc + (item.quantity ?? 1), 0);
    if (captured.itemCount !== null && units !== captured.itemCount) {
      mismatches.push(`${captured.purchasedAt} ${captured.store}: ${units}/${captured.itemCount} units`);
    }
    if (captured.items.length > 0 && Math.abs(sum - captured.total) > 0.02) {
      mismatches.push(
        `${captured.purchasedAt} ${captured.store}: items ${sum.toFixed(2)} != total ${captured.total.toFixed(2)}`
      );
    }

    sessions[i] = captured;
    capturedCount += 1;
    persist();
    process.stderr.write(
      `[${capturedCount}/${limit}] ${captured.purchasedAt.slice(0, 10)} ${captured.store} ` +
        `${captured.items.length} lines/${units} units €${captured.total.toFixed(2)}` +
        `${captured.receiptBarcode ? ` #${captured.receiptBarcode}` : ''}\n`
    );
  }

  if (previousTimeout && /^\d+$/.test(previousTimeout)) {
    adb(serial, ['shell', 'settings', 'put', 'system', 'screen_off_timeout', previousTimeout]);
  }
  if (previousStayOn && /^\d+$/.test(previousStayOn)) {
    adb(serial, ['shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', previousStayOn]);
  }

  persist();
  process.stderr.write(`\nwrote ${sessions.length} sessions -> ${outPath}\n`);
  if (mismatches.length > 0) {
    process.stderr.write(`\nreconciliation warnings (${mismatches.length}):\n`);
    for (const warning of mismatches) process.stderr.write(`  - ${warning}\n`);
  }
  return sessions;
}

function parseArgv(argv: string[]): CaptureOptions {
  const options: CaptureOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--limit') options.limit = Number(argv[++i]);
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--serial') options.serial = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`
EASY Shopper purchase capture

  --serial <host:port>  adb serial (default: first device, preferring wireless)
  --limit <n>           capture at most n sessions (default: all)
  --dry-run             list sessions without opening details
  --out <path>          output file (default ~/.local/share/groceries/easyshopper/purchases.json)
`);
      process.exit(0);
    }
  }
  return options;
}

if (process.argv[1] && process.argv[1].endsWith('easyshopper-capture.ts')) {
  capture(parseArgv(process.argv.slice(2))).catch((error: unknown) => {
    process.stderr.write(`\ncapture failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
