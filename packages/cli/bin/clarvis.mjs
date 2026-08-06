#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// Node 22 needs the strip-types flag to run the TypeScript sources directly.
// TODO: drop the flag once the project's floor is Node >= 23.6, where type
// stripping is on by default.
import { main } from "../src/main.ts";

main(process.argv.slice(2)).catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
