export type WhoisAnswer = "available" | "taken" | "unknown";

/*
 * WHOIS has no standard format. These patterns cover the registries we query.
 */

const NOT_FOUND = new RegExp(
  [
    "no match",
    "not[ _]found",
    "no data (was )?found",
    "no entries found",
    "nothing found",
    "status:\\s*(free|available)",
    "no object found",
    "is free",
    "not registered",
    "not been registered",
    "no such domain",
    "we do not have an entry",
    "no information available",
    "object does not exist",
    "available for registration",
    "does not exist",
  ].join("|"),
  "i",
);

const RATE_LIMITED = new RegExp(
  ["exceeded", "too many", "quota", "try again later", "access denied", "blacklisted", "not permitted", "not allowed"].join("|"),
  "i",
);

const REGISTERED = new RegExp(
  [
    "domain name:",
    "registrar:",
    "registrar\\b",
    "creation date",
    "created:",
    "registered:",
    "registration date",
    "status:\\s*(active|connect|registered|ok)",
    "nserver:",
    "name servers?:",
    "holder:",
    "registrant",
  ].join("|"),
  "i",
);

/**
 * Classifies a raw WHOIS reply.
 *
 * "taken" requires positive evidence: an unparseable reply is "unknown", never a guess.
 */
export function parseWhois(reply: string): WhoisAnswer {
  if (!reply.trim()) {
    return "unknown";
  }

  if (NOT_FOUND.test(reply)) {
    return "available";
  }

  if (RATE_LIMITED.test(reply)) {
    return "unknown";
  }

  return REGISTERED.test(reply) ? "taken" : "unknown";
}

/** Some registries need a special query syntax. */
export function formatQuery(tld: string, domain: string): string {
  switch (tld) {
    case "de":
      return `-T dn,ace ${domain}`; // DENIC: domain info, ASCII/punycode

    case "jp":
      return `${domain}/e`; // JPRS: English output

    default:
      return domain;
  }
}
