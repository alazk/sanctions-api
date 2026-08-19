/**
 * GET /healthz
 *
 * `ageHours` is the number to watch. On this deployment the data refreshes by
 * redeploy, not in-process — so if the daily GitHub Action breaks, this keeps
 * serving happily from an increasingly old snapshot and the only symptom is a
 * recently-designated wallet screening as clean. The age is the sole warning
 * you get.
 */

import { count, generatedAt } from "./_wallets.mjs";

export default function handler(_req, res) {
  const ageHours = +((Date.now() - Date.parse(generatedAt)) / 3_600_000).toFixed(1);
  res.status(200).json({
    status: "ok",
    wallets: count,
    generatedAt,
    ageHours,
    stale: ageHours > 48,
    source: "opensanctions-sanctions-collection",
  });
}
