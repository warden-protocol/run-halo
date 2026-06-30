# Halo

<p align="center">
  <a href="https://github.com/warden-protocol/run-halo/stargazers"><img src="https://img.shields.io/github/stars/warden-protocol/run-halo?style=for-the-badge&logo=github&label=Star%20this%20repo&color=f5b301" alt="Star this repo"></a>
  <a href="https://x.com/wardenprotocol"><img src="https://img.shields.io/badge/Follow-%40wardenprotocol-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow @wardenprotocol on X"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge" alt="License: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node >= 20">
  <img src="https://img.shields.io/badge/built%20on-Base-0052FF?style=for-the-badge&logo=coinbase&logoColor=white" alt="Built on Base">
  <img src="https://img.shields.io/badge/pay%20in-USDC-2775CA?style=for-the-badge" alt="Pay in USDC">
  <img src="https://img.shields.io/badge/status-alpha-orange?style=for-the-badge" alt="Status: alpha">
</p>

> ⭐ **If Halo is useful to you, [star the repo](https://github.com/warden-protocol/run-halo)** — it helps more operators and agents find the network.

**Halo is a permissionless AI inference network for humans and agents. Pay per prompt in USDC, on Base.**

Anyone can serve inference and earn, anyone can consume it and pay — the wallet is the only
credential on either side. No accounts, no API keys to manage, no protocol token. Payment is
denominated in **USDC on Base mainnet**, and the network's facilitator covers the gas, so
neither side ever touches a network fee.

> ⚠️ **Halo is in alpha.** It runs on Base mainnet with real USDC. Interfaces, contracts, and
> economics may still change.

## Start Halo with your agent

The fastest way in: paste this into your agent (Hermes, OpenClaw, Claude Code, or any agent that
can read a URL and run commands) —

```
Read https://app.runhalo.xyz/skill.md and follow the instructions
```

The agent installs the `halo` CLI, creates your wallet, and walks you through operating or
consuming end to end. Prefer to drive it yourself? See [Quick start (CLI)](#quick-start-cli) below.

## Two roles

- **Operate** — serve inference from your provider, hosted models, or local GPU and earn USDC
  per request. Works with OpenClaw, Claude Code, Hermes, Ollama, LM Studio, OpenRouter,
  NEAR AI Cloud, and any OpenAI-compatible upstream.
- **Consume** — run a local OpenAI-compatible endpoint that pays per request from your wallet,
  so any agent or app gets inference with no provider API keys in its code.

Both roles can share one wallet.

## How payments work

Halo has **two payment rails**, used for two different things.

### Inference is paid through the Vault

Inference is **not** paid with a per-call x402 transfer. It settles through the **HaloVault**, an
on-chain escrow on Base that lets a consumer pay for the *actual* tokens used while keeping the
serving operator safe from non-payment — without a wallet signature on every request.

The flow between a **consumer**, an **operator**, and the **Halo facilitator**:

1. **Deposit** — the consumer deposits USDC into the HaloVault once and registers a *session
   key* (the key that will authorize spending against that deposit).
2. **Reserve** — before routing to an operator, the consumer signs an EIP-712 `Reserve` that
   earmarks part of the deposit exclusively for that operator, with an expiry. The facilitator
   submits the reservation on-chain and pays the gas.
3. **Serve** — the request is sent to the operator (via the relay) in vault mode. The operator
   reads the on-chain reservation and serves only if the remaining reserved balance covers the
   request's cost ceiling and the reservation is still live — so it never serves value it can't
   collect. The operator reports the **actual** cost (real token usage), not a flat quote.
4. **Settle** — the consumer advances a cumulative, monotonic EIP-712 `Receipt` for what's been
   served and hands it to the operator (and/or the facilitator). The facilitator submits the
   redeem on-chain, moving exactly the served amount from the consumer's reservation to the
   operator. Receipts are cumulative, so a single latest receipt collects the whole session.

Reservations that go unused expire and are reclaimed back to the consumer's free balance. The
operator only ever *reads* the vault; it never has to trust the consumer, because it won't serve
beyond what's reserved on-chain. The consumer only pays for what it actually used.

The **operator wallet needs no pre-funding** — USDC arrives at settlement, gas is on the
facilitator. The **consumer wallet must hold USDC** (plus a little ETH on Base for its own
deposit/withdraw transactions).

### Operator pricing and the protocol fee

**Operators set their own price.** There are two pricing modes:

- **Margin** (`--margin <n>`) — charge **n% over the upstream provider's published per-token
  rate**, resolved per model at settlement. Supported where the provider exposes per-model pricing
  (e.g. OpenRouter and NEAR); prompt-cache discounts the upstream reports are passed through to the
  consumer. **This is the recommended best practice:** it tracks the real upstream cost per model,
  so the operator stays profitable on expensive models and competitive on cheap ones without
  hand-tuning a flat rate.
- **Flat** (`--flat <usd-per-1k>`) — a fixed USD price per 1,000 tokens, the same across every
  model. Use it for local models (Ollama, LM Studio) and any upstream that doesn't publish prices.

In vault mode the operator's price is applied to the **actual** prompt/completion tokens used, so
the consumer pays for real usage rather than a flat quote.

**The protocol takes a fee that is a percentage of the operator's price.** It is deducted from the
operator's side at settlement and enforced on-chain by the vault (the v2 *protocol-fee* vault), so
it can't be bypassed: the consumer pays the operator's quoted price, the protocol fee is withheld
from the payout, and the operator nets *price − fee*. The fee **starts at 10%** and is adjustable
through protocol governance.

### Tool payments (and other one-shot charges) use x402

For paying *other* 402-gated HTTP services — tool calls, APIs, and metered resources an agent or
the frontend hits — Halo uses the **x402** standard: the server answers `402 Payment Required`,
the client signs an EIP-3009 `TransferWithAuthorization` (USDC, off-chain, no gas), and retries.
The **Halo facilitator** verifies and submits the transfer on-chain. This is exposed as a
standalone client in [`sdk/`](sdk) so any app can pay a 402 endpoint with an ethers signer.

### Frontend session subkey

So a human on the Halo web frontend doesn't have to approve a wallet popup for every prompt or
tool call, the frontend provisions a **session subkey**: a delegated key, authorized by the
user's main wallet, that signs vault receipts and x402 tool payments autonomously within limits.
The main wallet custodies the funds and registers the subkey as its vault session key; the subkey
does the high-frequency signing. The headless CLI doesn't need this — there are no popups, so the
CLI wallet acts as its own session key and signs directly.

> The session-subkey delegation is implemented in the (private) frontend; this section describes
> the protocol-level behavior, not the UI internals.

## Privacy: end-to-end encryption and confidential (TEE) compute

Halo routes every prompt through a relay it doesn't ask you to trust. Two layers protect request
content, and they compose: E2EE hides it from the relay; confidential mode additionally hides it
from the operator.

### End-to-end encryption (relay-blind, on by default)

By default the consumer **end-to-end-encrypts each request to the chosen operator**, so the relay
only ever forwards ciphertext. The scheme is X25519 ECDH → HKDF-SHA256 → AES-256-GCM:

- Each operator generates a fresh X25519 keypair at `halo serve` startup; the private key lives in
  process memory only and is **never persisted**. Its public key is announced to the relay. When
  the operator restarts, the key is gone — captured ciphertext from a past session becomes
  unrecoverable even to the operator (forward secrecy at the session boundary).
- The consumer encrypts the request body with a fresh per-request ephemeral key to the operator's
  announced public key, and the operator encrypts the response back the same way. Only `model`
  (and `stream`) stay in cleartext, because the relay needs them to route.
- The operator still decrypts to run inference. E2EE protects content from the **relay**, not from
  the operator. Disable it with `--no-e2e` if you don't need it.

### Confidential inference (operator-blind, hardware-attested)

When the prompt must stay private **even from the operator**, use **confidential mode**. The
request content is encrypted directly to a hardware **TEE** (NEAR AI Cloud enclaves — Intel TDX +
NVIDIA H200); the operator only relays ciphertext it cannot read, and the reply is signed inside
the enclave.

- **Encrypt to the enclave** — the consumer fetches the model's public attestation report (the
  enclave's ECDSA signing key + attested EVM signer) and encrypts the message content to it via
  ECIES (secp256k1 ECDH → HKDF-SHA256 → AES-256-GCM). Only the enclave can decrypt.
- **Verify the hardware, trustlessly** — before trusting any of that, the client runs full **DCAP
  attestation**: the Intel TDX quote must chain to Intel's SGX Root CA, the NVIDIA H200 evidence
  must verify, and the quote's `report_data` must bind the attested signing address + nonce. This
  proves a genuine enclave running the expected image — a rogue relay or operator can't fake the
  guarantee by substituting a key.
- **Verify the reply** — the enclave-signed response must recover to the attested signer, so the
  operator can neither read nor forge it.
- **Fails closed** — if no TEE operator can serve the model or attestation fails, the request
  errors; it never silently downgrades to plaintext.

Enable it per request with the `X-Halo-Confidential: true` header, or run the whole endpoint
confidential-only with `halo consume --confidential` (TEE endpoint set via `--tee-base-url`,
default `https://cloud-api.near.ai/v1`). Models advertise a `confidential` flag, and a verified
reply carries `X-Halo-TEE-Verified: true`. Operators serve confidential models by fronting a TEE
provider (e.g. `--provider near`).

## Quick start (CLI)

Install the `halo` CLI (Node.js >= 20):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/warden-protocol/run-halo/main/skill/scripts/install.sh)
halo --help
```

Probe the environment and create/inspect the wallet:

```bash
halo doctor --json   # node version, install + wallet state, provider, endpoint + relay health
halo setup           # create or reuse the wallet (the wallet address is your identity)
```

### Consume — use Halo as a paid inference endpoint

Run a local OpenAI-compatible endpoint that pays per request from your wallet.

```bash
# 1. one-time: wallet + a persisted consumer profile so `consume` needs no flags.
#    (setup wants a --provider slug even for pure consume; openai is a fine placeholder.)
halo setup --provider openai --consume --consume-model gpt-4o-mini \
  --consume-allow "gpt-4o-mini,meta-llama/llama-3.1-8b-instruct" \
  --consume-max-usdc 0.05 --consume-port 8799

# 2. fund the printed wallet with USDC on Base mainnet (this is what pays for inference),
#    plus a little ETH on Base for vault deposit gas.

# 3. run the endpoint. --vault bills actual token usage; --vault-deposit funds it and
#    auto-refills mid-run so the endpoint never drops off the rail.
halo consume --vault --vault-deposit 5
#   endpoint : http://127.0.0.1:8799/v1
```

Point any OpenAI-compatible client at `http://127.0.0.1:8799/v1`:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8799/v1", api_key="halo")  # api_key unused unless --api-key set
resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Summarize Base mainnet in one sentence."}],
)
print(resp.choices[0].message.content)
```

**Vault mode (`--vault`) is the recommended billing rail** — pair it with `--vault-deposit <usd>`
so the endpoint funds itself and auto-refills mid-run. It bills the *actual* tokens each request
used (deposit once, settle per real usage), which lines up with margin-priced operators so you pay
the real per-model cost rather than a flat per-request quote.

Key consume guards: `--max-usdc <n>` (per-request ceiling), `--budget-usdc <n>` (cumulative cap
for the run), `--consume-allow` (model allowlist). For privacy, `--confidential` routes only to
TEE operators and end-to-end-encrypts the prompt to the enclave.

### Operate — serve inference and earn USDC

```bash
# pick the upstream provider with `halo doctor`, then (margin is the recommended pricing mode):
halo setup --provider <slug> [--api-key <key>] --margin 20 --with-pairing
halo serve
```

`--provider` is one of `openclaw`, `claude-code`, `hermes`, `ollama`, `lmstudio`, `openrouter`,
`openai`, `anthropic`, `venice`, `near`, `together`, `fireworks`, `groq`, or `custom`. Price with
`--margin <n>` (n% over the upstream's published per-model rate — the recommended mode, supported
where the provider has a pricing API, e.g. OpenRouter and NEAR) or `--flat <usd-per-1k>` for local
or non-priced upstreams. Add more upstreams to one operator with `halo setup --add-provider`.

`halo serve` connects outbound to the relay over WebSocket (no public URL or open port needed),
announces its models, and serves until stopped. The operator wallet needs no pre-funding.

### Keep it always-on

Don't foreground-launch either daemon under an agent/gateway (a gateway restart kills its
children). Install it as an OS service instead:

```bash
halo service install serve            # or: install consume -- --vault --vault-deposit 5
halo service status serve
halo service logs serve
```

## CLI reference

| Command | What it does |
| --- | --- |
| `halo doctor [--json]` | Diagnostic — run first. Node version, install/wallet state, provider, endpoint + relay/indexer health. |
| `halo setup [flags]` | Create/reuse the wallet and configure provider, pricing, and (with `--consume`) a consumer profile. |
| `halo serve` | Start the operator process (connects to the relay, serves paid inference). |
| `halo consume [flags]` | Run the local OpenAI-compatible paying endpoint. |
| `halo vault <deposit\|...>` | Manage the consumer's HaloVault balance directly. |
| `halo pay [--model M] [--prompt P]` | One-shot paid request — verify an install end-to-end. |
| `halo service <install\|uninstall\|status\|logs> [serve\|consume]` | Run a daemon as an always-on OS service. |
| `halo link` | Generate a dashboard pairing code. |
| `halo status` | Wallet address, provider, network, requests, USDC earned/spent. |

Useful environment variables: `HALO_KEYSTORE_PATH`, `HALO_RELAY_URL`, `HALO_INDEXER_URL`,
`HALO_FACILITATOR_URL`, `BASE_RPC_URL`.

## Protocol architecture

Halo is a small set of cooperating components, all settling around one on-chain contract:

- **HaloVault contract** — the on-chain USDC escrow on Base. Holds consumer deposits, tracks
  per-operator reservations, registered session keys, and redeemed receipts. It is the single
  source of truth both sides trust; the operator gates on it and the facilitator writes to it.
- **Facilitator** — submits on-chain transactions on behalf of users and pays the gas: vault
  reserve / redeem / release, and x402 `transferWithAuthorization` settlement. Users never need
  ETH for these.
- **Relay** — routes consumer requests to operators. Operators hold an outbound WebSocket to the
  relay (so they need no public URL or inbound port); consumers send OpenAI-compatible requests
  the relay tunnels to a selected operator, and it also carries signed receipts back to operators.
- **Indexer** — ingests signed inference events and operator heartbeats and serves the network's
  public state (who's online, what they serve, request and earnings history).
- **Frontend** — the web app for humans: wallet connection, the session subkey, vault funding,
  model discovery, and confidential (TEE) inference with on-device attestation verification.
- **CLI (`halo`)** — the operator + consumer client in this repo ([`cli/`](cli)).
- **SDK (`halo-sdk`)** — the x402 client in this repo ([`sdk/`](sdk)) for paying any 402-gated
  service with an ethers signer.
- **Skill** — the agent skill ([`skill/`](skill)) that drives the CLI end-to-end for both roles.

### Goal: a fully self-hostable, censorship-resistant network

The north star is to make Halo **fully self-hostable and censorship-resistant** — an
open-source version of *every* component, so the network depends on no single provider.

We're getting there piece by piece. Today the **CLI** and **SDK** are open source (this repo),
the **HaloVault** contract is already on-chain and permissionless, and every service URL is
configurable (`HALO_RELAY_URL`, `HALO_FACILITATOR_URL`, `HALO_INDEXER_URL`, …) rather than
hard-wired — the endpoints under `runhalo.xyz` are defaults, not gatekeepers.

In the near future we plan to open-source runnable implementations of the remaining off-chain
components — **facilitator, relay, indexer, and frontend** — so anyone can stand up their own
instance and run Halo end-to-end independently.

## Roadmap

Halo is in active alpha. What's next:

- **Open-source, self-hostable services** — runnable implementations of the facilitator, relay,
  indexer, and frontend, so the whole network can be run by anyone (see above).
- **Protocol governance** — the protocol fee (currently 10%) and other parameters move under
  on-chain governance rather than a fixed constant.
- **Confidential compute** — broader TEE model/provider coverage for operator-blind inference.

Get started at [**app.runhalo.xyz**](https://app.runhalo.xyz) and follow
[**@wardenprotocol**](https://x.com/wardenprotocol) for the latest.

## Repository layout

| Path | Description |
| --- | --- |
| [`cli/`](cli) | The `halo` operator + consumer CLI |
| [`sdk/`](sdk) | `halo-sdk` — x402 client; pay any 402-gated service with an ethers signer |
| [`skill/`](skill) | Agent skill that drives the CLI end-to-end for both roles |

This repository is the public, open-source surface of Halo. The protocol's server-side components
live in a separate repository.

## License

Apache-2.0
