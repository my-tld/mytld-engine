/** Domain parsing/validation and result types. Browser-safe: no Node APIs. */

export type DomainStatus = "available" | "taken" | "unknown";
export type LookupSource = "cache" | "dns" | "rdap" | "whois";

export interface DomainResult {
  domain: string;
  status: DomainStatus;
  /** true = definitive answer (NS delegation, or the registry via RDAP/WHOIS). */
  verified: boolean;
  /**
   * Set on "unknown": the name has no DNS delegation, but no registry confirmed it.
   * That is NOT "available" — registered names can lack DNS (on hold, parked, reserved).
   */
  noDns?: boolean;
  source: LookupSource;
}

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TLD_RE = /^[a-z0-9-]{2,63}$/;

/** IDN-safe → punycode via the WHATWG URL parser (works in browser and Node). */
function toAscii(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}


export function isValidLabel(label: string): boolean {
  if (!LABEL_RE.test(label)) {
    return false;
  }

  // "ab--" is reserved for A-labels (xn--) only.
  if (label.slice(2, 4) === "--" && !label.startsWith("xn--")) {
    return false;
  }

  return true;
}

export interface ParsedQuery {
  /** ASCII/punycode second-level label, e.g. "hello" */
  name: string;
  /** TLD the user typed, if any ("hello.dev" → "dev") */
  tld: string | null;
}

/** Accepts "Hello", "hello.dev", "https://www.hello.dev/x", "müller" … */
export function parseQuery(raw: string): ParsedQuery | null {
  let input = raw.trim().toLowerCase();

  if (!input) {
    return null;
  }

  input = input
    .replace(/^[a-z]+:\/\//, "") // scheme
    .replace(/[/?#].*$/, "") // path, query, fragment
    .replace(/^www\./, "")
    .replace(/\s+/g, "-")
    .replace(/\.+$/, "");

  const ascii = toAscii(input);

  if (!ascii) {
    return null;
  }

  const [name, ...rest] = ascii.split(".");

  if (!isValidLabel(name)) {
    return null;
  }

  const tld = rest.length ? rest.join(".") : null;

  return { name, tld: tld && TLD_RE.test(tld) ? tld : null };
}

/** Strict validation of a full "label.tld" domain (server-side input check). */
export function isValidDomain(domain: string): boolean {
  if (domain.length > 253) {
    return false;
  }

  const dot = domain.indexOf(".");
  const hasExactlyOneDot = dot > 0 && domain.indexOf(".", dot + 1) === -1;

  if (!hasExactlyOneDot) {
    return false;
  }

  return isValidLabel(domain.slice(0, dot)) && TLD_RE.test(domain.slice(dot + 1));
}

export function tldOf(domain: string): string {
  return domain.slice(domain.indexOf(".") + 1);
}
