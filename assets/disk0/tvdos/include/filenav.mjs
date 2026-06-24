/**
 * filenav.mjs — reusable dual-pane filesystem navigator.
 *
 * Extracted verbatim from zfm.js's battle-tested navigator (filenavOninput,
 * filesPanelDraw, refreshFilePanelCache, the file-operation actions, and the
 * file-list mouse regions). The op-panel (sidebar) is deliberately NOT part of
 * this module: the host draws it and routes its buttons through
 * `nav.invokeAction(id)`.
 *
 * The navigator owns the dual-pane state (path / scroll / cursor / dirFileList
 * / cache for both sides, plus `windowMode`), draws a single panel, walks the
 * list with the keyboard / mouse, activates entries (open dir, run file), and
 * performs the copy/move/delete/mkdir/rename mutations.
 *
 * create(opts) -> nav
 *
 * opts:
 *   C: {                       // geometry + colour constants (host owns layout)
 *     LIST_HEIGHT, FILELIST_WIDTH, FILESIZE_WIDTH, POPUP_WIDTH,
 *     COL_TEXT, COL_BACK, COL_BACK_SEL, COL_HLTEXT, COL_DIMTEXT, COL_HL_EXT
 *   }
 *   execFuns                            // ext -> fn table for activating files
 *   defaultExec                         // optional, default true. When false,
 *                                       //   activating a file whose ext has no
 *                                       //   execFun does NOTHING (no shell
 *                                       //   fallback) — directories still open.
 *                                       //   Lets a host present a navigate-only
 *                                       //   list where "clicking a file does
 *                                       //   nothing" (e.g. taut's File tab).
 *   win                                 // wintex module (scrollVert + showDialog)
 *   addMouseRegion(x,y,w,h,handlers)    // host's shared mouse-region registry
 *   requestRedraw()                     // deferred full redraw (host dirty flag)
 *   redrawNow()                         // synchronous full redraw
 *   drawActivePanel()                   // cheap repaint of the active panel
 *   clearScr()                          // clear screen to host's background
 *   onChildExit()                       // optional: host re-arms input latches
 *                                       //   after a child program returns
 *   initialPaths                        // optional [[left...],[right...]],
 *                                       //   default [["A:","home"],["A:"]]
 *   singlePanel                         // optional: when truthy, only panel 0
 *                                       //   exists — setWindowMode is pinned to
 *                                       //   0, and Switch / Copy / Move are
 *                                       //   structurally disabled (Copy/Move
 *                                       //   have no second panel to target).
 *                                       //   Delete/Mkdir/Rename still honour fs.
 *
 *   hooks: selects which EDITING functions are enabled (this is the "additional
 *          argument"). A capability stays OFF unless its hook is supplied:
 *     onQuit()                 — enables Quit          (q)
 *     onSwitchPanel()          — enables Switch panel  (z)
 *     onMore(cache, nav)       — enables More          (m)
 *     fs                       — enables Copy/Move/Delete/Mkdir/Rename.
 *                                Truthy turns them on with the built-in popups;
 *                                may also be an object { confirm, input, message }
 *                                to override those popups.
 *   ("Go up" needs no hook — it is the navigator's native function.)
 *
 * nav: {
 *   get windowMode, get singlePanel, setWindowMode,
 *   isEnabled(actionId),   // single source of truth for which actions are live;
 *                          //   the host's op-panel drawer should consult this to
 *                          //   grey out / skip disabled buttons. actionId is one
 *                          //   of switch|up|copy|move|delete|mkdir|rename|more|
 *                          //   quit|activate.
 *   filesPanelDraw, filenavOninput,
 *   refreshFilePanelCache, refreshActivePanel,
 *   setupMouseRegions, invokeAction,
 *   runChild, activate,
 *   getCurrentDirStr, getSelectedCache, getPath, clampCursorAfterChange
 * }
 */

