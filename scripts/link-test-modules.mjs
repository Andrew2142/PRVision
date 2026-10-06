// Links tests/node_modules -> backend/node_modules so files under tests/backend
// resolve backend dependencies (drizzle-orm, pg, pngjs, ...) by plain package name,
// both for Node at run time and for TypeScript at typecheck time.
import { lstat, readlink, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const linkPath = join(root, "tests", "node_modules");
const target = join("..", "backend", "node_modules");

async function main() {
  try {
    const stat = await lstat(linkPath);
    if (stat.isSymbolicLink() && (await readlink(linkPath)) === target) return;
    if (!stat.isSymbolicLink()) {
      console.error(
        `${linkPath} exists and is not a symlink; remove it and re-run.`,
      );
      process.exit(1);
    }
    await unlink(linkPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await symlink(target, linkPath, "dir");
  console.log(`Linked tests/node_modules -> ${target}`);
}

await main();
