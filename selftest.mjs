/**
 * Start the service, wait for it, screen both addresses, report, shut down.
 *
 * One command instead of a server in one tab and curl in another — that split
 * has repeatedly produced "empty reply" confusion where the real answer was
 * simply that nothing was listening yet.
 *
 *   node sanctions-api/selftest.mjs
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8099); // unlikely to collide
const BASE = `http://localhost:${PORT}`;

const OFAC = "0x7F367cC41522cE07553e823bf3be79A889DEbe1B";
const CLEAN = "0x0710868cBa0a72453E9f1a955Cf917d3A7A6951A";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`starting server on :${PORT} …`);
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
server.stdout.on("data", (d) => {
  const s = d.toString();
  serverLog += s;
  process.stdout.write("  " + s.replace(/\n(?=.)/g, "\n  "));
});
server.stderr.on("data", (d) => {
  serverLog += d.toString();
  process.stderr.write("  " + d.toString());
});

function shutdown(code) {
  server.kill();
  process.exit(code);
}

// Wait for readiness rather than a fixed sleep. /healthz is 503 until an
// index is loaded, which is exactly the condition we must not test through —
// an unloaded service answers "clean" for everything.
let ready = false;
for (let i = 0; i < 90 && !ready; i++) {
  await sleep(2000);
  try {
    const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const h = await res.json();
      console.log(`\nready: ${h.wallets} wallets loaded\n`);
      ready = true;
    }
  } catch {}
}

if (!ready) {
  console.error("\nServer never became ready. Log above.");
  shutdown(1);
}

async function screen(address) {
  const res = await fetch(`${BASE}/match/sanctions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      queries: { q1: { schema: "CryptoWallet", properties: { publicKey: [address] } } },
    }),
  });
  const body = await res.json();
  return body?.responses?.q1?.results ?? [];
}

const ofacHits = await screen(OFAC);
const cleanHits = await screen(CLEAN);

const ofacOk = ofacHits.some((r) => r.match === true);
const cleanOk = cleanHits.length === 0;

console.log("OFAC  ", OFAC);
console.log("   ", ofacOk ? `MATCH ✓  datasets: ${ofacHits[0].datasets.join(", ")}` : "NO MATCH ✗");
console.log("CLEAN ", CLEAN);
console.log("   ", cleanOk ? "no match ✓" : `MATCHED ✗ — false positive: ${JSON.stringify(cleanHits[0])}`);

const pass = ofacOk && cleanOk;
console.log(
  "\n" +
    (pass
      ? "PASS — safe to deploy. Re-run the same two checks against the deployed URL\n" +
        "before pointing YENTE_URL at it."
      : "FAIL — do not deploy.\n" +
        (!ofacOk
          ? "  A known OFAC wallet did not match, so this would report every address\n" +
            "  as clean. That fails OPEN and is worse than no screening at all.\n"
          : "") +
        (!cleanOk ? "  A clean wallet matched, so this would block legitimate payments.\n" : "")),
);

shutdown(pass ? 0 : 1);
