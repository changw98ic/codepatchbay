const API_KEY_PARAM = 'api_key';
const API_KEY_STORAGE = 'cpb_api_key';
const API_KEY_COOKIE = 'cpb_api_key';

let fetchInstalled = false;

function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function cookieAttributes() {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  return `Path=/; SameSite=Strict${secure}`;
}

function setApiKeyCookie(key: string) {
  document.cookie = `${API_KEY_COOKIE}=${encodeURIComponent(key)}; ${cookieAttributes()}`;
}

export function getApiKey() {
  if (!isBrowser()) return null;
  return window.sessionStorage.getItem(API_KEY_STORAGE);
}

function captureApiKeyFromUrl() {
  const url = new URL(window.location.href);
  const key = url.searchParams.get(API_KEY_PARAM);
  if (!key) return;

  window.sessionStorage.setItem(API_KEY_STORAGE, key);
  setApiKeyCookie(key);
  url.searchParams.delete(API_KEY_PARAM);
  window.history.replaceState(window.history.state, document.title, `${url.pathname}${url.search}${url.hash}`);
}

function isApiRequest(input: RequestInfo | URL) {
  if (typeof input === 'string') return input.startsWith('/api/');
  if (input instanceof URL) return input.origin === window.location.origin && input.pathname.startsWith('/api/');
  return input.url.startsWith(`${window.location.origin}/api/`) || input.url.startsWith('/api/');
}

function installFetchApiKey() {
  if (fetchInstalled || !isBrowser()) return;
  fetchInstalled = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
    const key = getApiKey();
    if (!key || !isApiRequest(input)) return originalFetch(input, init);

    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    if (!headers.has('x-api-key')) headers.set('x-api-key', key);
    return originalFetch(input, { ...init, headers });
  };
}

export function installApiKeyAuth() {
  if (!isBrowser()) return;
  captureApiKeyFromUrl();
  const key = getApiKey();
  if (key) setApiKeyCookie(key);
  installFetchApiKey();
}
