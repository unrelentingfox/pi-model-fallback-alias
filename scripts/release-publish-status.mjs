import { appendFile, readFile } from "node:fs/promises";

const githubApiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
const npmRegistryUrl = process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org";

export async function getReleasePublishStatus({
  fetchImpl = fetch,
  packagePath = "package.json",
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GITHUB_TOKEN,
} = {}) {
  if (!repository || !token) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
  }

  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const { name, version } = packageJson;
  const tag = `v${version}`;

  const releaseUrl = `${githubApiUrl}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
  const releaseResponse = await fetchImpl(releaseUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (releaseResponse.status === 404) {
    return { name, version, tag, shouldPublish: false };
  }
  if (!releaseResponse.ok) {
    throw new Error(`GitHub release lookup failed with ${releaseResponse.status}`);
  }

  const packageUrl = `${npmRegistryUrl.replace(/\/$/, "")}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const packageResponse = await fetchImpl(packageUrl);

  if (packageResponse.status === 404) {
    return { name, version, tag, shouldPublish: true };
  }
  if (!packageResponse.ok) {
    throw new Error(`npm package lookup failed with ${packageResponse.status}`);
  }

  return { name, version, tag, shouldPublish: false };
}

async function main() {
  const status = await getReleasePublishStatus();
  const output = [
    `package=${status.name}`,
    `version=${status.version}`,
    `tag=${status.tag}`,
    `should-publish=${status.shouldPublish}`,
  ].join("\n");

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `${output}\n`);
  }

  console.log(output);
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
