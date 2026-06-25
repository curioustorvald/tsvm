let PROMPT_TEXT = ">"
let CURRENT_DRIVE = "A"
let shell_pwd = [""]

let goInteractive = false
let goFancy = false

let DEBUG_PRINT = true

let errorlevel = 0

const termWidth = con.getmaxyx()[1]
const termHeight = con.getmaxyx()[0]
const osName = _TVDOS.variables.OS_NAME || "TVDOS"
const welcome_text = (termWidth > 40) ? `${osName}, version ${_TVDOS.VERSION}`
    : `${osName} ${_TVDOS.VERSION}`
const greetLeftPad = (termWidth - welcome_text.length - 6) >> 1
const greetRightPad = termWidth - greetLeftPad - welcome_text.length - 6

function debugprintln(t) {
    if (DEBUG_PRINT) serial.println(t)
}

function makeHash() {
	let e = "YBNDRFG8EJKMCPQXOTLVWIS2A345H769"
	let m = e.length
	return e[Math.floor(Math.random()*m)] + e[Math.floor(Math.random()*m)] + e[Math.floor(Math.random()*m)] + e[Math.floor(Math.random()*m)] + e[Math.floor(Math.random()*m)]
}

const shellID = makeHash()

function print_prompt_text() {
    // VT pane indicator: shown for VT 2..6, not VT 1 (the default) so the
    // unmodified prompt is what users see when they never touch virtual
    // consoles. VT_NUM is set by vtmgr's pane bootstrap.
    let vtPrefix = ""
    if (typeof VT_NUM !== "undefined" && VT_NUM > 1) vtPrefix = "[" + VT_NUM + "] "
    if (goFancy) {
        if (vtPrefix) {
            con.color_pair(161,253)
            print(`\u00DD${VT_NUM}`)
            con.color_pair(253,161)
            con.addch(16);con.curs_right()
        }
        con.color_pair(239,161)
        print(" "+CURRENT_DRIVE+":")
        con.color_pair(161,253)
        con.addch(16);con.curs_right()
        con.color_pair(240,253)
        print(" \\"+shell_pwd.join("\\").substring(1)+" ")
        if (errorlevel != 0 && errorlevel != "undefined" && errorlevel != undefined) {
            con.color_pair(166,253)
            print("["+errorlevel+"] ")
        }
        con.color_pair(253,255)
        con.addch(16);con.curs_right()
        con.addch(32);con.curs_right()
        con.color_pair(253,255)
    }
    else {
//        con.color_pair(253,255)
        if (errorlevel != 0 && errorlevel != "undefined" && errorlevel != undefined)
            print(vtPrefix + CURRENT_DRIVE + ":\\" + shell_pwd.join("\\") + " [" + errorlevel + "]" + PROMPT_TEXT)
        else
            print(vtPrefix + CURRENT_DRIVE + ":\\" + shell_pwd.join("\\") + PROMPT_TEXT)
    }
}

function greet() {
    if (goFancy) {
        con.color_pair(239,255)
        con.clear()
        con.color_pair(253,255)
        print('  ');con.addch(17);con.curs_right()
        con.color_pair(240,253)
        print(" ".repeat(greetLeftPad)+welcome_text+" ".repeat(greetRightPad))
        con.color_pair(253,255)
        con.addch(16);con.curs_right();print('  ')
        con.move(3,1)
    }
    else
        println(welcome_text)
}

function printmotd() {
    let motdFile = files.open("A:/etc/motd")
    if (!motdFile.exists) return
    let motd = motdFile.sread().trim()
    let width = con.getmaxyx()[1]

    let ts = require("typesetter")

    if (goFancy) {
        let margin = 4
        let internalWidth = width - 2*margin
        let textWidth = internalWidth - 2  // one space of padding inside each ribbon edge

        let lines = ts.typeset(motd, textWidth)
        lines.forEach(line => {
            let [cy, _cx] = con.getyx()
            con.color_pair(255,253) // ribbon edge: white text, transparent back
            con.mvaddch(cy, margin, 16); con.curs_right()
            print(' ')
            con.color_pair(240,253) // body: black text, white back
            print(line)
            con.color_pair(255,253)
            print(' ')
            con.addch(17); println()
        })
        con.reset_graphics()
    }
    else {
        println()
        let lines = ts.typeset(motd, width)
        lines.forEach(line => println(line))
    }

    println()
}

/*uninterruptible*/ function sendLcdMsg(s) {
    // making it uninterruptible
    sys.poke(-1025, (s === undefined) ? 0 : s.charCodeAt(0)|0)
    sys.poke(-1026, (s === undefined) ? 0 : s.charCodeAt(1)|0)
    sys.poke(-1027, (s === undefined) ? 0 : s.charCodeAt(2)|0)
    sys.poke(-1028, (s === undefined) ? 0 : s.charCodeAt(3)|0)
    sys.poke(-1029, (s === undefined) ? 0 : s.charCodeAt(4)|0)
    sys.poke(-1030, (s === undefined) ? 0 : s.charCodeAt(5)|0)
    sys.poke(-1031, (s === undefined) ? 0 : s.charCodeAt(6)|0)
    sys.poke(-1032, (s === undefined) ? 0 : s.charCodeAt(7)|0)
    sys.poke(-1033, (s === undefined) ? 0 : s.charCodeAt(8)|0)
    sys.poke(-1034, (s === undefined) ? 0 : s.charCodeAt(9)|0)
    sys.poke(-1035, (s === undefined) ? 0 : s.charCodeAt(10)|0)
    sys.poke(-1036, (s === undefined) ? 0 : s.charCodeAt(11)|0)
    sys.poke(-1037, (s === undefined) ? 0 : s.charCodeAt(12)|0)
    sys.poke(-1038, (s === undefined) ? 0 : s.charCodeAt(13)|0)
    sys.poke(-1039, (s === undefined) ? 0 : s.charCodeAt(14)|0)
    sys.poke(-1040, (s === undefined) ? 0 : s.charCodeAt(15)|0)
    sys.poke(-1041, (s === undefined) ? 0 : s.charCodeAt(16)|0)
    sys.poke(-1042, (s === undefined) ? 0 : s.charCodeAt(17)|0)
    sys.poke(-1043, (s === undefined) ? 0 : s.charCodeAt(18)|0)
    sys.poke(-1044, (s === undefined) ? 0 : s.charCodeAt(19)|0)
    sys.poke(-1045, (s === undefined) ? 0 : s.charCodeAt(20)|0)
    sys.poke(-1046, (s === undefined) ? 0 : s.charCodeAt(21)|0)
    sys.poke(-1047, (s === undefined) ? 0 : s.charCodeAt(22)|0)
    sys.poke(-1048, (s === undefined) ? 0 : s.charCodeAt(23)|0)
}

function trimStartRevSlash(s) {
    var cnt = 0
    while (cnt < s.length) {
        var chr = s[cnt]

        if (chr != '\\') break

        cnt += 1
    }

    return s.substring(cnt)
}

