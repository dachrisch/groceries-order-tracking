# Knuspr Integration Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings page where users connect Knuspr by saving encrypted credentials, replacing the cURL-paste import flow with API-based authentication.

**Architecture:** At login, a PBKDF2 key derived from the user's email+password is stored in a short-lived httpOnly cookie (`dkey`). This key encrypts/decrypts Knuspr credentials stored in a new `Integration` MongoDB model. A new Knuspr auth library calls `POST /services/frontend-service/login` to obtain a fresh Knuspr session whenever import runs — no need to store or cache Knuspr session tokens.

**Tech Stack:** Node.js `crypto` (built-in, no new deps), Express, Mongoose, SolidJS + DaisyUI. No test framework exists — use manual curl/browser verification.

---

## File Map

**Create:**
- `src/lib/crypto.ts` — `deriveKey`, `encrypt`, `decrypt` helpers
- `src/models/Integration.ts` — generic per-user integration document (`userId`, `provider`, `encryptedCredentials`)
- `src/lib/knuspr-auth.ts` — `loginToKnuspr(email, password)` → Knuspr session token
- `src/api/controllers/settings.controller.ts` — REST handlers for integrations CRUD + manual sync
- `src/frontend/pages/Settings.tsx` — Settings page with "Connected Services" section

**Modify:**
- `src/api/utils.ts` — add `derivedKeyMiddleware` to extract `dkey` cookie and attach to `req`
- `src/api/controllers/auth.controller.ts` — set `dkey` cookie on login, clear on logout
- `src/api/server.ts` — register settings routes with auth + dkey middleware
- `src/lib/order-importer.ts` — replace cURL headers with API-based Knuspr session; decrypt Integration creds; auto-retry on 401
- `src/models/User.ts` — remove `knusprCredentials` field (no longer needed)
- `src/frontend/App.tsx` — add Settings nav link (sidebar + mobile drawer)
- `src/frontend/index.tsx` — register `/settings` route
- `src/frontend/pages/Import.tsx` — simplify: remove cURL textarea, just trigger sync; show link to Settings if not connected

---

## Task 1: Crypto Utilities

**Files:**
- Create: `src/lib/crypto.ts`

- [ ] **Step 1: Create `src/lib/crypto.ts`**

```typescript
import crypto from 'crypto';

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // AES-256 needs 32-byte key
const FIXED_SALT_SUFFIX = 'groceries-tracking-v1';

/**
 * Derives a 256-bit AES key from the user's email and plaintext password.
 * Uses PBKDF2-SHA256 with the email as part of the salt for per-user uniqueness.
 * Call this at login time (when plaintext password is available).
 */
export function deriveKey(email: string, password: string): Buffer {
  const salt = email.toLowerCase() + ':' + FIXED_SALT_SUFFIX;
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Encrypts a plaintext string with AES-256-GCM (authenticated encryption).
 * Returns "ivHex:authTagHex:ciphertextHex".
 * AES-256-GCM is preferred over CBC because it detects tampering via the auth tag.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * Decrypts an "ivHex:authTagHex:ciphertextHex" string produced by encrypt().
 * Throws if the auth tag doesn't match (data was tampered).
 */
export function decrypt(ciphertext: string, key: Buffer): string {
  const parts = ciphertext.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 2: Manually verify crypto round-trip in a scratch Node REPL**

```bash
cd /home/cda/dev/groceries-order-tracking
node -e "
const { deriveKey, encrypt, decrypt } = require('./src/lib/crypto.ts');
"
# Note: since this is TypeScript, instead run via tsx:
npx tsx -e "
import { deriveKey, encrypt, decrypt } from './src/lib/crypto';
const key = deriveKey('test@example.com', 'password123');
const ct = encrypt('hello world', key);
const pt = decrypt(ct, key);
console.log('Plaintext matches:', pt === 'hello world');
"
```

Expected output: `Plaintext matches: true`

- [ ] **Step 3: Commit**

```bash
git add src/lib/crypto.ts
git commit -m "feat: add AES-256-GCM encrypt/decrypt with PBKDF2 key derivation"
```

---

## Task 2: Integration Model

**Files:**
- Create: `src/models/Integration.ts`
- Modify: `src/models/User.ts`

- [ ] **Step 1: Create `src/models/Integration.ts`**

```typescript
import mongoose from 'mongoose';

