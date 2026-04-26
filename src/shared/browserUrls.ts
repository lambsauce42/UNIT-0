export const DEFAULT_BROWSER_URL = "https://example.com/";

const supportedBrowserProtocols = new Set(["http:", "https:", "file:", "about:"]);
const localAddressPattern = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i;
const explicitSchemePattern = /^[a-z][a-z\d+.-]*:/i;

export function normalizeBrowserNavigationUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_BROWSER_URL;
  }
  const candidate = localAddressPattern.test(trimmed)
    ? `http://${trimmed}`
    : explicitSchemePattern.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
  const url = new URL(candidate);
  if (!supportedBrowserProtocols.has(url.protocol)) {
    throw new Error(`Unsupported browser protocol: ${url.protocol}`);
  }
  return url.toString();
}
