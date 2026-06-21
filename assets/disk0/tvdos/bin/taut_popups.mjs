/**
 * TAUT popups module.
 *
 * In-process modal dialogs (help / go-to / retune / mixer-flags / confirm-quit)
 * plus the shared popup chrome (frame painter, colour palette, scrollbar glyphs).
 * Extracted from taut.js on 2026-06-21.
 *
 * These are pure UI: every engine-state mutation is delegated back through HUB
 * callbacks (HUB.applyGoto, HUB.retuneAllPatterns, HUB.commitMixerFlags, …), so
 * the engine keeps owning currentPanel / cueIdx / patternIdx / mixer flags / the
 * unsaved-changes flag. init(HUB) returns the dialog openers and the chrome (so
 * other in-process modules can reuse the same look). Read-only constants come in
 * via HUB.C; \uXXXX escapes are kept verbatim (TSVM's string parser is not Unicode).
 */

const win = require("wintex")

function init(HUB) {
    const C = HUB.C
    const sym = C.sym
    const PANEL_NAMES = C.PANEL_NAMES
    const pitchTablePresets = C.pitchTablePresets
    const colWHITE = C.colWHITE, colPopupBack = C.colPopupBack
    const colTabBarOrn = C.colTabBarOrn, colTabBarBack = C.colTabBarBack
    const colTabInactive = C.colTabInactive
    const colPan = C.colPan, colInst = C.colInst, colStatus = C.colStatus
    const colHighlight = C.colHighlight, colVoiceHdr = C.colVoiceHdr
    const HELP_CONTENT_W = C.HELP_CONTENT_W, HELP_CONTENT_H = C.HELP_CONTENT_H

    /////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // SHARED POPUP CHROME
    /////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // Custom window-frame painter passed to wintex showDialog as `drawFrame`.
    // Paints a title bar at the top row, then fills the rest of the popup with
    // `colPopupBack` (including the bottom row, so the spacing row below wintex's
    // button strip stays painted).
    const popupDrawFrame = (wo) => {
        // draw header
        con.move(wo.y, wo.x)
        con.color_pair(colTabBarOrn, colTabBarBack)
        print(`\u00FB`.repeat(wo.width))

        // imprint title
        let titleWidth = wo.title.length
        con.move(wo.y, wo.x + (((wo.width - titleWidth - 2) & 254) >>> 1))
        con.color_pair(colTabInactive, colTabBarBack); print(` ${wo.title} `)

        // fill content area (title row already painted above)
        for (let r = 1; r < wo.height; r++) {
            con.move(wo.y + r, wo.x)
            con.color_pair(230, colPopupBack)
            print(' '.repeat(wo.width))
        }
    }

    // Taut's charset carries dedicated scrollbar glyphs at 0xBA..0xBF (empty
    // top/mid/bottom caps 0xBA..0xBC, filled top/mid/bottom thumb 0xBD..0xBF).
    // wintex defaults to the CP437-safe 0xBA/0xDB pair, so pass these to every
    // list popup to render the scrollbar in taut's style.
    const popupScrollbarChars = [0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF]

    // Standard colour palette shared by every taut popup so wintex's defaults blend
    // with taut's popup chrome.
    const popupColours = {
        // fg:        colStatus,
        // bg:        colPopupBack,
        // fieldBg:   240,
        // dimFg:     colVoiceHdrMuted,
        // hlFg:      colWHITE,
        // focusBg:   colHighlight,
        // listBg:    colPopupBack,
        // listSelBg: colHighlight,
    }

    /////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // HELP POPUP
    /////////////////////////////////////////////////////////////////////////////////////////////////////////////

    function openHelpPopup() {
        const currentPanel = HUB.getPanel()
        const helpmsg = HUB.help || {}
        const lines   = (helpmsg.MSG_BY_TABS && helpmsg.MSG_BY_TABS[currentPanel]) || ['']
        const colText = helpmsg.COL_TEXT || colWHITE

        win.showDialog({
            title: `Help: ${PANEL_NAMES[currentPanel]}`,
            drawFrame: popupDrawFrame,
            colours: popupColours,
            list: {
                items: lines.map(l => ({ label: l })),
                bg: colPopupBack,
                height: HELP_CONTENT_H,
                width: HELP_CONTENT_W+4,
                scrollbarChars: popupScrollbarChars,
                selectable: () => false,
                renderItem: (ctx) => {
                    con.color_pair(colText, ctx.listBg)
                    con.move(ctx.y, ctx.x)
                    const line = (ctx.item.label != null ? ctx.item.label : '')
                    print(line.padEnd(ctx.w, ' ').substring(0, ctx.w))
                },
            },
            buttons: [{ label: 'OK', action: 'ok', default: true }],
            onKey: (ks, _shift, ctx) => {
                if (ks === '!' || ks === 'q') { ctx.close({ action: 'cancel' }); return true }
                return false
            },
        })
        HUB.drawAll()
    }

    function openConfirmQuit() {
        const messageLines = ['Exit Microtone?']
        if (HUB.hasUnsavedChanges()) messageLines.push('You have unsaved changes.')

        const res = win.showDialog({
            title: 'Quit?',
            drawFrame: popupDrawFrame,
            colours: popupColours,
            message: messageLines,
            buttons: [
                { label: 'Yes', action: 'yes' },
                { label: 'No',  action: 'no', default: true },
            ],
            onKey: (ks, _shift, ctx) => {
                if (ks === 'y' || ks === 'Y') { ctx.close({ action: 'yes' }); return true }
                if (ks === 'n' || ks === 'N') { ctx.close({ action: 'no' });  return true }
                return false
            },
        })

        const result = (res.action === 'yes')
        if (!result) HUB.drawAll()
        return result
    }

    function openGotoPopup() {
        const currentPanel = HUB.getPanel()
        const prompts = ['Cue (hex):', 'Cue (hex):', 'Pattern (hex):']
        const promptStr = prompts[currentPanel] || 'Number:'

        const res = win.showDialog({
            title: 'Go To',
            drawFrame: popupDrawFrame,
            colours: popupColours,
            fields: [{ label: promptStr, width: 4, maxLength: 3 }],
            buttons: [
                { label: 'OK',     action: 'ok' },
                { label: 'Cancel', action: 'cancel' },
            ],
        })
        if (res.action === 'ok' && res.values[0]) {
            const n = parseInt(res.values[0], 16)
            if (!isNaN(n)) HUB.applyGoto(n)
        }
        HUB.drawAll()
    }

    /////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // RETUNE POPUP
    /////////////////////////////////////////////////////////////////////////////////////////////////////////////

    function openRetunePopup() {
        const PITCH_PRESET_IDX = HUB.getPitchPresetIdx()
        const entries = Object.values(pitchTablePresets).sort((a, b) => a.index - b.index)
        const n = entries.length

        // Foreground colour by tuning type (preset.t):
        //   'd' = 12-tone family, 'M' = Macrotonal, 'm' = microtonal, '' = Raw.
        const tuningTypeColour = { d: 230, M: colPan, m: colInst, '': colStatus }

        const methodLabels = {
            pitch:    'Nearest-note',
            delta:    'Nearest-delta',
            cadence:  'Nearest-cadence',
            harmonic: 'Nearest-harmonic', // this thing is cadence-aware (hopefully)
        }
        const methodCycle = ['pitch', 'harmonic', 'delta'/*, 'cadence'*/]
        let method = 'pitch'

        let selIdx = entries.findIndex(p => p.index === PITCH_PRESET_IDX)
        if (selIdx < 0) selIdx = 0

        const items = entries.map(e => ({ label: e.name, preset: e }))
        const listH = Math.min(n, 13)
        const messageLines = [
            'Select new tuning preset:',
            'Method: ' + methodLabels[method],
        ]

        const res = win.showDialog({
            title: 'Retune',
            drawFrame: popupDrawFrame,
            colours: popupColours,
            message: messageLines,
            list: {
                items: items,
                height: listH,
                width: 36,
                cursor: selIdx,
                scrollbarChars: popupScrollbarChars,
                renderItem: (ctx) => {
                    const e = ctx.item.preset
                    const isCur = (e.index === PITCH_PRESET_IDX)
                    const fore = (e.t in tuningTypeColour) ? tuningTypeColour[e.t] : 230
                    const useFg = (ctx.isCursor && ctx.focused) ? colWHITE : fore
                    const useBg = (ctx.isCursor && ctx.focused) ? colHighlight : ctx.listBg
                    con.color_pair(useFg, useBg)
                    con.move(ctx.y, ctx.x)
                    const marker = isCur ? sym.playhead : ' '
                    let label = `${marker} ${e.name}`
                    if (label.length > ctx.w) label = label.substring(0, ctx.w)
                    else label = label.padEnd(ctx.w, ' ')
                    print(label)
                },
            },
            buttons: [
                { label: 'OK',     action: 'ok' },
                { label: 'Cancel', action: 'cancel' },
            ],
            onKey: (ks, _shift, ctx) => {
                if (ks === 'm' || ks === 'M') {
                    method = methodCycle[(methodCycle.indexOf(method) + 1) % methodCycle.length]
                    messageLines[1] = 'Method: ' + methodLabels[method]
                    ctx.render()
                    return true
                }
                return false
            },
        })

        if (res.action === 'ok' && res.listItem) {
            const target = res.listItem.preset
            if (target && target.index !== PITCH_PRESET_IDX) {
                HUB.retuneAllPatterns(target.index, method)
            }
        }

        HUB.drawAll()
    }

    /////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // MIXER FLAGS POPUP
    /////////////////////////////////////////////////////////////////////////////////////////////////////////////

    function openFlagsPopup() {
        const flags0 = HUB.getMixerFlags()
        const toneNames = ['Linear pitch', 'Amiga pitch', 'Linear freq']
        const intpNames = ['Default', 'None', 'A500', 'A1200', 'SNES', 'DPCM']

        let toneMode = flags0 & 3
        let intpMode = (flags0 >>> 2) & 7
        if (toneMode >= toneNames.length) toneMode = 0
        if (intpMode >= intpNames.length) intpMode = 0

        // Build list rows: headers + selectable radio options.
        const items = []
        items.push({ label: 'Tone Mode:', kind: 'header' })
        toneNames.forEach((nm, i) => items.push({ label: nm, kind: 'tone', idx: i }))
        items.push({ label: '', kind: 'spacer' })
        items.push({ label: 'Interpolation:', kind: 'header' })
        intpNames.forEach((nm, i) => items.push({ label: nm, kind: 'intp', idx: i }))

        const res = win.showDialog({
            title: 'Mixer Flags',
            drawFrame: popupDrawFrame,
            colours: popupColours,
            list: {
                items: items,
                height: items.length,
                width: 22,
                drawWell: false,
                showScrollbar: false,
                scrollbarChars: popupScrollbarChars,
                selectable: (it) => it.kind === 'tone' || it.kind === 'intp',
                renderItem: (ctx) => {
                    const it = ctx.item
                    con.move(ctx.y, ctx.x)
                    if (it.kind === 'header') {
                        con.color_pair(colStatus, colPopupBack)
                        print(it.label.padEnd(ctx.w, ' ').substring(0, ctx.w))
                        return
                    }
                    if (it.kind === 'spacer') {
                        con.color_pair(colStatus, colPopupBack)
                        print(' '.repeat(ctx.w))
                        return
                    }
                    const isChecked = (it.kind === 'tone')
                        ? (toneMode === it.idx)
                        : (intpMode === it.idx)
                    const useBg = (ctx.isCursor && ctx.focused) ? colHighlight : colPopupBack
                    const useFg = isChecked ? colVoiceHdr : colWHITE
                    con.color_pair(useFg, useBg)
                    const line = ' ' + (isChecked ? sym.ticked : sym.unticked) + ' ' + it.label
                    print(line.padEnd(ctx.w, ' ').substring(0, ctx.w))
                },
                // Space and left-click toggle the radio; Enter commits via OK.
                onActivate: (item, _idx, key) => {
                    if (key === ' ' || key === 'click') {
                        if      (item.kind === 'tone') toneMode = item.idx
                        else if (item.kind === 'intp') intpMode = item.idx
                        return null
                    }
                    if (key === '\n') return 'ok'
                    return null
                },
            },
            buttons: [
                { label: 'OK',     action: 'ok' },
                { label: 'Cancel', action: 'cancel' },
            ],
        })

        if (res.action === 'ok') {
            const newFlags = (flags0 & ~0x1F) |
                             (toneMode & 3) | ((intpMode & 7) << 2)
            if (newFlags !== flags0) {
                HUB.commitMixerFlags(newFlags)
            }
        }

        HUB.drawAll()
    }

    return {
        openHelpPopup, openConfirmQuit, openGotoPopup, openRetunePopup, openFlagsPopup,
        popupDrawFrame, popupColours, popupScrollbarChars,
    }
}

exports = { init }
