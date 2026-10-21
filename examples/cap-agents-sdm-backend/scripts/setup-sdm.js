import cds from "@sap/cds";
import { getServiceBinding, serviceToken } from "@sap-cloud-sdk/connectivity";
import { SapCloudSdkCmisClient } from "@mi8y/cap-agents-sdm-backend";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

class SetupError extends Error {}

const seedDirectory = fileURLToPath(new URL("../seed/", import.meta.url));
const statusOf = (error) => error?.response?.status ?? error?.status;

// Setup uses a technical token; agent requests continue to use user JWT exchange.
export async function setupDestination({
  binding = getServiceBinding("sdm"),
  tokenProvider = serviceToken,
} = {}) {
  const { uri, uaa } = binding?.credentials ?? {};
  if (!uri || !uaa?.url || !uaa?.clientid || !uaa?.clientsecret) {
    throw new SetupError(
      "SDM binding missing or incomplete. Run through cds bind --exec.",
    );
  }
  try {
    const token = await tokenProvider({ ...binding, credentials: uaa });
    return {
      url: uri,
      authentication: "NoAuthentication",
      headers: { Authorization: `Bearer ${token}` },
    };
  } catch {
    throw new SetupError(
      "SDM setup authentication failed. Check the bound service key.",
    );
  }
}

export async function seedRepository(
  client,
  { directory = seedDirectory, overwrite = false, log = console.log } = {},
) {
  async function operation(label, repositoryPath, action) {
    try {
      return await action();
    } catch (error) {
      const status = statusOf(error);
      throw new SetupError(
        `${label} failed: ${repositoryPath}${status ? ` (HTTP ${status})` : ""}`,
      );
    }
  }

  async function existing(repositoryPath) {
    try {
      return (await client.getObject(repositoryPath)).data;
    } catch (error) {
      if (statusOf(error) === 404) return undefined;
      throw error;
    }
  }

  const typeOf = (object) => object?.succinctProperties?.["cmis:baseTypeId"];

  async function folder(repositoryPath) {
    await operation("Folder setup", repositoryPath, async () => {
      const object = await existing(repositoryPath);
      if (object) {
        if (typeOf(object) !== "cmis:folder")
          throw new SetupError("Expected folder");
        log(`Skipped folder ${repositoryPath}`);
      } else {
        await client.createFolder(repositoryPath);
        log(`Created folder ${repositoryPath}`);
      }
    });
  }

  async function upload(localPath, repositoryPath) {
    await operation("Upload", repositoryPath, async () => {
      const object = await existing(repositoryPath);
      if (object && typeOf(object) !== "cmis:document")
        throw new SetupError("Expected document");
      if (object && !overwrite) {
        log(`Skipped ${repositoryPath}`);
        return;
      }
      const content = new Blob([await readFile(localPath)], {
        type: repositoryPath.endsWith(".txt") ? "text/plain" : "text/markdown",
      });
      if (object) {
        await client.setContentStream(
          repositoryPath,
          content,
          object.succinctProperties["cmis:changeToken"],
        );
      } else {
        await client.createDocument(repositoryPath, content);
      }
      log(`${object ? "Replaced" : "Created"} ${repositoryPath}`);
    });
  }

  async function walk(localDirectory, repositoryDirectory) {
    const entries = await readdir(localDirectory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const localPath = path.join(localDirectory, entry.name);
      const repositoryPath = path.posix.join(repositoryDirectory, entry.name);
      if (entry.isDirectory()) {
        await folder(repositoryPath);
        await walk(localPath, repositoryPath);
      } else if (entry.isFile()) {
        await upload(localPath, repositoryPath);
      } else {
        throw new SetupError(`Unsupported seed entry: ${entry.name}`);
      }
    }
  }

  await folder("/report");
  await walk(directory, "/");
}

export async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== "--overwrite")) {
    throw new SetupError("Usage: pnpm setup:sdm [--overwrite]");
  }
  const repositoryId = cds.env.requires.sdm?.settings?.repositoryId;
  if (!repositoryId)
    throw new SetupError("Set cds.requires.sdm.settings.repositoryId.");
  const destination = await setupDestination();
  const client = new SapCloudSdkCmisClient({ repositoryId, destination });
  await seedRepository(client, { overwrite: args.includes("--overwrite") });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    // Only messages raised above are exposed; SDK errors can contain credentials.
    console.error(
      error instanceof SetupError
        ? error.message
        : "SDM setup failed. Check bindings, repository access, and seed files.",
    );
    process.exitCode = 1;
  });
}
