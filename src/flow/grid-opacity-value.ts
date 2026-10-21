// CSS color-mix requires a percentage. Keep the saved value as a whole number.
export const DEFAULT_GRID_OPACITY = 55;

export function gridOpacityCssValue(percent: number | undefined): string {
  const n = typeof percent === "number" && Number.isInteger(percent) && percent >= 0 && percent <= 100
    ? percent : DEFAULT_GRID_OPACITY;
  return `${n}%`;
}
