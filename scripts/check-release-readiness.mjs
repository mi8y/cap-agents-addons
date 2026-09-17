import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadataOnly = process.argv.includes("--metadata-only");
const rootPackage = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const expectedRepository = normalizeRepository(rootPackage.repository?.url);
const registry = new URL(
  process.env.npm_config_registry ??
    process.env.NPM_CONFIG_REGISTRY ??
    "https://registry.npmjs.org/",
);

const packages = await findWorkspacePackages(rootPackage.workspaces ?? []);
const errors = [];
const publishable = [];

for (const { directory, manifest } of packages) {
  if (manifest.private) continue;

  const label = manifest.name ?? directory;
  if (!manifest.name) {
    errors.push(`${directory}: publishable package is missing a name`);
    continue;
  }

  if (manifest.publishConfig?.access !== "public") {
    errors.push(`${label}: publishConfig.access must be "public"`);
  }

  if (manifest.publishConfig?.provenance !== true) {
    errors.push(`${label}: publishConfig.provenance must be true`);
  }

  const repository = normalizeRepository(manifest.repository?.url);
  if (!repository || repository !== expectedRepository) {
    errors.push(
      `${label}: repository.url must match ${rootPackage.repository.url}`,
    );
  }

  publishable.push({ directory, manifest });
}

if (!metadataOnly) {
  const results = await Promise.all(
    publishable.map(async ({ directory, manifest }) => {
      const packageUrl = new URL(encodeURIComponent(manifest.name), registry);
      try {
        const response = await fetch(packageUrl, {
          headers: { accept: "application/json" },
        });
        return { directory, manifest, status: response.status };
      } catch (error) {
        return { directory, manifest, error };
      }
    }),
  );

  for (const { directory, manifest, status, error } of results) {
    if (error) {
      errors.push(
        `${manifest.name}: unable to query ${registry.origin}: ${error.message}`,
      );
    } else if (status === 404) {
      errors.push(
        `${manifest.name}: package does not exist on npm; bootstrap it before merging its first release (see docs/releasing.md)`,
      );
    } else if (status !== 200) {
      errors.push(
        `${manifest.name}: npm registry readiness check returned HTTP ${status} (${directory})`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error("Release readiness check failed:\n");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  const scope = metadataOnly
    ? "publish metadata"
    : "npm bootstrap and metadata";
  console.log(
    `Release readiness check passed (${scope}, ${publishable.length} packages).`,
  );
}

async function findWorkspacePackages(workspaces) {
  const result = [];

  for (const pattern of workspaces) {
    if (!pattern.endsWith("/*")) {
      throw new Error(`Unsupported workspace pattern: ${pattern}`);
    }

    const parent = join(root, pattern.slice(0, -2));
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(parent, entry.name);
      try {
        const manifest = JSON.parse(
          await readFile(join(directory, "package.json"), "utf8"),
        );
        result.push({ directory: directory.slice(root.length + 1), manifest });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  return result;
}

function normalizeRepository(repository) {
  if (typeof repository !== "string") return undefined;
  return repository
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}
