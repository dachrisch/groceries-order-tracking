import { createSignal, untrack } from 'solid-js';

const [csrfToken, setCsrfToken] = createSignal<string | null>(null);
const originalFetch = window.fetch;

export async function refreshCsrfToken() {
  try {
    const res = await originalFetch('/api/csrf-token');
    if (res.ok) {
      const { token } = await res.json();
      setCsrfToken(token);
      return token;
    }
  } catch (e) {
    console.error('Failed to fetch CSRF token', e);
  }
  return null;
}

export async function apiFetch(url: string, options: RequestInit = {}) {
  const method = options.method?.toUpperCase() || 'GET';
  const isMutation = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method);

  if (isMutation) {
    let token = untrack(() => csrfToken());
    if (!token) {
      token = await refreshCsrfToken();
    }
    if (token) {
      options.headers = {
        ...options.headers,
        'x-csrf-token': token,
      };
    }
  }

  const res = await originalFetch(url, options);

  // If we get a 403 (Forbidden), it might be an expired CSRF token
  if (res.status === 403 && isMutation) {
    const newToken = await refreshCsrfToken();
    if (newToken) {
      options.headers = {
        ...options.headers,
        'x-csrf-token': newToken,
      };
      return originalFetch(url, options);
    }
  }

  return res;
}

export function patchFetch() {
    window.fetch = (url, options) => apiFetch(url as string, options);
}
