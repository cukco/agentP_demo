import type { ChainAdapter } from "./chain.js";
import type { VerifierDatabase } from "./db.js";

export async function syncSessions(db: VerifierDatabase, chain: ChainAdapter, clock: () => number, startBlock?: bigint) {
  const tip = await chain.getBlockNumber();
  // Leave a short confirmation window before indexing logs used for background processing.
  const end = tip > 2n ? tip - 2n : 0n;
  const cursor = db.cursor();
  let from = cursor === undefined ? startBlock ?? end : cursor + 1n;
  while (from <= end) {
    const to = from + 999n < end ? from + 999n : end;
    for (const id of await chain.scanSessionOpened(from, to)) {
      const session = await chain.getSession(id);
      if (session) db.saveSession(id, session, clock());
    }
    db.saveCursor(to);
    from = to + 1n;
  }
  for (const id of db.activeSessions()) {
    const session = await chain.getSession(id);
    if (session) db.saveSession(id, session, clock());
  }
}
