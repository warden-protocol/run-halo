import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync(new URL("../dist/cjs/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../dist/cjs/package.json", import.meta.url),
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`
);
