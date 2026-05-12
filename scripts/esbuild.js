import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const outdir = "dist/sidecars";
const wasmFiles = [
  "node_modules/@midnight-ntwrk/ledger-v8/midnight_ledger_wasm_bg.wasm",
  "node_modules/@midnight-ntwrk/zkir-v2/midnight_zkir_wasm_bg.wasm",
];

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

await esbuild.build({
  entryPoints: ["src/sidecars/wallet-sync.ts", "src/sidecars/dapp-connector.ts"],
  outdir,
  entryNames: "[name]",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outExtension: { ".js": ".mjs" },
  sourcemap: true,
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});

for (const wasmFile of wasmFiles) {
  if (!fs.existsSync(wasmFile)) continue;
  fs.copyFileSync(wasmFile, path.join(outdir, path.basename(wasmFile)));
}