// Resolve a per-extension table entry (COL_HL_EXT, execFuns, ...) by SUFFIX
// match rather than literal extension extraction: the LONGEST key K with
// lower(filename).endsWith(K) wins. This catches dotless suffixes like "rc"
// (commandrc, zfmrc, .bashrc) that have no "." to split on, while dotted keys
// (".js", ".bat", ".taud") keep matching exactly. Longest-match keeps the more
// specific key deterministic regardless of object key order. Returns undefined
// when nothing matches.
function matchExtKey(filename, map) {
    let lower = filename.toLowerCase()
    let best = undefined
    let bestLen = -1
    for (let k in map) {
        if (k.length > bestLen && lower.endsWith(k)) {
            best = map[k]
            bestLen = k.length
        }
    }
    return best
}

function create(opts) {
    const C = opts.C
    const LIST_HEIGHT    = C.LIST_HEIGHT
    const FILELIST_WIDTH = C.FILELIST_WIDTH
    const FILESIZE_WIDTH = C.FILESIZE_WIDTH
    const POPUP_WIDTH    = C.POPUP_WIDTH

    const COL_TEXT     = C.COL_TEXT
    const COL_BACK     = C.COL_BACK
    const COL_BACK_SEL = C.COL_BACK_SEL
    const COL_HLTEXT   = C.COL_HLTEXT
    const COL_DIMTEXT  = C.COL_DIMTEXT
    const COL_HL_EXT   = C.COL_HL_EXT || {}

    const execFuns      = opts.execFuns || {}
    const allowDefaultExec = (opts.defaultExec !== false)

    const win = opts.win
    const addMouseRegion = opts.addMouseRegion
    const requestRedraw  = opts.requestRedraw
    const redrawNow      = opts.redrawNow
    const drawActivePanel = opts.drawActivePanel
    const clearScr       = opts.clearScr
    const onChildExit    = opts.onChildExit

    const hooks = opts.hooks || {}
    const singlePanel = !!opts.singlePanel
    const fileOpsEnabled = !!hooks.fs

    // Single source of truth for which actions are live. The keyboard handler,
    // invokeAction (op-panel buttons), and the host's op-panel drawer all gate
    // on this so an action can never be half-enabled. "up"/"activate" are the
    // navigator's native functions and are always on. Copy/Move need a second
    // panel to target, so they are structurally off in single-panel mode even
    // when the fs hook is present. Switch is likewise impossible single-panel.
    function isEnabled(id) {
        switch (id) {
            case 'up':
            case 'activate': return true
            case 'switch':   return !singlePanel && !!hooks.onSwitchPanel
            case 'more':     return !!hooks.onMore
            case 'quit':     return !!hooks.onQuit
            case 'copy':
            case 'move':     return fileOpsEnabled && !singlePanel
            case 'delete':
            case 'mkdir':
            case 'rename':   return fileOpsEnabled
            default:         return false
        }
    }

    ///////////////////////////////////////////////////////////////////////////
    // Popups (file-op interaction). Overridable through hooks.fs.{confirm,input,message}.
    ///////////////////////////////////////////////////////////////////////////

    function defaultConfirm(title, message) {
        const res = win.showDialog({
            title: title,
            message: message,
            fields: [],
            buttons: [
                { label: 'OK',     action: 'ok', default: true },
                { label: 'CANCEL', action: 'cancel' },
            ],
        })
        return res.action === 'ok'
    }

    function defaultInput(title, prompt, defaultVal) {
        const res = win.showDialog({
            title: title,
            fields: [{ label: prompt, initial: defaultVal || '', width: POPUP_WIDTH - 6 }],
            buttons: [
                { label: 'OK',     action: 'ok', default: true },
                { label: 'CANCEL', action: 'cancel' },
            ],
        })
        return res.action === 'ok' ? res.values[0] : null
    }

    function defaultMessage(title, message) {
        win.showDialog({
            title: title,
            message: message,
            fields: [],
            buttons: [{ label: 'OK', action: 'ok', default: true }],
        })
    }

    const fsHook = (hooks.fs && typeof hooks.fs === 'object') ? hooks.fs : null
    const showConfirmPopup = (fsHook && fsHook.confirm) || defaultConfirm
    const showInputPopup   = (fsHook && fsHook.input)   || defaultInput
    const showMessagePopup = (fsHook && fsHook.message) || defaultMessage

    ///////////////////////////////////////////////////////////////////////////
    // Dual-pane state
    ///////////////////////////////////////////////////////////////////////////

    let windowMode = 0 // 0 == left, 1 == right
    let path = opts.initialPaths
        ? opts.initialPaths.map(p => p.slice())
        : [["A:", "home"], ["A:"]]
    let scroll = [0, 0]
    let dirFileList = [[], []]
    let cursor = [0, 0] // absolute position!
    let filePanelCache = [[], []]

    function bytesToReadable(i) {
        return ''+ (
           (i > 999999999999) ? (((i / 10000000000)|0)/100 + "T") :
           (i > 999999999) ? (((i / 10000000)|0)/100 + "G") :
           (i > 999999) ? (((i / 10000)|0)/100 + "M") :
           (i > 9999) ? (((i / 100)|0)/10 + "K") :
           i
       )
    }

    function refreshFilePanelCache(side) {
        let pathStr = path[side].concat(['']).join("\\").replaceAll('\\\\', '\\')
        const showDrives = (pathStr.length == 0)

        filePanelCache[side] = []

        let ds = []
        let fs = []

        if (!showDrives) {
            let letter = pathStr[0]
            let serialPath = pathStr.substring(3)
            // remove trailing slashes
            while (serialPath.endsWith("\\")) {
                serialPath = serialPath.substring(0, serialPath.length - 1)
            }

            let port = _TVDOS.DRV.FS.SERIAL._toPorts(letter)
            com.sendMessage(port[0], "DEVRST\x17")
            com.sendMessage(port[0], "OPENR"+'"'+serialPath+'",'+port[1])
            com.sendMessage(port[0], "LISTFILES")
            let response = com.getStatusCode(port[0])
            let rawStr = com.pullMessage(port[0]) // {\x11 | \x12} <name> [ \x1E {\x11 | \x12} <name> ] \x17

            rawStr.substring(0, rawStr.length).split('\x1E').forEach((s) => {
                let fname = undefined
                if (s[0] == '\x11') {
                    fname = s.substr(1)
                    ds.push(files.open(`${pathStr}${fname}`))
                }
                else if (s[0] == '\x12') {
                    fname = s.substr(1)
                    fs.push(files.open(`${pathStr}${fname}`))
                }
            })
        }
        else {
            Object.entries(_TVDOS.DRIVES).map(it=>{
                let [letter, [port, drivenum]] = it
                let dinfo = _TVDOS.DRIVEINFO[letter]

                if (dinfo.type == "STOR") {
                    let file = files.open(`${letter}:\\`)
                    ds.push(file)
                }
            })
        }

        ds.sort((a,b) => (a.name > b.name) ? 1 : (a.name < b.name) ? -1 : 0)
        fs.sort((a,b) => (a.name > b.name) ? 1 : (a.name < b.name) ? -1 : 0)
        dirFileList[side] = ds.concat(fs)

        let filesCount = dirFileList[side].length

        for (let i = 0; i < filesCount; i++) {
            let isDirectory = (i < ds.length)
            let file = dirFileList[side][i]
            let sizestr;
            if (!showDrives) {
                sizestr = (file) ? bytesToReadable(file.size) : ''  // FIXME file.size creates disk access
            }
            else if (file) {
                let port = _TVDOS.DRIVES[file.driveLetter]
                _TVDOS.DRV.FS.SERIAL._flush(port[0]);_TVDOS.DRV.FS.SERIAL._close(port[0])
                com.sendMessage(port[0], "USAGE")
                let response = com.getStatusCode(port[0])
                if (0 == response) {
                    let rawStr = com.fetchResponse(port[0]).split('/') // USED1234/TOTAL23412341
                    let usedBytes = (rawStr[0].substring(4))|0
                    let totalBytes = (rawStr[1].substring(5))|0
                    sizestr = bytesToReadable(usedBytes)
                }
                else {
                    sizestr = ''
                }
            }
            else {
                sizestr = ''
            }
            let filename = (showDrives && file) ? file.fullPath : (file) ? file.name : ''
            let fileext = filename.substring(filename.lastIndexOf(".") + 1).toLowerCase()

            filePanelCache[side].push({
                file: file,
                isDirectory: isDirectory,
                sizestr: sizestr,
                filename: filename,
                fileext: fileext
            })
        }
    }

    function refreshActivePanel() { refreshFilePanelCache(windowMode) }

    let filesPanelDraw = (wo) => {
        let usedBytes = undefined
        let totalBytes = undefined
        let freeBytes = undefined
        let pathStr = path[windowMode].concat(['']).join("\\").replaceAll('\\\\', '\\')

        let port = _TVDOS.DRIVES[pathStr[0]]

        const showDrives = (pathStr.length == 0)

        if (!showDrives) {
            _TVDOS.DRV.FS.SERIAL._flush(port[0]);_TVDOS.DRV.FS.SERIAL._close(port[0])
            com.sendMessage(port[0], "USAGE")
            let response = com.getStatusCode(port[0])
            if (0 == response) {
                let rawStr = com.fetchResponse(port[0]).split('/') // USED1234/TOTAL23412341
                usedBytes = (rawStr[0].substring(4))|0
                totalBytes = (rawStr[1].substring(5))|0
                freeBytes = totalBytes - usedBytes
            }
        }

        let diskSizestr = (isNaN(freeBytes / totalBytes)) ? undefined : bytesToReadable(usedBytes)+"/"+bytesToReadable(totalBytes)

        wo.titleLeft = (showDrives) ? "(drives)" : pathStr
        wo.titleRight = diskSizestr


        // draw list header
        con.color_pair(COL_HLTEXT, COL_BACK)
        con.move(wo.y + 1, wo.x + 1); print(" Name")
        con.mvaddch(wo.y + 1, wo.x + FILELIST_WIDTH, 0xB3)
        con.curs_right(); print(" Size")


        con.color_pair(COL_TEXT, COL_BACK)

        let s = scroll[windowMode]
        let filesCount = dirFileList[windowMode].length

        // print entries
        for (let i = 0; i < LIST_HEIGHT; i++) {
            let listObj = filePanelCache[windowMode][i+s]
            if (listObj) {
                let file = listObj.file
                let isDirectory = listObj.isDirectory
                let sizestr = listObj.sizestr
                let filename = listObj.filename

                // set bg colour
                let backCol = (i == cursor[windowMode] - s) ? COL_BACK_SEL : COL_BACK
                // set fg colour (if there are more at the top/bottom, dim the colour)
                let foreCol = (i == 0 && s > 0 || i == LIST_HEIGHT - 1 && i + s < filesCount - 1) ? COL_DIMTEXT : (matchExtKey(filename, COL_HL_EXT) || COL_TEXT)

                // print filename
                con.color_pair(foreCol, backCol)
                con.move(wo.y + 2+i, wo.x + 1)
                print(((file && isDirectory && !showDrives) ? '\\' : ' ') + filename)
                print(' '.repeat(FILELIST_WIDTH - 2 - filename.length))

                // print |
                con.color_pair(COL_TEXT, backCol)
                con.mvaddch(wo.y + 2+i, wo.x + FILELIST_WIDTH, 0xB3)

                // print filesize
                con.color_pair(foreCol, backCol)
                con.move(wo.y + 2+i, wo.x + FILELIST_WIDTH + 1)
                if (file && isDirectory && !showDrives) {
                    print(' '.repeat(FILESIZE_WIDTH - sizestr.length))
                    print(sizestr); con.prnch(0x7F)
                }
                else {
                    print(' '.repeat(FILESIZE_WIDTH - sizestr.length + 1))
                    print(sizestr)
                }
            }
            else {
                // set bg colour
                let backCol = (i == cursor[windowMode] - s) ? COL_BACK_SEL : COL_BACK
                // set fg colour (if there are more at the top/bottom, dim the colour)
                let foreCol = COL_TEXT

                // print empty filename
                con.color_pair(foreCol, backCol)
                con.move(wo.y + 2+i, wo.x + 1)
                print(' '.repeat(FILELIST_WIDTH - 1))

                // print |
                con.color_pair(COL_TEXT, backCol)
                con.mvaddch(wo.y + 2+i, wo.x + FILELIST_WIDTH, 0xB3)

                // print empty filesize
                con.color_pair(foreCol, backCol)
                con.move(wo.y + 2+i, wo.x + FILELIST_WIDTH + 1)
                print(' '.repeat(FILESIZE_WIDTH + 1))
            }
        }

        con.color_pair(COL_TEXT, COL_BACK)
    }

    let filenavOninput = (window, event) => {
        let eventName = event[0]
        if (eventName !== "key_down") return

        let keysym = event[1]
        let keyJustHit = (1 == event[2])
        let keycodes = [event[3],event[4],event[5],event[6],event[7],event[8],event[9],event[10]]
        let keycode = keycodes[0]

        let scrollPeek = (LIST_HEIGHT / 3)|0

        if      (keyJustHit && keysym == "q") { if (isEnabled('quit')) hooks.onQuit() }
        else if (keyJustHit && keysym == "z") { if (isEnabled('switch')) hooks.onSwitchPanel() }
        else if (keyJustHit && keysym == 'u') actGoUp()
        else if (keyJustHit && keysym == 'c') actCopy()
        else if (keyJustHit && keysym == 'v') actMove()
        else if (keyJustHit && keysym == 'd') actDelete()
        else if (keyJustHit && keysym == 'k') actMkdir()
        else if (keyJustHit && keysym == 'r') actRename()
        else if (keyJustHit && keysym == 'm') triggerMore()
        else if (keysym == "<UP>") {
            [cursor[windowMode], scroll[windowMode]] = win.scrollVert(-1, dirFileList[windowMode].length, LIST_HEIGHT, cursor[windowMode], scroll[windowMode], scrollPeek)
            drawActivePanel()
        }
        else if (keysym == "<DOWN>") {
            [cursor[windowMode], scroll[windowMode]] = win.scrollVert(+1, dirFileList[windowMode].length, LIST_HEIGHT, cursor[windowMode], scroll[windowMode], scrollPeek)
            drawActivePanel()
        }
        else if (keysym == "<PAGE_UP>") {
            [cursor[windowMode], scroll[windowMode]] = win.scrollVert(-LIST_HEIGHT, dirFileList[windowMode].length, LIST_HEIGHT, cursor[windowMode], scroll[windowMode], scrollPeek)
            drawActivePanel()
        }
        else if (keysym == "<PAGE_DOWN>") {
            [cursor[windowMode], scroll[windowMode]] = win.scrollVert(+LIST_HEIGHT, dirFileList[windowMode].length, LIST_HEIGHT, cursor[windowMode], scroll[windowMode], scrollPeek)
            drawActivePanel()
        }
        else if (keyJustHit && keycode == 66) { // enter
            activate()
        }
    }

    ///////////////////////////////////////////////////////////////////////////
    // File operations and actions
    ///////////////////////////////////////////////////////////////////////////

    function getCurrentDirStr(side) {
        return path[side].concat(['']).join("\\").replaceAll('\\\\', '\\')
    }

    function getSelectedCache() {
        return filePanelCache[windowMode][cursor[windowMode]]
    }

    function clampCursorAfterChange() {
        const len = dirFileList[windowMode].length
        if (cursor[windowMode] >= len) cursor[windowMode] = Math.max(0, len - 1)
        const maxScroll = Math.max(0, len - LIST_HEIGHT)
        if (scroll[windowMode] > maxScroll) scroll[windowMode] = maxScroll
        if (scroll[windowMode] < 0) scroll[windowMode] = 0
    }

    // Run a child program: drop to a clean cooked screen, run `thunk`, pause on
    // error, then let the host re-arm its input latches and repaint. Shared by
    // file activation and any host hook (More/edit/terminal) that shells out.
    function runChild(thunk) {
        let errorlevel = 0
        con.curs_set(1); clearScr(); con.move(1, 1)
        try {
            errorlevel = thunk()
        }
        catch (e) {
            println(e)
            errorlevel = 1
        }
        if (errorlevel) {
            println("Hit Return/Enter key to continue . . . .")
            sys.read()
        }
        if (onChildExit) onChildExit()
        con.curs_set(0); clearScr()
        refreshFilePanelCache(windowMode)
        requestRedraw()
    }

    function actGoUp() {
        if (path[windowMode].length >= 1) {
            path[windowMode].pop()
            cursor[windowMode] = 0; scroll[windowMode] = 0
            refreshFilePanelCache(windowMode)
            redrawNow()
        }
    }

    function activate() {
        let selectedFileCache = getSelectedCache()
        if (!selectedFileCache || !selectedFileCache.file) return
        let selectedFile = selectedFileCache.file

        if (selectedFile.fullPath[1] == ":" && selectedFile.fullPath[2] == "\\" && selectedFile.fullPath.length == 3) {
            path[windowMode].push(selectedFile.fullPath)
            cursor[windowMode] = 0; scroll[windowMode] = 0
            refreshFilePanelCache(windowMode)
            redrawNow()
        }
        else if (selectedFileCache.isDirectory) {
            path[windowMode].push(selectedFileCache.filename)
            cursor[windowMode] = 0; scroll[windowMode] = 0
            refreshFilePanelCache(windowMode)
            redrawNow()
        }
        else {
            let execfun = matchExtKey(selectedFileCache.filename, execFuns) || (allowDefaultExec ? ((f) => _G.shell.execute(f)) : null)
            if (execfun) runChild(() => execfun(selectedFile.fullPath))
        }
    }

    function actCopy() {
        if (!isEnabled('copy')) return
        if (path[windowMode].length === 0) return
        const cache = getSelectedCache()
        if (!cache || !cache.file) return
        if (cache.isDirectory) { showMessagePopup('Copy', 'Directory copy is not supported.'); redrawNow(); return }
        if (path[1 - windowMode].length === 0) { showMessagePopup('Copy', 'Cannot copy to drive list view.'); redrawNow(); return }

        const srcPath = cache.file.fullPath
        const dstDir = getCurrentDirStr(1 - windowMode)
        const dstPath = dstDir + cache.file.name
        if (srcPath === dstPath) { redrawNow(); return } // both panels point to same directory

        try {
            const srcFile = files.open(srcPath)
            const dstFile = files.open(dstPath)
            if (!srcFile.exists) { showMessagePopup('Copy', 'Source not found.'); redrawNow(); return }
            if (dstFile.exists) {
                if (!showConfirmPopup('Copy', `Overwrite "${cache.file.name}"?`)) { redrawNow(); return }
            }
            if (!dstFile.exists) dstFile.mkFile()
            dstFile.bwrite(srcFile.bread())
            try { dstFile.flush() } catch (e) {}
            try { dstFile.close() } catch (e) {}
            try { srcFile.close() } catch (e) {}
            refreshFilePanelCache(1 - windowMode)
        }
        catch (e) {
            showMessagePopup('Copy failed', e.message || ('' + e))
        }
        redrawNow()
    }

    function actMove() {
        if (!isEnabled('move')) return
        if (path[windowMode].length === 0) return
        const cache = getSelectedCache()
        if (!cache || !cache.file) return
        if (cache.isDirectory) { showMessagePopup('Move', 'Directory move is not supported.'); redrawNow(); return }
        if (path[1 - windowMode].length === 0) { showMessagePopup('Move', 'Cannot move to drive list view.'); redrawNow(); return }

        const srcPath = cache.file.fullPath
        const dstDir = getCurrentDirStr(1 - windowMode)
        const dstPath = dstDir + cache.file.name
        if (srcPath === dstPath) { redrawNow(); return } // no-op

        try {
            const srcFile = files.open(srcPath)
            const dstFile = files.open(dstPath)
            if (!srcFile.exists) { showMessagePopup('Move', 'Source not found.'); redrawNow(); return }
            if (dstFile.exists) {
                if (!showConfirmPopup('Move', `Overwrite "${cache.file.name}"?`)) { redrawNow(); return }
            }
            if (!dstFile.exists) dstFile.mkFile()
            dstFile.bwrite(srcFile.bread())
            try { dstFile.flush() } catch (e) {}
            try { dstFile.close() } catch (e) {}
            srcFile.remove()
            refreshFilePanelCache(windowMode)
            refreshFilePanelCache(1 - windowMode)
            clampCursorAfterChange()
        }
        catch (e) {
            showMessagePopup('Move failed', e.message || ('' + e))
        }
        redrawNow()
    }

    function actDelete() {
        if (!isEnabled('delete')) return
        if (path[windowMode].length === 0) return
        const cache = getSelectedCache()
        if (!cache || !cache.file) return

        const name = cache.file.name
        const kind = cache.isDirectory ? 'directory' : 'file'
        if (!showConfirmPopup('Delete', `Delete ${kind} "${name}"?`)) { redrawNow(); return }

        try {
            const status = cache.file.remove()
            if (status !== undefined && status !== 0 && status !== true) {
                showMessagePopup('Delete failed', `Cannot delete "${name}" (status ${status}).`)
            }
            refreshFilePanelCache(windowMode)
            clampCursorAfterChange()
        }
        catch (e) {
            showMessagePopup('Delete failed', e.message || ('' + e))
        }
        redrawNow()
    }

    function actMkdir() {
        if (!isEnabled('mkdir')) return
        if (path[windowMode].length === 0) { showMessagePopup('Mkdir', 'Choose a directory first.'); redrawNow(); return }
        const name = showInputPopup('Make Directory', 'Directory name:', '')
        if (name === null || name.length === 0) { redrawNow(); return }

        const dstPath = getCurrentDirStr(windowMode) + name
        try {
            const dstFile = files.open(dstPath)
            if (dstFile.exists) {
                showMessagePopup('Mkdir', `"${name}" already exists.`)
            }
            else {
                const ok = dstFile.mkDir()
                if (!ok) showMessagePopup('Mkdir failed', `Cannot create "${name}".`)
                else refreshFilePanelCache(windowMode)
            }
        }
        catch (e) {
            showMessagePopup('Mkdir failed', e.message || ('' + e))
        }
        redrawNow()
    }

    function actRename() {
        if (!isEnabled('rename')) return
        if (path[windowMode].length === 0) return
        const cache = getSelectedCache()
        if (!cache || !cache.file) return
        if (cache.isDirectory) { showMessagePopup('Rename', 'Directory rename is not supported.'); redrawNow(); return }

        const oldName = cache.file.name
        const newName = showInputPopup('Rename', 'New name:', oldName)
        if (newName === null || newName.length === 0 || newName === oldName) { redrawNow(); return }

        const dirStr = getCurrentDirStr(windowMode)
        const srcPath = cache.file.fullPath
        const dstPath = dirStr + newName

        try {
            const srcFile = files.open(srcPath)
            const dstFile = files.open(dstPath)
            if (dstFile.exists) {
                if (!showConfirmPopup('Rename', `Overwrite "${newName}"?`)) { redrawNow(); return }
            }
            if (!dstFile.exists) dstFile.mkFile()
            dstFile.bwrite(srcFile.bread())
            try { dstFile.flush() } catch (e) {}
            try { dstFile.close() } catch (e) {}
            srcFile.remove()
            refreshFilePanelCache(windowMode)
            clampCursorAfterChange()
        }
        catch (e) {
            showMessagePopup('Rename failed', e.message || ('' + e))
        }
        redrawNow()
    }

    function triggerMore() {
        if (!isEnabled('more')) return
        if (path[windowMode].length === 0) return
        const cache = getSelectedCache()
        if (!cache || !cache.file) return
        hooks.onMore(cache, nav)
    }

    function invokeAction(id) {
        if (!isEnabled(id)) return // single source of truth; act* self-gate too
        if      (id === 'switch') hooks.onSwitchPanel()
        else if (id === 'up')     actGoUp()
        else if (id === 'copy')   actCopy()
        else if (id === 'move')   actMove()
        else if (id === 'delete') actDelete()
        else if (id === 'mkdir')  actMkdir()
        else if (id === 'rename') actRename()
        else if (id === 'more')   triggerMore()
        else if (id === 'quit')   hooks.onQuit()
    }

    ///////////////////////////////////////////////////////////////////////////
    // Mouse regions for the file list (wheel scroll + per-row hover/click).
    // The op-panel buttons are the host's responsibility.
    ///////////////////////////////////////////////////////////////////////////

    function setupMouseRegions(fp) {
        const fpX = fp.x + 1
        const fpW = fp.width - 2
        const fpY = fp.y + 2  // first file row (after frame top + header)

        // Wheel-scroll over the file list. Wheel and keyboard are the only inputs allowed
        // to move the scroll position; hover (below) only moves the caret.
        addMouseRegion(fpX, fpY, fpW, LIST_HEIGHT, {
            onWheel: (cy, cx, dy) => {
                const filesCount = dirFileList[windowMode].length
                const maxScroll = Math.max(0, filesCount - LIST_HEIGHT)
                let s = scroll[windowMode] + dy * 3
                if (s > maxScroll) s = maxScroll
                if (s < 0) s = 0
                if (s !== scroll[windowMode]) {
                    scroll[windowMode] = s
                    drawActivePanel()
                }
            }
        })

        // One hover/click region per row so the caret can follow the mouse without
        // calling scrollVert (which would re-scroll the list near the upper/lower thirds).
        for (let i = 0; i < LIST_HEIGHT; i++) {
            const rowIdx = i
            addMouseRegion(fpX, fpY + i, fpW, 1, {
                onHover: () => {
                    const target = scroll[windowMode] + rowIdx
                    if (target < dirFileList[windowMode].length && cursor[windowMode] !== target) {
                        cursor[windowMode] = target
                        drawActivePanel()
                    }
                },
                onClick: (cy, cx, btn) => {
                    const target = scroll[windowMode] + rowIdx
                    if (target >= dirFileList[windowMode].length) return
                    if (btn === 1) {
                        cursor[windowMode] = target
                        activate()
                    }
                    else if (btn === 2) {
                        cursor[windowMode] = target
                        drawActivePanel()
                        triggerMore()
                    }
                }
            })
        }
    }

    const nav = {
        get windowMode() { return windowMode },
        get singlePanel() { return singlePanel },
        setWindowMode(m) { if (!singlePanel) windowMode = m },
        getPath(side) { return path[side] },
        isEnabled,
        filesPanelDraw,
        filenavOninput,
        refreshFilePanelCache,
        refreshActivePanel,
        setupMouseRegions,
        invokeAction,
        runChild,
        activate,
        getCurrentDirStr,
        getSelectedCache,
        clampCursorAfterChange,
    }
    return nav
}

exports = { create }
