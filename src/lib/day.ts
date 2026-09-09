/**
 * The calendar day, as the person in front of the screen would name it.
 *
 * `toISOString()` is UTC, and every "what day is it" in this project used to go
 * through it. East of Greenwich that is a day behind between local midnight and
 * the offset -- at 01:00 in Brussels the app still had yesterday's slate on the
 * table and refused a new one for another hour. West of it the error is worse
 * and lands in prime time: at 20:00 in New York it is already tomorrow in UTC,
 * so the day would roll over and hand out tomorrow's five before tonight was
 * finished.
 *
 * A slate belongs to a day as it is lived, so every moment that becomes a date
 * comes through here.
 *
 * Date *arithmetic* on an existing YYYY-MM-DD string is a different thing and
 * stays anchored at UTC midnight -- `currentStreak` stepping back a day, or
 * `simulate` stepping forward one -- because stepping a calendar has no
 * timezone and parsing a bare date as local would reintroduce the offset it is
 * trying to avoid.
 *
 * On a server this follows the process timezone, so an install running
 * somewhere other than home wants `TZ` set (`TZ=Europe/Brussels`). Node reads
 * it natively; there is no setting here to keep in step with it.
 */
export const dayOf = (moment: Date = new Date()): string =>
  `${moment.getFullYear()}-${String(moment.getMonth() + 1).padStart(2, '0')}-${String(
    moment.getDate(),
  ).padStart(2, '0')}`;
