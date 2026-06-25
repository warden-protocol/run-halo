# Halo

Halo is a marketplace for **x402-paid inference on Base mainnet**. Payment is settled
on-chain by the Halo protocol facilitator, which submits the transfer and covers the gas —
so neither side handles a network fee. There's **no token, no stake, and no deposit**:
operators earn real USDC per request, consumers pay real USDC per request, and the wallet is
the only credential on either side.

Two roles, one network:

- **Operate** — serve x402-paid inference from your provider, models, or local GPU and earn
  USDC. Works with OpenClaw, Claude Code, Hermes, Ollama, LM Studio, OpenRouter, NEAR AI Cloud,
  and any OpenAI-compatible upstream.
- **Consume** — run a local OpenAI-compatible endpoint that pays per request from your wallet,
  so any agent or app gets inference with no provider API keys in your code.

## Repository layout

| Path | Package | Description |
| --- | --- | --- |
| [`cli/`](cli) | [`@runhalodev/cli`](https://www.npmjs.com/package/@runhalodev/cli) | The `halo` operator + payer CLI |
| [`sdk/`](sdk) | [`@runhalodev/sdk`](https://www.npmjs.com/package/@runhalodev/sdk) | x402 client — pay any 402-gated service with an ethers signer |
| [`skill/`](skill) | — | Agent skill that drives the CLI end-to-end for both roles |

## Quick start

Install the CLI (Node.js >= 20):

```bash
npm install -g @runhalodev/cli
halo --help
```

Probe your environment, then configure a wallet:

```bash
halo doctor --json
halo setup
```

### Operate (serve & earn)

```bash
halo setup --provider <slug> [--api-key <key>] --flat 0.001 --with-pairing
halo serve
```

USDC arrives at settlement; the operator wallet needs no pre-funding (the facilitator covers
gas).

### Consume (use & pay)

```bash
halo setup --provider openai --consume --consume-model gpt-4o-mini --consume-port 8799
# fund the printed wallet with USDC on Base mainnet, then:
halo consume
```

Point any OpenAI-compatible client at `http://127.0.0.1:8799/v1`.

## How payment works

1. A consumer sends a chat request to the relay, which tunnels it to a selected operator.
2. The operator returns `402 Payment Required` (amount, operator wallet, USDC asset on Base).
3. The consumer's wallet signs an EIP-3009 `TransferWithAuthorization` off-chain.
4. The operator verifies and settles through the protocol facilitator, which submits the
   on-chain tx and pays the gas. USDC flows consumer → operator in one transaction.
5. The operator runs inference and returns the response with the settlement tx hash.

Neither wallet needs ETH for gas.

## License

Apache-2.0
