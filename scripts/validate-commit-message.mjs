import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const conventionalTypes = [
  "build",
  "chore",
  "ci",
  "deps",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
];

const conventionalSubject = new RegExp(
  `^(${conventionalTypes.join("|")})(\\([^()]+\\))?!?: \\S.*$`,
);
const generatedSubject =
  /^(Merge (branch|pull request|remote-tracking)|Revert "|fixup! |squash! |amend! )/;

export function validateCommitMessage(message) {
  const subject = message
    .split(/\r?\n/)
    .find((line) => line && !line.startsWith("#"));

  if (!subject) {
    return "commit message must include a subject";
  }
  if (generatedSubject.test(subject) || conventionalSubject.test(subject)) {
    return undefined;
  }
  return "subject must use type(scope)!: description; scope and ! are optional";
}

async function main() {
  const messageFile = process.argv[2];
  if (!messageFile) {
    console.error("usage: validate-commit-message.mjs <message-file>");
    process.exitCode = 2;
    return;
  }

  const error = validateCommitMessage(await readFile(messageFile, "utf8"));
  if (error) {
    console.error(`commit-msg: ${error}`);
    console.error(
      "commit-msg: https://github.com/googleapis/release-please#how-should-i-write-my-commits",
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
