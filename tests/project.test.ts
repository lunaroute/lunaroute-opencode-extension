import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECT_FILE,
  PROJECT_HEADER,
  clearProject,
  defaultProjectIo,
  findProjectRoot,
  projectFilePath,
  projectHeaders,
  projectState,
  readProject,
  validateProjectName,
  writeProject,
  type ProjectIo,
} from "../src/project.js";

const ENC = new TextEncoder();
const ROOT = "/repo";

function fakeIo(over: Partial<ProjectIo> = {}): ProjectIo {
  return {
    readFileSync: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    writeFileSync: () => {},
    renameSync: () => {},
    randomUUID: () => "uuid-1",
    existsSync: () => true,
    unlinkSync: () => {},
    ...over,
  };
}

const bytesIo = (raw: string): ProjectIo => fakeIo({ readFileBytes: () => ENC.encode(raw) });

function recordingIo() {
  const writes: { path: string; data: string }[] = [];
  const renames: [string, string][] = [];
  const unlinks: string[] = [];
  const overrides = {
    writeFileSync: (path: string, data: string) => void writes.push({ path, data }),
    renameSync: (from: string, to: string) => void renames.push([from, to]),
    unlinkSync: (path: string) => void unlinks.push(path),
  };
  return { io: fakeIo(overrides), writes, renames, unlinks };
}

describe("constants", () => {
  it("names the file and header the pi extension shares", () => {
    expect(PROJECT_FILE).toBe(".lunaroute.json");
    expect(PROJECT_HEADER).toBe("LUNAROUTE-PROJECT-ID");
  });
});

describe("findProjectRoot", () => {
  it("stops at the nearest ancestor with a .git directory", () => {
    const root = mkdtempSync(join(tmpdir(), "lr-root-"));
    mkdirSync(join(root, ".git"));
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested, defaultProjectIo)).toBe(root);
  });

  it("treats .git as a file (worktrees, submodules)", () => {
    mkdirSync(join(tmpdir(), "lr-worktree-probe"), { recursive: true });
    const root = mkdtempSync(join(tmpdir(), "lr-worktree-"));
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    const io = fakeIo({ existsSync: (path: string) => path === join(root, ".git") });
    expect(findProjectRoot(join(root, "pkg", "deep"), io)).toBe(root);
  });

  it("falls back to the given directory when no .git exists", () => {
    const io = fakeIo({ existsSync: () => false });
    expect(findProjectRoot("/work/repo/a/b", io)).toBe("/work/repo/a/b");
  });
});

describe("readProject", () => {
  const failures: [string, ProjectIo][] = [
    ["missing file", fakeIo()],
    ["bad JSON", bytesIo("{not json")],
    ["json array", bytesIo("[]")],
    ["json null", bytesIo("null")],
    ["non-string project", bytesIo('{"project":42}')],
    ["missing project key", bytesIo("{}")],
    ["newline in name", bytesIo('{"project":"a\\nb"}')],
    ["braces in name", bytesIo('{"project":"{file:/etc/passwd}"}')],
    ["oversize name", bytesIo(`{"project":"${"a".repeat(4100)}"}`)],
    ["undecodable bytes", fakeIo({ readFileBytes: () => new Uint8Array([0x7b, 0xff, 0x7d]) })],
  ];

  it.each(failures)("is undefined for %s", (_label, io) => {
    expect(readProject(ROOT, io)).toBeUndefined();
  });

  it("returns a valid name, trimmed", () => {
    expect(readProject(ROOT, bytesIo('{"project":" lunaroute-web "}'))).toBe("lunaroute-web");
  });

  it("reads the same file through readFileSync when no byte reader is given", () => {
    expect(readProject(ROOT, fakeIo({ readFileSync: () => '{"project":"web"}' }))).toBe("web");
    expect(readProject(ROOT, fakeIo({ readFileSync: () => "x".repeat(4097) }))).toBeUndefined();
  });
});

