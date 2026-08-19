/**
 * Shared lookup for the serverless handlers.
 *
 * The wallet list is imported, not read from disk: serverless bundlers trace
 * imports and would silently omit a file opened with fs, leaving a function
 * that answers "clean" for every address. An import either ships or the build
 * fails.
 */

import snapshot from "../wallets-data.mjs";

/**
 * Lowercased keys. Ethereum addresses arrive in mixed EIP-55 checksum case and
 * two spellings of the same address must never screen differently.
 */
const WALLETS = new Map(snapshot.wallets.map(([k, v]) => [String(k).toLowerCase(), v]));

export const generatedAt = snapshot.generatedAt;
export const count = WALLETS.size;

/**
 * A snapshot this small means the generator produced something broken. Fail at
 * import time rather than serve it — a near-empty index reports every address
 * as clean, which fails OPEN and is indistinguishable from working screening.
 */
if (WALLETS.size < 50) {
  throw new Error(
    `wallets-data.mjs holds only ${WALLETS.size} wallets — refusing to serve an index ` +
      "that would report every address as clean",
  );
}

/** yente's /match result shape, limited to what a wallet lookup can produce. */
export function resultsFor(address) {
  const hit = WALLETS.get(String(address).toLowerCase());
  if (!hit) return [];
  return [
    {
      id: hit.id,
      caption: hit.caption,
      schema: "CryptoWallet",
      properties: { publicKey: [address], topics: hit.topics ?? [] },
      datasets: hit.datasets ?? [],
      // Exact key equality. There is no partial credit for a wallet address:
      // it either is the designated key or it is a different wallet.
      score: 1.0,
      match: true,
      target: true,
    },
  ];
}
