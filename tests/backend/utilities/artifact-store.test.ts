import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ArtifactPathError, ArtifactStore } from "../../../backend/src/utilities/services/artifact-store";
import { withTempDir } from "../helpers/test-context";

async function withStore<T>(fn: (store: ArtifactStore, dataDir: string) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const dataDir = path.join(dir, "data");
    const store = new ArtifactStore(dataDir);
    await store.ensureRoots();
    return fn(store, dataDir);
  });
}

test("ArtifactStore path builders produce the 00 §4 layout", () => {
  const store = new ArtifactStore("/data");
  assert.equal(store.artifactsRoot(), "/data/artifacts");
  assert.equal(store.worktreesRoot(), "/data/worktrees");
  assert.equal(store.fixturesRoot(), "/data/fixtures");
  assert.equal(store.visualizationArtifactsDir(12), "/data/artifacts/12");
  assert.equal(store.visualizationWorktreeRoot(12), "/data/worktrees/12");
  assert.equal(store.worktreeDir(12, "base"), "/data/worktrees/12/base");
  assert.equal(store.worktreeDir(12, "head"), "/data/worktrees/12/head");
});

test("ArtifactStore.componentImagePath returns POSIX relative artifacts/<v>/<c>/<kind>.png", () => {
  const store = new ArtifactStore("/data");
  assert.equal(store.componentImagePath(12, 345, "base"), "artifacts/12/345/base.png");
  assert.equal(store.componentImagePath(12, 345, "diff"), "artifacts/12/345/diff.png");
  assert.ok(!path.isAbsolute(store.componentImagePath(1, 2, "head")));
});

test("ArtifactStore.componentDir is absolute under artifacts", () => {
  assert.equal(new ArtifactStore("/data").componentDir(12, 345), "/data/artifacts/12/345");
});

test("ArtifactStore rejects non-positive ids and a relative data dir", () => {
  const store = new ArtifactStore("/data");
  for (const id of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => store.componentImagePath(id, 1, "base"), ArtifactPathError);
    assert.throws(() => store.componentDir(1, id), ArtifactPathError);
    assert.throws(() => store.visualizationWorktreeRoot(id), ArtifactPathError);
  }
  assert.throws(() => new ArtifactStore("relative/dir"), ArtifactPathError);
});

test("ArtifactStore.resolveSafe rejects absolute, NUL, backslash and ../ escapes", async () => {
  await withStore((store, dataDir) => {
    assert.equal(store.resolveSafe("artifacts/1/2/base.png"), path.join(dataDir, "artifacts/1/2/base.png"));
    for (const bad of ["/etc/passwd", "artifacts/1/\0x", "artifacts\\1", "../outside", "artifacts/../../x", ""]) {
      assert.throws(() => store.resolveSafe(bad), ArtifactPathError, `must reject ${JSON.stringify(bad)}`);
    }
    return Promise.resolve();
  });
});

test("ArtifactStore.resolveSafe rejects a symlink inside the artifacts root that points outside it", async () => {
  await withTempDir(async (outside) => {
    await withStore(async (store, dataDir) => {
      await fs.mkdir(path.join(dataDir, "artifacts", "5"), { recursive: true });
      await fs.symlink(outside, path.join(dataDir, "artifacts", "5", "6"));
      assert.throws(() => store.resolveSafe("artifacts/5/6/base.png"), ArtifactPathError);
      await assert.rejects(store.write("artifacts/5/6/base.png", Buffer.from("x")), ArtifactPathError);
      assert.deepEqual(await fs.readdir(outside), []);
    });
  });
});

test("ArtifactStore.write is atomic, creates parents and returns the relative path; read returns the bytes", async () => {
  await withStore(async (store, dataDir) => {
    const relative = store.componentImagePath(3, 4, "head");
    assert.equal(await store.write(relative, Buffer.from([1, 2, 3])), relative);
    assert.deepEqual(await store.read(relative), Buffer.from([1, 2, 3]));
    await store.write(relative, Buffer.from([9]));
    assert.deepEqual(await store.read(relative), Buffer.from([9]));
    assert.deepEqual(await fs.readdir(path.join(dataDir, "artifacts/3/4")), ["head.png"]); // no temp files left
    assert.equal(await store.exists(relative), true);
    assert.equal(await store.exists("artifacts/3/4/base.png"), false);
    await assert.rejects(
      store.read("artifacts/3/4/base.png"),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT"
    );
  });
});

test("ArtifactStore.ensureComponentDir creates the folder", async () => {
  await withStore(async (store) => {
    await store.ensureComponentDir(7, 8);
    assert.ok((await fs.stat(store.componentDir(7, 8))).isDirectory());
  });
});

test("ArtifactStore.ensureRoots creates the data dir with mode 0700", async () => {
  await withStore(async (store, dataDir) => {
    assert.equal((await fs.stat(dataDir)).mode & 0o777, 0o700);
    assert.ok((await fs.stat(store.worktreesRoot())).isDirectory());
  });
});

test("ArtifactStore.removeVisualization tolerates missing dirs and does not follow a symlink", async () => {
  await withTempDir(async (outside) => {
    await fs.writeFile(path.join(outside, "keep.txt"), "keep");
    await withStore(async (store) => {
      await store.removeVisualization(99);
      await store.write(store.componentImagePath(9, 1, "base"), Buffer.from("png"));
      await fs.symlink(outside, path.join(store.visualizationArtifactsDir(9), "link"));
      await store.removeVisualization(9);
      await assert.rejects(fs.access(store.visualizationArtifactsDir(9)));
      assert.equal(await fs.readFile(path.join(outside, "keep.txt"), "utf8"), "keep");
    });
  });
});

