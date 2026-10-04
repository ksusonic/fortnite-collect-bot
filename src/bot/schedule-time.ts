export function moscowDate(now = Date.now()): Date {
  return new Date(now + 3 * 60 * 60 * 1000);
}
// Friday 21:00 MSK for the most recent due weekly period. IDs and decision
// timestamps stay fixed even when maintenance catches up after downtime.
export function weeklyDue(now: number): { date: string; now: number } {
  const current = moscowDate(now * 1000);
  const due = new Date(current);
  due.setUTCDate(due.getUTCDate() - ((due.getUTCDay() + 2) % 7));
  due.setUTCHours(21, 0, 0, 0);
  if (due.getTime() > current.getTime()) due.setUTCDate(due.getUTCDate() - 7);
  return {
    date: due.toISOString().slice(0, 10),
    now: due.getTime() / 1000 - 3 * 3600,
  };
}
