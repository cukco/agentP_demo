/** RFC 6901. Only own JSON properties, with canonical array indices. */
export function pointer(value: unknown, path: string): unknown {
  if (path === "") return value;
  if (!path.startsWith("/") || /~(?:[^01]|$)/.test(path)) return undefined;
  for (const token of path.slice(1).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, key)
    )
      return undefined;
    if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