test("ArtifactStore.removeVisualizationArtifacts is the same operation", async () => {
  await withStore(async (store) => {
    await store.write(store.componentImagePath(10, 1, "diff"), Buffer.from("png"));
    // Called through Reflect: the alias is @deprecated and no-deprecated flags direct calls (00 §14.12).
    const alias: (visualizationId: number) => Promise<void> = Reflect.get(store, "removeVisualizationArtifacts");
    await alias.call(store, 10);
    await assert.rejects(fs.access(store.visualizationArtifactsDir(10)));
  });
});

test("ArtifactStore.ensureDir and removeVisualizationWorktreeRoot stay inside the data dir", async () => {
  await withStore(async (store) => {
    await store.ensureDir(store.worktreeDir(4, "base"));
    await assert.rejects(store.ensureDir("/tmp/prvision-elsewhere"), ArtifactPathError);
    await store.removeVisualizationWorktreeRoot(4);
    await assert.rejects(fs.access(store.visualizationWorktreeRoot(4)));
  });
});

test("ArtifactStore.toPublicUrl maps relative paths and rejects others", () => {
  const store = new ArtifactStore("/data");
  assert.equal(store.toPublicUrl("artifacts/12/345/base.png"), "/artifacts/12/345/base.png");
  assert.equal(store.toPublicUrl(null), null);
  for (const bad of [
    "/abs/artifacts/1/2/base.png",
    "artifacts/1/2/base.txt",
    "artifacts/0/2/base.png",
    "artifacts/1/2/../x.png",
    "worktrees/1/base"
  ]) {
    assert.throws(() => store.toPublicUrl(bad), ArtifactPathError);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Sheet 16 §6.14: state image paths
// ---------------------------------------------------------------------------------------------------------------

test("ArtifactStore.componentStateImagePath: ordinal 0 keeps the component path, 1–9 use s<ordinal>/", () => {
  const store = new ArtifactStore("/data");
  assert.equal(store.componentStateImagePath(12, 345, 0, "base"), "artifacts/12/345/base.png");
  assert.equal(store.componentStateImagePath(12, 345, 0, "diff"), store.componentImagePath(12, 345, "diff"));
  assert.equal(store.componentStateImagePath(12, 345, 1, "head"), "artifacts/12/345/s1/head.png");
  assert.equal(store.componentStateImagePath(12, 345, 9, "diff"), "artifacts/12/345/s9/diff.png");
});

test("ArtifactStore.componentStateImagePath rejects ordinals outside 0–9 and invalid ids", () => {
  const store = new ArtifactStore("/data");
  for (const ordinal of [10, -1, 1.5, Number.NaN]) {
    assert.throws(() => store.componentStateImagePath(12, 345, ordinal, "base"), ArtifactPathError, String(ordinal));
  }
  assert.throws(() => store.componentStateImagePath(0, 345, 1, "base"), ArtifactPathError);
  assert.throws(() => store.componentStateImagePath(12, 345, 1, "other" as "base"), ArtifactPathError);
});

test("ArtifactStore.ensureComponentStateDir creates the component dir and its s<ordinal> folder", async () => {
  await withStore(async (store) => {
    await store.ensureComponentStateDir(3, 4, 0);
    assert.ok((await fs.stat(store.componentDir(3, 4))).isDirectory());
    await assert.rejects(fs.access(path.join(store.componentDir(3, 4), "s0")));
    await store.ensureComponentStateDir(3, 4, 2);
    assert.ok((await fs.stat(path.join(store.componentDir(3, 4), "s2"))).isDirectory());
    await assert.rejects(store.ensureComponentStateDir(3, 4, 10), ArtifactPathError);
    // A state image round-trips through write/read at the relative path.
    const relative = store.componentStateImagePath(3, 4, 2, "head");
    await store.write(relative, "png");
    assert.equal((await store.read(relative)).toString(), "png");
  });
});

test("ArtifactStore.toPublicUrl and resolveSafe accept s<n> state paths and reject malformed or escaping ones", async () => {
  await withStore((store, dataDir) => {
    assert.equal(store.toPublicUrl("artifacts/12/345/s2/head.png"), "/artifacts/12/345/s2/head.png");
    assert.equal(store.toPublicUrl("artifacts/12/345/s9/diff.png"), "/artifacts/12/345/s9/diff.png");
    for (const bad of [
      "artifacts/12/345/s0/head.png",
      "artifacts/12/345/s10/head.png",
      "artifacts/12/345/s/head.png",
      "artifacts/12/345/s2/s3/head.png",
      "artifacts/12/345/x2/head.png",
      "artifacts/12/345/s2/../head.png",
      "artifacts/12/345/s2/head.jpg"
    ]) {
      assert.throws(() => store.toPublicUrl(bad), ArtifactPathError, bad);
    }
    assert.equal(store.resolveSafe("artifacts/12/345/s2/head.png"), path.join(dataDir, "artifacts/12/345/s2/head.png"));
    for (const escape of [
      "artifacts/12/345/s2/../../../../etc/passwd",
      "/artifacts/12/345/s2/head.png",
      "artifacts\\12\\s2"
    ]) {
      assert.throws(() => store.resolveSafe(escape), ArtifactPathError, escape);
    }
    return Promise.resolve();
  });
});
