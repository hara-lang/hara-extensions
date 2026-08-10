import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const nodeFileSystem = Object.freeze({
  resolve(path) {
    return resolve(String(path));
  },

  async read(path) {
    try {
      return new Uint8Array(await readFile(path));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  },

  async writeAtomic(path, bytes) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(temporary, bytes);
      const file = await open(temporary, "r");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      try {
        const directory = await open(dirname(path), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (_) {
        // Some platforms do not support directory fsync. The atomic rename
        // still prevents a partially-written database image.
      }
    } catch (error) {
      try {
        await unlink(temporary);
      } catch (_) {
        // The temporary may already have been renamed or may not exist.
      }
      throw error;
    }
  }
});
