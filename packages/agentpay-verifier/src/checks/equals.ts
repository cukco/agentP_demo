import { isDeepStrictEqual } from "node:util";
import { pointer } from "./pointer.js";
export function equals(
  body: unknown,
  field: string,
  expected: unknown,
): boolean {
  return isDeepStrictEqual(pointer(body, field), expected);
}
