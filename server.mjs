/**
 * Minimal sanctioned-wallet screening API, yente-response-compatible.
 *
 * Why this exists: the oracle asks yente exactly one kind of question —
 *
 *   { schema: "CryptoWallet", properties: { publicKey: ["0x…"] } }
 *
 * an exact key lookup. yente answers it with Elasticsearch, which needs ~2GB
 * of RAM, which is why the only free host that fit was Oracle. Doing the same
 * lookup with a hash map needs ~100MB and runs on any free tier.
 *
 * It serves the same /match/{dataset} response shape, so the deployed WASM
 * oracle and Rego policy need no changes at all — only YENTE_URL moves.
 *
 * What it does NOT do: name matching, fuzzy search, any non-wallet schema.
 * Those are real yente features and this is not a yente replacement. It is a
 * wallet-screening endpoint that happens to speak yente's dialect.
 *
 *   node server.mjs
 */

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.join(__dirname, "wallets.json");

const PORT = Number(process.env.PORT ?? 8001);
const REFRESH_HOURS = Number(process.env.REFRESH_HOURS ?? 12);

/**
 * Which OpenSanctions sources to load. Defaults to the whole `sanctions`
 * collection.
 *
 * The alternative is naming the handful of sources known to designate crypto
 * wallets, which loads in a fraction of the time. It was rejected on purpose:
 * a hardcoded source list goes stale silently. When OpenSanctions adds wallet
 * designations to a source not on the list, those addresses screen as CLEAN,
 * and no test catches it because the tests use addresses from sources that
 * are on the list. That is a fail-open, and fail-open is the one direction
 * this service must never take.
 *
 * The cost is a slow first load — several hundred MB, most of it entities we
 * discard. During it /healthz returns 503 and the policy denies, which is the
 * correct behaviour while coverage is unknown.
 *
 * For a quick local test where completeness does not matter:
 *   DATASETS=us_ofac_sdn,il_mod_crypto,us_fbi_lazarus_crypto node server.mjs
 */
const DATASETS = (process.env.DATASETS ?? "sanctions")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const indexUrl = (d) => `https://data.opensanctions.org/datasets/latest/${d}/index.json`;
const fallbackUrl = (d) => `https://data.opensanctions.org/datasets/latest/${d}/entities.ftm.json`;

/**
 * publicKey (lowercased) -> entity summary.
 *
 * Lowercased because Ethereum addresses arrive in mixed EIP-55 checksum case
 * and two spellings of the same address must not screen differently.
 */
let WALLETS = new Map();
let loadedAt = null;
let loadedVersion = null;
let loading = false;

async function resolveDataUrl(dataset) {
  try {
    const res = await fetch(indexUrl(dataset), { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`index ${res.status}`);
    const idx = await res.json();
    const entities = (idx.resources ?? []).find((r) => r.name === "entities.ftm.json");
    return { url: entities?.url ?? fallbackUrl(dataset), version: idx.version ?? null };
  } catch (e) {
    console.warn(`[${dataset}] index lookup failed, using fallback URL:`, String(e));
    return { url: fallbackUrl(dataset), version: null };
  }
}

/**
 * Stream the dataset and keep only CryptoWallet entities.
 *
 * The file is hundreds of MB of newline-delimited JSON. Parsing it in one go
 * would need more memory than the whole point of this service allows, so it
 * is consumed line by line and everything that isn't a wallet is discarded
 * immediately.
 */
async function loadOne(dataset, into) {
  const { url, version } = await resolveDataUrl(dataset);
  const res = await fetch(url, { signal: AbortSignal.timeout(900_000) });
  if (!res.ok) throw new Error(`${dataset}: HTTP ${res.status}`);

  const before = into.size;
  let scanned = 0;
  let buf = "";
  let nextTick = 100_000;

  // The full collection takes minutes. Without progress output it is
  // indistinguishable from a hang, and the natural response to an apparent
  // hang is to kill it and retry — which never finishes either.
  const tick = () => {
    if (++scanned >= nextTick) {
      nextTick += 100_000;
      console.log(`    ${dataset}: ${scanned} entities scanned, ${into.size - before} wallets so far`);
    }
  };

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) ingest(line, into, tick);
    }
  }
  if (buf.trim()) ingest(buf, into, tick);

  const added = into.size - before;
  console.log(`  ${dataset.padEnd(24)} ${String(added).padStart(5)} wallets  (${scanned} entities)`);
  return { added, version };
}

