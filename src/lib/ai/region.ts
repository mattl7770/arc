/**
 * Which country the phone is in, from its own settings (item 91, 2026-10-21).
 *
 * Owner, verbatim: *"location data for food logging; different countries fast
 * food menus notably?"* A Big Mac is not one food: the New Zealand menu and the
 * US one differ, and so do portion sizes and recipes for most chain items. His
 * call: the country comes from the phone's **time zone and region settings**,
 * not from GPS. No new permission, no native module, no location ever read.
 *
 * ## Time zone first, region setting second
 *
 * iOS sets the time zone by itself when the phone lands somewhere new, so it
 * follows the owner across a border; the Region setting is chosen once at setup
 * and stays home. The menu that matters is the one he is standing in front of,
 * so a zone that maps to one country wins. A zone that maps to none (`UTC`,
 * `Etc/GMT+3`) falls back to the region subtag of the locale. When the two
 * disagree the context line names both, so the model can see a trip rather
 * than have one hidden from it.
 *
 * ## Intl, defensively
 *
 * `Intl.DateTimeFormat().resolvedOptions()` gives both values. Much of this
 * codebase says Hermes ships no `Intl` (it hand-rolls every date format), so
 * the read is guarded: no `Intl`, or one that throws, gives a null region and
 * the context simply omits the line. Nothing is guessed from the UTC offset,
 * which is shared by many countries.
 *
 * PURE apart from {@link deviceRegion}'s one Intl read; headless-tested in
 * db/model-client.test.mjs.
 */

/** The phone's region, as far as its settings say. */
export type DeviceRegion = {
  /** ISO 3166-1 alpha-2 country, e.g. "NZ", or null when nothing maps. */
  country: string | null;
  /** The IANA time zone id, e.g. "Pacific/Auckland", when readable. */
  timeZone: string | null;
  /** The locale's own region subtag, e.g. "US" in "en-US", when present. */
  localeRegion: string | null;
};

/**
 * IANA zone → country, for the zones people actually live in. Not every zone:
 * an unlisted one falls back to the locale's region, which is always right
 * for someone at home. Legacy aliases (`Asia/Calcutta`, `Europe/Kiev`) are
 * listed because older devices still report them.
 */
const ZONE_COUNTRY: Record<string, string> = {
  // Oceania
  'Pacific/Auckland': 'NZ',
  'Pacific/Chatham': 'NZ',
  NZ: 'NZ',
  'Pacific/Fiji': 'FJ',
  'Pacific/Honolulu': 'US',
  'Pacific/Port_Moresby': 'PG',
  'Pacific/Tongatapu': 'TO',
  'Pacific/Apia': 'WS',
  'Pacific/Noumea': 'NC',
  'Pacific/Guam': 'GU',
  // North America
  'America/New_York': 'US',
  'America/Chicago': 'US',
  'America/Denver': 'US',
  'America/Phoenix': 'US',
  'America/Los_Angeles': 'US',
  'America/Anchorage': 'US',
  'America/Detroit': 'US',
  'America/Boise': 'US',
  'America/Juneau': 'US',
  'America/Adak': 'US',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
  'America/Edmonton': 'CA',
  'America/Winnipeg': 'CA',
  'America/Halifax': 'CA',
  'America/St_Johns': 'CA',
  'America/Regina': 'CA',
  'America/Montreal': 'CA',
  'America/Moncton': 'CA',
  'America/Whitehorse': 'CA',
  'America/Mexico_City': 'MX',
  'America/Cancun': 'MX',
  'America/Tijuana': 'MX',
  'America/Monterrey': 'MX',
  // Central and South America, Caribbean
  'America/Sao_Paulo': 'BR',
  'America/Bogota': 'CO',
  'America/Lima': 'PE',
  'America/Santiago': 'CL',
  'America/Caracas': 'VE',
  'America/Montevideo': 'UY',
  'America/Guatemala': 'GT',
  'America/Costa_Rica': 'CR',
  'America/Panama': 'PA',
  'America/Puerto_Rico': 'PR',
  'America/Jamaica': 'JM',
  'America/Havana': 'CU',
  'America/Santo_Domingo': 'DO',
  'America/Buenos_Aires': 'AR',
  // Europe
  'Europe/London': 'GB',
  'Europe/Dublin': 'IE',
  'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE',
  'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT',
  'Europe/Amsterdam': 'NL',
  'Europe/Brussels': 'BE',
  'Europe/Zurich': 'CH',
  'Europe/Vienna': 'AT',
  'Europe/Stockholm': 'SE',
  'Europe/Oslo': 'NO',
  'Europe/Copenhagen': 'DK',
  'Europe/Helsinki': 'FI',
  'Europe/Lisbon': 'PT',
  'Europe/Warsaw': 'PL',
  'Europe/Prague': 'CZ',
  'Europe/Budapest': 'HU',
  'Europe/Athens': 'GR',
  'Europe/Istanbul': 'TR',
  'Europe/Moscow': 'RU',
  'Europe/Kyiv': 'UA',
  'Europe/Kiev': 'UA',
  'Europe/Bucharest': 'RO',
  'Europe/Sofia': 'BG',
  'Europe/Belgrade': 'RS',
  'Europe/Zagreb': 'HR',
  'Europe/Ljubljana': 'SI',
  'Europe/Bratislava': 'SK',
  'Europe/Luxembourg': 'LU',
  'Europe/Monaco': 'MC',
  'Europe/Riga': 'LV',
  'Europe/Tallinn': 'EE',
  'Europe/Vilnius': 'LT',
  'Europe/Malta': 'MT',
  'Atlantic/Reykjavik': 'IS',
  'Atlantic/Canary': 'ES',
  'Atlantic/Madeira': 'PT',
  'Asia/Nicosia': 'CY',
  // Asia
  'Asia/Tokyo': 'JP',
  'Asia/Seoul': 'KR',
  'Asia/Shanghai': 'CN',
  'Asia/Hong_Kong': 'HK',
  'Asia/Macau': 'MO',
  'Asia/Taipei': 'TW',
  'Asia/Singapore': 'SG',
  'Asia/Kolkata': 'IN',
  'Asia/Calcutta': 'IN',
  'Asia/Dubai': 'AE',
  'Asia/Bangkok': 'TH',
  'Asia/Jakarta': 'ID',
  'Asia/Makassar': 'ID',
  'Asia/Manila': 'PH',
  'Asia/Kuala_Lumpur': 'MY',
  'Asia/Ho_Chi_Minh': 'VN',
  'Asia/Saigon': 'VN',
  'Asia/Karachi': 'PK',
  'Asia/Dhaka': 'BD',
  'Asia/Riyadh': 'SA',
  'Asia/Qatar': 'QA',
  'Asia/Kuwait': 'KW',
  'Asia/Bahrain': 'BH',
  'Asia/Muscat': 'OM',
  'Asia/Jerusalem': 'IL',
  'Asia/Tel_Aviv': 'IL',
  'Asia/Beirut': 'LB',
  'Asia/Amman': 'JO',
  'Asia/Tehran': 'IR',
  'Asia/Kathmandu': 'NP',
  'Asia/Colombo': 'LK',
  'Asia/Phnom_Penh': 'KH',
  'Asia/Yangon': 'MM',
  'Asia/Almaty': 'KZ',
  'Asia/Tashkent': 'UZ',
  'Asia/Tbilisi': 'GE',
  'Asia/Yerevan': 'AM',
  'Asia/Baku': 'AZ',
  // Africa
  'Africa/Johannesburg': 'ZA',
  'Africa/Cairo': 'EG',
  'Africa/Lagos': 'NG',
  'Africa/Nairobi': 'KE',
  'Africa/Casablanca': 'MA',
  'Africa/Accra': 'GH',
  'Africa/Addis_Ababa': 'ET',
  'Africa/Algiers': 'DZ',
  'Africa/Tunis': 'TN',
  'Africa/Dar_es_Salaam': 'TZ',
  'Africa/Kampala': 'UG',
  'Indian/Mauritius': 'MU',
};

