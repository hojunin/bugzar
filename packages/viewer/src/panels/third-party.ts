// Heuristic "third-party" classifier for console/network noise from analytics,
// RUM, and tag products. Used to hide them by default (toggle to include).
// Matches by URL (network) or by the joined console args.

const PATTERNS: RegExp[] = [
  /datadoghq|datadog|dd-rum|dd_rum|browser-intake/i,
  /amplitude/i,
  /sentry\.io|@sentry|\bsentry\b/i,
  /google-analytics|googletagmanager|gtag|analytics\.google|doubleclick/i,
  /\bsegment\b|segment\.(io|com)/i,
  /mixpanel/i,
  /hotjar/i,
  /fullstory/i,
  /clarity\.ms/i,
  /newrelic|nr-data/i,
  /connect\.facebook|facebook\.net|fbevents/i,
  /braze|appboy/i,
  /intercom/i,
];

/** True when the text (a URL, or joined console args) looks like third-party noise. */
export function isThirdParty(text: string): boolean {
  return PATTERNS.some((re) => re.test(text));
}
