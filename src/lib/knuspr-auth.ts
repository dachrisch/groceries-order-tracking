import Integration from '../models/Integration';
import { decrypt } from './crypto';

const KNUSPR_LOGIN_URL = 'https://www.knuspr.de/services/frontend-service/login';

export interface KnusprSession {
  session: string; // PHPSESSION_de-production value
  userId: string;
}

/**
 * Authenticates with Knuspr using email+password.
 * Returns the PHPSESSION token and userId needed for subsequent Knuspr API calls.
 * Throws if credentials are invalid or network fails.
 */
export async function loginToKnuspr(email: string, password: string): Promise<KnusprSession> {
  const response = await fetch(KNUSPR_LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-origin': 'WEB',
    },
    body: JSON.stringify({ email, password, name: '' }), // name: '' is required by the Knuspr login API (observed via Chrome DevTools)
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

  const userId: string = String(data.data.userId ?? data.data.id ?? '');

  return { session, userId };
}

/**
 * Retrieves a fresh Knuspr session for a user by decrypting their stored credentials.
 */
export async function getKnusprSession(userId: string, derivedKey: Buffer | undefined): Promise<string> {
  if (!derivedKey) {
    throw new Error('Session key missing — please re-login');
  }

  const integration = await Integration.findOne({ userId, provider: 'knuspr' });
  if (!integration?.encryptedCredentials) {
    throw new Error('Knuspr not connected. Go to Settings to connect.');
  }

  const creds = JSON.parse(decrypt(integration.encryptedCredentials, derivedKey));
  const { session } = await loginToKnuspr(creds.email, creds.password);
  return session;
}