async function load() {
  if (loading) return;
  loading = true;
  const started = Date.now();
  try {
    console.log(`loading ${DATASETS.length} dataset(s)…`);
    const next = new Map();
    const versions = {};
    let failures = 0;

    for (const d of DATASETS) {
      try {
        const { version } = await loadOne(d, next);
        versions[d] = version;
      } catch (e) {
        // One source being unavailable must not silently shrink coverage.
        // Count it, and let the size check below decide whether what we got
        // is still usable.
        failures++;
        console.error(`  ${d.padEnd(24)} FAILED — ${String(e).slice(0, 120)}`);
      }
    }

    /**
     * Refuse to swap in an empty or implausibly small index.
     *
     * An index with no wallets answers "clean" for every address — it fails
     * OPEN, silently, and looks exactly like a working screening service.
     * Keeping the previous good data and shouting is strictly better.
     */
    if (next.size < 50) {
      console.error(
        `REFUSING to load: only ${next.size} wallets across ${DATASETS.length} datasets ` +
          `(${failures} failed). Keeping the previous index rather than reporting ` +
          "every address as clean.",
      );
      return;
    }

    if (failures > 0) {
      console.warn(
        `${failures} dataset(s) failed to load — coverage is incomplete. ` +
          "Addresses designated only by those sources will screen as clean.",
      );
    }

    WALLETS = next;
    loadedAt = new Date().toISOString();
    loadedVersion = versions;
    console.log(
      `ready: ${next.size} sanctioned wallets in ${((Date.now() - started) / 1000) | 0}s`,
    );
  } catch (e) {
    console.error("load failed:", String(e));
  } finally {
    loading = false;
  }
}

function ingest(line, map, count) {
  count();

  /**
   * Cheap reject before the expensive parse.
   *
   * Over 99% of lines are people, companies, vessels — everything we discard.
   * JSON.parse on all of them dominates startup, which matters because the
   * free tier this runs on has 0.1 vCPU and the service denies every payment
   * until it has finished loading. A substring scan is orders of magnitude
   * cheaper and cannot produce a false negative: any line whose schema is
   * CryptoWallet necessarily contains that string.
   *
   * False positives (the string appearing elsewhere in a record) are fine —
   * they fall through to the exact schema check below.
   */
  if (line.indexOf('"CryptoWallet"') === -1) return;

  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  if (e.schema !== "CryptoWallet") return;
  for (const key of e.properties?.publicKey ?? []) {
    const k = String(key).toLowerCase();
    const prev = map.get(k);
    // The same wallet can appear under several regimes. Merge the dataset
    // lists rather than letting the last one win, or a wallet on both the
    // OFAC and EU lists would report only one of them.
    const datasets = new Set([...(prev?.datasets ?? []), ...(e.datasets ?? [])]);
    map.set(k, {
      id: prev?.id ?? e.id,
      caption: prev?.caption ?? e.caption ?? key,
      datasets: [...datasets],
      topics: e.properties?.topics ?? prev?.topics ?? [],
    });
  }
}

/** yente's /match result shape, limited to what a wallet lookup can produce. */
function resultFor(address) {
  const hit = WALLETS.get(address.toLowerCase());
  if (!hit) return [];
  return [
    {
      id: hit.id,
      caption: hit.caption,
      schema: "CryptoWallet",
      properties: { publicKey: [address], topics: hit.topics },
      datasets: hit.datasets,
      // Exact key equality. There is no partial credit for a wallet address:
      // it either is the designated key or it is a different wallet.
      score: 1.0,
      match: true,
      target: true,
    },
  ];
}

