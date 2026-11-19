#!/usr/bin/env node
/** Copy what the AI Reader injects into pages: Mozilla's Readability (Apache-2.0) and our extractor. */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
copyFileSync(createRequire(import.meta.url).resolve("@mozilla/readability/Readability.js"), join(dist, "Readability.js"));
copyFileSync(join(root, "src", "reader-extractor.js"), join(dist, "reader-extractor.js"));
console.log("reader assets: Readability.js + reader-extractor.js");
