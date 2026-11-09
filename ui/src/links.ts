/** The URL when it is an absolute https link (safe to hand to `router.open`), else null. */
export function httpsUrl(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url) ? url : null;
}
