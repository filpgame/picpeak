/**
 * Country codes offered in the customer country picker. Stored value is
 * always the ISO 3166-1 alpha-2 code; Liechtenstein is `LI` (NOT the
 * colloquial `FL` plate code) so it matches ISO + the PDF renderer's
 * lookup. Display names are derived at runtime from `Intl.DisplayNames`
 * in the active UI language, so the list stays locale-aware without a
 * hand-maintained translation map.
 */
export const COUNTRY_CODES = [
  'LI', 'CH', 'AT', 'DE', 'FR', 'IT', 'ES', 'PT', 'NL', 'BE', 'LU',
  'GB', 'US', 'DK', 'SE', 'NO', 'FI', 'PL', 'CZ', 'SK', 'HU', 'IE',
] as const;

export type CountryCode = (typeof COUNTRY_CODES)[number];

/** Localized country name for an ISO code, falling back to the code. */
export function countryLabel(code: string, lang: string): string {
  if (!code) return '';
  const upper = code.trim().toUpperCase();
  try {
    return new Intl.DisplayNames([lang || 'en'], { type: 'region' }).of(upper) || upper;
  } catch {
    return upper;
  }
}

/** Country codes sorted by their localized label for the active language. */
export function sortedCountryOptions(lang: string): { code: string; label: string }[] {
  return COUNTRY_CODES.map((code) => ({ code, label: countryLabel(code, lang) }))
    .sort((a, b) => a.label.localeCompare(b.label, lang || 'en'));
}
