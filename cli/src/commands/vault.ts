/**
 * halo vault — manage the consumer's HaloVault balance for `halo consume --vault`.
 *
 *   halo vault status              show balance / locked / withdrawable
 *   halo vault deposit <usd>       move USDC from the wallet into the vault
 *   halo vault withdraw [usd]      start/complete a timelocked withdrawal
 *
 * The vault rail bills the ACTUAL tokens each request used (settle-actual), vs
 * exact mode's prompt-blind flat per-request quote. Deposits are on-chain (the
 * wallet pays a little gas); per-request reserve/redeem are gasless (facilitator).
 */
import prompts from "prompts";
import { loadConfig } from "../config";
import { loadWallet } from "../wallet";
import { VaultConsumeClient, VAULT_ADDRESS, fmtUsd, guardVaultFresh } from "../vault-consume";

export async function cmdVault(rawArgs: string[]): Promise<void> {
  const sub = rawArgs[0];
  const cfg = loadConfig();

  // Passphrase resolution mirrors consume/serve.
  let passphrase = "";
  if (cfg.operator.noPassphrase) {
    passphrase = "";
  } else if (typeof process.env.HALO_PASSPHRASE === "string") {
    passphrase = process.env.HALO_PASSPHRASE;
  } else {
    const r = await prompts({ type: "password", name: "passphrase", message: "Keystore passphrase" });
    if (!r.passphrase) process.exit(130);
    passphrase = r.passphrase;
  }
  const force = rawArgs.includes("--force");
  const wallet = await loadWallet(cfg.operator.keystorePath, passphrase);
  const facilitatorUrl = cfg.facilitator?.url ?? "https://facilitator.runhalo.xyz";
  const client = new VaultConsumeClient(wallet, {
    facilitatorUrl,
    rpcUrl: (process.env.BASE_RPC_URL || "https://mainnet.base.org").trim(),
    chainId: cfg.network === "base-sepolia" ? 84532 : 8453,
  });

  switch (sub) {
    case "status": {
      const s = await client.readVaultState();
      console.log(`halo vault`);
      console.log(`  vault       : ${VAULT_ADDRESS}  (${cfg.network})`);
      console.log(`  consumer    : ${wallet.address}`);
      console.log(`  balance     : $${fmtUsd(s.balance)}`);
      console.log(`  locked      : $${fmtUsd(s.lockedTotal)} (reserved to operators)`);
      console.log(`  withdrawable: $${fmtUsd(s.withdrawable)}`);
      console.log(
        `  session key : ${s.sessionKey}${s.sessionKey.toLowerCase() === wallet.address.toLowerCase() ? " (this wallet)" : ""}`
      );
      return;
    }
    case "deposit": {
      // First non-flag arg after the subcommand is the amount, so `--force` can
      // sit anywhere (e.g. `deposit 5 --force` or `deposit --force 5`).
      const amount = Number(rawArgs.slice(1).find((a) => !a.startsWith("-")));
      if (!Number.isFinite(amount) || amount <= 0) {
        console.error("usage: halo vault deposit <usd>   (e.g. halo vault deposit 5)");
        process.exit(1);
      }
      // Staleness gate (#392): refuse to move USDC into a stale pinned vault.
      if (!(await guardVaultFresh(facilitatorUrl, { force }))) process.exit(1);
      console.log(`  depositing $${amount.toFixed(2)} into the vault (approve + deposit; needs a little ETH for gas)…`);
      try {
        const tx = await client.deposit(amount);
        console.log(`  ✓ deposited — tx ${tx}`);
        const s = await client.readVaultState();
        console.log(`  balance now : $${fmtUsd(s.balance)} (withdrawable $${fmtUsd(s.withdrawable)})`);
      } catch (e) {
        console.error(`  ✗ deposit failed: ${e instanceof Error ? e.message : String(e)}`);
        console.error(`    Ensure ${wallet.address} holds USDC and ~$0.50 of ETH on ${cfg.network}.`);
        process.exit(1);
      }
      return;
    }
    case "withdraw": {
      // The contract enforces a withdrawal timelock; this command surfaces the
      // two-step flow. (Implemented as a guided message rather than firing txs
      // blindly, since withdrawals move real funds.)
      console.log(
        "Withdrawals are timelocked by the vault contract. Run `halo vault status` to see your\n" +
          "withdrawable balance, then withdraw from the dashboard wallet UI (request → wait out the\n" +
          "timelock → withdraw). CLI withdraw is intentionally not a one-shot to avoid mis-fires."
      );
      return;
    }
    default:
      console.error("usage: halo vault <status|deposit <usd>|withdraw>");
      process.exit(1);
  }
}
