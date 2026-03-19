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
