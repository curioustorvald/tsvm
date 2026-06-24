// harness/test/t_io.mjs -- console output capture, con.* cursor ops, the
// \x84..u emit-char escape, input queue.

import { createVM, makeT } from "../index.mjs"

export function run() {
    const t = makeT("io")
    const vm = createVM({ tvdos: false })
    const { con } = vm.sandbox

    // ---- print / println capture ----
    vm.eval(`print("hello "); println("world")`)
    t.eq(vm.outputText(), "hello world\n", "print/println captured")
    t.contains(vm.output, "world", "raw output contains text")

    // ---- screenText reflects the grid ----
    t.eq(vm.screenText(), "hello world", "screenText row 0")

    // ---- con cursor move is 1-based and round-trips ----
    vm.eval(`con.move(5, 10)`)
    const yx = vm.eval(`con.getyx()`)
    t.eq(yx[0], 5, "con.getyx row (1-based)")
    t.eq(yx[1], 10, "con.getyx col (1-based)")

    // ---- con.getmaxyx == [rows, cols] = [32, 80] ----
    const max = vm.eval(`con.getmaxyx()`)
    t.eq(max[0], 32, "term rows")
    t.eq(max[1], 80, "term cols")

    // ---- con.clear ----
    vm.eval(`con.clear()`)
    t.eq(vm.screenText(), "", "con.clear empties the screen")

    // ---- the \x84<decimal>u emit-char escape (con.prnch) ----
    vm.clearOutput()
    vm.eval(`con.prnch(65); con.prnch(66)`) // 'A','B'
    t.eq(vm.outputText(), "AB", "con.prnch emits chars via the \\x84 escape")

    // ---- SGR colour codes are swallowed from the visible text ----
    vm.clearOutput()
    vm.eval(`print("\\x1B[31mRED\\x1B[m")`)
    t.eq(vm.outputText(), "RED", "CSI SGR stripped from outputText")

    // ---- input queue feeds con.getch / sys.read ----
    vm.feedKeys([72]) // 'H'
    t.eq(vm.eval(`con.getch()`), 72, "con.getch pulls from the input queue")
    vm.feedLine("test")
    t.eq(vm.eval(`read()`), "test", "read() collects a line until Enter")

    vm.dispose()
    return t.report()
}