let shell = {}
shell.usrcfg = {textCol: 254}
shell.replaceVarCall = function(value) {
// syntax:
// line = literal [varcall] [literal] 
// varcall = "$" ident 
// ident = ? regex: [A-Za-z_]+ ? 
// literal = ? you know what it is ? 
    let replaceMap = []
    let varMode = false
    let sb = ''
    for (let i=0; i<value.length; i++) {
        let char = value.charAt(i)
        let cp = value.charCodeAt(i)
        if (!varMode && char == '$') {
            replaceMap.push({s:sb,r:false})
            sb = ''; varMode = true
        }
        else if (varMode && !(cp >= 48 && cp <= 57 || cp >= 65 && cp <= 90 || cp == 95 || cp >= 97 && cp <= 122)) {
            replaceMap.push({s:sb,r:true})
            sb = ''+char; varMode = false
        }
        else sb += char
    }; replaceMap.push({s:sb,r:(varMode)})

    return replaceMap.map(it => (it.r) ? _TVDOS.variables[it.s] : it.s).join('')
}
shell.getPwd = function() { return shell_pwd; }
shell.getPwdString = function() { return "\\" + (shell_pwd.concat([""])).join("\\"); }
shell.getCurrentDrive = function() { return CURRENT_DRIVE; }
shell.runningScriptPaths = []
shell.getFilePath = function() {
    return shell.runningScriptPaths[shell.runningScriptPaths.length - 1]
}
shell.getFileDir = function() {
    let p = shell.runningScriptPaths[shell.runningScriptPaths.length - 1]
    if (p === undefined) return undefined
    let lastSlash = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
    if (lastSlash < 0) return p
    // root of a drive (e.g. "A:\foo.js" -> "A:\")
    if (lastSlash === 2 && p[1] === ':') return p.substring(0, 3)
    return p.substring(0, lastSlash)
}
// example input: echo "the string" > subdir\test.txt
shell.parse = function(input) {
    let tokens = []
    let stringBuffer = ""
    let mode = "LITERAL"; // LITERAL, QUOTE, ESCAPE, LIMBO, OP
    let i = 0
    while (i < input.length) {
        const c = input[i]
/*digraph g {
	LITERAL -> QUOTE [label="\""]
	LITERAL -> OP [label="pipe"]
	LITERAL -> LIMBO [label="space"]
	LITERAL -> LITERAL [label=else]

	QUOTE -> LIMBO [label="\""]
	QUOTE -> ESCAPE [label="\\"]
	QUOTE -> QUOTE [label=else]

	ESCAPE -> QUOTE

	LIMBO -> LITERAL [label="not space"]
	LIMBO -> QUOTE [label="\""]
	LIMBO -> LIMBO [label="space"]
	LIMBO -> OP [label="pipe"]

	OP -> QUOTE [label="\""]
	OP -> LIMBO [label="space"]
    OP -> LITERAL [label=else]
}*/
        if ("LITERAL" == mode) {
            if (' ' == c) {
                tokens.push(stringBuffer); stringBuffer = ""
                mode = "LIMBO"
            }
            else if ('"' == c) {
                tokens.push(stringBuffer); stringBuffer = ""
                mode = "QUOTE"
            }
            else if ('|' == c || '>' == c || '&' == c || '<' == c) {
                tokens.push(stringBuffer); stringBuffer = ""
                mode = "OP"
            }
            else {
                stringBuffer += c
            }
        }
        else if ("LIMBO" == mode) {
            if ('"' == c) {
                mode = "QUOTE"
            }
            else if ('|' == c || '>' == c || '&' == c || '<' == c) {
                mode = "OP"
                stringBuffer += c
            }
            else if (c != ' ') {
                mode = "LITERAL"
                stringBuffer += c
            }
        }
        else if ("QUOTE" == mode) {
            if ('"' == c) {
                tokens.push(stringBuffer); stringBuffer = ""
                mode = "LIMBO"
            }
            else if ('^' == c) {
                mode = "ESCAPE"
            }
            else {
                stringBuffer += c
            }
        }
        else if ("OP" == mode) {
            if (' ' == c) {
                tokens.push(stringBuffer); stringBuffer = ""
                mode = "LIMBO"
            }
            else if ('|' == c || '>' == c || '&' == c || '<' == c) {
                stringBuffer += c
            }
            else if ('"' == c) {
                tokens.push(stringBuffer); stringBuffer = ""
                mode = "QUOTE"
            }
            else {
                tokens.push(stringBuffer); stringBuffer = ""
                mode = "LITERAL"
            }
        }
        else if ("ESCAPE" == mode) {
            TODO()
        }

        i += 1
    }

    if (stringBuffer.length > 0) {
        tokens.push(stringBuffer)
    }

    return tokens
}
/** @return fully resolved path, starting with '\' but not a drive letter */
shell.resolvePathInput = function(input) {
    if (input === undefined) return undefined


    // replace slashes
    let pathstr0 = input.replaceAll('\\','/') // JS thinks '/' as a regex, so we're doing this to circumvent the issue
    let pathstr = ''
    let driveLetter = CURRENT_DRIVE

    // if input has no drive letter?
    if (pathstr0[2] != '/' && pathstr0[2] != '\\') {
        pathstr = pathstr0
    }
    else {
        pathstr = pathstr0.substring(2)
        driveLetter = pathstr0[0].toUpperCase()
    }


//    debugprintln("command.js > resolvePathInput > sanitised input: "+pathstr)

    let startsWithSlash = pathstr.startsWith('/')
    let newPwd = []

//    debugprintln("command.js > resolvePathInput > path starts with slash: "+startsWithSlash)

    // split them into an array while filtering empty elements except for the root 'head'
    let ipwd = (startsWithSlash ? [""] : shell_pwd).concat(pathstr.split("/").filter(function(it) { return (it.length > 0); }))

//    debugprintln("command.js > resolvePathInput > ipwd = "+ipwd)
//    debugprintln("command.js > resolvePathInput > newPwd = "+newPwd)

    // process dots
    ipwd.forEach(function(it) {
//        debugprintln("command.js > resolvePathInput > ipwd.forEach > it = "+it)
        if (it === ".." && newPwd[1] !== undefined) {
            newPwd.pop()
        }
        else if (it !== ".." && it !== ".") {
            newPwd.push(it)
        }
//        debugprintln("command.js > resolvePathInput > newPwd = "+newPwd)
    })

    // construct new pathstr from pwd arr so it will be sanitised
    pathstr = '\\' + newPwd.join('\\').substring(1) // dirty hack to make sure slash is prepended even if newPwd is one elem long

    return { string: pathstr, pwd: newPwd, drive: driveLetter, full: `${driveLetter}:${pathstr}` }
}
shell.isValidDriveLetter = function(l) {
    if (typeof l === 'string' || l instanceof String) {
        let lc = l.charCodeAt(0)
        return (l == '$' || 65 <= lc && lc <= 90 || 97 <= lc && lc <= 122)
    }
    else return false
}
shell.coreutils = {
/* Args follow this format:
 * <command-name> <1st arg> <2nd arg> ...
 * NOTE:
 *   even if there's no 1st arg, length of args may not be 1, therefore don't:
 *     if (args.length < 2)
 *   but do instead:
 *     if (args[1] === undefined)
 */

    cat: function(args) {
        let pathstr = (args[1] !== undefined) ? args[1] : shell.getPwdString()
        let resolvedPath = shell.resolvePathInput(pathstr)

        let file = files.open(resolvedPath.full)

        if (!file.exists) { printerrln("File not found"); return 1 }
        let contents = file.sread()
        // TODO deal with pipes
        print(contents)
        file.close()
    },
    cd: function(args) {
        if (args[1] === undefined) {
            println(CURRENT_DRIVE+":"+shell_pwd.join("/"))
            return
        }
        let path = shell.resolvePathInput(args[1])
        debugprintln("command.js > cd > pathstr = "+path.string)

        // check if path is valid
        let file = files.open(path.full)
        if (!file.isDirectory) { printerrln(`${args[0].toUpperCase()} failed for '${path.full}'`); return 1; } // if file is not opened, IO error code will be returned
        shell_pwd = path.pwd
    },
    cls: function(args) {
        con.clear()
        graphics.clearPixels(255)
        graphics.clearPixels2(240)
    },
    cp: function(args) {
        if (args[2] === undefined || args[1] === undefined) {
            printerrln(`Usage: ${args[0].toUpperCase()} source_file destination_file`)
            return
        }
        let path = shell.resolvePathInput(args[1])
        let pathd = shell.resolvePathInput(args[2])
        let sourceFile = files.open(path.full)
        let destFile = files.open(pathd.full)

        debugprintln(`[cp] source path: ${path.full}`)
        debugprintln(`[cp] dest path: ${pathd.full}`)

        if (sourceFile.isDirectory || !sourceFile.exists) { printerrln(`${args[0].toUpperCase()} failed for '${sourceFile.fullPath}'`); return 1 } // if file is directory or failed to open, IO error code will be returned
        if (destFile.isDirectory) { printerrln(`${args[0].toUpperCase()} failed for '${destFile.fullPath}'`); return 1 } // if file is directory or failed to open, IO error code will be returned

        destFile.bwrite(sourceFile.bread())

        destFile.flush(); destFile.close(); sourceFile.close()
    },
    date: function(args) {
        let monthNames = ["Spring", "Summer", "Autumn", "Winter"]
        let dayNames = ["Mondag", "Tysdag", "Midtveke", "Torsdag", "Fredag", "Laurdag", "Sundag", "Verddag"]

        let msec = sys.currentTimeInMills()
        while (msec == 0) {
            msec = sys.currentTimeInMills()
        }

        let secs = ((msec / 1000)|0) % 60
        let timeInMinutes = ((msec / 60000)|0)
        let mins = timeInMinutes % 60
        let hours = ((timeInMinutes / 60)|0) % 24
        let ordinalDay = ((timeInMinutes / (60*24))|0) % 120
        let visualDay = (ordinalDay % 30) + 1
        let months = ((timeInMinutes / (60*24*30))|0) % 4
        let dayName = ordinalDay % 7 // 0 for Mondag
        if (ordinalDay == 119) dayName = 7 // Verddag
        let years = ((timeInMinutes / (60*24*30*120))|0) + 125

        println(`\xE7${years} ${monthNames[months]} ${visualDay} ${dayNames[dayName]}, ${(''+hours).padStart(2,'0')}:${(''+mins).padStart(2,'0')}:${(''+secs).padStart(2,'0')}`)
    },
    dir: function(args) {
        let currentPath = (args[1] !== undefined) ? args[1] : shell.getPwdString()
        let currentDir = files.open(`${CURRENT_DRIVE}:\\${currentPath}`)
        let fileList = currentDir.list()

        let fileCnt = 0
        let dirCnt = 0

        println(`Current directory: ${currentDir.fullPath}`)
        fileList.forEach(it => {
            println(`${it.name.padEnd(termWidth / 2, ' ')}${it.size}`)
            if (it.isDirectory)
                dirCnt += 1
            else
                fileCnt += 1
        })


        // print file/dir count
        println(`\n${fileCnt} Files, ${dirCnt} Directories`)

        // print disk usage, if available
        if (currentDir.driverID == "SERIAL") {
            let port = _TVDOS.DRV.FS.SERIAL._toPorts(currentDir.driveLetter)
            _TVDOS.DRV.FS.SERIAL._flush(port[0]);_TVDOS.DRV.FS.SERIAL._close(port[0])
            com.sendMessage(port[0], "USAGE")
            let response = com.getStatusCode(port[0])
            if (0 == response) {
                let rawStr = com.fetchResponse(port[0]).split('/') // USED1234/TOTAL23412341
                let usedBytes = (rawStr[0].substring(4))|0
                let totalBytes = (rawStr[1].substring(5))|0
                let freeBytes = totalBytes - usedBytes
                println(`Disk used ${usedBytes} bytes, ${freeBytes} bytes free of ${totalBytes} bytes`)
            }
        }
    },
    del: function(args) {
        if (args[1] === undefined) {
            printerrln(`Usage: ${args[0].toUpperCase()} file_to_delete`)
            return
        }

        let file = files.open(shell.resolvePathInput(args[1]).full)
        if (!file.exists) { printerrln("File not found"); return 1 }
        let removalStatus = file.remove()
        if (removalStatus != 0) { printerrln("File removal failed"); return removalStatus }
    },
    echo: function(args) {
        if (args[1] !== undefined) {
            args.forEach(function(it,i) { if (i > 0) print(shell.replaceVarCall(it)+" ") })
        }
        println()
    },
    exit: function(args) {
        cmdExit = true
    },
    mkdir: function(args) {
        if (args[1] === undefined) {
            printerrln(`Usage: ${args[0].toUpperCase()} directory_name_to_create`)
            return
        }
        let path = shell.resolvePathInput(args[1])
        let file = files.open(path.full)
        debugprintln("command.js > mkdir > pathstr = "+path.full)

        // check if path is valid
        if (!file.exists) {
            let mkdird = file.mkDir()
            if (!mkdird) { printerrln(`${args[0].toUpperCase()} failed for '${path.full}'`); return 1 }
        }
        else return 1
    },
    mv: function(args) {
        if (args[2] === undefined || args[1] === undefined) {
            printerrln(`Usage: ${args[0].toUpperCase()} source_file destination_file`)
            return
        }
        let path = shell.resolvePathInput(args[1])
        let pathd = shell.resolvePathInput(args[2])
        let sourceFile = files.open(path.full)
        let destFile = files.open(pathd.full)

        debugprintln(`[mv] source path: ${path.full}`)
        debugprintln(`[mv] dest path: ${pathd.full}`)

        if (sourceFile.isDirectory || !sourceFile.exists) { printerrln(`${args[0].toUpperCase()} failed for '${sourceFile.fullPath}'`); return 1 } // if file is directory or failed to open, IO error code will be returned
        if (destFile.isDirectory) { printerrln(`${args[0].toUpperCase()} failed for '${destFile.fullPath}'`); return 1 } // if file is directory or failed to open, IO error code will be returned

        destFile.bwrite(sourceFile.bread())

        destFile.flush(); destFile.close()
        sourceFile.remove()
    },
    rem: function(args) {
        return 0
    },
    set: function(args) {
        // print all the env vars
        if (args[1] === undefined) {
            Object.entries(_TVDOS.variables).forEach(function(a) { println(a[0]+"="+a[1]) })
        }
        else {
            // parse key-value pair with splitter '='
            var key = undefined; var value = undefined
            // if syntax "<key> = <value>" is used?
            if ('=' == args[2]) {
                key = args[1].toUpperCase(); value = args[3]
            }
            else if (args[2] === undefined) {
                var pair = args[1].split('=')
                key = pair[0].toUpperCase(); value = pair[1]
            }

            if (key == undefined) throw SyntaxError("Input format must be 'key=value'")

            // if value is undefined, show what envvar[key] has
            if (value === undefined) {
                if (_TVDOS.variables[key] === undefined)
                    println("Environment variable '"+key+"' not found")
                else
                    println(_TVDOS.variables[key])
            }
            else {
                _TVDOS.variables[key] = shell.replaceVarCall(value)

                // if key is KEYBOARD, reload the keyboard layout
                if ("KEYBOARD" == key)
                    input.changeKeyLayout(_TVDOS.variables.KEYBOARD || "us_qwerty")
            }
        }
    },
    ver: function(args) {
        println(welcome_text)
    },
    which: function(args) {
        if (args[1] === undefined) {
            printerrln(`Usage: ${args[0].toUpperCase()} program_name`)
            return 1
        }
        let cmd = args[1]

        if (shell.coreutils[cmd.toLowerCase()] !== undefined) {
            println(`${cmd}: shell built-in command`)
            return 0
        }

        var fileExists = false
        var searchFile
        var searchPath = ""

        if (shell.isValidDriveLetter(cmd[0]) && cmd[1] == ':') {
            searchFile = files.open(cmd)
            searchPath = trimStartRevSlash(searchFile.path)
            fileExists = searchFile.exists
        }
        else {
            var searchDir = (cmd.startsWith("/")) ? [""] : ["/"+shell_pwd.join("/")].concat(_TVDOS.getPath())

            var pathExt = []
            if (cmd.split(".")[1] === undefined)
                _TVDOS.variables.PATHEXT.split(';').forEach(function(it) { pathExt.push(it); pathExt.push(it.toUpperCase()); })
            else
                pathExt.push("")

            searchLoop:
            for (var i = 0; i < searchDir.length; i++) {
                for (var j = 0; j < pathExt.length; j++) {
                    let search = searchDir[i]; if (!search.endsWith('\\')) search += '\\'
                    searchPath = trimStartRevSlash(search + cmd + pathExt[j])

                    searchFile = files.open(`${CURRENT_DRIVE}:\\${searchPath}`)
                    if (searchFile.exists) {
                        fileExists = true
                        break searchLoop
                    }
                }
            }
        }

        if (!fileExists) {
            printerrln(`${cmd}: not found`)
            return 1
        }

        println(searchFile.fullPath)
        return 0
    },
    panic: function(args) {
        throw Error("Panicking command.js")
    },
    chvt: function(args) {
        // Request a switch to another virtual console. Only meaningful when
        // running inside a pane spawned by vtmgr (VT_CTRL_ADDR is set by the
        // pane bootstrap). Outside that environment this is a no-op error.
        if (args[1] === undefined) { printerrln("Usage: chvt N (1..6)"); return 1 }
        let n = parseInt(args[1])
        if (isNaN(n) || n < 1 || n > 6) { printerrln("chvt: N must be in 1..6"); return 1 }
        if (typeof VT_CTRL_ADDR === "undefined") {
            printerrln("chvt: not running under vtmgr (no VT context)"); return 1
        }
        // CTRL_SWITCH_REQUEST is byte +1 of the shared CTRL area. Dispatcher
        // picks this up on its next 30 Hz tick and performs the switch.
        sys.poke(VT_CTRL_ADDR + 1, n)
        return 0
    }
}
// define command aliases here
shell.coreutils.chdir = shell.coreutils.cd
shell.coreutils.copy = shell.coreutils.cp
shell.coreutils.erase = shell.coreutils.del
shell.coreutils.rm = shell.coreutils.del
shell.coreutils.ls = shell.coreutils.dir
shell.coreutils.time = shell.coreutils.date
shell.coreutils.md = shell.coreutils.mkdir
shell.coreutils.move = shell.coreutils.mv
shell.coreutils.where = shell.coreutils.which
// end of command aliases
Object.freeze(shell.coreutils)
shell.stdio = {
    out: {
        // When running inside a vtmgr virtual console, __VT_OUT routes output
        // to the pane's text-plane buffer instead of the physical GPU (which
        // the compositor would otherwise overwrite). Outside a VT the hook is
        // absent and these fall through to sys.print exactly as before.
        print:      function(s) { if (globalThis.__VT_OUT) globalThis.__VT_OUT.print(s); else sys.print(s) },
        println:    function(s) { if (globalThis.__VT_OUT) globalThis.__VT_OUT.println(s); else { if (s === undefined) sys.print("\n"); else sys.print(s+"\n") } },
        printerr:   function(s) { if (globalThis.__VT_OUT) globalThis.__VT_OUT.printerr(s); else sys.print("\x1B[31m"+s+"\x1B[m") },
        printerrln: function(s) { if (globalThis.__VT_OUT) globalThis.__VT_OUT.printerrln(s); else { if (s === undefined) sys.print("\n"); else sys.print("\x1B[31m"+s+"\x1B[m\n") } },
    },
    pipe: {
        print:      function(s) { if (shell.getPipe() === undefined) throw Error("No pipe opened"); shell.appendToCurrentPipe(s);  },
        println:    function(s) { if (shell.getPipe() === undefined) throw Error("No pipe opened"); if (s === undefined) shell.appendToCurrentPipe("\n"); else shell.appendToCurrentPipe(s+"\n") },
        printerr:   function(s) { if (shell.getPipe() === undefined) throw Error("No pipe opened"); shell.appendToCurrentPipe("\x1B[31m"+s+"\x1B[m") },
        printerrln: function(s) { if (shell.getPipe() === undefined) throw Error("No pipe opened"); if (s === undefined) shell.appendToCurrentPipe("\n"); else shell.appendToCurrentPipe("\x1B[31m"+s+"\x1B[m\n") },
    }
}
Object.freeze(shell.stdio)
// install an improved version of require that takes care of relative path
shell.require = require
require = function(path) {
    // absolute path?
    if (path[1] == ":") return shell.require(path)
    else {
        // if the path starts with ".", look for the current directory
        // if the path starts with [A-Za-z0-9], search through INCLPATH
        if (path[0] == '.') return shell.require(shell.resolvePathInput(path).full + ".mjs")
        else {
            let inclDirs = (_TVDOS.variables.INCLPATH || "").split(';').filter(function(it) { return it.length > 0 })
            for (let i = 0; i < inclDirs.length; i++) {
                let dir = inclDirs[i]
                if (!dir.endsWith('\\') && !dir.endsWith('/')) dir += '\\'
                let candidate = `${CURRENT_DRIVE}:${dir}${path}.mjs`
                if (files.open(candidate).exists) return shell.require(candidate)
            }
            // no match found; defer to shell.require with the first entry so the error mentions a sensible path
            let firstDir = inclDirs[0] || `${_TVDOS.variables.DOSDIR}\\include`
            if (!firstDir.endsWith('\\') && !firstDir.endsWith('/')) firstDir += '\\'
            return shell.require(`${CURRENT_DRIVE}:${firstDir}${path}.mjs`)
        }
    }
}

