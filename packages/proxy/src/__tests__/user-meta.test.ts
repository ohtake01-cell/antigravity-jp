import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearProjectAssignmentsForProject,
  getProjectSettings,
  getUserMeta,
  invalidateUserMetaCache,
  setPinnedOverride,
  setProjectAssignment,
  updateProjectSettings,
} from "../user-meta.js";
import { expandHomePath } from "../routes/workspaces.js";

describe("user-meta store & project helpers", () => {
  let tmpDir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ag-jp-usermeta-"));
    prevEnv = process.env.PORTA_USER_META_FILE;
    process.env.PORTA_USER_META_FILE = join(tmpDir, "conversation-meta.json");
    invalidateUserMetaCache();
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.PORTA_USER_META_FILE;
    } else {
      process.env.PORTA_USER_META_FILE = prevEnv;
    }
    invalidateUserMetaCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists pinned overrides (including explicit unpin false) across cache reloads", async () => {
    await setPinnedOverride("conv-1", true);
    await setPinnedOverride("conv-2", false);

    invalidateUserMetaCache();
    const meta = await getUserMeta();
    expect(meta.pinnedOverrides["conv-1"]).toBe(true);
    expect(meta.pinnedOverrides["conv-2"]).toBe(false);

    await setPinnedOverride("conv-1", false);
    invalidateUserMetaCache();
    const afterUnpin = await getUserMeta();
    expect(afterUnpin.pinnedOverrides["conv-1"]).toBe(false);
  });

  it("assigns, unassigns, and cleans up conversation project assignments when a project is deleted", async () => {
    await setProjectAssignment("conv-a", "proj-1");
    await setProjectAssignment("conv-b", "proj-1");
    await setProjectAssignment("conv-c", "proj-2");

    invalidateUserMetaCache();
    let meta = await getUserMeta();
    expect(meta.projectAssignments).toEqual({
      "conv-a": "proj-1",
      "conv-b": "proj-1",
      "conv-c": "proj-2",
    });

    await setProjectAssignment("conv-a", null);
    meta = await getUserMeta();
    expect(meta.projectAssignments["conv-a"]).toBeUndefined();

    const removed = await clearProjectAssignmentsForProject("proj-1");
    expect(removed).toBe(1);
    invalidateUserMetaCache();
    meta = await getUserMeta();
    expect(meta.projectAssignments).toEqual({ "conv-c": "proj-2" });
  });

  it("persists defaultProjectFolder & createProjectSubfolder and expands tilde paths", async () => {
    const initial = await getProjectSettings();
    expect(initial).toEqual({
      defaultProjectFolder: "",
      createProjectSubfolder: false,
    });

    const updated = await updateProjectSettings({
      defaultProjectFolder: "~/Projects",
      createProjectSubfolder: true,
    });
    expect(updated).toEqual({
      defaultProjectFolder: "~/Projects",
      createProjectSubfolder: true,
    });

    invalidateUserMetaCache();
    const reloaded = await getProjectSettings();
    expect(reloaded).toEqual({
      defaultProjectFolder: "~/Projects",
      createProjectSubfolder: true,
    });

    expect(expandHomePath("~")).toBe(homedir());
    expect(expandHomePath("~/Projects/demo")).toBe(
      join(homedir(), "Projects/demo"),
    );
    expect(expandHomePath("/tmp/work")).toBe("/tmp/work");
  });
});
