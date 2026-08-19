/**
 * POST /match/{dataset} — yente-compatible wallet screening.
 *
 * The dataset segment is accepted and ignored: this index is built from the
 * whole OpenSanctions `sanctions` collection, so there is no narrower scope to
 * select. It stays in the path so the deployed WASM oracle needs no change.
 */

import { resultsFor } from "../_wallets.mjs";

export default function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  // Vercel parses JSON bodies, but a raw string arrives if the content-type is
  // missing. Handle both rather than 500 on a header nobody thought about.
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body || "{}");
    } catch {
      res.status(400).json({ error: "invalid JSON" });
      return;
    }
  }

  const responses = {};
  for (const [key, q] of Object.entries(body?.queries ?? {})) {
    const addresses = q?.properties?.publicKey ?? [];
    const results = addresses.flatMap((a) => resultsFor(a));
    responses[key] = {
      status: 200,
      results,
      total: { value: results.length, relation: "eq" },
      query: { id: null, schema: q?.schema ?? "CryptoWallet", properties: q?.properties ?? {} },
    };
  }

  res.status(200).json({ responses, limit: 5 });
}
