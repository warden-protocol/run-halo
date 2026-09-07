import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Wallet } from "ethers";
import { WalletAccessError } from "../domain/walletAccess";
import {
  FileConsumeSessionKeyStore,
  consumeSessionKeyPath,
  type ConsumeSessionKeyRecordV1,
  type ConsumeSessionKeyScope,
} from "./fileConsumeSessionKeyStore";

const owner = new Wallet(`0x${"1".repeat(64)}`);
const session = new Wallet(`0x${"2".repeat(64)}`);
const scope: ConsumeSessionKeyScope = {
  chainId: 8453,
  vaultAddress: "0x1111111111111111111111111111111111111111",
  consumerAddress: owner.address,
  derivationVersion: 1,
};

function record(): ConsumeSessionKeyRecordV1 {
  return {
    version: 1,
    chainId: "8453",
    vaultAddress: scope.vaultAddress.toLowerCase(),
    consumerAddress: owner.address.toLowerCase(),
    derivationVersion: 1,
    privateKey: session.privateKey.toLowerCase(),
    sessionAddress: session.address.toLowerCase(),
  };
}

test("consume-key store writes and restores one strict mode-0600 scoped record", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "halo-consume-key-"));
  try {
    const store = new FileConsumeSessionKeyStore(scope, root);
    await store.withScopeLock(async () => store.write(record()));
    const file = consumeSessionKeyPath(scope, root);
    assert.deepEqual(store.read(), record());
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).chainId, "8453");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("consume-key store rejects unknown fields and never overwrites another valid key", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "halo-consume-key-"));
  try {
    const store = new FileConsumeSessionKeyStore(scope, root);
    await store.withScopeLock(async () => store.write(record()));
    await assert.rejects(
      store.withScopeLock(async () =>
        store.write({ ...record(), privateKey: `0x${"3".repeat(64)}` })
      ),
      (error: unknown) =>
        error instanceof WalletAccessError &&
        error.code === "privy_consume_key_state_ambiguous"
    );
    const file = consumeSessionKeyPath(scope, root);
    writeFileSync(file, JSON.stringify({ ...record(), accessToken: "forbidden" }), {
      mode: 0o600,
    });
    assert.throws(
      () => store.read(),
      (error: unknown) =>
        error instanceof WalletAccessError &&
        error.code === "privy_consume_key_state_ambiguous"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent first-use lock contention fails with a stable retryable incident", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "halo-consume-key-"));
  try {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = new FileConsumeSessionKeyStore(scope, root);
    const second = new FileConsumeSessionKeyStore(scope, root, {
      timeoutMs: 0,
      retryMs: 1,
    });
    const ownerLock = first.withScopeLock(async () => held);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      second.withScopeLock(async () => undefined),
      (error: unknown) =>
        error instanceof WalletAccessError &&
        error.code === "privy_consume_key_lock_unavailable" &&
        error.incident.disposition === "retryable"
    );
    release();
    await ownerLock;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