/** Whole families of zones that all sit in one country. */
const ZONE_PREFIX_COUNTRY: [string, string][] = [
  ['Australia/', 'AU'],
  ['America/Indiana/', 'US'],
  ['America/Kentucky/', 'US'],
  ['America/North_Dakota/', 'US'],
  ['America/Argentina/', 'AR'],
  ['US/', 'US'],
  ['Canada/', 'CA'],
  ['Brazil/', 'BR'],
  ['Mexico/', 'MX'],
  ['Chile/', 'CL'],
];

/** The country an IANA zone id sits in, or null when the table does not say. */
export function countryOfTimeZone(timeZone: string | null | undefined): string | null {
  if (!timeZone) return null;
  const exact = ZONE_COUNTRY[timeZone];
  if (exact) return exact;
  for (const [prefix, country] of ZONE_PREFIX_COUNTRY) {
    if (timeZone.startsWith(prefix)) return country;
  }
  return null;
}

/**
 * The region subtag of a BCP 47 locale: "en-NZ" → "NZ", "zh-Hant-TW" → "TW",
 * "en_GB" → "GB". Null for none ("en"), for a numeric UN M.49 area ("es-419",
 * not a country), and for anything after an extension singleton ("-u-…").
 */
export function regionOfLocale(locale: string | null | undefined): string | null {
  if (!locale) return null;
  const subtags = locale.split(/[-_]/).slice(1);
  for (const subtag of subtags) {
    if (subtag.length === 1) return null; // an extension starts; no region came first
    if (/^[A-Za-z]{2}$/.test(subtag)) return subtag.toUpperCase();
  }
  return null;
}

/** Combine what the settings say into one region (see the header for the order). */
export function deriveRegion(input: {
  locale?: string | null;
  timeZone?: string | null;
}): DeviceRegion {
  const timeZone = input.timeZone && input.timeZone.trim() !== '' ? input.timeZone : null;
  const localeRegion = regionOfLocale(input.locale);
  return {
    country: countryOfTimeZone(timeZone) ?? localeRegion,
    timeZone,
    localeRegion,
  };
}

/** The phone's region now. Never throws; an absent `Intl` gives all nulls. */
export function deviceRegion(): DeviceRegion {
  try {
    if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') {
      return deriveRegion({});
    }
    const options = Intl.DateTimeFormat().resolvedOptions();
    return deriveRegion({ locale: options.locale, timeZone: options.timeZone });
  } catch {
    return deriveRegion({});
  }
}

/**
 * The one context line: `Region: NZ (time zone Pacific/Auckland)`, or with the
 * locale's region named too when it says something else (a trip). Null when
 * nothing is known, so the line is simply absent.
 */
export function regionLine(region: DeviceRegion): string | null {
  const { country, timeZone, localeRegion } = region;
  if (country === null && timeZone === null) return null;
  const notes: string[] = [];
  if (timeZone) notes.push(`time zone ${timeZone}`);
  if (localeRegion && localeRegion !== country) notes.push(`phone region ${localeRegion}`);
  return `Region: ${country ?? 'unknown'}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`;
}
