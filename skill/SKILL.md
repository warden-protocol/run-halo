---
name: halo
description: The Halo skill — paid inference on Base mainnet in EITHER role. OPERATE — serve x402-paid inference from your provider/models and earn USDC (no token, no stake, no deposit). CONSUME — run a local OpenAI-compatible endpoint that pays per request from your wallet, so any agent/app gets inference with no provider API keys in your code. Auto-generates a wallet and drives the `halo` CLI end-to-end (OpenClaw, Claude Code, Hermes, Ollama, OpenRouter, and more).
version: 0.1.0
metadata:
  openclaw:
    env:
      - HALO_KEYSTORE_PATH
      - HALO_RELAY_URL
      - HALO_INDEXER_URL
      - HALO_FACILITATOR_URL
    primaryEnv: HALO_KEYSTORE_PATH
    bins:
      - node
      - halo
    emoji: "◉"
    homepage: https://github.com/warden-protocol/run-halo
---

# Halo

Halo is a marketplace for **x402-paid inference on Base mainnet**. Payment is settled
on-chain by the **Halo protocol facilitator** (the default at
`https://facilitator.runhalo.xyz`) — it submits the transfer and covers the gas, so
neither side handles a network fee and operators need no facilitator credentials. (CDP
or another x402 facilitator can be used instead via `--facilitator-url`, but you almost
never need to.) This one skill covers **both roles** an agent can play on the network —
and the first thing you do is decide which the user wants.

**No token required.** Halo alpha runs directly on USDC on Base. Nothing is staked,
no protocol token is held. Operators earn real USDC per request; consumers pay real
USDC per request. The wallet is the only credential on either side.

## Pick the role first (do this before anything else)

This skill does two opposite things. Read the user's intent and route to the right
section — don't run setup until you know which role they want.

