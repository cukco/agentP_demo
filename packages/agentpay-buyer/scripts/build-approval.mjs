import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const file = name => new URL(`../${name}`, import.meta.url);
const source = await readFile(file("src/approve/page.html"), "utf8");
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(file("src/approve/page.ts"))], bundle: true, write: false,
  platform: "browser", format: "iife", target: "es2022", minify: true,
});
const js = outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
await mkdir(file("dist/approve/"), { recursive: true });
await writeFile(file("dist/approve/index.html"), source.replace("<!-- APPROVAL_SCRIPT -->", () => `<script>${js}</script>`));
