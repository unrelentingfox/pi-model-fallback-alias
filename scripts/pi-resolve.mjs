import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const piPackageUrl = pathToFileURL(join(findPiRoot(), "package.json")).href;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (!specifier.startsWith("@earendil-works/")) return nextResolve(specifier, context);
		return nextResolve(specifier, { ...context, parentURL: piPackageUrl });
	},
});

function findPiRoot() {
	for (const candidate of piRootCandidates()) {
		if (existsSync(join(candidate, "package.json"))) return candidate;
	}
	throw new Error(`Cannot find ${PI_PACKAGE}; set PI_ROOT`);
}

function* piRootCandidates() {
	if (process.env.PI_ROOT) yield process.env.PI_ROOT;
	const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	yield join(packageRoot, "node_modules", PI_PACKAGE);
	const npmRoot = commandOutput("npm", ["root", "-g"]);
	if (npmRoot) yield join(npmRoot, PI_PACKAGE);
	const brewPrefix = commandOutput("brew", ["--prefix"]);
	if (brewPrefix) yield join(brewPrefix, "lib", "node_modules", PI_PACKAGE);
	yield `/usr/local/lib/node_modules/${PI_PACKAGE}`;
	yield `/usr/lib/node_modules/${PI_PACKAGE}`;
}

function commandOutput(command, args) {
	try {
		return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}