shell.execute = function(line, nameOverride, inheritedOp) {
    if (0 == line.size) return
    let parsedTokens = shell.parse(line) // echo, "hai", |, less
    let statements = [] // [[echo, "hai"], [less]]
    let operators = [] // [|]

    let opRegex = /[|>&<]/
    let stmtBuf = []
    parsedTokens.forEach((tok, i) => {
        if (tok.match(opRegex)) {
            operators.push(tok)
            statements.push(stmtBuf.slice())
            stmtBuf = []
        }
        else {
            stmtBuf.push(tok)
        }
    })
    if (stmtBuf[0] !== undefined) {
        statements.push(stmtBuf.slice())
    }

    let retValue = undefined // return value of the previous statement
    for (let c = 0; c < statements.length; c++) {
        let tokens = statements[c]


        if (retValue) {
            debugprintln(`[shell.execute] previous statement "${statements[c - 1].join(' ')}" had non-zero errorlevel: ${retValue}, raising error...`)
            return retValue
        }

        let op = operators[c]

        // When this is a nested alias expansion (inheritedOp set), the alias body's
        // LAST statement inherits the parent's pipe operator, so the alias's output
        // still flows into the surrounding pipeline instead of falling back to stdout.
        // (The pipe itself was already pushed by the parent statement, so we must NOT
        // push another here — only the print binding follows the effective op.)
        let effectiveOp = (op === undefined && inheritedOp !== undefined && c === statements.length - 1) ? inheritedOp : op

        // TODO : if operator is not undefined, swap built-in print functions with ones that 'prints' on pipes instead of stdout
        if (op == '|') {
            debugprintln(`Statement #${c+1}: pushing anon pipe`)
            shell.pushAnonPipe('')
        }

        if (effectiveOp == '|') {
            print = shell.stdio.pipe.print
            println = shell.stdio.pipe.println
            printerr = shell.stdio.pipe.printerr
            printerrln = shell.stdio.pipe.printerrln
        }
        else {
            // pipe destruction is at the very bottom
            print = shell.stdio.out.print
            println = shell.stdio.out.println
            printerr = shell.stdio.out.printerr
            printerrln = shell.stdio.out.printerrln
        }



        let cmd = tokens[0]
        if (cmd === undefined || cmd === '') {
            retValue = 0
            continue
        }

        // handle Ctrl-C
        if (con.hitterminate()) {
            retValue = 1
            continue
        }

        if (shell.coreutils[cmd.toLowerCase()] !== undefined) {
            try {
                var retval = shell.coreutils[cmd.toLowerCase()](tokens)
                retValue = retval|0 // return value of undefined will cast into 0
            }
            catch {
                if (!retValue) retValue = 1
            }
            continue
        }
        else {
            // search through PATH for execution

            var fileExists = false
            var searchFile;
            var searchPath = "";

            // if the file is absolute path:
            if (shell.isValidDriveLetter(cmd[0]) && cmd[1] == ':') {
                searchFile = files.open(cmd)
                searchPath = trimStartRevSlash(searchFile.path)
                fileExists = searchFile.exists
            }
            // else
            else {
                var searchDir = (cmd.startsWith("/")) ? [""] : ["/"+shell_pwd.join("/")].concat(_TVDOS.getPath())

                var pathExt = [] // it seems Nashorn does not like 'let' too much? this line gets ignored sometimes
                // fill pathExt using %PATHEXT% but also capitalise them
                if (cmd.split(".")[1] === undefined)
                    _TVDOS.variables.PATHEXT.split(';').forEach(function(it) { pathExt.push(it); pathExt.push(it.toUpperCase()); })
                else
                    pathExt.push("") // final empty extension

                searchLoop:
                for (var i = 0; i < searchDir.length; i++) {
                    for (var j = 0; j < pathExt.length; j++) {
                        let search = searchDir[i]; if (!search.endsWith('\\')) search += '\\'
                        searchPath = trimStartRevSlash(search + cmd + pathExt[j])

    //                    debugprintln("[shell.execute] file search path: "+searchPath)

                        searchFile = files.open(`${CURRENT_DRIVE}:\\${searchPath}`)
                        if (searchFile.exists) {
                            fileExists = true
                            break searchLoop
                        }
                    }
                }
            }

            if (!fileExists) {
                printerrln('Bad command or filename: "'+cmd+'"')
                retValue = 127
                continue
            }
            else {
                let programCode = searchFile.sread()
                let extension = searchFile.extension.toUpperCase()

                shell.runningScriptPaths.push(searchFile.fullPath)
                try {
                if ("BAT" == extension) {
                    // parse and run as batch file
                    var lines = programCode.split('\n').filter(function(it) { return it.length > 0 }) // this return is not shell's return!
                    lines.forEach(function(line) {
                        shell.execute(line)
                    })
                }
                else if ("ALIAS" == extension) {
                    // parse alias
                    // $0: all arguments
                    // $1..9: specific arguments
                    // Tokens that contain whitespace or shell metacharacters must be re-quoted
                    // before re-execution, otherwise the re-parse splits them on spaces.
                    var quoteAliasArg = function(s) {
                        if (s === undefined || s === null) return ""
                        s = ''+s
                        if (s.length === 0) return ""
                        if (/[\s"|><&]/.test(s)) return '"' + s.replaceAll('"', '^"') + '"'
                        return s
                    }
                    var lines = programCode.split('\n').filter(function(it) { return it.length > 0 }) // this return is not shell's return!
                    lines.forEach(function(line) {
                        var newLine = line

                        // replace $1..$9
                        for (let j = 1; j <= 9; j++) {
                            newLine = newLine.replaceAll('$'+j, quoteAliasArg(tokens[j]))
                        }

                        // replace $0
                        newLine = newLine.replaceAll('$0', tokens.slice(1).map(quoteAliasArg).join(' '))

                        // Propagate this statement's operator so an alias on the left of a
                        // pipe (e.g. "hop ls | less") feeds its output into the pipe instead
                        // of stdout, and so the nested call does not flush the parent pipeline.
                        shell.execute(newLine, cmd, op)
                    })
                }
                else if ("APP" == extension) {
                    let appexec = `A:${_TVDOS.variables.DOSDIR}\\sbin\\appexec.js`
                    let foundFile = searchFile.fullPath

//                    println(`${appexec} ${foundFile} ${parsedTokens.tail().join(' ')}`)
                    shell.execute(`${appexec} ${foundFile} ${parsedTokens.tail().join(' ')}`)
                }
                else {
                    let gotError = false

                    try {
                        errorlevel = 0 // reset the number

                        if (_G.shellProgramTitles === undefined) _G.shellProgramTitles = []
                        if (nameOverride !== undefined) {
                            tokens[0] = (''+nameOverride)
                            cmd = tokens[0]
                        }
                        _G.shellProgramTitles.push(cmd.toUpperCase())
                        sendLcdMsg(_G.shellProgramTitles[_G.shellProgramTitles.length - 1])
                        //serial.println(_G.shellProgramTitles)

                        debugprintln("[shell.execute] exec app " + searchFile.fullPath)
                        errorlevel = execApp(programCode, tokens, `tvdosExec$${cmd}$${searchPath}`.replaceAll(/[^A-Za-z0-9_]/g, "$")) // return value of undefined will cast into 0
                    }
                    catch (e) {
                        gotError = true

                        // A host (Java) exception has no JS `.stack`, so `e.stack` alone is
                        // "(stack trace unavailable)". Recover the real host trace (to stderr + string).
                        let hostTrace = ""
                        try { hostTrace = sys.printStackTrace(e) } catch (_) {}
                        serial.printerr(`[command.js] program quit with ${e}:\n${e.stack || hostTrace || '(stack trace unavailable)'}`)
                        printerrln(`Program quit with ${e}:\n${e.stack || hostTrace || '(stack trace unavailable)'}`)

                        if (`${e}`.startsWith("InterruptedException"))
                            errorlevel = SIGTERM.name
                        else if (e instanceof IllegalAccessException || `${e}`.startsWith("net.torvald.tsvm.ErrorIllegalAccess"))
                            errorlevel = SIGSEGV.name

                        // exception catched means something went wrong, so if errorlevel is found to be zero, force set to 1.
                        if (errorlevel === 0 || errorlevel == undefined)
                            errorlevel = 1
                    }
                    finally {
                        debugprintln("[shell.execute] exec app " + searchFile.fullPath + " exit with no exception; errorlevel = " + errorlevel)

                        // sometimes no-error program may return nothing as the errorlevel; force set to 0 then.
                        if (!gotError && (errorlevel == undefined || (typeof errorlevel.trim == "function" && errorlevel.trim().length == 0) || isNaN(errorlevel)))
                            errorlevel = 0

                        debugprintln(`[shell.execute] errorlevel: ${errorlevel}`)

                        _G.shellProgramTitles.pop()
                        sendLcdMsg(_G.shellProgramTitles[_G.shellProgramTitles.length - 1])
                        //serial.println(_G.shellProgramTitles)

                        retValue = errorlevel
                        continue
                    }
                }
                } finally {
                    shell.runningScriptPaths.pop()
                }
            }
        }


        // destroy pipe if operator is not pipe (use effectiveOp so a nested alias's
        // last statement leaves the inherited parent pipe intact for the next stage)
        if (effectiveOp != "|" && effectiveOp != ">>" && effectiveOp != ">") {
            debugprintln(`Statement #${c+1}: destroying pipe`)
            debugprintln(`its content was: ${shell.removePipe()}`)
        }
    }
    serial.println("[shell.execute] final retvalue: "+retValue)

    // flush pipes — but only at the top level; a nested alias expansion must leave
    // the surrounding pipeline's pipes untouched for the parent to consume.
    if (inheritedOp === undefined) {
        while (1) { if (undefined === shell.removePipe()) break }
    }

    return retValue
}
shell.pipes = {} // syntax: _G.shell.pipes[name] = contents; all pipes are named pipes just like in Windows
shell.currentlyActivePipes = [] // Queue of pipe's names. Use shell.removePipe() to dequeue and shell.pushPipe() to enqueue.
shell._rndstr = '0123456789+qwfpgjluyarstdhneiozxcvbkm&QWFPGJLUYARSTDHNEIOZXCVBKM'
shell.generateAnonPipeName = function() {
    let name = ''
    while (true) {
        name = "anonpipe_"
        for (let k = 0; k < 32; k++) {
            name += shell._rndstr[(Math.random() * 64)|0]
        }
        if (shell.pipes[name] == undefined) break
    }
    return name
}
shell.getPipe = function() {
    let n = shell.currentlyActivePipes[0]
    return (n != undefined) ? shell.pipes[n] : undefined
}
shell.appendToCurrentPipe = function(s) {
    let n = shell.currentlyActivePipes[0]
    let content = (n != undefined) ? shell.pipes[n] : undefined
    shell.pipes[n] = content += s
}
shell.pushAnonPipe = function(contents) {
    let name = shell.generateAnonPipeName()
    shell.pushPipe(name, contents)
}
shell.pushPipe = function(name, contents) {
    shell.pipes[name] = contents
    shell.currentlyActivePipes.unshift(name)
}
shell.hasPipe = function() {
    return shell.currentlyActivePipes[0] != undefined
}
shell.removePipe = function() {
    let n = shell.currentlyActivePipes.shift()
    return (n != undefined) ? shell.pipes[n] : undefined
}
Object.freeze(shell)
_G.shell = shell

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// TAB AUTOCOMPLETION
//
// Invoked by TAB at the interactive prompt. Only active when BOTH:
//   1. wintex.mjs is available (provides the selection popup), AND
//   2. goFancy == true.
// One candidate  -> expand immediately (no popup).
// Many candidates -> wintex popup; user scrolls and selects, or Esc/Cancel to
//                    discard. The popup over-draws the screen without saving
//                    what was beneath it, so we snapshot the text plane before
//                    and copy it back after (the shell can't just redraw like a
//                    full-screen TUI — there's scrollback above the prompt).
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Lazily-resolved wintex module. undefined = not probed yet, null = unavailable.
let _acWin = undefined
function getAutocompleteWin() {
    if (_acWin !== undefined) return _acWin
    _acWin = null
    try {
        let w = require("wintex") // resolved through INCLPATH (\tvdos\include\wintex.mjs)
        if (w && typeof w.showDialog === "function") _acWin = w
    } catch (e) {
        debugprintln("command.js > autocomplete: wintex unavailable: " + e)
    }
    return _acWin
}

// Lazily-resolved synopsis module (TSF loader/completion resolver). Held for
// the whole session so its in-memory cache survives across keystrokes.
// undefined = not probed yet, null = unavailable.
let _acSyn = undefined
function getSynopsisMod() {
    if (_acSyn !== undefined) return _acSyn
    _acSyn = null
    try {
        let m = require("synopsis") // resolved through INCLPATH (\tvdos\include\synopsis.mjs)
        if (m && typeof m.getCompletion === "function") _acSyn = m
    } catch (e) {
        debugprintln("command.js > autocomplete: synopsis unavailable: " + e)
    }
    return _acSyn
}

// List a directory's entries, swallowing any IO error.
function _acListDir(fullPath) {
    try {
        let f = files.open(fullPath)
        if (!f.exists || !f.isDirectory) return []
        return f.list() || []
    } catch (e) { return [] }
}

// Strip a trailing PATHEXT extension so command names show without ".js" etc.
function _acStripExt(name) {
    let lower = name.toLowerCase()
    let exts = (_TVDOS.variables.PATHEXT || "").split(';').filter(function(e){ return e.length > 0 })
    for (let i = 0; i < exts.length; i++) {
        let e = exts[i].toLowerCase()
        if (lower.endsWith(e)) return name.substring(0, name.length - e.length)
    }
    return name
}

// Candidates for the command position (first word, no path separators):
// shell built-ins + runnable files found along the current dir, drive root and PATH.
function _acCommandCandidates(prefix) {
    let lower = prefix.toLowerCase()
    let seen = {}
    let out = []
    function add(name) {
        let k = name.toLowerCase()
        if (seen[k]) return
        seen[k] = true
        out.push({ label: name, value: name + ' ', isDir: false })
    }

    // shell built-ins (and their aliases)
    Object.keys(shell.coreutils).forEach(function(k) {
        if (k.toLowerCase().startsWith(lower)) add(k)
    })

    // runnable files: search the same places shell.execute does, in the same order
    let exts = (_TVDOS.variables.PATHEXT || "").split(';')
        .filter(function(e){ return e.length > 0 }).map(function(e){ return e.toLowerCase() })
    let dirFulls = [shell.resolvePathInput('.').full] // current directory first
    _TVDOS.getPath().forEach(function(d) {
        dirFulls.push((d === '' || d === undefined) ? `${CURRENT_DRIVE}:\\` : shell.resolvePathInput(d).full)
    })
    dirFulls.forEach(function(full) {
        _acListDir(full).forEach(function(it) {
            if (it.isDirectory) return
            let nameLower = (it.name || '').toLowerCase()
            if (!exts.some(function(e){ return nameLower.endsWith(e) })) return // only runnables
            let stripped = _acStripExt(it.name)
            if (stripped.toLowerCase().startsWith(lower)) add(stripped)
        })
    })
    return out
}

// Candidates for a path argument. The word may carry a directory prefix
// (kept verbatim) and a partial basename that we match against the directory.
function _acPathCandidates(word) {
    let sepIdx = Math.max(word.lastIndexOf('\\'), word.lastIndexOf('/'))
    let dirPart, basePart, listArg
    if (sepIdx >= 0) {
        dirPart  = word.substring(0, sepIdx + 1) // includes the trailing separator
        basePart = word.substring(sepIdx + 1)
        listArg  = dirPart
    } else {
        dirPart  = ''
        basePart = word
        listArg  = '.'
    }
    let resolved = shell.resolvePathInput(listArg)
    if (resolved === undefined) return []
    let sep = (dirPart.length > 0 && dirPart.charAt(dirPart.length - 1) === '/') ? '/' : '\\'
    let lower = basePart.toLowerCase()
    let out = []
    _acListDir(resolved.full).forEach(function(it) {
        let name = it.name || ''
        if (!name.toLowerCase().startsWith(lower)) return
        out.push({
            // directories get a trailing separator so completion can continue into them;
            // files get a trailing space so the next argument can be typed straight away.
            label: name + (it.isDirectory ? '\\' : ''),
            value: dirPart + name + (it.isDirectory ? sep : ' '),
            isDir: it.isDirectory
        })
    })
    return out
}

// Candidates for an argument (not the command word). Consults the command's
// TSF synopsis (via synopsis.mjs) for option flags, enum/list values and
// subcommand names, and merges in filesystem entries when the synopsis says the
// slot expects a path/file/directory. Falls back to plain path completion when
// no synopsis exists, so behaviour is unchanged for commands without one.
function _acArgCandidates(prefix, word) {
    let syn = getSynopsisMod()
    if (syn) {
        try {
            let toks = prefix.trim().split(/\s+/)
            let cmd = toks[0]
            let argToks = toks.slice(1)
            let r = syn.getCompletion(cmd, argToks, word)
            if (r && r.ok) {
                let out = (r.candidates || []).slice()
                if (r.filesystem) {
                    _acPathCandidates(word).forEach(function(c) {
                        if (r.filesystem === 'directory' && !c.isDir) return // dirs only
                        out.push(c)
                    })
                }
                // de-dupe by the text that would be inserted
                let seen = {}, dedup = []
                out.forEach(function(c) { if (seen[c.value]) return; seen[c.value] = true; dedup.push(c) })
                return dedup
            }
        } catch (e) {
            debugprintln("command.js > _acArgCandidates: " + e)
        }
    }
    return _acPathCandidates(word)
}

// Work out what is being completed at `caret` within `line`.
// Returns { wordStart, word, candidates } (candidates sorted by label).
function computeCompletion(line, caret) {
    let wordStart = caret
    while (wordStart > 0 && line.charAt(wordStart - 1) !== ' ') wordStart -= 1
    let word = line.substring(wordStart, caret)
    let prefix = line.substring(0, wordStart)
    let isFirstWord = (prefix.trim().length === 0)
    let hasPathSep = (word.indexOf('\\') >= 0 || word.indexOf('/') >= 0 || word.indexOf(':') >= 0)
    let candidates
    if (isFirstWord)
        candidates = hasPathSep ? _acPathCandidates(word) : _acCommandCandidates(word)
    else
        candidates = _acArgCandidates(prefix, word)
    candidates.sort(function(a, b) { return (a.label < b.label) ? -1 : (a.label > b.label) ? 1 : 0 })
    return { wordStart: wordStart, word: word, candidates: candidates }
}

// --- text-plane snapshot/restore (so the popup leaves no artefacts) ---------
// In a vtmgr pane the shimmed con/print draw into the pane buffer
// (globalThis.VT_TEXT_PLANE, forward layout); on the physical console they
// draw into the GPU text area (mapped at getGpuMemBase()-253950). vaddr(0) is
// that base in either case; sys.memcpy reads/writes it forward-native.
// NOTE: 7681, not the full 7682-byte text area: relPtrInDev() bounds-checks
// `from+len` inclusively, so the final byte (bottom-right char cell, never
// touched by a centred popup) is unreachable by a single memcpy.
const _AC_TEXTAREA_BYTES = 7681
let _acTextBase = null
let _acScratchPtr = 0
function _acTextAreaBase() {
    if (_acTextBase === null) {
        _acTextBase = (typeof globalThis.VT_TEXT_PLANE !== 'undefined')
            ? globalThis.VT_TEXT_PLANE
            : (graphics.getGpuMemBase() - 253950)
    }
    return _acTextBase
}
function _acSnapshotScreen() {
    if (_acScratchPtr === 0) _acScratchPtr = sys.malloc(_AC_TEXTAREA_BYTES)
    sys.memcpy(_acTextAreaBase(), _acScratchPtr, _AC_TEXTAREA_BYTES)
}
function _acRestoreScreen() {
    if (_acScratchPtr === 0) return
    sys.memcpy(_acScratchPtr, _acTextAreaBase(), _AC_TEXTAREA_BYTES)
}

// Modal popup of candidates. Returns the chosen item, or null if discarded.
function _acShowPopup(win, candidates) {
    let res = win.showDialog({
        title: `Complete (${candidates.length})`,
        list: {
            items: candidates,
            height: Math.min(12, candidates.length),
            onActivate: function(item, idx, key) { return 'select' }
        },
        buttons: [{ label: 'Cancel', action: 'cancel' }]
    })
    if (res && res.action === 'select' && res.listItem) return res.listItem
    return null
}

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// ensure USERCONFIGPATH directory exists
try {
    let userConfigPath = `${CURRENT_DRIVE}:${_TVDOS.variables.USERCONFIGPATH}`
    let userConfigDir = files.open(userConfigPath)
    if (!userConfigDir.exists) {
        debugprintln(`command.js > creating USERCONFIGPATH at ${userConfigPath}`)
        userConfigDir.mkDir()
    }
} catch (e) {
    debugprintln("command.js > USERCONFIGPATH creation failed: " + e.message)
}

// ensure \commandrc exists. This is the environment-setup rc that TVDOS.SYS
// replays (line-by-line, via `command -c`) in every context. Self-heal a
// fresh/wiped disk by writing the stock defaults so the next boot has them.
try {
    let rcFile = files.open("A:\\commandrc")
    if (!rcFile.exists) {
        debugprintln("command.js > creating A:\\commandrc")
        rcFile.swrite(`rem commandrc -- environment setup, run by TVDOS.SYS in EVERY context
rem (the boot shell AND every virtual-console pane). Put \`set\` commands and
rem other env-only configuration here. Do NOT launch apps from this file:
rem app launches belong in AUTOEXEC.BAT (run per-console by vtmgr).

set PATH=\\hopper\\bin;$PATH
set INCLPATH=\\hopper\\include;$INCLPATH
set HELPPATH=\\hopper\\help;$HELPPATH
set KEYBOARD=us_qwerty
`)
    }
} catch (e) {
    debugprintln("command.js > commandrc creation failed: " + e.message)
}

if (exec_args[1] !== undefined) {
    // only meaningful switches would be either -c or -k anyway
    var firstSwitch = exec_args[1].toLowerCase()

    // command -c   <commands>
    // ^[0]    ^[1] ^[2]
    if ("-c" == firstSwitch) {
        if ("" == exec_args[2]) return 0 // no commands were given, just exit successfully
        return shell.execute(exec_args[2])
    }
    else if ("-k" == firstSwitch) {
        if ("" == exec_args[2]) return 0 // no commands were given, just exit successfully
        shell.execute(exec_args[2])
        goInteractive = true
    }
    else if ("-fancy" == firstSwitch) {
        graphics.setBackground(34,51,68)
        goFancy = true
        goInteractive = true
    }
    else {
        printerrln("Invalid switch: "+exec_args[1])
        return 1
    }
}
else {
    goInteractive = true
}

let cmdExit = false
if (goInteractive) {
    con.curs_set(1)
    greet()
    printmotd()

    let cmdHistory = [] // zeroth element is the oldest
    let cmdHistoryScroll = 0 // 0 for outside-of-buffer, 1 for most recent
    while (!cmdExit) {
        con.curs_set(1)
        con.color_pair(shell.usrcfg.textCol,255)
        print_prompt_text()

        var cmdbuf = ""
        var caret = 0 // insertion point within cmdbuf, 0..cmdbuf.length

        // Self-contained line editor with a movable caret (so command.js does
        // NOT depend on wintex being installed). The prompt has just been
        // printed, so the current cursor marks where the editable text begins.
        // We track that anchor and rebuild the on-screen line from it, decoding
        // line-wrap ourselves so the maths holds in both the physical console
        // and a vtmgr pane (whose con.move CLAMPS x instead of wrapping it).
        let [baseY, baseX] = con.getyx() // 1-based
        let termCols = con.getmaxyx()[1]

        // absolute (y,x) on screen for caret index `idx`
        function caretPos(idx) {
            let abs = (baseX - 1) + idx
            return [baseY + ((abs / termCols) | 0), (abs % termCols) + 1]
        }
        function gotoCaret() {
            let [cy, cx] = caretPos(caret)
            con.move(cy, cx)
        }
        // reprint cmdbuf from index `from` to the end, optionally padding with
        // `clearTrail` blanks to wipe characters left over by a now-shorter
        // line, then park the hardware cursor back on the caret.
        function refresh(from, clearTrail) {
            let [py, px] = caretPos(from)
            con.move(py, px)
            print(cmdbuf.substring(from))
            for (let i = 0; i < clearTrail; i++) print(" ")
            gotoCaret()
        }
        // replace the whole buffer (used by history recall)
        function setBuf(next) {
            let oldLen = cmdbuf.length
            cmdbuf = next
            caret = cmdbuf.length
            refresh(0, Math.max(0, oldLen - cmdbuf.length))
        }

        // Replace the word [wordStart, caret) with `value`, keeping any text to
        // the right of the caret, then reprint the line from `wordStart`.
        function applyCompletion(wordStart, value) {
            let oldLen = cmdbuf.length
            cmdbuf = cmdbuf.substring(0, wordStart) + value + cmdbuf.substring(caret)
            caret = wordStart + value.length
            con.color_pair(shell.usrcfg.textCol, 255)
            refresh(wordStart, Math.max(0, oldLen - cmdbuf.length))
        }

        // TAB handler. No-op unless fancy mode is on and wintex is installed.
        function tryAutocomplete() {
            if (!goFancy) return
            let win = getAutocompleteWin()
            if (!win) return

            let comp = computeCompletion(cmdbuf, caret)
            let cands = comp.candidates
            if (cands.length === 0) return
            if (cands.length === 1) { applyCompletion(comp.wordStart, cands[0].value); return }

            _acSnapshotScreen()
            let chosen = _acShowPopup(win, cands)
            _acRestoreScreen()

            // The popup drives input through input.withEvent (physical held-key
            // state), which bypasses the buffer con.getch reads. Inside a vtmgr
            // pane the dispatcher keeps draining physical keystrokes into this
            // pane's input ring the whole time the popup is open, so the navigation
            // keys (and the closing Enter) would otherwise surface as phantom input
            // afterwards. Flush them. (On the physical console readKey self-clears,
            // so this is harmless there.)
            con.resetkeybuf()

            // The popup hid the caret and clobbered colours; restore the prompt
            // editing state. The screen content is already back from the snapshot.
            con.curs_set(1)
            con.color_pair(shell.usrcfg.textCol, 255)
            gotoCaret()

            if (chosen) applyCompletion(comp.wordStart, chosen.value)
        }

        while (true) {
            let key = con.getch()

            // printable chars
            if (key >= 32 && key <= 126) {
                let s = String.fromCharCode(key)
                let atEnd = (caret === cmdbuf.length)
                cmdbuf = cmdbuf.substring(0, caret) + s + cmdbuf.substring(caret)
                caret += 1
                if (atEnd) print(s) // fast path: simple append
                else refresh(caret - 1, 0)
            }
            // TAB: autocomplete (fancy mode + wintex only; otherwise a no-op)
            else if (key === con.KEY_TAB) {
                tryAutocomplete()
            }
            // backspace: delete the char to the left of the caret
            else if (key === con.KEY_BACKSPACE && caret > 0) {
                cmdbuf = cmdbuf.substring(0, caret - 1) + cmdbuf.substring(caret)
                caret -= 1
                refresh(caret, 1)
            }
            // forward delete: delete the char under the caret
            else if (key === con.KEY_DELETE && caret < cmdbuf.length) {
                cmdbuf = cmdbuf.substring(0, caret) + cmdbuf.substring(caret + 1)
                refresh(caret, 1)
            }
            // caret left
            else if (key === con.KEY_LEFT) {
                if (caret > 0) { caret -= 1; gotoCaret() }
            }
            // caret right
            else if (key === con.KEY_RIGHT) {
                if (caret < cmdbuf.length) { caret += 1; gotoCaret() }
            }
            // jump to start of line
            else if (key === con.KEY_HOME) {
                caret = 0; gotoCaret()
            }
            // jump to end of line
            else if (key === con.KEY_END) {
                caret = cmdbuf.length; gotoCaret()
            }
            // enter
            else if (key === 10 || key === con.KEY_RETURN) {
                caret = cmdbuf.length; gotoCaret()
                println()

                errorlevel = shell.execute(cmdbuf)

                if (cmdbuf.trim().length > 0)
                    cmdHistory.push(cmdbuf)

                cmdHistoryScroll = 0
                con.curs_set(1)
                con.resetkeybuf()

                break
            }
            // up arrow
            else if (key === con.KEY_UP && cmdHistory.length > 0 && cmdHistoryScroll < cmdHistory.length) {
                cmdHistoryScroll += 1
                setBuf(cmdHistory[cmdHistory.length - cmdHistoryScroll])
            }
            // down arrow
            else if (key === con.KEY_DOWN) {
                if (cmdHistoryScroll > 1) {
                    cmdHistoryScroll -= 1
                    setBuf(cmdHistory[cmdHistory.length - cmdHistoryScroll])
                }
                else if (cmdHistoryScroll === 1) {
                    cmdHistoryScroll = 0
                    setBuf("")
                }
            }
        }
    }
}

return 0