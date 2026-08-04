const FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
] as const;

export function validateCron(expression: string): void {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron must contain five fields: minute hour day month weekday");
  fields.forEach((field, index) => {
    const [minimum, maximum] = FIELD_RANGES[index]!;
    parseField(field!, minimum, maximum);
  });
}

export function cronMatches(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
  return fields.every((field, index) => {
    const [minimum, maximum] = FIELD_RANGES[index]!;
    return parseField(field!, minimum, maximum).has(values[index]!);
  });
}

export function cronMinute(date = new Date()): number {
  return Math.floor(date.getTime() / 60_000);
}

function parseField(field: string, minimum: number, maximum: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step: ${part}`);
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = minimum;
      end = maximum;
    } else if (rangePart?.includes("-")) {
      const [left, right] = rangePart.split("-");
      start = Number(left);
      end = Number(right);
    } else {
      start = Number(rangePart);
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < minimum || end > maximum || start > end) {
      throw new Error(`Invalid cron field: ${part}`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}
