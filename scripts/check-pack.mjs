import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const [manifest] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }));
const paths = manifest.files.map(({ path }) => path);
const forbidden = paths.filter((path) =>
	path.startsWith("__tests__/") ||
	path.startsWith("docs/") ||
	path.startsWith("logs/") ||
	path.startsWith("node_modules/") ||
	path.endsWith(".test.ts") ||
	path === "tsconfig.json",
);

assert.deepEqual(forbidden, [], `Unexpected package files: ${forbidden.join(", ")}`);
assert(paths.includes("LICENSE"));
assert(paths.includes("README.md"));
assert(paths.includes("index.ts"));
console.log(`Package payload verified: ${paths.length} files`);
