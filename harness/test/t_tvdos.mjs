// harness/test/t_tvdos.mjs -- TVDOS userland: path resolution, real-disk reads,
// copy-on-write overlay (the repo is never mutated), require(), and modules
// seeing host globals.

import fs from "node:fs"
import path from "node:path"
import { createVM, makeT } from "../index.mjs"

export function run() {
    const t = makeT("tvdos")
    const vm = createVM()
    const { files, _G, _TVDOS } = vm.sandbox

    // ---- resolvePathInput ----
    const r1 = _G.shell.resolvePathInput("foo/bar")
    t.eq(r1.full, "A:\\foo\\bar", "resolvePathInput from root")
    const r2 = _G.shell.resolvePathInput("A:/a/b/../c")
    t.eq(r2.full, "A:\\a\\c", "resolvePathInput resolves ..")
    t.eq(_TVDOS.variables.OS_NAME, "TSVM Disk Operating System", "_TVDOS.variables seeded")

    // ---- read a real disk0 file ----
    const cmd = files.open("A:/tvdos/bin/command.js")
    t.ok(cmd.exists, "real disk file exists")
    t.ok(cmd.size > 0, "real disk file has a size")
    t.contains(cmd.sread(), "shell", "real disk file content readable")
    t.eq(cmd.extension, "js", "descriptor.extension")
    t.eq(cmd.name, "command.js", "descriptor.name")

    // ---- directory listing ----
    const bin = files.open("A:/tvdos/bin")
    t.ok(bin.isDirectory, "directory recognised")
    const listed = bin.list().map((f) => f.name)
    t.ok(listed.includes("command.js"), "list() includes command.js")

    // ---- write goes to the overlay, NOT the real disk ----
    const tmp = files.open("A:/__harness_probe__.txt")
    tmp.swrite("hello overlay")
    t.eq(files.open("A:/__harness_probe__.txt").sread(), "hello overlay", "overlay write/read round-trip")
    const realProbe = path.join(vm.opts.diskRoot, "__harness_probe__.txt")
    t.ok(!fs.existsSync(realProbe), "real disk0 is NOT mutated by the write")

    // ---- pwrite / pread through VM memory ----
    const { sys } = vm.sandbox
    for (let i = 0; i < 4; i++) sys.poke(7000 + i, 0x40 + i) // @ABC
    const bin2 = files.open("A:/__harness_bin__.dat")
    bin2.pwrite(7000, 4, 0)
    files.open("A:/__harness_bin__.dat").pread(8000, 4, 0)
    t.eq(sys.peek(8001), 0x41, "pwrite then pread round-trips through memory")

    // ---- require a module written to the overlay; module sees host globals ----
    const mod = files.open("A:/__harness_mod__.js")
    mod.swrite("exports.add = (a,b) => a+b; exports.zlen = gzip.comp('x'.repeat(99)).length")
    const m = vm.sandbox.require("A:/__harness_mod__.js")
    t.eq(m.add(2, 3), 5, "require()'d module function works")
    t.ok(m.zlen > 0 && m.zlen < 99, "module can use host globals (gzip)")
    t.throws(() => { m.add = 1 }, undefined, "require() returns a frozen exports object")

    vm.dispose()
    return t.report()
}
