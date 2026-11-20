import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { KeeperStore, KeeperStoreData } from "./keeper.js";

/** JSON file store with atomic replace (write temp, then rename). */
export function fileStore(path: string): KeeperStore {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, "utf8")) as KeeperStoreData;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    },
    async save(data) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2));
      await rename(tmp, path);
    },
  };
}
