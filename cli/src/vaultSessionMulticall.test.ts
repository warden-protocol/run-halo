import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { VAULT_ABI } from "@halo/vault-core";
import { readVaultConsumerSessionAt } from "./vault";

const MULTICALL3 = new Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
]);
const VAULT_INTERFACE = new Interface(VAULT_ABI);
const VAULT = "0x00000000000000000000000000000000000000A1";
const CONSUMER = "0x00000000000000000000000000000000000000B2";
const SESSION = "0x00000000000000000000000000000000000000C3";

test("vault session key and epoch use one required Multicall3 RPC element", async () => {
  let calls = 0;
  const provider = {
    async call(transaction: { to?: string; data?: string }) {
      calls += 1;
      assert.equal(
        transaction.to?.toLowerCase(),
        "0xca11bde05977b3631167028862be2a173976ca11"
      );
      const decoded = MULTICALL3.decodeFunctionData(
        "aggregate3",
        transaction.data!
      )[0];
      assert.equal(decoded.length, 2);
      assert.equal(decoded[0].target.toLowerCase(), VAULT.toLowerCase());
      assert.equal(decoded[1].target.toLowerCase(), VAULT.toLowerCase());
      return MULTICALL3.encodeFunctionResult("aggregate3", [
        [
          [true, VAULT_INTERFACE.encodeFunctionResult("sessionKey", [SESSION])],
          [true, VAULT_INTERFACE.encodeFunctionResult("keyEpoch", [7n])],
        ],
      ]);
    },
  };

  await assert.doesNotReject(async () => {
    assert.deepEqual(
      await readVaultConsumerSessionAt(provider, VAULT, CONSUMER),
      { sessionKey: SESSION.toLowerCase(), keyEpoch: 7n }
    );
  });
  assert.equal(calls, 1);
});

test("vault session Multicall fails closed when a required subcall fails", async () => {
  const provider = {
    async call() {
      return MULTICALL3.encodeFunctionResult("aggregate3", [
        [
          [true, VAULT_INTERFACE.encodeFunctionResult("sessionKey", [SESSION])],
          [false, "0x"],
        ],
      ]);
    },
  };

  await assert.rejects(
    readVaultConsumerSessionAt(provider, VAULT, CONSUMER),
    /failed keyEpoch/
  );
});
