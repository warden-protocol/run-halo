# HALO Buyback & Burn Ledger

Public record of every HALO buyback cycle. Protocol fees are routed by published rule, and
every step of every cycle links to an on-chain transaction on Base.

## The rule

- **Pool creator fees** (HALO/VIRTUAL launch pool trading fees): 100% → buyback bucket.
- **Vault protocol fees** (10% fee on settled inference, collected in USDC at redemption):
  80% → buyback bucket, 20% → USDC treasury.
- The buyback bucket is converted to HALO on-market. Of all HALO in the bucket:
  **70% → staking contract** (real-revenue yield) · **30% → burned** (permanent supply
  reduction via `burn()`; burned tokens are never re-minted).
- The staking/burn split sits on a governance dial bounded between 20% and 80% burn.

Cycles are currently executed manually by the team, following the rule exactly, until the
permissionless `execute()` contract ships.

**Contracts & addresses:**

- HALO token: [`0xbbd27C575fB0e113219D610cc787B02Eeff71d42`](https://basescan.org/token/0xbbd27C575fB0e113219D610cc787B02Eeff71d42)
- Staking contract: [`0x1466d94Eb3485bCd4c0fbB943b9F9251dE5b56D5`](https://basescan.org/address/0x1466d94Eb3485bCd4c0fbB943b9F9251dE5b56D5)
- Executing address: [`0xf3eEE5bBBF234FD6392465B48Fa1c5f44AeEF6F5`](https://basescan.org/address/0xf3eEE5bBBF234FD6392465B48Fa1c5f44AeEF6F5)

## Cumulative totals

*Updated after each cycle. Last update: cycle 1, 2026-09-02.*

| Metric | Amount |
|---|---|
| HALO market-bought | 359,723.803895 |
| **HALO burned** | **219,944.298197** |
| HALO distributed to staking | 513,203.362462 |

---

## Cycle 1 — 2026-09-02

**Fees collected:** 32,037.004032 VIRTUAL + 373,423.856760 HALO (pool creator fees) +
238.053554 USDC (vault protocol fees).

| Step | Amount | Transaction |
|---|---|---|
| VIRTUAL → HALO buyback | 32,037.004032 VIRTUAL → 355,971.779487 HALO | [`0x7dc628c4…`](https://basescan.org/tx/0x7dc628c4eb6eb95009cb1f056eed1e02523ec981d8285b868a0cb61acb11b491) |
| USDC → HALO buyback | 238.053554 USDC → 3,752.024409 HALO | [`0x72837843…`](https://basescan.org/tx/0x72837843241accb809f80b366566e58d6b6ad09996128da8445b701e267e28a0) |
| Bucket total | 733,147.660655 HALO | — |
| **Burn (30%)** | **219,944.298197 HALO** | [`0x8e849f8b…`](https://basescan.org/tx/0x8e849f8b5d49374112233ecea85c0e68e58f689ebe4698bb670a8169ba7b361d) |
| Staking deposit (70%) | 513,203.362462 HALO | [`0xddf44493…`](https://basescan.org/tx/0xddf444932a13a2ce1f523a7582b21f6c3810a7b9797a49dc07713ceea5213f5c) |

**Notes:**

- In this first cycle the full 238.05 USDC of vault fees was routed to the buyback; the 20%
  treasury share (47.610711 USDC) is carried forward and will be settled from the next USDC
  accrual. The 80/20 routing applies strictly from cycle 2.
- The staking deposit includes a negligible wallet-dust overage (~0.0000032 HALO) above the
  computed 70% share.
