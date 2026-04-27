/**
 * TAUT Instrument Editor
 * Sub-program launched by taut.js when the Instrmnt tab is active.
 * Rows 1-3 are owned by the parent; this program draws rows 4+.
 *
 * exec_args[1] = path to .taud file
 * Sets _G.taut_nextPanel before returning to request a panel switch.
 *
 * Created by minjaesong on 2026-04-27
 */

const win = require("wintex")

const PANEL_COUNT = 7
const MY_PANEL   = 4 // VIEW_INSTRMNT

const [SCRH, SCRW] = con.getmaxyx()
const PANEL_Y = 4
const PANEL_H = SCRH - PANEL_Y

const colStatus  = 253
const colContent = 240
const colHdr     = 230

function drawInstEditContents(wo) {
    for (let y = PANEL_Y; y < SCRH; y++) {
        con.move(y, 1)
        con.color_pair(colContent, 255)
        print(' '.repeat(SCRW))
    }
    con.move(PANEL_Y + 1, 3)
    con.color_pair(colHdr, 255)
    print('[ Instrument Editor ]')
    con.move(PANEL_Y + 3, 3)
    con.color_pair(colStatus, 255)
    print('placeholder — not yet implemented')
}

function drawHints() {
    con.move(SCRH, 1)
    con.color_pair(colStatus, 255)
    print(' '.repeat(SCRW - 1))
    con.move(SCRH, 1)
    con.color_pair(colHdr, 255); print('Tab ')
    con.color_pair(colStatus, 255); print('Panel')
}

function instEditInput(wo, event) {
    // placeholder — no interaction yet
}

const panel = new win.WindowObject(1, PANEL_Y, SCRW, PANEL_H, instEditInput, drawInstEditContents, undefined, ()=>{})

panel.drawContents()
drawHints()

let done = false
while (!done) {
    input.withEvent(event => {
        if (event[0] !== 'key_down') return
        const keysym     = event[1]
        const keyJustHit = (1 == event[2])
        const shiftDown  = (event.includes(59) || event.includes(60))

        if (!keyJustHit) return

        if (keysym === '<TAB>') {
            _G.taut_nextPanel = (MY_PANEL + (shiftDown ? -1 : 1) + PANEL_COUNT) % PANEL_COUNT
            done = true
            return
        }

        panel.processInput(event)
    })
}

return 0
