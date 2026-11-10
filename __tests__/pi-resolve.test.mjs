import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("pi-resolve uses explicit and local roots without global command discovery", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-resolve-"));
	try {
		const marker = join(directory, "command-ran");
		const bin = join(directory, "bin");
		mkdirSync(bin);
		for (const command of ["npm", "brew"]) {
			writeFileSync(join(bin, command), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
		}
		const scripts = join(directory, "scripts");
		mkdirSync(scripts);
		copyFileSync(new URL("../scripts/pi-resolve.mjs", import.meta.url), join(scripts, "pi-resolve.mjs"));
		const root = join(directory, "explicit");
		mkdirSync(root);
		writeFileSync(join(root, "package.json"), "{}");
		const env = { ...process.env, PATH: bin, PI_ROOT: root };
		delete env.NODE_OPTIONS;
		execFileSync(process.execPath, ["--import", join(scripts, "pi-resolve.mjs"), "--eval", ""], { env });
		assert.equal(existsSync(marker), false);
		const local = join(directory, "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(local, { recursive: true });
		writeFileSync(join(local, "package.json"), "{}");
		delete env.PI_ROOT;
		execFileSync(process.execPath, ["--import", join(scripts, "pi-resolve.mjs"), "--eval", ""], { env });
		assert.equal(existsSync(marker), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
