import prompts from "prompts";
import { randomBytes, randomInt } from "crypto";
import { loadConfig } from "../config";
import { loadWallet } from "../wallet";

function generateCode(): string {
  // CSPRNG (crypto.randomInt), not Math.random — this is a pairing secret.
  const groups = Array.from({ length: 3 }, () =>
    randomInt(0, 1000).toString().padStart(3, "0")
  );
  return groups.join("-");
}

export async function cmdLink(): Promise<void> {
  const cfg = loadConfig();

  // Empty passphrases are valid unattended keystores; distinguish empty submit from prompt cancellation.
  let passphrase = "";
  if (cfg.operator.noPassphrase) {
    passphrase = "";
  } else if (typeof process.env.HALO_PASSPHRASE === "string") {
    passphrase = process.env.HALO_PASSPHRASE;
  } else {
    const r = await prompts(
      {
        type: "password",
        name: "passphrase",
        message: "Keystore passphrase (leave blank if none)",
      },
      { onCancel: () => process.exit(130) }
    );
    passphrase = r.passphrase ?? "";
  }

  const wallet = await loadWallet(cfg.operator.keystorePath, passphrase);

  const code = generateCode();
  const nonce = "0x" + randomBytes(32).toString("hex");
  const expiresAt = Math.floor(Date.now() / 1000) + 300;

  const message = `halo-link-init:${wallet.address.toLowerCase()}:${code}:${nonce}:${expiresAt}`;
  const operatorSig = await wallet.signMessage(message);

  const url = `${cfg.indexerUrl.replace(/\/+$/, "")}/link/init`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      operatorAddress: wallet.address,
      operatorSig,
      nonce,
      expiresAt,
    }),
  });

  if (!res.ok) {
    console.log(`\n✖ /link/init failed: ${res.status} ${await res.text()}\n`);
    process.exit(1);
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Pairing code`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`\n                 ${code}\n`);
  console.log(`  Open the dashboard, connect your wallet, paste this code,`);
  console.log(`  and sign to finalize the link. Valid 5 minutes.\n`);
}
