import { pointer } from "./pointer.js";
export function range(
  body: unknown,
  field: string,
  min?: number,
  max?: number,
): boolean {
  const value = pointer(body, field);
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (min === undefined || value >= min) &&
    (max === undefined || value <= max)
  );
}
