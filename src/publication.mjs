import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Publish a complete validated artifact set with rollback on failed rename.
 * Readers should consider the receipt (published last) the commit marker.
 * This is failure-atomic for a single writer, not a multi-file FS transaction.
 */
export async function publishArtifacts(records, options = {}) {
  const rename = options.rename || fs.rename;
  const token = randomUUID();
  const tasks = [];
  const seen = new Set();
  let committed = false;
  try {
    for (const [index, record] of records.entries()) {
      const dest = path.resolve(record.path);
      const unique = process.platform === "win32" ? dest.toLowerCase() : dest;
      if (seen.has(unique)) throw new Error(`Duplicate artifact destination: ${dest}`);
      seen.add(unique);
      const dir = path.dirname(dest);
      await fs.mkdir(dir, { recursive: true });
      const temporary = path.join(dir, `.${path.basename(dest)}.essemble-${token}-${index}.tmp`);
      const backup = path.join(dir, `.${path.basename(dest)}.essemble-${token}-${index}.bak`);
      const state = { dest, temporary, backup, backedUp: false, published: false };
      tasks.push(state);
      await fs.writeFile(temporary, record.bytes, { flag: "wx" });
      try {
        const existing = await fs.lstat(dest);
        if (!existing.isFile()) throw new Error(`Artifact destination is not a regular file: ${dest}`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    for (const task of tasks) {
      try {
        await fs.lstat(task.dest);
        await rename(task.dest, task.backup);
        task.backedUp = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await rename(task.temporary, task.dest);
      task.published = true;
    }
    committed = true;
  } catch (error) {
    const rollbackFailures = [];
    for (const task of [...tasks].reverse()) {
      try {
        if (task.published) await fs.rm(task.dest);
        if (task.backedUp) await fs.rename(task.backup, task.dest);
      } catch (rollbackError) {
        rollbackFailures.push(`${task.dest}: ${rollbackError.message}`);
      }
    }
    if (rollbackFailures.length) {
      throw new AggregateError([error, ...rollbackFailures.map((m) => new Error(m))],
        "Artifact publication failed and rollback was incomplete; inspect backup artifacts");
    }
    throw error;
  } finally {
    for (const task of tasks) {
      await fs.rm(task.temporary, { force: true }).catch(() => {});
      // Preserve a backup after a failed rollback for manual recovery.
      if (committed) await fs.rm(task.backup, { force: true }).catch(() => {});
    }
  }
}