const server = createServer((req, res) => {
  const send = (code, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  };

  if (req.method === "GET" && req.url.startsWith("/healthz")) {
    // Not ready until an index is loaded. Reporting healthy while empty would
    // make every address look clean.
    const ready = WALLETS.size > 0;
    return send(ready ? 200 : 503, {
      status: ready ? "ok" : "loading",
      wallets: WALLETS.size,
      datasets: DATASETS,
      loadedAt,
      // Age of the data being served. If this keeps growing, the background
      // refresh is failing and coverage is quietly falling behind — the only
      // symptom of which would be a recently-designated wallet screening as
      // clean.
      ageHours: loadedAt ? +((Date.now() - Date.parse(loadedAt)) / 3_600_000).toFixed(1) : null,
      versions: loadedVersion,
    });
  }

  if (req.method === "POST" && req.url.startsWith("/match/")) {
    if (WALLETS.size === 0) {
      return send(503, { error: "index not loaded yet" });
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        return send(400, { error: "invalid JSON" });
      }
      const responses = {};
      for (const [key, q] of Object.entries(parsed.queries ?? {})) {
        const addrs = q?.properties?.publicKey ?? [];
        const results = addrs.flatMap((a) => resultFor(String(a)));
        responses[key] = {
          status: 200,
          results,
          total: { value: results.length, relation: "eq" },
          query: { id: null, schema: q?.schema ?? "CryptoWallet", properties: q?.properties ?? {} },
        };
      }
      send(200, { responses, limit: 5 });
    });
    return;
  }

  send(404, { error: "not found" });
});

/**
 * Write the current index to disk, to be committed and baked into the image.
 *
 *   node server.mjs --write-snapshot
 */
if (process.argv.includes("--write-snapshot")) {
  await load();
  if (WALLETS.size < 50) {
    console.error("refusing to write a snapshot with almost no wallets");
    process.exit(1);
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    count: WALLETS.size,
    wallets: [...WALLETS],
  };
  await writeFile(SNAPSHOT, JSON.stringify(payload) + "\n");

  /**
   * Also emit an ES module.
   *
   * Serverless bundlers trace imports, not filesystem reads — a function that
   * did readFile("wallets.json") would deploy without the file and answer
   * "clean" for every address. Exporting it as a module makes the data an
   * import, so it either bundles or the build fails loudly.
   */
  await writeFile(
    path.join(__dirname, "wallets-data.mjs"),
    "// GENERATED by `node server.mjs --write-snapshot`. Do not edit.\n" +
      "// Imported rather than read from disk so serverless bundlers include it.\n" +
      `export default ${JSON.stringify(payload)};\n`,
  );

  console.log(`wrote wallets.json and wallets-data.mjs (${WALLETS.size} wallets)`);
  process.exit(0);
}

/**
 * Boot from the committed snapshot, then refresh from OpenSanctions in the
 * background.
 *
 * Free hosts sleep when idle and take a while to wake. Loading ~300MB before
 * answering anything would mean minutes of 503s after every idle period, and
 * because the policy fails closed, minutes of denied payments. Booting from a
 * snapshot makes the service useful immediately and lets the network fetch
 * happen while it is already serving.
 *
 * The tradeoff is honest and bounded: between boot and the first successful
 * refresh, answers come from a snapshot that may be days old and could miss a
 * recent designation. That is a real gap. It is preferable to the
 * alternatives — answering nothing (denies everything) or answering from an
 * empty index (clears everything) — and /healthz reports the snapshot age so
 * the staleness is visible rather than assumed.
 */
try {
  const snap = JSON.parse(await readFile(SNAPSHOT, "utf8"));
  if (Array.isArray(snap.wallets) && snap.wallets.length >= 50) {
    WALLETS = new Map(snap.wallets);
    loadedAt = snap.generatedAt;
    loadedVersion = { source: "snapshot" };
    const ageDays = (Date.now() - Date.parse(snap.generatedAt)) / 86_400_000;
    console.log(
      `booted from snapshot: ${WALLETS.size} wallets, ${ageDays.toFixed(1)} days old`,
    );
    if (ageDays > 7) {
      console.warn(
        "snapshot is over a week old — if the background refresh fails, recent " +
          "designations will screen as clean",
      );
    }
  }
} catch {
  console.log("no snapshot; loading from OpenSanctions before serving");
}

server.listen(PORT, () => console.log(`listening on :${PORT} (${WALLETS.size} wallets)`));

// Not awaited: serving from the snapshot starts now, fresh data lands when it
// lands. With no snapshot this is the only source, and /healthz stays 503
// until it completes.
load();
setInterval(load, REFRESH_HOURS * 3600 * 1000);
