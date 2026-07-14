import prompts from "prompts";
import { classifySessionKey } from "@halo/vault-core";
import { loadConfig, BASE_CHAIN_ID } from "../config";
import { loadWallet } from "../wallet";
import {
  VaultConsumeClient,
  fmtUsd,
  guardVaultFresh,
  resolveSessionSigner,
  type SessionKeyMode,
} from "../vault-consume";
import {
  facilitatorVaultError,
  inspectFacilitatorVault,
  resolveVaultAddress,
} from "../vault-address";

function flagValue(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

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
  // Use the same signer mode for status, deposit, and consume.
  const sessionKeyRaw = flagValue(rawArgs, "--session-key");
  if (sessionKeyRaw && sessionKeyRaw !== "wallet" && sessionKeyRaw !== "browser") {
    console.error(`  ✗ --session-key must be "wallet" or "browser" (got "${sessionKeyRaw}").`);
    process.exit(1);
  }
  const sessionKeyMode: SessionKeyMode = sessionKeyRaw === "browser" ? "browser" : "wallet";
  const wallet = await loadWallet(cfg.operator.keystorePath, passphrase);
  const facilitatorUrl = cfg.facilitator?.url ?? "https://facilitator.runhalo.xyz";
  const vaultAddress = resolveVaultAddress(cfg.vaultAddress);
  const sessionSigner = await resolveSessionSigner(wallet, sessionKeyMode);
  const client = new VaultConsumeClient(
    wallet,
    {
      facilitatorUrl,
      rpcUrl: (process.env.BASE_RPC_URL || "https://mainnet.base.org").trim(),
      chainId: BASE_CHAIN_ID,
      vaultAddress,
    },
    sessionSigner
  );

  switch (sub) {
    case "status": {
      const identity = await inspectFacilitatorVault(facilitatorUrl, vaultAddress);
      const s = await client.readVaultState();
      // Classify against the selected receipt signer, not always the main wallet.
      const expected = await client.sessionAddress();
      const skStatus = classifySessionKey(s.sessionKey, expected);
      const browser = sessionKeyMode === "browser";
      const skNote =
        skStatus === "match"
          ? browser
            ? " (browser-derived key — shared with the Halo web app)"
            : " (this wallet)"
          : skStatus === "unregistered"
            ? browser
              ? " (none yet — your first deposit registers the browser-derived key)"
              : " (none yet — your first deposit registers this wallet)"
            : " ⚠ NOT the key this CLI signs with — receipts can't redeem against it";
      console.log(`halo vault`);
      console.log(`  vault       : ${vaultAddress}  (Base mainnet)`);
      console.log(
        identity.status === "match"
          ? `  facilitator : verified (${identity.live})`
          : `  facilitator : ${facilitatorVaultError(vaultAddress, identity)}`
      );
      console.log(`  consumer    : ${wallet.address}`);
      console.log(`  balance     : $${fmtUsd(s.balance)}`);
      console.log(`  locked      : $${fmtUsd(s.lockedTotal)} (reserved to operators)`);
      console.log(`  withdrawable: $${fmtUsd(s.withdrawable)}`);
      console.log(`  signs with  : ${expected}${browser ? " (browser-derived; --session-key browser)" : " (this wallet)"}`);
      console.log(`  session key : ${s.sessionKey}${skNote}`);
      if (skStatus === "mismatch") {
        console.log(
          `\n  ⚠ The registered session key is NOT the key this CLI signs with, so\n` +
            `    \`halo consume${browser ? " --session-key browser" : ""}\` would serve work it can never collect\n` +
            `    (redeem reverts BadSignature). Common causes: mixing the Halo browser app and the\n` +
            `    CLI on one wallet, or the wrong --session-key mode. Try the other mode\n` +
            `    (--session-key ${browser ? "wallet" : "browser"}), use a DEDICATED wallet, or rotate the key via\n` +
            `    setSessionKey(${expected}) (needs locked == $0).`
        );
      }
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
      if (!(await guardVaultFresh(facilitatorUrl, vaultAddress, { force }))) process.exit(1);
      console.log(`  depositing $${amount.toFixed(2)} into the vault (approve + deposit; needs a little ETH for gas)…`);
      try {
        const tx = await client.deposit(amount);
        console.log(`  ✓ deposited — tx ${tx}`);
        const s = await client.readVaultState();
        console.log(`  balance now : $${fmtUsd(s.balance)} (withdrawable $${fmtUsd(s.withdrawable)})`);
      } catch (e) {
        console.error(`  ✗ deposit failed: ${e instanceof Error ? e.message : String(e)}`);
        console.error(`    Ensure ${wallet.address} holds USDC and ~$0.50 of ETH on Base mainnet.`);
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
      console.error("usage: halo vault [--session-key <wallet|browser>] <status|deposit <usd>|withdraw>");
      process.exit(1);
  }
}
