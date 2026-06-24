// harness/index.mjs -- public API for the TSVM/TVDOS Node test harness.
//
//   import { createVM } from "./harness/index.mjs"
//   const vm = createVM()
//   vm.run(`println("hello from TSVM")`)
//   console.log(vm.outputText())   // "hello from TSVM\n"
//   vm.dispose()
//
// See harness/README.md for the full surface.

export { createVM } from "./lib/context.mjs"
export { makeT, runSuites } from "./lib/assert.mjs"
export { VMMemory } from "./lib/memory.mjs"
export { TTY } from "./lib/tty.mjs"
