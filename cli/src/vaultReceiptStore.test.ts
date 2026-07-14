import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { VaultReceiptStore, StoredReceipt } from "./vaultReceiptStore";

const C = "0x1111111111111111111111111111111111111111";
const O = "0x2222222222222222222222222222222222222222";

function tmpFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "halo-receipts-"));
  return path.join(dir, "vault-receipts.json");
}

const receipt = (cumulative: bigint, cycle: bigint, signature = "0xsig"): StoredReceipt => ({
  consumer: C,
  operator: O,
  receipt: { cumulative, signature, cycle },
});

test("save → load round-trips a receipt, bigint-safe", () => {
  const f = tmpFile();
  const store = new VaultReceiptStore(f);
  const beyondSafeInteger = 9_007_199_254_740_993n;
  store.save([receipt(beyondSafeInteger, 7n, "0xdeadbeef")]);

  const loaded = new VaultReceiptStore(f).load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].consumer.toLowerCase(), C);
  assert.equal(loaded[0].operator.toLowerCase(), O);
  assert.equal(loaded[0].receipt.cumulative, beyondSafeInteger);
  assert.equal(loaded[0].receipt.cycle, 7n);
  assert.equal(loaded[0].receipt.signature, "0xdeadbeef");
  rmSync(path.dirname(f), { recursive: true, force: true });
});

test("save is atomic — no torn .tmp is left behind, and re-save overwrites", () => {
  const f = tmpFile();
  const store = new VaultReceiptStore(f);
  store.save([receipt(100n, 1n)]);
  assert.equal(existsSync(`${f}.tmp`), false, "temp file must not linger after rename");

  store.save([receipt(250n, 1n)]);
  const loaded = store.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].receipt.cumulative, 250n);
  rmSync(path.dirname(f), { recursive: true, force: true });
});

test("missing file loads as []", () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "halo-receipts-")), "does-not-exist.json");
  assert.deepEqual(new VaultReceiptStore(f).load(), []);
});

test("corrupt / garbage file loads as [] (never blocks boot)", () => {
  const f = tmpFile();
  writeFileSync(f, "{ this is not json ]]", "utf-8");
  assert.deepEqual(new VaultReceiptStore(f).load(), []);
  writeFileSync(
    f,
    JSON.stringify({ version: 1, receipts: { [`${C}:${O}`]: { cumulative: "-5", signature: "0x", cycle: "x" } } }),
    "utf-8"
  );
  assert.deepEqual(new VaultReceiptStore(f).load(), []);
  rmSync(path.dirname(f), { recursive: true, force: true });
});

test("malformed entries are skipped individually, valid ones survive", () => {
  const f = tmpFile();
  writeFileSync(
    f,
    JSON.stringify({
      version: 1,
      receipts: {
        [`${C}:${O}`]: { cumulative: "500", signature: "0xok", cycle: "3" },
        "no-colon-key": { cumulative: "1", signature: "0x", cycle: "1" },
        [`${C}:0xbad`]: { cumulative: "0", signature: "0x", cycle: "1" },
        [`0xdead:${O}`]: { cumulative: "1", signature: "", cycle: "1" },
      },
    }),
    "utf-8"
  );
  const loaded = new VaultReceiptStore(f).load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].receipt.cumulative, 500n);
  rmSync(path.dirname(f), { recursive: true, force: true });
});

test("save swallows a write failure (best-effort — never throws)", () => {
  const missingRoot = path.join(tmpdir(), "halo-receipts-missing-parent");
  const missingDir = path.join(missingRoot, "sub", "vault-receipts.json");
  rmSync(missingRoot, { recursive: true, force: true });
  const warnings: string[] = [];
  const store = new VaultReceiptStore(missingDir, (m) => warnings.push(m));
  assert.doesNotThrow(() => store.save([receipt(100n, 1n)]));
  assert.equal(warnings.length, 1, "a single throttled warning is emitted");
  assert.match(warnings[0], /could not persist/);
  assert.doesNotThrow(() => store.save([receipt(100n, 1n)]));
  assert.equal(warnings.length, 1);
});

test("empty snapshot writes an empty receipts map (prunes everything)", () => {
  const f = tmpFile();
  const store = new VaultReceiptStore(f);
  store.save([receipt(100n, 1n)]);
  store.save([]);
  assert.deepEqual(store.load(), []);
  const raw = JSON.parse(readFileSync(f, "utf-8"));
  assert.deepEqual(raw.receipts, {});
  rmSync(path.dirname(f), { recursive: true, force: true });
});
