import { build } from "esbuild";
// Bundle pure JS imports to avoid loading hundreds of ESM files for each isolated
// request worker. RE2 stays external so its WASM loader retains its package path.
await build({
  entryPoints: ["src/checks/worker.ts"],
  outfile: "dist/checks/worker.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["re2-wasm"],
});
