/**
 * TAUT File panel (in-process).
 *
 * Replaces the old taut_fileop.js sub-program. The File tab is now a normal
 * in-process panel: init(HUB) returns { drawContents, input }, wired into a
 * wintex WindowObject like the other panels. Tab / global keys are handled by
 * taut.js's main loop, so input() is a no-op for now.
 *
 * Still a placeholder UI — file load / save lands here later.
 * Converted from taut_fileop.js on 2026-06-21.
 */

function init(HUB) {
    const C = HUB.C
    const SCRW = C.SCRW, SCRH = C.SCRH
    const PANEL_Y = C.PTNVIEW_OFFSET_Y
    const colStatus = C.colStatus, colHdr = C.colVoiceHdr
    const colContent = 240

    function drawContents(wo) {
        for (let y = PANEL_Y; y < SCRH; y++) {
            con.move(y, 1)
            con.color_pair(colContent, 255)
            print(' '.repeat(SCRW))
        }
        con.move(PANEL_Y + 1, 3)
        con.color_pair(colHdr, 255)
        print('[ File ]')
        con.move(PANEL_Y + 3, 3)
        con.color_pair(colStatus, 255)
        print('(not yet implemented)')
    }

    // Main loop owns Tab and the global shortcuts; nothing panel-specific yet.
    function input(wo, event) {}

    return { drawContents, input }
}

exports = { init }
