import Ajv2020 from "ajv/dist/2020.js";
import { RE2 } from "re2-wasm";
const re2 = Object.assign(
  (pattern: string, flags: string) =>
    new RE2(pattern, flags.includes("u") ? flags : flags + "u"),
  { code: "RE2" },
);
const ajv = new Ajv2020({
  strict: true,
  allErrors: false,
  code: { regExp: re2 },
});
export function jsonSchema(
  body: unknown,
  schema: Record<string, unknown>,
): boolean {
  const validate = ajv.compile(schema);
  try {
    return !!validate(body);
  } finally {
    ajv.removeSchema(schema);
  }
}
