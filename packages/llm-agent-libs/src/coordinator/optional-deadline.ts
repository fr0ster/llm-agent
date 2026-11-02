/** Only durations supported by Node timers can opt in to a deadline. */
export function optionalDeadlineMs(
  value: number | undefined,
): number | undefined {
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 2_147_483_647
    ? value
    : undefined;
}