describe("projectState", () => {
  it("reports a missing file and a cleared file as none", () => {
    expect(projectState(ROOT, fakeIo()).kind).toBe("none");
    expect(projectState(ROOT, bytesIo("{}\n")).kind).toBe("none");
    expect(projectState(ROOT, bytesIo('{"other":1}')).kind).toBe("none");
  });

  it("reports the value when one is set", () => {
    expect(projectState(ROOT, bytesIo('{"project":"lunaroute-web"}'))).toEqual({ kind: "set", name: "lunaroute-web" });
  });

  it("separates an unreadable or invalid file from a cleared one", () => {
    const invalid: ProjectIo[] = [
      bytesIo("{oops"),
      bytesIo("[]"),
      bytesIo('{"project":42}'),
      bytesIo('{"project":"{x}"}'),
      bytesIo('{"project":"clear"}'),
      bytesIo("x".repeat(4097)),
      fakeIo({ readFileBytes: () => new Uint8Array([0x7b, 0xff, 0x7d]) }),
      fakeIo({ readFileBytes: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } }),
    ];
    for (const io of invalid) expect(projectState(ROOT, io).kind, String(io)).toBe("invalid");
  });
});

describe("validateProjectName", () => {
  it("rejects empty, oversize, control, non-ASCII, reserved and braced names", () => {
    for (const raw of ["", "   ", "a".repeat(129), "a\nb", "héllo", "clear", "CLEAR", "off", "OFF", "{x}", "x}"]) {
      expect(validateProjectName(raw), raw).toMatchObject({ ok: false });
    }
  });

  it("accepts printable ASCII up to 128 characters, including $ and !", () => {
    for (const name of ["a".repeat(128), "my app", "$HOME", "!cmd", "lunaroute-web"]) {
      expect(validateProjectName(name), name).toEqual({ ok: true, name });
    }
    expect(validateProjectName("  web  ")).toEqual({ ok: true, name: "web" });
  });

  it("says why a name was refused", () => {
    const reserved = validateProjectName("clear");
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.reason).toContain("reserved");

    const braced = validateProjectName("{x}");
    expect(braced.ok).toBe(false);
    if (!braced.ok) expect(braced.reason).toContain("{");
  });
});

describe("writeProject / clearProject", () => {
  it("writes tmp then renames it onto <root>/.lunaroute.json", () => {
    const { io, writes, renames } = recordingIo();
    writeProject(ROOT, " lunaroute-web ", io);
    const tmp = join(ROOT, `${PROJECT_FILE}.uuid-1.tmp`);
    expect(writes).toEqual([{ path: tmp, data: '{\n  "project": "lunaroute-web"\n}\n' }]);
    expect(renames).toEqual([[tmp, projectFilePath(ROOT)]]);
  });

  it("validates before touching the disk", () => {
    const { io, writes } = recordingIo();
    expect(() => writeProject(ROOT, "clear", io)).toThrow(/reserved/);
    expect(() => writeProject(ROOT, "{x}", io)).toThrow(/\{/);
    expect(writes).toEqual([]);
  });

  it("unlinks the temp file and rethrows when the rename fails", () => {
    const { io, unlinks } = recordingIo();
    const boom = new Error("read-only file system");
    io.renameSync = () => {
      throw boom;
    };
    expect(() => writeProject(ROOT, "web", io)).toThrow(boom);
    expect(unlinks).toEqual([join(ROOT, `${PROJECT_FILE}.uuid-1.tmp`)]);
  });

  it("clears by writing an empty object", () => {
    const { io, writes } = recordingIo();
    clearProject(ROOT, io);
    expect(writes[0].data).toBe("{}\n");
  });
});

describe("projectHeaders", () => {
  it("is empty without a project or with an invalid one", () => {
    for (const value of [undefined, "", "clear", "a\nb", "{x}"]) {
      expect(projectHeaders(value), String(value)).toEqual({});
    }
  });

  it("emits the literal header pair", () => {
    expect(projectHeaders("lunaroute-web")).toEqual({ [PROJECT_HEADER]: "lunaroute-web" });
  });
});
