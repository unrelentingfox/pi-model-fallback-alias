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

function piRootCandidates() {
	const candidates = [];
	if (process.env.PI_ROOT) candidates.push(process.env.PI_ROOT);
	const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	candidates.push(join(packageRoot, "node_modules", PI_PACKAGE));
	const npmRoot = commandOutput("npm", ["root", "-g"]);
	if (npmRoot) candidates.push(join(npmRoot, PI_PACKAGE));
	const brewPrefix = commandOutput("brew", ["--prefix"]);
	if (brewPrefix) candidates.push(join(brewPrefix, "lib", "node_modules", PI_PACKAGE));
	candidates.push(`/usr/local/lib/node_modules/${PI_PACKAGE}`, `/usr/lib/node_modules/${PI_PACKAGE}`);
	return candidates;
}

function commandOutput(command, args) {
	try {
		return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}
