/**
 * halo pay — test x402 payment from the CLI.
 *
 * Signs an EIP-3009 TransferWithAuthorization for the requested inference
 * and prints the operator's response.
 */
import prompts from "prompts";
import { loadConfig } from "../config";
import { loadWallet } from "../wallet";
import { payAndFetch, X402Error } from "../x402-consume";

interface Args {
  model?: string;
  prompt?: string;
  maxTokens?: number;
}

export async function cmdPay(args: Args): Promise<void> {
  const cfg = loadConfig();

  const model = args.model || (await promptText("Model", "gpt-4o-mini"));
  const promptText_ = args.prompt || (await promptText("Prompt", "Hello"));
  const maxTokens = args.maxTokens ?? 200;

  const { passphrase } = await prompts({
    type: "password",
    name: "passphrase",
    message: "Keystore passphrase",
  });
  if (!passphrase) process.exit(130);

  const wallet = await loadWallet(cfg.operator.keystorePath, passphrase);
  const url = `${cfg.relayUrl.replace(/\/+$/, "")}/v1/chat/completions`;

  const body = {
    model,
    messages: [{ role: "user", content: promptText_ }],
    max_tokens: maxTokens,
  };

  try {
    const res = await payAndFetch(url, body, { wallet }, {
      onPaying: ({ amountBase, payTo }) =>
        console.log(`\n  signed ${amountBase} USDC base units → ${payTo}`),
    });
    console.log(`\n  status: ${res.status}`);
    if (res.settlement !== undefined) console.log(`  settlement:`, res.settlement);
    console.log(`\n  response:\n${res.body}\n`);
  } catch (err) {
    if (err instanceof X402Error) {
      console.log(`✖ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

async function promptText(label: string, initial: string): Promise<string> {
  const r = await prompts({ type: "text", name: "v", message: label, initial });
  return r.v;
}
