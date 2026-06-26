# halo-sdk

x402 client for [Halo](https://github.com/warden-protocol/run-halo) — pay any HTTP 402–gated service with an [ethers](https://docs.ethers.org/) signer, and discover payable resources via the Coinbase CDP x402 Bazaar.

It targets the standard "exact" EVM scheme (USDC `transferWithAuthorization`, EIP‑3009) — the same flow Coinbase's CDP facilitator settles onchain.

## Install

Not yet published to a registry. Build it from source (requires Node.js >= 20):

```bash
git clone https://github.com/warden-protocol/run-halo.git
cd run-halo/sdk
npm install && npm run build
```

## Pay a 402-gated endpoint

```ts
import { ethers } from "ethers";
import { fetchWithX402 } from "halo-sdk";

const signer = new ethers.Wallet(process.env.PRIVATE_KEY!);

const { response, paid, paymentAmount } = await fetchWithX402(
  "https://api.example.com/premium",
  { method: "GET" },
  signer,
  { maxAmount: 1_000_000n }, // hard cap in USDC base units (6 decimals) = 1 USDC
);

console.log({ paid, paymentAmount });
console.log(await response.json());
```

`paid` is `true` only when a payment was made and the retried request succeeded. Set `onPaymentRequired` in the options to inspect/approve a charge before signing.

## Discover and call resources (x402 Bazaar)

```ts
import { searchBazaar, callX402Json } from "halo-sdk";

const { resources } = await searchBazaar({ query: "weather", asset: "USDC" });

const { data, paid, paymentAmount } = await callX402Json(
  resources[0].resource,
  { method: "GET" },
  signer,
);
```

Use `listBazaarResources` to paginate the full catalog and `pickAccept` to choose a payment option by scheme/network.

## API

- `fetchWithX402(input, init, signer, options?)` — fetch that transparently handles `402 Payment Required`.
- `signX402Payment` / `parsePaymentRequired` / `encodePaymentSignature` — low-level handshake primitives.
- `searchBazaar(opts?)` / `listBazaarResources(opts?)` / `pickAccept(resource, filter?)` — Bazaar discovery.
- `callX402Json<T>(url, init, signer, options?)` — call a discovered resource and parse typed JSON.
- `CHAINS`, `getChain`, `resolveChainId` — USDC chain config (Base mainnet & Sepolia).

Full type declarations ship in the package.

## License

Apache-2.0
