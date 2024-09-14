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
    if (goFancy) {
        con.color_pair(239,161)
        print(" "+CURRENT_DRIVE+":")
        con.color_pair(161,253)
        con.addch(16);con.curs_right()
        con.color_pair(0,253)
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
            print(CURRENT_DRIVE + ":\\" + shell_pwd.join("\\") + " [" + errorlevel + "]" + PROMPT_TEXT)
        else
            print(CURRENT_DRIVE + ":\\" + shell_pwd.join("\\") + PROMPT_TEXT)
    }
}

function greet() {
    if (goFancy) {
        con.color_pair(239,255)
        con.clear()
        con.color_pair(253,255)
        print('  ');con.addch(17);con.curs_right()
        con.color_pair(0,253)
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


    if (goFancy) {
        let margin = 4
        let internalWidth = width - 2*margin

        con.color_pair(255,253) // white text, transparent back (initial ribbon)

        let [cy, cx] = con.getyx()

        con.mvaddch(cy, 4, 16);con.curs_right();print(' ')

        const PCX_INIT = margin - 2
        let tcnt = 0
        let pcx = PCX_INIT
        con.color_pair(240,253) // black text, white back (first line of text)
        while (tcnt <= motd.length) {
            let char = motd.charAt(tcnt)

            if (char != '\n') {
                // prevent the line starting from ' '
                if (pcx != PCX_INIT || char != ' ') {
                    print(motd.charAt(tcnt))
                }
                pcx += 1
            }

            if ('\n' == char || pcx % internalWidth == 0 && pcx != 0 || tcnt == motd.length) {
                // current line ending
                let [_, ncx] = con.getyx()
                for (let k = 0; k < width - margin - ncx + 1; k++) print(' ')
                con.color_pair(255,253) // white text, transparent back
                con.addch(17);println()

                if (tcnt == motd.length) break

                // next line header
                let [ncy, __] = con.getyx()
                con.color_pair(255,253) // white text, transparent back
                con.mvaddch(ncy, 4, 16);con.curs_right();print(' ');con.color_pair(240,253) // black text, white back (subsequent lines of the text)
                pcx = PCX_INIT
            }

            tcnt += 1
        }

        con.reset_graphics()
    }
    else {
        println()
        println(motd)
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
    panic: function(args) {
        throw Error("Panicking command.js")
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
// end of command aliases
Object.freeze(shell.coreutils)
shell.stdio = {
    out: {
        print:      function(s) { sys.print(s) },
        println:    function(s) { if (s === undefined) sys.print("\n"); else sys.print(s+"\n") },
        printerr:   function(s) { sys.print("\x1B[31m"+s+"\x1B[m") },
        printerrln: function(s) { if (s === undefined) sys.print("\n"); else sys.print("\x1B[31m"+s+"\x1B[m\n") },
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
        // if the path starts with [A-Za-z0-9], look for the DOSDIR/includes
        if (path[0] == '.') return shell.require(shell.resolvePathInput(path).full + ".js")
        else return shell.require(`A:${_TVDOS.variables.DOSDIR}/include/${path}.js`)
    }
}

shell.execute = function(line) {
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

        // TODO : if operator is not undefined, swap built-in print functions with ones that 'prints' on pipes instead of stdout
        if (op == '|') {
            debugprintln(`Statement #${c+1}: pushing anon pipe`)
            shell.pushAnonPipe('')

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

                if ("BAT" == extension) {
                    // parse and run as batch file
                    var lines = programCode.split('\n').filter(function(it) { return it.length > 0 }) // this return is not shell's return!
                    lines.forEach(function(line) {
                        shell.execute(line)
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
                        _G.shellProgramTitles.push(cmd.toUpperCase())
                        sendLcdMsg(_G.shellProgramTitles[_G.shellProgramTitles.length - 1])
                        //serial.println(_G.shellProgramTitles)

                        debugprintln("[shell.execute] exec app " + searchFile.fullPath)
                        errorlevel = execApp(programCode, tokens, `tvdosExec$${cmd}$${searchPath}`.replaceAll(/[^A-Za-z0-9_]/g, "$")) // return value of undefined will cast into 0
                    }
                    catch (e) {
                        gotError = true

                        serial.printerr(`[command.js] program quit with ${e}:\n${e.stack || '(stack trace unavailable)'}`)
                        printerrln(`Program quit with ${e}:\n${e.stack || '(stack trace unavailable)'}`)

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
            }
        }


        // destroy pipe if operator is not pipe
        if (op != "|" && op != ">>" && op != ">") {
            debugprintln(`Statement #${c+1}: destroying pipe`)
            debugprintln(`its content was: ${shell.removePipe()}`)
        }
    }
    serial.println("[shell.execute] final retvalue: "+retValue)

    // flush pipes
    while (1) { if (undefined === shell.removePipe()) break }

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

        while (true) {
            let key = con.getch()

            // printable chars
            if (key >= 32 && key <= 126) {
                var s = String.fromCharCode(key)
                cmdbuf += s
                print(s)
            }
            // backspace
            else if (key === con.KEY_BACKSPACE && cmdbuf.length > 0) {
                cmdbuf = cmdbuf.substring(0, cmdbuf.length - 1)
                print(String.fromCharCode(key))
            }
            // enter
            else if (key === 10 || key === con.KEY_RETURN) {
                println()

                errorlevel = shell.execute(cmdbuf)

                if (cmdbuf.trim().length > 0)
                    cmdHistory.push(cmdbuf)

                cmdHistoryScroll = 0
                con.curs_set(1)

                break
            }
            // up arrow
            else if (key === con.KEY_UP && cmdHistory.length > 0 && cmdHistoryScroll < cmdHistory.length) {
                cmdHistoryScroll += 1

                // back the cursor in order to type new cmd
                var x = 0
                for (x = 0; x < cmdbuf.length; x++) print(String.fromCharCode(8))
                cmdbuf = cmdHistory[cmdHistory.length - cmdHistoryScroll]
                // re-type the new command
                print(cmdbuf)

            }
            // down arrow
            else if (key === con.KEY_DOWN) {
                if (cmdHistoryScroll > 0) {
                    // back the cursor in order to type new cmd
                    var x = 0
                    for (x = 0; x < cmdbuf.length; x++) print(String.fromCharCode(8))
                    cmdbuf = cmdHistory[cmdHistory.length - cmdHistoryScroll]
                    // re-type the new command
                    print(cmdbuf)

                    cmdHistoryScroll -= 1
                }
                else {
                    // back the cursor in order to type new cmd
                    var x = 0
                    for (x = 0; x < cmdbuf.length; x++) print(String.fromCharCode(8))
                    cmdbuf = ""
                }
            }
        }
    }
}

return 0