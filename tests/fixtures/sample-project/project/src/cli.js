#!/usr/bin/env node
import { slugify } from "./slug.js";

const titles = process.argv.slice(2);
if (!titles.length) {
  console.error("usage: slugkit <title>...");
  process.exit(2);
}
for (const title of titles) console.log(slugify(title));
