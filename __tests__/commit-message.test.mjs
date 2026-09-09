import assert from "node:assert/strict";
import test from "node:test";

import { validateCommitMessage } from "../scripts/validate-commit-message.mjs";

const validSubjects = [
  "fix: preserve alias identity",
  "feat(config): support comments",
  "feat!: remove legacy settings",
  "refactor(config)!: change the schema",
  "deps: update runtime dependencies",
  "chore: refresh fixtures",
  "Merge pull request #12 from example/branch",
  "Revert \"feat: remove legacy settings\"",
  "fixup! fix: preserve alias identity",
];

for (const subject of validSubjects) {
  test(`accepts ${subject}`, () => {
    assert.equal(validateCommitMessage(`${subject}\n`), undefined);
  });
}

test("accepts a breaking change footer", () => {
  const message = [
    "feat: replace legacy settings",
    "",
    "BREAKING CHANGE: callers must use the new schema.",
  ].join("\n");

  assert.equal(validateCommitMessage(message), undefined);
});

test("ignores Git comment lines", () => {
  const message = "# generated comment\nfix: preserve alias identity\n";

  assert.equal(validateCommitMessage(message), undefined);
});

const invalidMessages = [
  ["empty message", ""],
  ["missing type", "preserve alias identity"],
  ["missing description", "fix:"],
  ["missing separator", "fix preserve alias identity"],
  ["uppercase type", "Fix: preserve alias identity"],
  ["empty scope", "fix(): preserve alias identity"],
];

for (const [name, message] of invalidMessages) {
  test(`rejects ${name}`, () => {
    assert.match(validateCommitMessage(message), /subject|message/);
  });
}
