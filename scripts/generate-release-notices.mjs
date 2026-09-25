import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateLicense } from "./dependency-license-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const noticeName = "THIRD-PARTY-NOTICES.txt";
const manifestName = "THIRD-PARTY-NOTICES.json";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function licenses(args) {
  return JSON.parse(execFileSync("pnpm", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  }));
}

async function installedPackages(report) {
  const packages = new Map();
  for (const [license, entries] of Object.entries(report)) {
    for (const entry of entries) {
      for (const location of entry.paths ?? []) {
        const directory = await realpath(location);
        const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
        if (metadata.name !== entry.name) {
          throw new Error(`License report does not match installed package: ${entry.name}`);
        }
        const key = `${metadata.name}@${metadata.version}`;
        if (packages.has(key) && packages.get(key).license !== license) {
          throw new Error(`Conflicting license expressions for ${key}`);
        }
        packages.set(key, {
          name: metadata.name,
          version: metadata.version,
          license,
          directory,
          repository: typeof metadata.repository === "string"
            ? metadata.repository
            : metadata.repository?.url ?? metadata.homepage ?? "",
        });
      }
    }
  }
  return [...packages.values()];
}

function within(directory, file) {
  return file === directory || file.startsWith(`${directory}${path.sep}`);
}

async function licenseTexts(pkg, all) {
  const names = (await readdir(pkg.directory)).filter((name) =>
    /^(?:licen[cs]e|copying|notice|patents)(?:[._-]|$)/i.test(name)
  ).sort();
  const files = [];
  for (const name of names) {
    const file = path.join(pkg.directory, name);
    if (!within(pkg.directory, await realpath(file))) {
      throw new Error(`License file escapes package directory: ${pkg.name}`);
    }
    const text = await readFile(file, "utf8");
    if (text.length > 300_000) {
      throw new Error(`Unusually large license text for ${pkg.name}`);
    }
    files.push({ name, text });
  }
  if (files.length) return files;

  // Some published tarballs keep the complete license in README instead of
  // a separate LICENSE. Only accept a full section, never a short SPDX label.
  const readme = (await readdir(pkg.directory)).find((name) => /^readme\.md$/i.test(name));
  if (readme) {
    const content = await readFile(path.join(pkg.directory, readme), "utf8");
    const heading = /^#{1,3} licen[cs]e[ \t]*$/im.exec(content);
    if (heading) {
      const remaining = content.slice(heading.index + heading[0].length);
      const nextHeading = remaining.search(/^#{1,3} /m);
      const text = (nextHeading < 0 ? remaining : remaining.slice(0, nextHeading)).trim();
      if (text.length > 400 && /copyright|public domain/i.test(text)) {
        files.push({ name: `${readme} (License section)`, text });
      }
    }
  }
  if (files.length) return files;

  // Exact, version-bound upstream sources for tarballs without license text.
  // Hashes ensure that an unrelated installed package cannot silently supply
  // different terms; there is no network dependency in a CI/release build.
  if ((pkg.name === "drizzle-orm" && pkg.version === "0.45.2")
    || (pkg.name === "drizzle-zod" && pkg.version === "0.8.3")) {
    const source = all.find((candidate) => candidate.name === "baseline-browser-mapping");
    if (!source) throw new Error("Pinned Apache-2.0 license source is not installed");
    const text = await readFile(path.join(source.directory, "LICENSE.txt"), "utf8");
    if (sha256(text) !== "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4") {
      throw new Error("Pinned Drizzle Apache-2.0 license text differs from upstream");
    }
    return [{
      name: "Apache-2.0 (https://github.com/drizzle-team/drizzle-orm/blob/0.45.2/LICENSE)",
      text,
    }];
  }
  if (pkg.name === "wouter" && pkg.version === "3.11.0") {
    const source = all.find((candidate) => candidate.name === "fast-sha256");
    if (!source) throw new Error("Pinned Unlicense text source is not installed");
    const text = (await readFile(path.join(source.directory, "LICENSE"), "utf8"))
      .replace("http://unlicense.org", "https://unlicense.org");
    if (sha256(text) !== "6b0382b16279f26ff69014300541967a356a666eb0b91b422f6862f6b7dad17e") {
      throw new Error("Pinned wouter Unlicense text differs from upstream");
    }
    return [{
      name: "Unlicense (https://github.com/molefrog/wouter/blob/v3.11.0/LICENSE)",
      text,
    }];
  }
  if (pkg.name === "standardwebhooks" && pkg.version === "1.1.1") {
    const text = await readFile(path.join(root, "scripts/release-license-sources/standardwebhooks-1.1.1.txt"), "utf8");
    if (sha256(`${text.trimEnd()}\n`) !== "5ec8c7b26b64d881a6706617bed25c049f97f2f35de034c756de8546fd6dbe27") {
      throw new Error("Pinned standardwebhooks MIT text differs from upstream");
    }
    return [{
      name: "MIT (https://github.com/standard-webhooks/standard-webhooks/blob/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/libraries/LICENSE)",
      text,
    }];
  }
  return files;
}

export async function writeReleaseNotices({ artifact, modulePaths, outputDir }) {
  if (!["api", "web"].includes(artifact)) throw new Error("Unknown release artifact");
  const all = await installedPackages(licenses(["licenses", "list", "--json"]));
  const production = await installedPackages(licenses([
    "--filter", artifact === "api" ? "@workspace/api-server" : "@workspace/web-irc",
    "licenses", "list", "--prod", "--json",
  ]));
  const normalizedInputs = await Promise.all(modulePaths
    .filter((file) => !file.startsWith("\0") && !file.startsWith("<"))
    .map(async (file) => {
      const resolved = path.resolve(root, file);
      return realpath(resolved).catch(() => resolved);
    }));
  const selected = new Map(production.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]));
  for (const input of normalizedInputs) {
    const match = all.find((pkg) => within(pkg.directory, input));
    if (match) selected.set(`${match.name}@${match.version}`, match);
    else if (input.includes(`${path.sep}node_modules${path.sep}`)) {
      throw new Error(`Bundled package missing from installed license report: ${input}`);
    }
  }

  const packages = [];
  const sections = [
    `Third-party notices for ${artifact === "api" ? "Relay API" : "Relay web"} build`,
    "Generated from the installed dependency graph and bundler inputs.",
    "Includes runtime-reachable packages conservatively, even if not all are emitted.",
    "This is technical evidence, not legal approval or a source-code offer.",
  ];
  for (const pkg of [...selected.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  )) {
    if (!evaluateLicense(pkg.license).allowed) {
      throw new Error(`Unreviewed license expression: ${pkg.name}@${pkg.version}: ${pkg.license}`);
    }
    const files = await licenseTexts(pkg, all);
    const record = {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      repository: pkg.repository,
      files: files.map(({ name, text }) => ({ name, sha256: sha256(text) })),
      missingText: files.length === 0,
    };
    packages.push(record);
    sections.push(
      "",
      "=".repeat(72),
      `${pkg.name}@${pkg.version} | ${pkg.license}`,
      `Source: ${pkg.repository || "not specified in package metadata"}`,
    );
    if (!files.length) {
      sections.push("MISSING LICENSE TEXT: obtain authoritative package license/notice text before distribution.");
    }
    for (const { name, text } of files) sections.push(`--- ${name} ---`, text.trimEnd());
  }
  const notice = `${sections.join("\n")}\n`;
  const manifest = {
    artifact,
    noticeSha256: sha256(notice),
    packages,
  };
  await writeFile(path.join(outputDir, noticeName), notice);
  await writeFile(path.join(outputDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Generated ${artifact} notices for ${packages.length} packages (${packages.filter((pkg) => pkg.missingText).length} missing texts).`);
  return manifest;
}

export async function verifyReleaseNotices(outputDir, artifact) {
  const manifest = JSON.parse(await readFile(path.join(outputDir, manifestName), "utf8"));
  const notice = await readFile(path.join(outputDir, noticeName), "utf8");
  if (manifest.artifact !== artifact || manifest.noticeSha256 !== sha256(notice)
    || !Array.isArray(manifest.packages) || manifest.packages.length === 0) {
    throw new Error(`${artifact} notice bundle is absent, corrupted, or for another artifact`);
  }
  const missing = manifest.packages.filter((pkg) =>
    pkg.missingText || !Array.isArray(pkg.files) || pkg.files.length === 0
  );
  if (missing.length) {
    throw new Error(`${artifact} notice bundle is incomplete; missing authoritative texts for: ${
      missing.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")
    }`);
  }
  console.log(`Verified ${artifact} notice bundle (${manifest.packages.length} packages).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, artifact, source] = process.argv.slice(2);
    if (operation === "web" && artifact) {
      const inputs = JSON.parse(await readFile(artifact, "utf8"));
      await writeReleaseNotices({
        artifact: "web",
        modulePaths: inputs,
        outputDir: path.dirname(artifact),
      });
      await unlink(artifact);
    } else if (operation === "verify") {
      if (artifact !== "api" && artifact !== "web") throw new Error("Unknown artifact");
      const outputDir = artifact === "api"
        ? path.join(root, "artifacts/api-server/dist")
        : path.join(root, "artifacts/web-irc/dist/public");
      await verifyReleaseNotices(outputDir, artifact);
    } else {
      throw new Error("Usage: generate-release-notices.mjs web <input-file> | verify <api|web>");
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}