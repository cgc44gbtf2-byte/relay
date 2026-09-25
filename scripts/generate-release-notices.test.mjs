import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyReleaseNotices } from "./generate-release-notices.mjs";

test("release notice verification checks output, artifact identity and completeness", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-notices-"));
  const notice = "Third-party license text\n";
  const manifest = {
    artifact: "web",
    noticeSha256: createHash("sha256").update(notice).digest("hex"),
    packages: [{
      name: "example",
      version: "1.0.0",
      files: [{ name: "LICENSE", sha256: "example" }],
      missingText: false,
    }],
  };
  try {
    await assert.rejects(verifyReleaseNotices(directory, "web"), /ENOENT/);
    await writeFile(path.join(directory, "THIRD-PARTY-NOTICES.txt"), notice);
    await writeFile(path.join(directory, "THIRD-PARTY-NOTICES.json"), JSON.stringify(manifest));
    await verifyReleaseNotices(directory, "web");
    await assert.rejects(verifyReleaseNotices(directory, "api"), /corrupted, or for another artifact/);
    manifest.packages[0].files = [];
    await writeFile(path.join(directory, "THIRD-PARTY-NOTICES.json"), JSON.stringify(manifest));
    await assert.rejects(verifyReleaseNotices(directory, "web"), /incomplete/);
    await writeFile(path.join(directory, "THIRD-PARTY-NOTICES.txt"), "altered\n");
    await assert.rejects(verifyReleaseNotices(directory, "web"), /corrupted/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});