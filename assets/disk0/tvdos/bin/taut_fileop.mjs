/**
 * TAUT File panel (in-process) — filenav-driven open / save / new + mkdir / rename.
 *
 * Layout (inside the shared panel region, rows PTNVIEW_OFFSET_Y..SCRH-1):
 *
 *   [op  ][            Filenav panel             ]
 *   [pal ][  (single-pane file list, navigate-   ]
 *   [ette][   only: clicking a file does nothing) ]
 *
 * The op-panel (left strip) is a palette of project file-operations the host
 * draws and routes itself; the filenav panel is a `filenav.create` instance in
 * single-pane, navigate-only mode (no execfun → activating a file is a no-op;
 * directories still open). The engine state mutations (open/save/new) live in
 * taut.js and are reached through the HUB.
 *
 * Converted from the placeholder taut_fileop.mjs on 2026-06-24.
 */

const win     = require("wintex")
const filenav = require("filenav")

function init(HUB) {
    const C = HUB.C
    const SCRW = C.SCRW, SCRH = C.SCRH
    const PANEL_Y = C.PTNVIEW_OFFSET_Y
    const PANEL_H = C.PTNVIEW_HEIGHT
    const VIEW_TIMELINE = C.VIEW_TIMELINE

    // Colours (mirrors zfm's filenav palette; 255 == taut's panel background).
    const COL_TEXT     = 253
    const COL_BACK     = 255
    const COL_BACK_SEL = 81
    const COL_HLTEXT   = 230
    const COL_DIMTEXT  = 249
    const COL_HLACTION = 39      // access-key letter (enabled)
    const COL_DISABLED = 244     // greyed-out (non-clickable) button
    const COL_HL_EXT   = { taud: 109 }

    // Geometry: narrow op strip on the left, file list fills the rest.
    const OPW            = 10
    const FILESIZE_WIDTH = 7
    const navW           = SCRW - OPW
    const LIST_HEIGHT    = PANEL_H - 3
    const FILELIST_WIDTH = navW - 3 - FILESIZE_WIDTH
    const POPUP_WIDTH    = 52

    ///////////////////////////////////////////////////////////////////////////
    // Popups (host-owned; thin wrappers over win.showDialog, like filenav's
    // defaults). Every caller repaints afterwards via HUB.drawAll().
    ///////////////////////////////////////////////////////////////////////////

    function showConfirm(title, message) {
        const res = win.showDialog({
            title, message, fields: [],
            buttons: [{ label: 'OK', action: 'ok', default: true }, { label: 'CANCEL', action: 'cancel' }],
        })
        return res.action === 'ok'
    }
    function showInput(title, prompt, defaultVal) {
        const res = win.showDialog({
            title,
            fields: [{ label: prompt, initial: defaultVal || '', width: POPUP_WIDTH - 6 }],
            buttons: [{ label: 'OK', action: 'ok', default: true }, { label: 'CANCEL', action: 'cancel' }],
        })
        return res.action === 'ok' ? res.values[0] : null
    }
    function showMessage(title, message) {
        win.showDialog({ title, message, fields: [], buttons: [{ label: 'OK', action: 'ok', default: true }] })
    }

    ///////////////////////////////////////////////////////////////////////////
    // The navigator: single-pane, navigate-only. fs:true turns on the built-in
    // mkdir / rename popups (copy/move/delete are structurally off in single-
    // pane mode / never exposed); defaultExec:false makes activating a file a
    // no-op so "clicking a file does nothing".
    ///////////////////////////////////////////////////////////////////////////

    function curFile() { return HUB.getCurrentFilePath() }

    // Initial browse path = the directory of the currently-open file (its parent),
    // or A:\home when launched on a bare/new project.
    function initialSegments() {
        const full = curFile()
        if (!full) return ["A:", "home"]
        const parts = full.replaceAll('/', '\\').split('\\').filter(s => s.length > 0)
        parts.pop()  // drop the filename
        return parts.length ? parts : ["A:"]
    }

    const nav = filenav.create({
        C: { LIST_HEIGHT, FILELIST_WIDTH, FILESIZE_WIDTH, POPUP_WIDTH,
             COL_TEXT, COL_BACK, COL_BACK_SEL, COL_HLTEXT, COL_DIMTEXT, COL_HL_EXT },
        win,
        singlePanel: true,
        defaultExec: false,
        initialPaths: [ initialSegments(), ["A:"] ],
        addMouseRegion: HUB.addPanelMouseRegion,
        requestRedraw: () => HUB.drawAll(),
        redrawNow:     () => HUB.drawAll(),
        drawActivePanel: drawNavPanel,
        clearScr: clearPanelArea,
        hooks: { fs: true },   // mkdir + rename
    })

    const navPanel = new win.WindowObject(OPW + 1, PANEL_Y, navW, PANEL_H, () => {}, nav.filesPanelDraw)
    navPanel.isHighlighted = true
    const opPanel = new win.WindowObject(1, PANEL_Y, OPW, PANEL_H, () => {}, opPanelDraw)

    ///////////////////////////////////////////////////////////////////////////
    // Op panel (project file operations). New / save / etc. live in taut.js
    // (the HUB); mkdir / rename route through the navigator's own actions.
    ///////////////////////////////////////////////////////////////////////////

    // yOff = row offset of the label inside the op-panel content; the rule sits
    // at yOff+1, so each button (label + rule) is a 2-row block. A thick double
    // rule sits after 'new', splitting project ops from filesystem ops.
    const OP_BUTTONS = [
        { id: 'open',   label: 'Open',   ki: 0, yOff: 0  },
        { id: 'save',   label: 'Save',   ki: 0, yOff: 2  },
        { id: 'saveas', label: 'SvAs',   ki: 2, yOff: 4  },
        { id: 'new',    label: 'New',    ki: 0, yOff: 6  },
        { id: 'mkdir',  label: 'MkDir',  ki: 1, yOff: 8  },
        { id: 'rename', label: 'Rename', ki: 0, yOff: 10 },
    ]
    const THICK_SEP_AFTER = 3   // double rule after OP_BUTTONS[3] ('new')
    let opHover = -1

    // 'save' is the only conditionally-disabled op: greyed (and non-clickable)
    // when there is no backing file yet (fresh "new" project).
    function btnEnabled(id) { return (id === 'save') ? (curFile() !== null) : true }

    function printLabel(y, x, label, ki, baseCol, keyCol) {
        for (let i = 0; i < label.length; i++) {
            con.color_pair(i === ki ? keyCol : baseCol, COL_BACK)
            con.move(y, x + i)
            print(label[i])
        }
    }

    function opPanelDraw(wo) {
        const xp = wo.x + 1
        const yp = wo.y + 1
        const innerW = OPW - 2

        // clear interior
        con.color_pair(COL_TEXT, COL_BACK)
        for (let y = wo.y + 1; y < wo.y + PANEL_H - 1; y++) {
            con.move(y, xp); print(' '.repeat(innerW))
        }

        for (let i = 0; i < OP_BUTTONS.length; i++) {
            const b = OP_BUTTONS[i]
            const on = btnEnabled(b.id)
            const baseCol = !on ? COL_DISABLED : (opHover === i) ? COL_HLTEXT : COL_TEXT
            const keyCol  = !on ? COL_DISABLED : COL_HLACTION
            printLabel(yp + b.yOff, xp + 1, b.label, b.ki, baseCol, keyCol)

            // separator rule below the button
            const ruleY = yp + b.yOff + 1
            con.color_pair(COL_TEXT, COL_BACK)
            con.move(ruleY, xp)
            if (i === THICK_SEP_AFTER) print('\u00CD'.repeat(innerW))   // double-line (thick) separator
            else                       print('\u00C4'.repeat(innerW))   // single-line (thin) rule
        }
        con.color_pair(COL_TEXT, COL_BACK)
    }

    ///////////////////////////////////////////////////////////////////////////
    // Drawing
    ///////////////////////////////////////////////////////////////////////////

    function drawNavPanel() {
        navPanel.isHighlighted = true
        navPanel.drawContents()   // filesPanelDraw: sets titleLeft/Right + paints the list
        navPanel.drawFrame()      // border + titles
    }
    function drawOpPanel() {
        opPanel.drawContents()
        opPanel.drawFrame()
    }
    function clearPanelArea() {
        con.color_pair(COL_TEXT, COL_BACK)
        for (let y = PANEL_Y; y < SCRH; y++) { con.move(y, 1); print(' '.repeat(SCRW)) }
    }

    // Host hook: full File-panel repaint (op strip + file list).
    function drawContents(wo) {
        drawOpPanel()
        drawNavPanel()
    }

    ///////////////////////////////////////////////////////////////////////////
    // Operations
    ///////////////////////////////////////////////////////////////////////////

    function actOpen() {
        const cache = nav.getSelectedCache()
        if (!cache || !cache.file || cache.isDirectory) {
            showMessage('Open', 'Select a file to open.'); HUB.drawAll(); return
        }
        if (HUB.hasUnsavedChanges() && !showConfirm('Open', 'Discard unsaved changes?')) {
            HUB.drawAll(); return
        }
        try { HUB.openProject(cache.file.fullPath) }
        catch (e) { showMessage('Open failed', e.message || ('' + e)); HUB.drawAll(); return }
        HUB.switchToPanel(VIEW_TIMELINE)   // reveal the loaded song
    }

    function actSave() {
        if (curFile() === null) return     // disabled
        const name = curFile().split('\\').last()
        if (!showConfirm('Save', `Overwrite "${name}"?`)) { HUB.drawAll(); return }
        try { HUB.saveProject(curFile()) }
        catch (e) { showMessage('Save failed', e.message || ('' + e)) }
        HUB.drawAll()
    }

    function actSaveAs() {
        const dir = nav.getCurrentDirStr(0)
        if (!dir || dir.length === 0) { showMessage('Save As', 'Choose a directory first.'); HUB.drawAll(); return }
        let defName = curFile() ? curFile().split('\\').last() : 'untitled.taud'
        while (true) {
            const name = showInput('Save As', 'Filename:', defName)
            if (name === null || name.length === 0) { HUB.drawAll(); return }   // cancelled
            const target = dir + name
            if (files.open(target).exists) {
                showMessage('Save As', `"${name}" already exists.`)
                defName = name
                continue                                                       // collision: prompt again
            }
            try {
                HUB.saveProject(target)
                HUB.setCurrentFilePath(target)
            } catch (e) {
                showMessage('Save As failed', e.message || ('' + e)); HUB.drawAll(); return
            }
            nav.refreshActivePanel()             // the new file appears in the list
            HUB.drawAll()
            HUB.rebuildPanelMouseRegions()       // 'save' just became enabled → (re)register its hit-box
            return
        }
    }

    function actNew() {
        if (HUB.hasUnsavedChanges() && !showConfirm('New', 'Discard unsaved changes?')) {
            HUB.drawAll(); return
        }
        HUB.newProject()
        HUB.switchToPanel(VIEW_TIMELINE)
    }

    function doAction(id) {
        if      (id === 'open')   actOpen()
        else if (id === 'save')   actSave()
        else if (id === 'saveas') actSaveAs()
        else if (id === 'new')    actNew()
        else if (id === 'mkdir')  nav.invokeAction('mkdir')   // built-in popup + refresh + redrawNow
        else if (id === 'rename') nav.invokeAction('rename')
    }

    ///////////////////////////////////////////////////////////////////////////
    // Mouse + keyboard
    ///////////////////////////////////////////////////////////////////////////

    function registerMouse() {
        nav.setupMouseRegions(navPanel)   // file-list wheel + hover-caret + click (dir-open / file-noop)

        const opX = opPanel.x + 1
        const opW = OPW - 2
        for (let i = 0; i < OP_BUTTONS.length; i++) {
            const idx = i
            const b = OP_BUTTONS[i]
            if (!btnEnabled(b.id)) continue   // greyed buttons take no hover/click
            HUB.addPanelMouseRegion(opX, PANEL_Y + 1 + b.yOff, opW, 2, {
                onHover:      () => { if (opHover !== idx) { opHover = idx; drawOpPanel() } },
                onHoverLeave: () => { if (opHover === idx) { opHover = -1;  drawOpPanel() } },
                onClick: (cy, cx, btnNum) => { if (btnNum === 1) doAction(b.id) },
            })
        }
    }

    // Re-read the active directory on panel entry (files may have changed) and
    // drop any stale op-button hover from a previous visit.
    function onEnter() { opHover = -1; nav.refreshActivePanel() }

    function input(wo, event) {
        if (event[0] !== 'key_down') return
        const keysym = event[1]
        const keyJustHit = (1 === event[2])

        // Navigation → navigator (arrows / page keys).
        if (keysym === '<UP>' || keysym === '<DOWN>' || keysym === '<PAGE_UP>' || keysym === '<PAGE_DOWN>') {
            nav.filenavOninput(navPanel, event); return
        }
        // Enter: open directories only (files do nothing).
        if (keyJustHit && event[3] === 66) {
            const cache = nav.getSelectedCache()
            if (cache && cache.isDirectory) nav.activate()
            return
        }
        if (!keyJustHit) return

        // Op shortcuts (mirrors the op-panel labels' access keys) + 'u' = go up.
        if      (keysym === 'u') nav.invokeAction('up')
        else if (keysym === 'o') doAction('open')
        else if (keysym === 's') doAction('save')
        else if (keysym === 'a') doAction('saveas')
        else if (keysym === 'n') doAction('new')
        else if (keysym === 'k') doAction('mkdir')
        else if (keysym === 'r') doAction('rename')
    }

    // Prime the file list once so the first draw / mouse-bounds have data.
    nav.refreshFilePanelCache(0)

    return { drawContents, input, registerMouse, onEnter }
}

exports = { init }