/**
 * Stores encrypted third-party integration credentials per user.
 * One document per (userId, provider) pair.
 * encryptedCredentials is a JSON object encrypted with the user's derived key.
 */
const integrationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  provider: { type: String, required: true }, // e.g. 'knuspr'
  encryptedCredentials: { type: String, required: true },
  lastSyncAt: { type: Date, default: null },
}, { timestamps: true });

integrationSchema.index({ userId: 1, provider: 1 }, { unique: true });

export default mongoose.models.Integration || mongoose.model('Integration', integrationSchema);
```

- [ ] **Step 2: Remove the old `knusprCredentials` field from `src/models/User.ts`**

Replace the schema in `src/models/User.ts`:

```typescript
import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
}, { timestamps: true });

export default mongoose.models.User || mongoose.model('User', userSchema);
```

- [ ] **Step 3: Commit**

```bash
git add src/models/Integration.ts src/models/User.ts
git commit -m "feat: add Integration model; remove legacy knusprCredentials from User"
```

---

## Task 3: Knuspr Auth Library

**Files:**
- Create: `src/lib/knuspr-auth.ts`

This module handles calling the Knuspr login API discovered via Chrome DevTools.

- [ ] **Step 1: Create `src/lib/knuspr-auth.ts`**

```typescript
const KNUSPR_LOGIN_URL = 'https://www.knuspr.de/services/frontend-service/login';

/**
 * Authenticates with Knuspr using email+password.
 * Returns the PHPSESSION token needed for subsequent Knuspr API calls.
 * Throws if credentials are invalid or network fails.
 */
