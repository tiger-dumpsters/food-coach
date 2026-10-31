// Days that get a short morning note: US holidays people celebrate around food, and Mondays.

function nthWeekday(year, month, weekday, n) { // month 1-12, weekday 0=Sun; n=-1 for last
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return lastDay - ((last - weekday + 7) % 7);
}

// Easter Sunday (Anonymous Gregorian algorithm).
function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451), month = Math.floor((h + l - 7 * m + 114) / 31);
  return { month, day: ((h + l - 7 * m + 114) % 31) + 1 };
}

const pad = (n) => String(n).padStart(2, '0');

export function holidaysFor(year) {
  const e = easter(year);
  const list = [
    [1, 1, "New Year's Day"],
    [e.month, e.day, 'Easter'],
    [5, nthWeekday(year, 5, 1, -1), 'Memorial Day'],
    [7, 4, 'the Fourth of July'],
    [9, nthWeekday(year, 9, 1, 1), 'Labor Day'],
    [10, 31, 'Halloween'],
    [11, nthWeekday(year, 11, 4, 4), 'Thanksgiving'],
    [12, 24, 'Christmas Eve'],
    [12, 25, 'Christmas'],
    [12, 31, "New Year's Eve"],
  ];
  return Object.fromEntries(list.map(([m, d, name]) => [`${year}-${pad(m)}-${pad(d)}`, name]));
}

// { kind: 'holiday' | 'monday', name } or null. `day` is YYYY-MM-DD local.
export function occasionFor(day) {
  const holiday = holidaysFor(Number(day.slice(0, 4)))[day];
  if (holiday) return { kind: 'holiday', name: holiday };
  if (new Date(`${day}T12:00:00Z`).getUTCDay() === 1) return { kind: 'monday', name: 'Monday' };
  return null;
}
