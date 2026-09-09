import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getReleasePublishStatus } from "../scripts/release-publish-status.mjs";

async function createPackage() {
  const directory = await mkdtemp(path.join(tmpdir(), "release-status-"));
  const packagePath = path.join(directory, "package.json");
  await writeFile(packagePath, JSON.stringify({ name: "example-package", version: "1.2.3" }));
  return packagePath;
}

function response(status) {
  return new Response(null, { status });
}

test("publishes a GitHub release missing from npm", async () => {
  const packagePath = await createPackage();
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return response(requests.length === 1 ? 200 : 404);
  };

  const status = await getReleasePublishStatus({
    fetchImpl,
    packagePath,
    repository: "owner/repository",
    token: "token",
  });

  assert.deepEqual(status, {
    name: "example-package",
    version: "1.2.3",
    tag: "v1.2.3",
    shouldPublish: true,
  });
  assert.deepEqual(requests, [
    "https://api.github.com/repos/owner/repository/releases/tags/v1.2.3",
    "https://registry.npmjs.org/example-package/1.2.3",
  ]);
});

test("skips a version already published to npm", async () => {
  const packagePath = await createPackage();
  const fetchImpl = async () => response(200);

  const status = await getReleasePublishStatus({
    fetchImpl,
    packagePath,
    repository: "owner/repository",
    token: "token",
  });

  assert.equal(status.shouldPublish, false);
});

test("skips a version without a GitHub release", async () => {
  const packagePath = await createPackage();
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    return response(404);
  };

  const status = await getReleasePublishStatus({
    fetchImpl,
    packagePath,
    repository: "owner/repository",
    token: "token",
  });

  assert.equal(status.shouldPublish, false);
  assert.equal(requestCount, 1);
});

test("requires GitHub repository and token settings", async () => {
  await assert.rejects(
    getReleasePublishStatus({ repository: "", token: "" }),
    /GITHUB_REPOSITORY and GITHUB_TOKEN are required/,
  );
});

test("fails closed when a GitHub lookup fails", async () => {
  const packagePath = await createPackage();
  const fetchImpl = async () => response(503);

  await assert.rejects(
    getReleasePublishStatus({
      fetchImpl,
      packagePath,
      repository: "owner/repository",
      token: "token",
    }),
    /GitHub release lookup failed with 503/,
  );
});

test("fails closed when a registry lookup fails", async () => {
  const packagePath = await createPackage();
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    return response(requestCount === 1 ? 200 : 503);
  };

  await assert.rejects(
    getReleasePublishStatus({
      fetchImpl,
      packagePath,
      repository: "owner/repository",
      token: "token",
    }),
    /npm package lookup failed with 503/,
  );
});
