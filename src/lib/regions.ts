/**
 * The regions §2 names as blind spots.
 *
 * Deliberately not a clean geographic partition. These are the groupings the
 * brief argues about, so "East Asia beyond Japan" and "Middle East beyond Iran"
 * are real entries: the point of the panel is the gap, and folding Japan back
 * into East Asia would hide the only interesting thing it says.
 *
 * A country not listed here lands in "Elsewhere" on the matrix rather than
 * being dropped, because a country silently missing from a coverage chart is
 * exactly the failure this project keeps trying not to have.
 */
export const REGION_GROUPS: [string, string[]][] = [
  ['India', ['IN']],
  ['Iran', ['IR']],
  [
    'Africa',
    ['SN', 'ML', 'BF', 'DZ', 'MA', 'EG', 'TN', 'ZA', 'NG', 'ET', 'TD', 'MR', 'GH', 'KE', 'AO', 'CM', 'CI'],
  ],
  ['Latin America', ['AR', 'BR', 'MX', 'CL', 'CO', 'PE', 'CU', 'UY', 'VE', 'BO', 'EC', 'GT']],
  ['Southeast Asia', ['TH', 'PH', 'ID', 'VN', 'MY', 'SG', 'KH', 'MM']],
  ['East Asia beyond Japan', ['CN', 'HK', 'TW', 'KR']],
  ['Middle East beyond Iran', ['TR', 'LB', 'IL', 'SY', 'IQ', 'JO', 'AE', 'PS', 'QA']],
  [
    'Eastern Europe',
    ['PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'RS', 'HR', 'XC', 'YU', 'SU', 'RU', 'EE', 'BA'],
  ],
  ['Nordics', ['SE', 'NO', 'DK', 'FI', 'IS']],
];