export async function loginToKnuspr(email: string, password: string): Promise<string> {
  const response = await fetch(KNUSPR_LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-origin': 'WEB',
    },
    body: JSON.stringify({ email, password, name: '' }),
  });

  if (!response.ok) {
    throw new Error(`Knuspr login request failed: HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!data?.data?.isAuthenticated) {
    throw new Error('Invalid Knuspr credentials');
  }

  const session: string = data.data.session;
  if (!session) {
    throw new Error('Knuspr login succeeded but no session token returned');
  }

  return session; // This is the PHPSESSION_de-production value
}
```

- [ ] **Step 2: Manual smoke test (requires real credentials)**

```bash
npx tsx -e "
import { loginToKnuspr } from './src/lib/knuspr-auth';
loginToKnuspr('YOUR_KNUSPR_EMAIL', 'YOUR_KNUSPR_PASSWORD')
  .then(s => console.log('Session token (first 20 chars):', s.substring(0, 20)))
  .catch(e => console.error('FAILED:', e.message));
"
```

Expected: prints a session token prefix.

- [ ] **Step 3: Commit**

```bash
git add src/lib/knuspr-auth.ts
git commit -m "feat: add Knuspr API login client"
```

---

## Task 4: Derived Key Cookie Middleware + Auth Controller Changes

**Files:**
- Modify: `src/api/utils.ts`
- Modify: `src/api/controllers/auth.controller.ts`

The derived key (32 bytes, base64-encoded) is set as an httpOnly cookie `dkey` at login. The middleware decodes it and attaches it as a Buffer to `req.derivedKey`.

- [ ] **Step 1: Add `derivedKeyMiddleware` to `src/api/utils.ts`**

Use Express module augmentation so `req.derivedKey` is type-safe everywhere — no `as any` casting needed in controllers.

```typescript
import { Request, Response, NextFunction } from 'express';

// Extend Express Request type globally — avoids (req as any) in every controller
declare global {
  namespace Express {
    interface Request {
      userId: string;
      derivedKey?: Buffer;
    }
  }
}

export const JWT_SECRET = process.env.JWT_SECRET || 'groceries-secret-key-123-change-me';

export function formatZodError(error: any) {
  return error.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
}

/**
 * Middleware that reads the `dkey` httpOnly cookie and attaches the
 * decoded Buffer to req.derivedKey. If the cookie is missing, req.derivedKey
 * is undefined (routes that need it should check explicitly).
 */
export function derivedKeyMiddleware(req: Request, _res: Response, next: NextFunction) {
  const dkeyCookie = (req.cookies as any)?.dkey;
  if (dkeyCookie) {
    try {
      req.derivedKey = Buffer.from(dkeyCookie, 'base64');
    } catch {
      // Invalid cookie — just leave derivedKey undefined
    }
  }
  next();
}
```

- [ ] **Step 2: Update `handleLogin` in `src/api/controllers/auth.controller.ts` to set the `dkey` cookie**

In `handleLogin`, after setting the JWT cookie, add:

```typescript
import { deriveKey } from '../../lib/crypto';

// Inside handleLogin, after verifying credentials and before res.json():
const key = deriveKey(email, password);
res.cookie('dkey', key.toString('base64'), {
  path: '/',
  httpOnly: true,
  maxAge: 604800000, // 7 days, matches JWT
  sameSite: 'lax',
});
```

Full updated `handleLogin`:

```typescript
export async function handleLogin(req: Request, res: Response) {
  const result = loginSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.message });
  }

  const { email, password } = result.data;
  const user = await User.findOne({ email });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { path: '/', httpOnly: true, maxAge: 604800000, sameSite: 'lax' });

  const key = deriveKey(email, password);
  res.cookie('dkey', key.toString('base64'), { path: '/', httpOnly: true, maxAge: 604800000, sameSite: 'lax' });

  res.json({ message: 'Logged in', user: { name: user.name, email: user.email } });
}
```

- [ ] **Step 3: Clear `dkey` in `handleLogout`**

```typescript
export async function handleLogout(req: Request, res: Response) {
  res.clearCookie('token');
  res.clearCookie('dkey');
  res.json({ message: 'Logged out' });
}
```

- [ ] **Step 4: Verify manually**

Start backend: `npm run dev:backend`

```bash
# Login and check cookies
curl -s -c /tmp/cookies.txt -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"yourapp@example.com","password":"yourpassword"}' | jq .

# Inspect cookie file — should see both 'token' and 'dkey'
cat /tmp/cookies.txt
```

Expected: two httpOnly cookies present in the cookie jar.

- [ ] **Step 5: Commit**

```bash
git add src/api/utils.ts src/api/controllers/auth.controller.ts
git commit -m "feat: derive and store AES key in httpOnly dkey cookie at login"
```

---

## Task 5: Settings Controller + Routes

**Files:**
- Create: `src/api/controllers/settings.controller.ts`
- Modify: `src/api/server.ts`

The settings controller provides:
- `GET /api/settings/integrations` — list connected providers (no credentials returned)
- `POST /api/settings/integrations/knuspr` — connect: validate Knuspr creds, encrypt, save
- `DELETE /api/settings/integrations/knuspr` — disconnect: delete the integration document
- `POST /api/settings/integrations/knuspr/sync` — trigger a manual order import

- [ ] **Step 1: Create `src/api/controllers/settings.controller.ts`**

```typescript
import { Request, Response } from 'express';
import Integration from '../../models/Integration';
import { encrypt } from '../../lib/crypto';
import { loginToKnuspr } from '../../lib/knuspr-auth';
import { importOrders } from '../../lib/order-importer';
// Note: utils.ts declares the global Express.Request augmentation (userId, derivedKey),
// so req.userId and req.derivedKey are typed without any casting.
import '../utils';

export async function handleListIntegrations(req: Request, res: Response) {
  const integrations = await Integration.find({ userId: req.userId }).select('provider lastSyncAt createdAt');
  res.json(integrations);
}

export async function handleConnectKnuspr(req: Request, res: Response) {
  const key = req.derivedKey;
  if (!key) return res.status(401).json({ error: 'Session key missing — please log in again' });

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  // Validate credentials against Knuspr before storing
  try {
    await loginToKnuspr(email, password);
  } catch (err: any) {
    return res.status(400).json({ error: `Knuspr login failed: ${err.message}` });
  }

  const encryptedCredentials = encrypt(JSON.stringify({ email, password }), key);

  await Integration.findOneAndUpdate(
    { userId: req.userId, provider: 'knuspr' },
    { encryptedCredentials, lastSyncAt: null },
    { upsert: true, new: true }
  );

  res.json({ message: 'Knuspr connected successfully' });
}

export async function handleDisconnectKnuspr(req: Request, res: Response) {
  await Integration.deleteOne({ userId: req.userId, provider: 'knuspr' });
  res.json({ message: 'Knuspr disconnected' });
}

export async function handleSyncKnuspr(req: Request, res: Response) {
  const key = req.derivedKey;
  if (!key) return res.status(401).json({ error: 'Session key missing — please log in again' });

  const integration = await Integration.findOne({ userId: req.userId, provider: 'knuspr' });
  if (!integration) return res.status(404).json({ error: 'Knuspr not connected. Go to Settings to connect.' });

  try {
    const result = await importOrders(req.userId, key, integration);
    await Integration.findByIdAndUpdate(integration._id, { lastSyncAt: new Date() });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
```

- [ ] **Step 2: Register routes in `src/api/server.ts`**

Add the import and routes. **CRITICAL: `app.use(derivedKeyMiddleware)` MUST be placed before any `app.get/post/...` route registrations.** Express applies middleware in declaration order, so placing it after route registrations means those routes will never see `req.derivedKey`.

```typescript
import { derivedKeyMiddleware } from './utils';
import { handleListIntegrations, handleConnectKnuspr, handleDisconnectKnuspr, handleSyncKnuspr } from './controllers/settings.controller';

// Add BEFORE all route registrations (after cookieParser, before first app.get/post):
app.use(derivedKeyMiddleware);

// Settings routes (all require auth):
app.get('/api/settings/integrations', auth, handleListIntegrations);
app.post('/api/settings/integrations/knuspr', auth, handleConnectKnuspr);
app.delete('/api/settings/integrations/knuspr', auth, handleDisconnectKnuspr);
app.post('/api/settings/integrations/knuspr/sync', auth, handleSyncKnuspr);
```

The final middleware setup block in `server.ts` should read:
```typescript
app.use(express.json());
app.use(cookieParser());
app.use(derivedKeyMiddleware);  // ← must be here, before routes

// Routes
app.post('/api/register', handleRegister);
// ... etc
```

- [ ] **Step 3: Manual test — connect Knuspr**

```bash
# Login first to get cookies
curl -s -c /tmp/cookies.txt -b /tmp/cookies.txt \
  -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"YOUR_APP_EMAIL","password":"YOUR_APP_PASSWORD"}'

# Connect Knuspr (use your actual Knuspr credentials)
curl -s -c /tmp/cookies.txt -b /tmp/cookies.txt \
  -X POST http://localhost:3000/api/settings/integrations/knuspr \
  -H 'Content-Type: application/json' \
  -d '{"email":"YOUR_KNUSPR_EMAIL","password":"YOUR_KNUSPR_PASSWORD"}'
```

Expected: `{"message":"Knuspr connected successfully"}`

```bash
# List integrations
curl -s -b /tmp/cookies.txt http://localhost:3000/api/settings/integrations | jq .
```

Expected: array with one entry showing `provider: "knuspr"`, no credentials field.

- [ ] **Step 4: Commit**

```bash
git add src/api/controllers/settings.controller.ts src/api/server.ts
git commit -m "feat: add settings controller and routes for Knuspr integration CRUD"
```

---

## Task 6: Update Order Importer to Use API Auth

**Files:**
- Modify: `src/lib/order-importer.ts`

Replace the cURL-based flow with: decrypt Knuspr credentials from the Integration doc → call `loginToKnuspr` → use session cookie to fetch orders. Auto-retry once on 401.

The signature changes: `importOrders(userId, key, integration)` — the cURL parameter is removed. The old `POST /api/import` endpoint (cURL paste) can remain as-is for backward compat and is now a no-op path (it will error if no curl is provided and no integration exists — acceptable, the Settings page is the new entry point).

- [ ] **Step 1: Rewrite `src/lib/order-importer.ts`**

```typescript
import Order from '../models/Order';
import { decrypt } from './crypto';
import { loginToKnuspr } from './knuspr-auth';

const KNUSPR_API_BASE = 'https://www.knuspr.de';

async function fetchWithSession(url: string, session: string) {
  return fetch(url, {
    headers: {
      'Cookie': `PHPSESSION_de-production=${session}`,
      'x-origin': 'WEB',
    },
  });
}

export async function importOrders(
  userId: string,
  derivedKey: Buffer,
  integration: any
): Promise<{ importedCount: number }> {
  // Decrypt stored Knuspr credentials
  let knusprEmail: string;
  let knusprPassword: string;
  try {
    const creds = JSON.parse(decrypt(integration.encryptedCredentials, derivedKey));
    knusprEmail = creds.email;
    knusprPassword = creds.password;
  } catch {
    throw new Error('Failed to decrypt Knuspr credentials — please reconnect in Settings');
  }

  // Get fresh Knuspr session
  let session = await loginToKnuspr(knusprEmail, knusprPassword);

  console.log(`Starting Knuspr import for userId ${userId}...`);

  let offset = 0;
  const limit = 20;
  let importedCount = 0;
  let shouldContinue = true;

  while (shouldContinue) {
    const url = `${KNUSPR_API_BASE}/api/v3/orders/delivered?offset=${offset}&limit=${limit}`;
    let response = await fetchWithSession(url, session);

    // Auto-refresh session once on 401
    if (response.status === 401) {
      session = await loginToKnuspr(knusprEmail, knusprPassword);
      response = await fetchWithSession(url, session);
    }

    if (!response.ok) {
      throw new Error(`Knuspr API error: ${response.status} ${response.statusText}`);
    }

    const summaries = await response.json();
    if (!Array.isArray(summaries) || summaries.length === 0) break;

    for (const summary of summaries) {
      const existing = await Order.findOne({ userId, id: summary.id });
      if (existing) {
        if (offset > 0) {
          shouldContinue = false;
          break;
        }
        continue;
      }

      const detailUrl = `${KNUSPR_API_BASE}/api/v3/orders/${summary.id}`;
      let detailRes = await fetchWithSession(detailUrl, session);
      if (detailRes.status === 401) {
        session = await loginToKnuspr(knusprEmail, knusprPassword);
        detailRes = await fetchWithSession(detailUrl, session);
      }
      if (!detailRes.ok) continue;

      const detail = await detailRes.json();
      detail.userId = userId;
      detail.orderTimeDate = new Date(detail.orderTime);

      // Use upsert to prevent duplicate-key errors on concurrent syncs
      const upsertResult = await Order.findOneAndUpdate(
        { userId, id: detail.id },
        { $setOnInsert: detail },
        { upsert: true, new: false }
      );
      if (!upsertResult) importedCount++; // null means it was inserted (not found before)
    }

    if (summaries.length < limit) break;
    offset += limit;
  }

  return { importedCount };
}
```

- [ ] **Step 2: Update `handleImport` in `src/api/controllers/order.controller.ts` to use new flow**

Replace the existing `handleImport` with the following. Also add the two new imports at the top of the file alongside the existing ones:

```typescript
// New imports to add at the top of order.controller.ts:
import Integration from '../../models/Integration';
import { importOrders } from '../../lib/order-importer';
import '../../api/utils'; // activates Express.Request module augmentation (userId, derivedKey)

export async function handleImport(req: Request, res: Response) {
  if (!req.derivedKey) return res.status(401).json({ error: 'Session key missing — please log in again' });

  const integration = await Integration.findOne({ userId: req.userId, provider: 'knuspr' });
  if (!integration) {
    return res.status(400).json({ error: 'Knuspr not connected. Go to Settings to connect.' });
  }

  try {
    const result = await importOrders(req.userId, req.derivedKey, integration);
    await Integration.findByIdAndUpdate(integration._id, { lastSyncAt: new Date() });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
```

- [ ] **Step 3: Manual smoke test — trigger sync via API**

```bash
curl -s -b /tmp/cookies.txt \
  -X POST http://localhost:3000/api/settings/integrations/knuspr/sync | jq .
```

Expected: `{"importedCount": N}` (N may be 0 if already imported).

- [ ] **Step 4: Commit**

```bash
git add src/lib/order-importer.ts src/api/controllers/order.controller.ts
git commit -m "feat: replace cURL-based import with API auth using encrypted stored credentials"
```

---

## Task 7: Settings Frontend Page

**Files:**
- Create: `src/frontend/pages/Settings.tsx`

The Settings page has one section: "Connected Services". For Knuspr, it shows:
- If not connected: a form with email + password fields and a Connect button
- If connected: a status card with "Last synced", a Sync Now button, and a Disconnect button

- [ ] **Step 1: Create `src/frontend/pages/Settings.tsx`**

```tsx
import { createSignal, onMount, Show, For } from 'solid-js';
import { Link2, Link2Off, RefreshCw, ShoppingCart } from 'lucide-solid';

interface Integration {
  _id: string;
  provider: string;
  lastSyncAt: string | null;
  createdAt: string;
}

export function Settings() {
  const [integrations, setIntegrations] = createSignal<Integration[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [knusprEmail, setKnusprEmail] = createSignal('');
  const [knusprPassword, setKnusprPassword] = createSignal('');
  const [connecting, setConnecting] = createSignal(false);
  const [syncing, setSyncing] = createSignal(false);
  const [disconnecting, setDisconnecting] = createSignal(false);
  const [message, setMessage] = createSignal<{ type: 'success' | 'error'; text: string } | null>(null);

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  };

  const fetchIntegrations = async () => {
    try {
      const res = await fetch('/api/settings/integrations');
      if (res.ok) setIntegrations(await res.json());
    } finally {
      setLoading(false);
    }
  };

  onMount(fetchIntegrations);

  const knusprIntegration = () => integrations().find(i => i.provider === 'knuspr');

  const handleConnect = async (e: Event) => {
    e.preventDefault();
    setConnecting(true);
    try {
      const res = await fetch('/api/settings/integrations/knuspr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: knusprEmail(), password: knusprPassword() }),
      });
      const data = await res.json();
      if (res.ok) {
        showMessage('success', 'Knuspr connected successfully!');
        setKnusprEmail('');
        setKnusprPassword('');
        await fetchIntegrations();
      } else {
        showMessage('error', data.error || 'Connection failed');
      }
    } catch {
      showMessage('error', 'Network error');
    } finally {
      setConnecting(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/settings/integrations/knuspr/sync', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showMessage('success', `Sync complete — ${data.importedCount} new orders imported`);
        await fetchIntegrations();
      } else {
        showMessage('error', data.error || 'Sync failed');
      }
    } catch {
      showMessage('error', 'Network error during sync');
    } finally {
      setSyncing(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect Knuspr? Your imported order history will remain.')) return;
    setDisconnecting(true);
    try {
      const res = await fetch('/api/settings/integrations/knuspr', { method: 'DELETE' });
      if (res.ok) {
        showMessage('success', 'Knuspr disconnected');
        await fetchIntegrations();
      }
    } catch {
      showMessage('error', 'Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div class="max-w-2xl mx-auto space-y-8">
      <h1 class="text-3xl font-bold">Settings</h1>

      <Show when={message()}>
        <div class={`alert ${message()!.type === 'success' ? 'alert-success' : 'alert-error'}`}>
          <span>{message()!.text}</span>
        </div>
      </Show>

      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title mb-4">Connected Services</h2>

          <Show when={loading()}>
            <div class="flex justify-center py-8">
              <span class="loading loading-spinner loading-md"></span>
            </div>
          </Show>

          <Show when={!loading()}>
            {/* Knuspr Integration */}
            <div class="border border-base-300 rounded-xl p-4 space-y-4">
              <div class="flex items-center gap-3">
                <div class="bg-orange-100 text-orange-600 rounded-lg p-2">
                  <ShoppingCart size={24} />
                </div>
                <div class="flex-grow">
                  <div class="font-semibold text-lg">Knuspr</div>
                  <div class="text-xs opacity-60">Online supermarket order history</div>
                </div>
                <Show
                  when={knusprIntegration()}
                  fallback={
                    <div class="badge badge-ghost">Not connected</div>
                  }
                >
                  <div class="badge badge-success gap-1">
                    <Link2 size={12} />
                    Connected
                  </div>
                </Show>
              </div>

              {/* Connected state */}
              <Show when={knusprIntegration()}>
                {(integration) => (
                  <div class="space-y-3">
                    <div class="text-sm opacity-70">
                      Last synced:{' '}
                      {integration().lastSyncAt
                        ? new Date(integration().lastSyncAt!).toLocaleString()
                        : 'Never'}
                    </div>
                    <div class="flex gap-2">
                      <button
                        class="btn btn-primary btn-sm gap-2"
                        onClick={handleSync}
                        disabled={syncing()}
                      >
                        <Show when={syncing()}>
                          <span class="loading loading-spinner loading-xs"></span>
                        </Show>
                        <Show when={!syncing()}>
                          <RefreshCw size={14} />
                        </Show>
                        Sync Now
                      </button>
                      <button
                        class="btn btn-ghost btn-sm text-error gap-2"
                        onClick={handleDisconnect}
                        disabled={disconnecting()}
                      >
                        <Link2Off size={14} />
                        Disconnect
                      </button>
                    </div>
                  </div>
                )}
              </Show>

              {/* Connect form */}
              <Show when={!knusprIntegration()}>
                <form onSubmit={handleConnect} class="space-y-3">
                  <p class="text-sm opacity-70">
                    Enter your Knuspr login credentials. They are encrypted with your app password and stored securely.
                  </p>
                  <div class="form-control">
                    <label class="label label-text text-xs">Knuspr Email</label>
                    <input
                      type="email"
                      class="input input-bordered input-sm"
                      placeholder="your@email.de"
                      value={knusprEmail()}
                      onInput={(e) => setKnusprEmail(e.currentTarget.value)}
                      required
                    />
                  </div>
                  <div class="form-control">
                    <label class="label label-text text-xs">Knuspr Password</label>
                    <input
                      type="password"
                      class="input input-bordered input-sm"
                      placeholder="••••••••"
                      value={knusprPassword()}
                      onInput={(e) => setKnusprPassword(e.currentTarget.value)}
                      required
                    />
                  </div>
                  <button
                    type="submit"
                    class="btn btn-primary btn-sm gap-2 w-full"
                    disabled={connecting()}
                  >
                    <Show when={connecting()}>
                      <span class="loading loading-spinner loading-xs"></span>
                    </Show>
                    <Show when={!connecting()}>
                      <Link2 size={14} />
                    </Show>
                    Connect Knuspr
                  </button>
                </form>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-base">About credential security</h2>
          <p class="text-sm opacity-70">
            Your third-party passwords are encrypted with a key derived from your app login credentials
            using AES-256-GCM. They are never stored in plaintext. The decryption key is stored in a
            secure httpOnly cookie for the duration of your session (7 days) and is never accessible
            to JavaScript.
          </p>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/frontend/pages/Settings.tsx
git commit -m "feat: add Settings page with Knuspr connect/disconnect/sync UI"
```

---

## Task 8: Wire Up Navigation and Routes

**Files:**
- Modify: `src/frontend/index.tsx`
- Modify: `src/frontend/App.tsx`
- Modify: `src/frontend/pages/Import.tsx`

- [ ] **Step 1: Add `/settings` route in `src/frontend/index.tsx`**

Add the import and route:

```tsx
import { Settings } from './pages/Settings';

// Inside Router:
<Route path="/settings" component={Settings} />
```

- [ ] **Step 2: Add Settings link to sidebar in `src/frontend/App.tsx`**

Import the icon with an alias to avoid collision with the `Settings` page component imported in `index.tsx`:
```tsx
import { Settings as SettingsIcon } from 'lucide-solid';
```

Add nav item after the Import link in the desktop sidebar `<ul>`:
```tsx
<li>
  <A href="/settings" activeClass="active" class={`flex items-center gap-4 ${sidebarCollapsed() ? 'justify-center' : ''}`}>
    <SettingsIcon size={20} />
    <Show when={!sidebarCollapsed()}>
      <span>Settings</span>
    </Show>
  </A>
</li>
```

Add same in the mobile drawer `<ul>`:
```tsx
<li><A href="/settings" onClick={() => (document.getElementById('mobile-drawer') as HTMLInputElement).checked = false} activeClass="active"><SettingsIcon size={20} /> Settings</A></li>
```

- [ ] **Step 3: Update `src/frontend/pages/Import.tsx` to use API auth**

Replace the cURL textarea import page with a simplified "Sync Orders" page that uses the settings-based flow, and shows a link to Settings if Knuspr is not connected:

```tsx
import { createSignal, onMount, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { RefreshCw } from 'lucide-solid';

export function Import() {
  const [loading, setLoading] = createSignal(false);
  const [connected, setConnected] = createSignal<boolean | null>(null);
  const [result, setResult] = createSignal<any>(null);
  const [error, setError] = createSignal('');

  onMount(async () => {
    const res = await fetch('/api/settings/integrations');
    if (res.ok) {
      const integrations = await res.json();
      setConnected(integrations.some((i: any) => i.provider === 'knuspr'));
    }
  });

  const handleSync = async () => {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      // Use the dedicated sync endpoint (same as Settings "Sync Now")
      const res = await fetch('/api/settings/integrations/knuspr/sync', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setResult(data);
      } else {
        setError(data.error || 'Import failed');
      }
    } catch {
      setError('An error occurred during import.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="max-w-2xl mx-auto space-y-8">
      <h1 class="text-3xl font-bold">Sync Orders</h1>

      <Show when={connected() === false}>
        <div class="alert alert-warning">
          <span>Knuspr is not connected. <A href="/settings" class="link font-semibold">Go to Settings</A> to connect your account.</span>
        </div>
      </Show>

      <Show when={connected()}>
        <div class="card bg-base-100 shadow-xl">
          <div class="card-body space-y-4">
            <h2 class="card-title">Fetch latest orders from Knuspr</h2>
            <p class="text-sm opacity-70">
              Fetches all new delivered orders since your last sync. Already-imported orders are skipped.
            </p>
            <button
              class="btn btn-primary w-full gap-2"
              onClick={handleSync}
              disabled={loading()}
            >
              <Show when={loading()}>
                <span class="loading loading-spinner"></span>
              </Show>
              <Show when={!loading()}>
                <RefreshCw size={18} />
              </Show>
              Sync Now
            </button>

            <Show when={error()}>
              <div class="alert alert-error"><span>{error()}</span></div>
            </Show>
            <Show when={result()}>
              <div class="alert alert-success">
                <span>Sync complete — {result().importedCount} new orders imported!</span>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
```

- [ ] **Step 4: Start the full app and do an end-to-end manual test**

```bash
npm run dev
```

1. Go to `http://localhost:5173/login` — log in
2. Go to `/settings` — should see Knuspr "Not connected" with a form
3. Enter Knuspr credentials → click Connect → should show "Connected" badge
4. Click "Sync Now" → verify orders imported
5. Go to `/import` — should show Sync page (no cURL textarea)
6. Go back to `/settings` → click Disconnect → form reappears

- [ ] **Step 5: Commit**

```bash
git add src/frontend/index.tsx src/frontend/App.tsx src/frontend/pages/Import.tsx
git commit -m "feat: wire Settings route, sidebar nav, and update Import page to credential-free sync"
```

---

## Final Checklist

- [ ] `deriveKey` is called only at login (plaintext password available)
- [ ] `dkey` cookie is httpOnly (not accessible by JavaScript)
- [ ] Knuspr credentials in MongoDB are always stored encrypted — never plaintext
- [ ] Disconnect removes the Integration document (order history untouched)
- [ ] 401 from Knuspr mid-import triggers one automatic re-login attempt
- [ ] Settings page shows last sync time
- [ ] Import page redirects user to Settings if not connected
