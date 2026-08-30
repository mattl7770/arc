/**
 * SSRF guard for the only URLs ARC ever fetches from user input: a pasted or
 * shared recipe/article link (src/lib/recipes/import.ts, src/lib/knowledge/import.ts).
 *
 * Even though the user supplies the URL themselves, the request runs from the
 * device's own network position, so a link pointing at localhost, the LAN, or the
 * link-local metadata range (169.254.169.254) would make ARC issue a request an
 * outside site never could — the classic SSRF shape. These imports are single-user
 * and low-frequency, so we reject the private / loopback / link-local address
 * space outright rather than run a DNS resolver: it closes the literal-address
 * vectors the audit named, and no real recipe or article lives at one of these
 * hosts. (A public host that later 30x-redirects to a private one is not covered
 * here — that would need a redirect-time check at the fetch site.)
 *
 * Takes the host portion of a URL (optionally with a port), as produced by the
 * callers' host extraction. Returns true when the host must not be fetched.
 */
export function isPrivateHost(rawHost: string): boolean {
  let h = rawHost.trim().toLowerCase();
  if (h === '') return true;

  // Strip a port: [IPv6]:port, or host:port for IPv4/hostnames (a bare IPv6
  // literal has multiple colons and no brackets — leave those intact).
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    h = end > 0 ? h.slice(1, end) : h.slice(1);
  } else if ((h.match(/:/g) || []).length === 1) {
    h = h.slice(0, h.indexOf(':'));
  }
  h = h.replace(/%.*$/, ''); // drop an IPv6 zone id (fe80::1%en0)

  if (h === '' || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;

  // IPv6 literal ranges (only when it actually looks like one).
  if (h.includes(':')) {
    if (h === '::1') return true; // loopback
    if (h.startsWith('fe80:')) return true; // link-local
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // unique-local fc00::/7
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h); // IPv4-mapped
    if (!mapped) return false; // any other IPv6 literal → treat as public
    h = mapped[1]!;
  }

  // IPv4 literal ranges. A normal hostname never matches this.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false; // not a real IP
  if (a === 0 || a === 127 || a === 10) return true; // "this host", loopback, RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}
