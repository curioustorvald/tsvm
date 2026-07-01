// harness/test/t_taud.mjs -- LibTaud interrupt-note callback management
// (attachIntCallback / removeIntCallback / removeAllIntCallback / pollInterrupts).
//
// The engine latches Taud interrupt notes (Int0..IntF) in the adapter; the JS side
// drains the latch and dispatches callbacks. Here the latch is modelled by the
// harness audio stub: vm.fireTrackerInterrupt(playhead, intNum) sets a bit, and
// audio.pollTrackerInterrupts(playhead) drains it on read.

import { createVM, makeT } from "../index.mjs"

export function run() {
    const t = makeT("taud")
    const vm = createVM()
    const taud = vm.sandbox.require("A:/tvdos/include/taud.mjs")

    // helper to reset all registry + latch state between groups
    const reset = () => { taud.removeAllIntCallback(); vm.pendingTrackerInterrupts = {} }

    // ---- no callbacks: poll is a no-op, never touches hardware ----
    reset()
    vm.fireTrackerInterrupt(0, 3)               // staged, but nothing registered
    t.eq(taud.pollInterrupts(0), 0, "poll with no callbacks returns 0")
    t.eq(vm.pendingTrackerInterrupts[0] | 0, 1 << 3, "poll with no callbacks does NOT drain the latch")

    // ---- single callback fires once, with (intNum, playhead) ----
    reset()
    let calls = []
    taud.attachIntCallback(0, 0, (n, ph) => calls.push([n, ph]))
    vm.fireTrackerInterrupt(0, 0)
    const mask = taud.pollInterrupts(0)
    t.eq(mask, 0x0001, "poll returns the fired mask (Int0)")
    t.eq(calls.length, 1, "Int0 callback fired exactly once")
    t.eq(calls[0][0], 0, "callback got intNum 0")
    t.eq(calls[0][1], 0, "callback got playhead 0")

    // ---- latch is drained: a second poll without a new fire does nothing ----
    t.eq(taud.pollInterrupts(0), 0, "second poll returns 0 (latch drained)")
    t.eq(calls.length, 1, "callback not re-fired on the drained poll")

    // ---- multiple callbacks on one interrupt fire in registration order ----
    reset()
    let order = []
    taud.attachIntCallback(0, 5, () => order.push("a"))
    taud.attachIntCallback(0, 5, () => order.push("b"))
    vm.fireTrackerInterrupt(0, 5)
    taud.pollInterrupts(0)
    t.eq(order.join(","), "a,b", "two callbacks on Int5 fire in registration order")

    // ---- distinct interrupts dispatched in one poll ----
    reset()
    let hit = {}
    taud.attachIntCallback(0, 1, (n) => { hit[n] = (hit[n] || 0) + 1 })
    taud.attachIntCallback(0, 4, (n) => { hit[n] = (hit[n] || 0) + 1 })
    vm.fireTrackerInterrupt(0, 1)
    vm.fireTrackerInterrupt(0, 4)
    const m2 = taud.pollInterrupts(0)
    t.eq(m2, (1 << 1) | (1 << 4), "mask carries both Int1 and Int4")
    t.eq(hit[1], 1, "Int1 dispatched")
    t.eq(hit[4], 1, "Int4 dispatched")

    // ---- an interrupt with no callback is drained but dispatches nothing ----
    reset()
    let only2 = 0
    taud.attachIntCallback(0, 2, () => only2++)
    vm.fireTrackerInterrupt(0, 2)
    vm.fireTrackerInterrupt(0, 7)               // no callback for Int7
    const m3 = taud.pollInterrupts(0)
    t.eq(m3, (1 << 2) | (1 << 7), "mask reports both even though Int7 has no callback")
    t.eq(only2, 1, "only the Int2 callback fired")
    t.eq(vm.pendingTrackerInterrupts[0] | 0, 0, "whole latch drained once a callback exists on the playhead")

    // ---- per-playhead isolation ----
    reset()
    let phHits = []
    taud.attachIntCallback(0, 0, () => phHits.push(0))
    taud.attachIntCallback(1, 0, () => phHits.push(1))
    vm.fireTrackerInterrupt(1, 0)
    taud.pollInterrupts(0)                        // playhead 0 has nothing pending
    t.eq(phHits.length, 0, "firing on playhead 1 does not dispatch playhead 0")
    taud.pollInterrupts(1)
    t.eq(phHits.join(","), "1", "playhead 1 callback fired for its own interrupt")

    // ---- removeIntCallback removes exactly one callback ----
    reset()
    let aN = 0, bN = 0
    const cbA = () => aN++
    const cbB = () => bN++
    taud.attachIntCallback(0, 8, cbA)
    taud.attachIntCallback(0, 8, cbB)
    t.eq(taud.removeIntCallback(0, 8, cbA), true, "removeIntCallback returns true on hit")
    t.eq(taud.removeIntCallback(0, 8, cbA), false, "removeIntCallback returns false when already gone")
    vm.fireTrackerInterrupt(0, 8)
    taud.pollInterrupts(0)
    t.eq(aN, 0, "removed callback does not fire")
    t.eq(bN, 1, "surviving callback still fires")

    // ---- removeAllIntCallback(playhead, intNum) clears one slot ----
    reset()
    let slotN = 0, otherN = 0
    taud.attachIntCallback(0, 9, () => slotN++)
    taud.attachIntCallback(0, 10, () => otherN++)
    taud.removeAllIntCallback(0, 9)
    vm.fireTrackerInterrupt(0, 9)
    vm.fireTrackerInterrupt(0, 10)
    taud.pollInterrupts(0)
    t.eq(slotN, 0, "cleared Int9 slot does not fire")
    t.eq(otherN, 1, "untouched Int10 slot still fires")

    // ---- removeAllIntCallback(playhead) clears the playhead and stops draining ----
    reset()
    let anyN = 0
    taud.attachIntCallback(0, 0, () => anyN++)
    taud.removeAllIntCallback(0)
    vm.fireTrackerInterrupt(0, 0)
    t.eq(taud.pollInterrupts(0), 0, "after removeAll(playhead), poll returns 0")
    t.eq(vm.pendingTrackerInterrupts[0] | 0, 1, "and the latch is left untouched (no callbacks → no drain)")
    t.eq(anyN, 0, "no callback fires after playhead cleared")

    // ---- removeAllIntCallback() clears everything ----
    reset()
    let g0 = 0, g1 = 0
    taud.attachIntCallback(0, 0, () => g0++)
    taud.attachIntCallback(1, 0, () => g1++)
    taud.removeAllIntCallback()
    vm.fireTrackerInterrupt(0, 0)
    vm.fireTrackerInterrupt(1, 0)
    t.eq(taud.pollInterrupts(0) + taud.pollInterrupts(1), 0, "global clear: both playheads inert")
    t.eq(g0 + g1, 0, "no callbacks fire after global clear")

    // ---- stale latch is dropped on the FIRST attach for a playhead ----
    reset()
    let staleN = 0
    vm.fireTrackerInterrupt(0, 0)                 // fired BEFORE any callback exists
    taud.attachIntCallback(0, 0, () => staleN++)  // first attach drains the latch
    t.eq(vm.pendingTrackerInterrupts[0] | 0, 0, "first attach drained the pre-registration latch")
    t.eq(taud.pollInterrupts(0), 0, "no stale interrupt dispatched on next poll")
    t.eq(staleN, 0, "callback not triggered by a pre-registration fire")

    // ---- input validation ----
    reset()
    t.throws(() => taud.attachIntCallback(0, 0, 123), /function/, "attach rejects non-function")
    t.throws(() => taud.attachIntCallback(0, 16, () => {}), /range/, "attach rejects intNum 16")
    t.throws(() => taud.attachIntCallback(0, -1, () => {}), /range/, "attach rejects intNum -1")

    // ---- a throwing callback is isolated ----
    reset()
    let after = 0
    taud.attachIntCallback(0, 0, () => { throw new Error("boom") })
    taud.attachIntCallback(0, 0, () => after++)
    vm.fireTrackerInterrupt(0, 0)
    const safeMask = taud.pollInterrupts(0)
    t.eq(safeMask, 0x0001, "poll completes despite a throwing callback")
    t.eq(after, 1, "sibling callback still fires after one throws")

    vm.dispose()
    return t.report()
}
