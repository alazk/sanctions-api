# Sanctioned-wallet screening API

A drop-in replacement for self-hosted yente, for the one question the Newton
oracle actually asks: *is this crypto wallet on a sanctions list?*

yente answers that with Elasticsearch, which needs ~2GB RAM and rules out
every free host. This does the same lookup with a hash map in ~100MB, serves
the same `/match/{dataset}` response shape, and needs **no changes to the
deployed WASM oracle or Rego policy** — only `YENTE_URL` moves.

## What it does and doesn't do

Does: exact `publicKey` lookups against every OpenSanctions sanctions source,
refreshed on a schedule, merging dataset attributions when a wallet is
designated by more than one regime.

Doesn't: name matching, fuzzy search, any schema other than `CryptoWallet`.
Those are real yente features. This is not a yente replacement — it is a
wallet-screening endpoint that speaks yente's dialect.

## Run locally

```
PORT=8002 node server.mjs
```

Full load takes a few minutes and prints progress. For a quick wiring check:

```
DATASETS=us_ofac_sdn PORT=8002 node server.mjs
```

That is fine for testing plumbing and **not** fine for screening anything —
partial coverage means addresses designated elsewhere come back clean.

## Verify before trusting it

Never point `YENTE_URL` at this without running both checks. A screening
service that answers but finds nothing reports every address as clean, which
fails open and looks identical to one that works.

```
curl -s -X POST localhost:8002/match/sanctions -H 'content-type: application/json' \
  -d '{"queries":{"q1":{"schema":"CryptoWallet","properties":{"publicKey":["0x7F367cC41522cE07553e823bf3be79A889DEbe1B"]}}}}'
```

Must return a result with `"match": true` and `us_ofac_sdn` in `datasets`.

```
curl -s -X POST localhost:8002/match/sanctions -H 'content-type: application/json' \
  -d '{"queries":{"q1":{"schema":"CryptoWallet","properties":{"publicKey":["0x0710868cBa0a72453E9f1a955Cf917d3A7A6951A"]}}}}'
```

Must return an empty `results` array.

Then, once deployed and `YENTE_URL` points at it:

```
node --env-file=deploy/.env sanctions-oracle/verify-both.mjs
```

All three cases must pass — clean payee allows, sanctioned payee denies,
sanctioned payer denies.

## Safety behaviours

Both exist because the dangerous failure here is silent approval, not
rejection.

- **Refuses to load an index with fewer than 50 wallets.** Keeps the previous
  good data and logs loudly instead of swapping in something that would clear
  every address.
- **`/healthz` returns 503 until loaded**, so platform health checks do not
  route traffic to a service with unknown coverage. The policy denies during
  that window, which is correct.

## Deploy

Any platform that builds a Dockerfile. 512MB is enough.

| Setting | Value |
| --- | --- |
| Port | `8001` (or whatever `PORT` the platform injects) |
| Health check | `GET /healthz` |
| Health check grace | **at least 10 minutes** — the first load is slow |
| Instance | 512MB / 0.1 vCPU is sufficient |

Env vars:

| Name | Default | Notes |
| --- | --- | --- |
| `DATASETS` | `sanctions` | Comma-separated. Leave as-is for full coverage. |
| `REFRESH_HOURS` | `12` | How often to re-pull the dataset. |
| `PORT` | `8001` | Most platforms set this for you. |

The grace period matters: with a short health-check timeout the platform kills
the container mid-load, restarts it, and it never finishes.

## Licensing

OpenSanctions data is free for non-commercial use. Commercial use needs a
delivery token and a licence — settle that before this is load-bearing.