- **OPERATE** (serve & earn) — cues: *"earn USDC", "monetize my GPU / API key / Ollama",
  "run an operator", "serve inference", "join the League"*. The agent's host has
  inference to sell. → go to **[Operate](#operate--serve--earn-usdc)**.
- **CONSUME** (use & pay) — cues: *"let my agent use Halo", "OpenAI-compatible endpoint",
  "pay-per-use models", "I don't want to manage provider API keys", "access models I
  don't host"*. The agent needs inference and will pay for it. → go to
  **[Consume](#consume--use-halo-as-a-paid-inference-endpoint)**.

If it's ambiguous, ask exactly one question and then proceed:

> "Two ways to use Halo: **operate** — earn USDC by serving inference from your machine/keys —
> or **consume** — pay per request to use models through Halo as an OpenAI-compatible
> endpoint. Which do you want?"

Both roles can share one wallet, but **never route your own served models through your own
consume endpoint** — that's self-inference (see the off-rail note under Consume): it earns
no League points and just burns the settlement spread.

---

## Shared: install + identity (applies to both roles)

### Install the CLI

Both roles use the `halo` CLI. One command installs it and is safe to re-run: a managed
install updates in place, while a contributor's unmanaged `npm link` checkout is left untouched.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/warden-protocol/run-halo/main/skill/scripts/install.sh)
```

The script checks for **Node 20+** (the CLI fails fast on older versions), resolves the latest
CI-verified `cli-vX.Y.Z` release into `~/.halo/src`, builds `vault-core → sdk → cli` with
`npm ci`, links it with `npm link`, and verifies with `halo --version`. Future releases apply
silently in the background; `halo update` forces an immediate check. If Node 20+ is missing,
the operator installs it manually
(https://nodejs.org or `nvm install 20 && nvm use 20`) — don't try to install Node from the
skill.

### Always probe with doctor first

```bash
halo doctor --json
```

Single-command diagnostic: Node version, install state, `~/.halo/` state (keystore? config?
orphaned?), wallet address, configured provider, local endpoint reachability (Ollama,
LM Studio, OpenClaw — each with a model count), and relay/indexer health. `--json` gives
agent-parseable output. It replaces the half-dozen `ls`/`curl`/`node --version` calls you'd
otherwise invent, and (for the operate path) tells you which provider to pick without an
interview.

### The wallet is identity — never silently rotate it

`~/.halo/{config.json, keystore.json}` holds the wallet. The address is the user's identity:
operator League points, dashboard pairings, earnings, and (for consumers) the funded balance
all live on it.

- The skill markdown lives separately from `~/.halo/`. Reinstalling the skill never touches
  the wallet.
- `halo setup` detects an existing config and **preserves the wallet by default** — it only
  updates provider/pricing/label/network/infra URLs.
- **Never pass `--rotate-wallet`** unless the user explicitly asks to "create a new wallet" /
  "start over with a fresh identity". It's destructive: the old address keeps any past points
  but can no longer be signed for, and dashboard pairing breaks. If they ask, confirm once in
  chat ("This replaces wallet 0xABC… with a new one; the old one is unrecoverable unless you
  backed up the keystore. Proceed?") before running it.
- A full wipe (config + keystore + backups) is the user deleting `~/.halo/` themselves. The
  skill must not do this on its own.

### Unattended mode is the skill's default (both roles)

The skill runs inside the agent shell, which **cannot drive interactive password prompts**.
Pass `--no-wallet-passphrase` on every skill-driven `setup` unless the user explicitly wants a
passphrase. The keystore is then created with an empty passphrase (file mode `0600` + host
security become the only protection), and `serve`/`consume` start with no prompt — restartable
from any agent session, systemd unit, or container. Surface the trade-off once:

> "Your wallet is `0xABC…`. The skill defaulted to unattended mode — the keystore can be read
> by anyone with access to your user account on this machine. If you'll hold significant USDC,
> switch to a passphrase later via `halo setup --rotate-wallet` (interactive)."

If they want a passphrase, drop the flag and warn them they'll type it in their own terminal
(the agent shell can't drive it). For a passphrase keystore running headless, `HALO_PASSPHRASE`
in the environment unlocks `serve`/`consume` without the prompt.

---

## Operate — serve & earn USDC

Run the agent as a Halo **operator**: accept inference requests paid in USDC via x402, route
them to a configured upstream provider, return results, and earn USDC at settlement. The
operator never handles gas; the consumer never sees a network fee.

### What the operate path does

- Generates (or imports) an operator wallet on first run.
- One-time setup: pick an inference provider, API key (if required), model list, pricing mode.
- Starts a long-running process that connects to the relay via WebSocket.
- Handles x402 end-to-end: issues `402` challenges, verifies + settles through the protocol
  facilitator (which submits the tx and pays gas), returns the inference response.
- Emits signed inference events + heartbeats to the indexer so the operator shows up in the
  League and on the Dashboard.

### Providers supported (the operator's upstream)

**Agent runtimes** (operator already runs an agent that exposes inference):
- **OpenClaw gateway** (auto-detect at `http://127.0.0.1:18789/v1`)
- **Claude Code** (`claude-code` — Anthropic API; Messages format is translated to OpenAI
  chat completions on the wire)
- **Hermes** (`hermes` — Nous Research inference API, OpenAI-compatible)

**Self-hosted local models** (no upstream bill, operator keeps 100% USDC):
- **Local Ollama** (`ollama` at `http://127.0.0.1:11434/v1` — privacy-preserving)
- **Local LM Studio** (`lmstudio` at `http://127.0.0.1:1234/v1` — privacy-preserving)

**Hosted gateways** (operator has an API key, just wants to monetize quota):
- **OpenRouter** (100+ models through one key)
- **OpenAI, Anthropic, Venice, Together, Fireworks, Groq**
- **NEAR AI Cloud** (`near` — **confidential TEE** inference; serving NEAR models makes them
  available to consumers as confidential, see the consume Confidential section)
- **Custom** (any OpenAI-compatible endpoint + URL)

**Multiple providers at once.** An operator isn't limited to one gateway — add more with
`halo setup --add-provider --provider <slug> --api-key <key> --models <ids>` (preserves the
wallet and existing providers). Each request routes to whichever provider serves the requested
model. Common use: add `near` alongside an existing OpenRouter setup so the same operator
serves both commodity models and NEAR confidential ones.

### Drive the operate flow

After `install.sh` and `halo doctor --json`, run setup using the probe to pick `--provider`:

```bash
halo setup --provider <slug> [--api-key <key>] --margin <n> \
  --fallback-cents 1 --no-wallet-passphrase --with-pairing
```

`--fallback-cents 1` sets the per-request fallback price to **1 cent ($0.01)**. **Always pass
it** — without it setup hits an interactive number prompt the agent shell can't drive. The
unit is *cents USD*; it's what the operator charges when token-count pricing isn't available.
Setup hard-caps the prompt at 1000 cents ($10) against unit-confusion typos.

Decision tree for `--provider` from `doctor --json` (`endpoints` where `reachable === true`):

```
choose the first match:
  1. openclaw    — purpose-built for paid inference, prefer when available
  2. ollama      — local model, $0 upstream cost, operator keeps 100% USDC
  3. lmstudio    — same trade-off as ollama
else ask the operator:
  • OpenRouter API key?        → --provider openrouter
  • Anthropic key + Claude?    → --provider claude-code
  • Nous Research key?         → --provider hermes
  • OpenAI / Venice / Together / Fireworks / Groq / custom — only on explicit request
```

Don't open a long select menu — use `doctor` to pick the obvious default and confirm in one
yes/no question.

> **🔑 API keys: never read them from masked/truncated output.** The #1 cause of "operator
> 401s / inference not responding" with an agent-driven setup is a **corrupted key**: the agent
> copies the terminal's **masked** display (`sk-or-…1955`, `sk-…abcd`) or a length-truncated
> value into `--api-key`, and every upstream call then fails with 401. Pass the **full, exact
> key** from its original source — the user's paste, an environment variable
> (`--api-key "$OPENROUTER_API_KEY"`), or the provider dashboard — and never re-type, summarize,
> or copy a key from anything that might shorten or mask it. (`halo setup` now rejects a key
> that contains a masking marker like `…`/`...` or is implausibly short, and `halo serve`
> probes each key against the upstream at startup — `✖ <provider>: upstream REJECTED the stored
> key` means re-set it with the real value.)

**Models** — after the provider is picked, hit `<base-url>/v1/models` (`/api/tags` for
`ollama`) and propose the top 3–8 small/cheap models; let the operator strike any. Prefer the
flag (`--models "id1,id2,id3"`) over the interactive multi-select the agent can't drive.

**Fee margin** — pick by **provider**, not preference; the wrong one bleeds money:
- **`--margin <n>`** — n% over the upstream's per-model rate, resolved at settle time. **Only
  works against providers that publish a per-model pricing API. Currently: OpenRouter and
  NEAR.**
- **`--flat <usd-per-1k>`** — fixed USD per 1K tokens, model-agnostic. Use for everything that
  doesn't publish prices (Ollama, OpenAI/Anthropic/Venice direct, …).
- Wrong combo (margin against an unsupported provider) silently falls through to
  `fallbackPerRequestUsdc` ($0.01) on every request — `--margin 25` becomes "flat $0.01
  forever". Setup warns when this is configured; surface the warning verbatim. (A NEAR model
  not in NEAR's price catalog hits the same fallback but is clamped to a sane advertised rate.)

Defaults to propose: OpenRouter/NEAR → `--margin 20–25`; Ollama → `--flat 0.0005`; anything else
paid → `--flat 0.001`. Confirm before proceeding.

**Label** (optional) — League leaderboard name via `--label "my-operator"`. Skip if they don't
care.

**Pairing** — always pass `--with-pairing` so setup prints the 9-digit dashboard pairing code
(`XXX-XXX-XXX`, valid 5 min). Surface it verbatim; the operator opens the dashboard, pastes it,
and signs with their **dashboard** wallet (intentionally separate from the operator wallet).

**Orphaned-keystore recovery** is automatic: if a prior setup crashed and left
`keystore.json` without a `config.json`, re-running setup preserves the existing wallet.

### Start serving

```bash
halo serve     # alias: /halo start
```

Loads the keystore, connects to the relay, announces the models, and handles requests until
interrupted. While running it serves x402-paid requests, reports each settled request to the
indexer for League points, sends a signed heartbeat every 30s, and **auto-reconnects** with
exponential backoff (1s → 30s) up to 10 consecutive failures (a successful re-announce resets
the counter). In unattended mode it starts with no prompt and prints a `⚠ unattended mode`
notice each restart.

The operator wallet **does not need pre-funding** — USDC arrives at settlement, paid by the
consumer, gas covered by the facilitator. Only fund it with ~$0.50 of ETH on Base if the
operator later wants to move earned USDC off-chain.

**To keep it running 24/7, don't foreground-launch it under an agent/gateway** (a gateway
restart kills its children). Install it as an always-on OS service instead:
`halo service install serve` — see [Keep it always-on](#keep-it-always-on-do-this--dont-foreground-launch-it)
under Consume for details. It auto-restarts on crash and survives gateway restarts.

Sample log:

```
  connecting to relay: wss://relay.runhalo.xyz
  ✓ connected; announcing as 0xabc…123
  inference req_5f3 ← consumer 0xd4e…9a2 (model=gpt-4o-mini, 1240 tok, $0.012)
    verify ok, settle tx 0x9f1…c4 → earned $0.012 USDC
```

---

## Consume — use Halo as a paid inference endpoint

Run the agent (or any app) as a Halo **consumer**: get inference from the network and pay per
request in USDC from your own wallet. **No provider API keys in your code** — the wallet is the
only credential. This is the right role when the agent needs models it doesn't host, wants
pay-per-use without subscriptions, or wants to keep provider keys out of its codebase.

### Quickest path: the `consume` sidecar (recommended)

`halo consume` runs a **local OpenAI-compatible endpoint** that pays each request from the CLI
wallet via x402. Point any OpenAI client's `baseURL` at it.

```bash
# 1. one-time: wallet + config, AND a persisted consumer profile so `consume`
#    needs no flags. No upstream provider is needed for pure consume, but setup
#    wants a --provider slug; openai is a fine placeholder.
halo setup --provider openai --models gpt-4o-mini --no-wallet-passphrase \
  --consume --consume-model gpt-4o-mini \
  --consume-allow "gpt-4o-mini,meta-llama/llama-3.1-8b-instruct" \
  --consume-max-usdc 0.05 --consume-port 8799

# 2. fund the printed wallet address on Base mainnet (unlike the operator wallet, a
#    consumer wallet MUST be funded): USDC pays for inference, AND a little ETH for gas
#    on the vault deposit tx that step 3's --vault-deposit submits (exact mode needs USDC only).

# 3. run the local endpoint on the vault rail (the recommended billing rail —
#    deposits once, then bills the ACTUAL tokens used; see "Billing rail" below)
halo consume --vault --vault-deposit 5
#   endpoint : http://127.0.0.1:8799/v1
#   wallet   : 0x…  (Base)
#   rail     : vault (deposit-backed, settles ACTUAL tokens)
```

**Configuring consume at setup time** (skill-driven): pass `--consume` plus the
fields so the profile persists and `halo consume` runs flag-free. Interactive setup
instead asks "Also use this wallet to consume?" then prompts for these. The fields:
- `--consume-model <id>` — model used when a request omits `model` (a default).
- `--consume-allow "a,b,c"` — the **allowlist** of models the agent will pay for; a
  request for anything else is refused (HTTP 403) *before* any payment. `""`/`"any"`
  = no limit. This is the agent's guard against accidentally paying for an expensive
  model.
- `--consume-max-usdc <n>` — per-request spend ceiling in USD (the cost guard).
- `--consume-port <n>` — local endpoint port (default 8799).

In unattended/skill flows the consume step is configured **only when `--consume` is
passed** — it never prompts — so an operator-only setup is unaffected.

### Keep it always-on (do this — don't foreground-launch it)

A plain `halo consume` launched from a gateway's terminal/tool joins the gateway's process
group — so when the gateway restarts it SIGTERMs its children and **kills the endpoint**. The
agent then hits `Connection error` until something relaunches it. Cron/"restart it if it died"
loops just fight their own gateway. Two ways to do it right:

**If an agent starts consume itself → use `--detach` (simplest).** It re-spawns the server in
its OWN session (reparented to init), so a gateway restart can't kill it, and returns
immediately. It's **idempotent** — safe to run on every session start; if one's already
serving it just no-ops. Needs an unattended keystore (`setup --no-wallet-passphrase`) or
`HALO_PASSPHRASE`, since a detached process can't be prompted.

```bash
halo consume --detach --port 8799 --vault --vault-deposit 5   # starts once, survives restarts, no-ops if already up
```

**For start-on-boot + auto-restart-on-crash → install it as an OS service** (launchd on
macOS, systemd `--user` on Linux), owned by the OS, not the gateway:

```bash
halo service install consume -- --port 8799 --vault --vault-deposit 5 --budget-usdc 5
halo service status consume      # MUST show a PID; an exit code = crash-looping →
halo service logs consume        # prints the real reason (e.g. EPERM, passphrase, port)
halo service uninstall consume
```

Either way: point the agent at `http://127.0.0.1:8799/v1` and treat consume as infrastructure
that is **always there** — the agent talks to the endpoint and never starts/stops/restarts it.
For the operator side, install it as a service (`halo service install serve`). Preview a
service unit without installing with `--dry-run`.

Then point any OpenAI-compatible client at it (Python/TS/LangChain/LlamaIndex/Vercel AI SDK/
OpenClaw/Hermes — anything that takes a base URL). For **Hermes** and **OpenClaw**, prefer the
drop-in configs in the repo's `integrations/` dir — they register Halo as a NAMED provider
(`halo/…`) instead of a generic `custom` endpoint (Hermes `ProviderProfile` plugin + OpenClaw
`models.providers.halo` snippet). Raw OpenAI client example:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8799/v1", api_key="halo")  # api_key unused unless --api-key set
resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Summarize Base mainnet in one sentence."}],
    max_tokens=100,
)
print(resp.choices[0].message.content)
```

**`consume` flags:**
- `--port <n>` (default `8799`) — port to listen on.
- `--host <addr>` (default `127.0.0.1`) — bind address. Keep it loopback unless you also set
  `--api-key`.
- `--api-key <secret>` — require `Authorization: Bearer <secret>` on `/v1/*`. Set this if you
  bind to a non-loopback host.
- `--max-usdc <n>` (default `0.10`) — **per-request spend ceiling in USD**. A request is
  refused (HTTP 402) if the operator asks for more. This is the consumer's primary cost guard —
  set it deliberately.
- `--vault` — **bill on the HaloVault rail (recommended — use it for inference by default).**
  Deposits USDC into the vault once, then settles the ACTUAL tokens used per request instead of a
  flat per-request quote. Omitting it falls back to exact mode (see "Billing rail").
- `--vault-deposit <usd>` — vault top-up target (e.g. `--vault-deposit 5`). Deposits on startup AND
  auto-refills from the wallet mid-run so the vault won't 402. Always pass it together with `--vault`.
- `--budget-usdc <n>` — **cumulative spend cap** for the run (0/unset = uncapped). A human on a
  frontend self-paces; an agent loops, retries and fans out tool calls, so per-request caps don't
  bound TOTAL spend — this does. See the budget section below.
- `--budget-warn-pct <0-1>` (default `0.8`) — warn (response header) at this fraction of the budget.
- `--keystore <path>` — pay from a different wallet than the operator keystore.
- `--confidential` — **confidential-only mode**: every request is end-to-end encrypted to a
  hardware TEE the operator can't read, routed only to a TEE operator, and the reply is verified
  against the enclave attestation. Fails closed (errors, never plaintext). See below.
- `--tee-base-url <url>` — TEE provider attestation endpoint (default `https://cloud-api.near.ai/v1`).

**Endpoints:** `POST /v1/chat/completions`, `GET /v1/models`, `GET /health`, `GET /v1/account`
(this consume wallet's League standing — consume points, tier, streak, requests, total USDC
spent — plus the session budget), `GET|POST /v1/budget` (cumulative cap). Caller routing
hints (`X-Halo-Routing`, `X-Halo-Operator`, `X-Halo-Max-Price`, …) are forwarded to the relay.

**Security:** anything that can reach the endpoint can spend the wallet. The default loopback
bind keeps it to local processes; add `--api-key` (and only then a non-loopback `--host`) for a
remote caller. Cap per-request exposure with `--max-usdc`.

**Streaming on consume:** `stream: true` IS accepted (needed by agents like Hermes that always
stream). Under the hood the x402 pay flow is buffered — consume pays for and receives the whole
answer, then re-emits it to your client as a valid OpenAI SSE stream (`chat.completion.chunk`
events + `[DONE]`). So the client streams, but tokens arrive as one batch at the end, not
incrementally.

### Billing rail + keeping it funded (avoid falling back off Halo)

Two rails, both funded from the same wallet. **Vault mode (`--vault`) is the recommended rail —
pass `--vault --vault-deposit <usd>` for inference.** It deposits USDC into the HaloVault once and
bills the ACTUAL tokens used per request (deposit once, settle-actual); it's the rail Halo is
standardizing on. **Exact mode** (what you get when you omit `--vault`) signs a separate x402
payment per request at a flat, prompt-blind quote priced on `max_tokens` — no deposit, but it
settles straight to the operator and bypasses the vault. Use exact only as an explicit fallback on
dev / non-vault stacks.

The #1 cause of an agent silently dropping to a non-Halo fallback is **running out of funds**:
- Exact mode → the consumer wallet is out of **USDC**.
- Vault mode → the **vault** is drained (a `402 Vault can't cover this request`).

Keep it on the rail:
- **Vault: always pass `--vault-deposit <usd>`** (e.g. `--vault --vault-deposit 5`). That deposits
  on startup AND **auto-refills from the wallet mid-run** when the vault runs low, so it won't 402
  as long as the wallet still has USDC (a drained wallet 402s either rail).
- Keep the **wallet** funded — USDC for inference, plus ~$0.50 ETH on Base for deposit gas (vault).
- When you DO see a funds error (`Fund your consumer wallet …` / `Vault can't cover …`), **tell the
  user to fund the wallet `0x…`** and stop — do NOT quietly switch to another provider. Surfacing
  "you're low on Halo funds, send USDC to `0x…`" is the right move; a silent fallback hides the spend
  leaving Halo and earns no league points.

### Confidential (TEE) inference — when the agent must not be read

If the agent's prompts must stay private *even from the serving operator*, use **confidential**
mode. The prompt is end-to-end encrypted to a hardware enclave (NEAR AI Cloud — Intel TDX +
NVIDIA H200); the operator only relays ciphertext, and the reply is signed inside the enclave and
verified against its attestation. This is stronger than privacy mode (`X-Halo-Privacy: true`,
which only filters by an operator's *declared* posture, not cryptographically).

How the agent uses it through `consume`:

1. **Discover** — `GET /v1/models`; each model carries a `confidential` boolean (true ⇒ a TEE
   operator is online for it). Pick a `confidential: true` model.
2. **Require** — either run the whole endpoint confidential-only with `halo consume
   --confidential`, OR require it per request by sending the header `X-Halo-Confidential: true`
   on `/v1/chat/completions`. Either way it **fails closed** — if no TEE operator can serve the
   model, the request errors; it never silently downgrades to plaintext. Before encrypting, the
   sidecar runs the **full DCAP hardware attestation verification** (Intel TDX → Intel root +
   NVIDIA H200, cached per model) — the same trustless check the frontend does, so a rogue
   relay/provider can't fake the confidential guarantee with a substituted key.
3. **Assert** — the response carries `X-Halo-Confidential: true` and `X-Halo-TEE-Verified: true`.
   The agent should treat the reply as untrusted unless `X-Halo-TEE-Verified: true` is present
   (it means the enclave's signature verified against the attested signer — the operator could
   neither read nor forge it). Check the endpoint's default mode with `GET /health` →
   `{ "confidential": true|false }`.

```bash
# Per-request confidential, asserting the proof:
curl -s localhost:8799/v1/models | jq -r '.data[] | select(.confidential) | .id'   # pick one
curl -s -D - localhost:8799/v1/chat/completions \
  -H 'content-type: application/json' -H 'X-Halo-Confidential: true' \
  -d '{"model":"deepseek-ai/DeepSeek-V4-Flash","messages":[{"role":"user","content":"hi"}]}'
#   response headers must include  X-Halo-TEE-Verified: true
```

Confidential models are only the handful served by TEE operators, so set the consume
`--consume-allow` allowlist accordingly (or check `confidential` per model at runtime).

**Even non-confidential consume is relay-blind:** by default the sidecar end-to-end-encrypts the
prompt to the chosen operator's announced key, so the **relay** only ever sees ciphertext (the
operator still decrypts to serve — use confidential mode to hide from the operator too). `--no-e2e`
disables it. So the consume API now has full parity with the frontend: same operator E2E, same
trustless hardware attestation, same economic safeguards (per-request cap, payTo/operator pinning,
exact-amount settlement, unfunded rejection).

### Cumulative spend budget — the agent-volume guard

`--max-usdc` bounds ONE request. An agent makes many — loops, retries, tool fan-out — so set
`--budget-usdc <n>` to bound TOTAL spend for the run. The sidecar tracks settled spend and:

- puts the live state on **every** response: `X-Halo-Budget-Limit`, `X-Halo-Budget-Spent`,
  `X-Halo-Budget-Remaining`.
- once spend crosses `--budget-warn-pct` (default 80%), adds `X-Halo-Budget-Warning: true` and a
  human-readable `X-Halo-Budget-Message`. **The agent should surface this to the user and ask
  whether to raise the budget — before it runs out.**
- once exhausted, refuses with **HTTP 402 `code: "over_budget"`** (an actionable message) instead
  of spending more.

Raise the cap **without restarting** (the path for "user approved more"):
`POST /v1/budget {"limitUsd": <new total>}` (or `GET /v1/budget` to read it). Spend is never reset
by an update — only the ceiling moves. So the agent's loop is: watch the warning header → tell the
user → on approval `POST /v1/budget` → continue. The funded wallet balance is still the ultimate
hard ceiling regardless of this soft cap.

> **Self-inference is off-rail.** If you want the agent to use a model *it already serves*
> itself, call that provider endpoint directly — don't route through Halo to pay yourself. It
> earns no League points, burns the settlement spread, and the indexer's self-deal guard
> ignores it. `consume` is for using capacity from *other* operators.

### Alternative: embed the x402 flow yourself

If you can't run a sidecar process, sign the `402` challenge inside your own code with the
agent's private key. Under the hood:

1. Agent wallet holds USDC on Base mainnet.
2. Agent POSTs a chat completion to the relay (`https://relay.runhalo.xyz/v1/chat/completions`).
3. Relay returns `402` with a `PAYMENT-REQUIRED` header (amount, operator wallet, USDC asset).
4. Agent signs an EIP-3009 `TransferWithAuthorization` locally (off-chain, no gas).
5. Agent retries with a `PAYMENT-SIGNATURE` header — pin `X-Halo-Operator` to the operator from
   the probe so the retry lands on the same operator the signature is for.
6. Relay forwards to the operator; it runs inference, settles via the protocol facilitator,
   returns the completion.
7. Agent parses the response exactly like an OpenAI API response.

Gas for the on-chain USDC transfer is paid by the facilitator, not the agent. A drop-in
TypeScript wrapper is in `docs/AGENT_INTEGRATION.md`; prefer the sidecar unless you specifically
can't run one.

---

## Commands (CLI reference)

- **`halo setup [flags]`** — configure the wallet + (for operate) provider/pricing. Skill
  alias `/halo setup`. Key flags:
  - `--provider <slug>` — `openclaw` (default), `claude-code`, `hermes`, `ollama`, `lmstudio`,
    `openai`, `anthropic`, `openrouter`, `venice`, `near`, `together`, `fireworks`, `groq`, `custom`
  - `--add-provider` — ADD this provider to an existing operator instead of replacing it
    (front several gateways at once, e.g. openrouter + near); preserves the wallet + other providers
  - `--base-url <url>` — required for `--provider custom`
  - `--api-key <key>` — paid providers only (omit for `openclaw`/`ollama`/`lmstudio`)
  - `--models "a,b,c"` — model ids the operator advertises
  - `--margin <n>` / `--flat <n>` — pricing (mutually exclusive; see Operate)
  - `--fallback-cents <n>` — **always pass in skill flows** (`1` = $0.01)
  - `--label <name>` — League label
  - `--no-wallet-passphrase` — **skill default** (unattended)
  - `--wallet-mode <generate|import>` / `--key-backup <file|skip>` — skip the wallet/backup
    prompts in driven setup (unattended defaults to `generate`/`skip`)
  - `--encrypt-api-key` / `--no-encrypt-api-key` — encrypt the upstream key (forced off in
    unattended mode — no passphrase to derive a key from)
  - `--with-pairing` — **always pass for operate**; prints the dashboard pairing code
  - `--data-retention <none|24h|7d|unknown>` — operator-declared log retention (default
    `unknown`; set `none` if the operator commits to zero logging)
  - `--consume` / `--no-consume` — opt in/out of a persisted consumer profile (see Consume).
    `--consume-model <id>`, `--consume-allow "a,b,c"`, `--consume-max-usdc <n>`,
    `--consume-port <n>` set its fields. Pass `--consume` for a consume-capable agent; omit
    it for operator-only.
- **`halo serve`** (alias `/halo start`) — start the operator process.
- **`halo consume [flags]`** — run the local OpenAI-compatible paying endpoint (see Consume).
- **`halo service <install|uninstall|status|logs> [consume|serve] [-- daemon args…]`** — install
  consume/serve as an always-on OS service (launchd/systemd) that survives agent/gateway restarts.
  Prefer this over foreground-launching either daemon. `--dry-run` prints the unit without installing.
- **`halo pay [--model M] [--prompt P]`** — one-shot test of a paid request as a consumer;
  good for verifying an install end-to-end.
- **`halo link`** — generate a fresh 9-digit dashboard pairing code (only needed if
  `--with-pairing` failed or the operator wants a new code; one dashboard wallet can claim many
  operator addresses).
- **`halo status`** — wallet address, provider, network, League points + tier, requests
  served, USDC earned, uptime.
- **`halo doctor [--json]`** — the diagnostic; run first.

## How payment works (no gas, no token — both roles)

1. A consumer sends a chat request to the relay.
2. The relay tunnels it to a selected operator over the operator's outbound WebSocket.
3. The operator returns `402 Payment Required` (`PAYMENT-REQUIRED` header: amount, operator
   wallet, USDC asset on Base).
4. The consumer's wallet signs an EIP-3009 `TransferWithAuthorization` off-chain.
5. The retry carries a `PAYMENT-SIGNATURE` header.
6. The operator calls the protocol facilitator `/verify` then `/settle`; the facilitator submits
   the on-chain tx and pays the gas. USDC flows consumer → operator in one transaction.
7. The operator runs inference and returns the response with `PAYMENT-RESPONSE` (settlement tx
   hash). Settlement happens *after* inference, so the signed authorization stays valid for the
   whole sign → inference → settle window.

Neither wallet needs ETH for gas — the facilitator covers it.

## When things go wrong

- **"keystore not found"** → run `halo setup`.
- **(operate) "provider /v1/models returned 401"** → upstream API key is wrong; re-run setup.
- **(operate) "facilitator /settle 400: insufficient_balance"** → the consumer signed for more
  USDC than they hold; the operator returns 402 automatically.
- **(consume) request fails with 402 / "exceeds --max-usdc"** → the picked operator's price is
  above your ceiling. Raise `--max-usdc`, or set `X-Halo-Max-Price` / route to a cheaper
  operator.
- **(consume) "insufficient funds" / payments fail** → the consumer wallet has no USDC. Fund
  the address `halo status` (or the consume startup line) prints with USDC on Base mainnet. As of
  the latest CLI the consume endpoint returns this as an actionable error whose `message` names
  the exact wallet to fund and carries `code: "insufficient_funds"`.
- **(consume) streaming** → `stream: true` is now accepted; consume buffers the paid response and
  re-emits it as OpenAI SSE (tokens arrive in one batch at the end, not incrementally).
- **(consume) error codes (in `error.code`) for programmatic handling:** `insufficient_funds`
  (fund the wallet) · `over_cap` (raise `--max-usdc` / `X-Halo-Max-Price`) · `no_operator` (no
  operator serving that model — check `<relay>/v1/models`) · `confidential_setup_failed` (the
  model has no confidential/TEE operator, or the TEE provider is briefly down — retry, pick a
  model where `confidential: true`, or drop `X-Halo-Confidential`). Each error's `message` also
  states the fix in plain language for the agent to relay.
- **"operator disconnected" on the relay side** → network blip; `halo serve` auto-reconnects up
  to 10 attempts. "exceeded 10 reconnect attempts; exiting" means the relay is genuinely
  unreachable — check `https://relay.runhalo.xyz/health` and restart.

## What this skill is NOT

- It does not stake a token, deposit collateral, or hold any balance on the user's behalf.
- It does not verify inference or run adversarial checks. Halo alpha is a payment marketplace,
  not a verification network.
- It does not require a public URL or open port to operate — the operator's WebSocket connects
  outbound, and the consumer endpoint binds to loopback by default.
