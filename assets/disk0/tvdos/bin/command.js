let PROMPT_TEXT = ">";
let CURRENT_DRIVE = "A";
let shell_pwd = [""];

let goInteractive = false;
let goFancy = false;

let DEBUG_PRINT = true;

let errorlevel = 0;

const termWidth = con.getmaxyx()[1];
const termHeight = con.getmaxyx()[0];
const welcome_text = (termWidth > 40) ? "TSVM Disk Operating System, version " + _TVDOS.VERSION
    : "TSVM Disk Operating System " + _TVDOS.VERSION;
const greetLeftPad = (termWidth - welcome_text.length - 6) >> 1;
const greetRightPad = termWidth - greetLeftPad - welcome_text.length - 6;

function makeHash() {
	let e = "YBNDRFG8EJKMCPQXOTLVWIS2A345H769";
	let m = e.length;
	return e[Math.floor(Math.random()*m)] + e[Math.floor(Math.random()*m)] + e[Math.floor(Math.random()*m)] + e[Math.floor(Math.random()*m)] + e[Math.floor(Math.random()*m)]
}

const shellID = makeHash();

function print_prompt_text() {
    if (goFancy) {
        con.color_pair(239,161);
        print(" "+CURRENT_DRIVE+":");
        con.color_pair(161,253);
        con.addch(16);con.curs_right();
        con.color_pair(0,253);
        print(" /"+shell_pwd.join("/").substring(1)+" ");
        if (errorlevel != 0) {
            con.color_pair(166,253);
            print("["+errorlevel+"] ");
        }
        con.color_pair(253,255);
        con.addch(16);con.curs_right();
        con.addch(32);con.curs_right();
        con.color_pair(253,255);
    }
    else {
//        con.color_pair(253,255);
        if (errorlevel != 0)
            print(CURRENT_DRIVE + ":/" + shell_pwd.join("/") + " [" + errorlevel + "]" + PROMPT_TEXT);
        else
            print(CURRENT_DRIVE + ":/" + shell_pwd.join("/") + PROMPT_TEXT);
    }
}

function greet() {
    if (goFancy) {
        con.color_pair(239,255);
        con.clear();
        con.color_pair(253,255);
        print('  ');con.addch(17);con.curs_right();
        con.color_pair(0,253);
        print(" ".repeat(greetLeftPad)+welcome_text+" ".repeat(greetRightPad));
        con.color_pair(253,255);
        con.addch(16);con.curs_right();print('  ');
        con.move(3,1);
    }
    else
        println(welcome_text);
}

/*uninterruptible*/ function sendLcdMsg(s) {
    // making it uninterruptible
    sys.poke(-1025, (s === undefined) ? 0 : s.charCodeAt(0)|0);
    sys.poke(-1026, (s === undefined) ? 0 : s.charCodeAt(1)|0);
    sys.poke(-1027, (s === undefined) ? 0 : s.charCodeAt(2)|0);
    sys.poke(-1028, (s === undefined) ? 0 : s.charCodeAt(3)|0);
    sys.poke(-1029, (s === undefined) ? 0 : s.charCodeAt(4)|0);
    sys.poke(-1030, (s === undefined) ? 0 : s.charCodeAt(5)|0);
    sys.poke(-1031, (s === undefined) ? 0 : s.charCodeAt(6)|0);
    sys.poke(-1032, (s === undefined) ? 0 : s.charCodeAt(7)|0);
    sys.poke(-1033, (s === undefined) ? 0 : s.charCodeAt(8)|0);
    sys.poke(-1034, (s === undefined) ? 0 : s.charCodeAt(9)|0);
    sys.poke(-1035, (s === undefined) ? 0 : s.charCodeAt(10)|0);
    sys.poke(-1036, (s === undefined) ? 0 : s.charCodeAt(11)|0);
    sys.poke(-1037, (s === undefined) ? 0 : s.charCodeAt(12)|0);
    sys.poke(-1038, (s === undefined) ? 0 : s.charCodeAt(13)|0);
    sys.poke(-1039, (s === undefined) ? 0 : s.charCodeAt(14)|0);
    sys.poke(-1040, (s === undefined) ? 0 : s.charCodeAt(15)|0);
    sys.poke(-1041, (s === undefined) ? 0 : s.charCodeAt(16)|0);
    sys.poke(-1042, (s === undefined) ? 0 : s.charCodeAt(17)|0);
    sys.poke(-1043, (s === undefined) ? 0 : s.charCodeAt(18)|0);
    sys.poke(-1044, (s === undefined) ? 0 : s.charCodeAt(19)|0);
    sys.poke(-1045, (s === undefined) ? 0 : s.charCodeAt(20)|0);
    sys.poke(-1046, (s === undefined) ? 0 : s.charCodeAt(21)|0);
    sys.poke(-1047, (s === undefined) ? 0 : s.charCodeAt(22)|0);
    sys.poke(-1048, (s === undefined) ? 0 : s.charCodeAt(23)|0);
}

function trimStartRevSlash(s) {
    var cnt = 0;
    while (cnt < s.length) {
        var chr = s[cnt];

        if (chr != '\\') break;

        cnt += 1;
    }

    return s.substring(cnt);
}

let shell = {};
shell.replaceVarCall = function(value) {
// syntax:
// line = literal [varcall] [literal] ;
// varcall = "$" ident ;
// ident = ? regex: [A-Za-z_]+ ? ;
// literal = ? you know what it is ? ;
    let replaceMap = [];
    let varMode = false;
    let sb = '';
    for (let i=0; i<value.length; i++) {
        let char = value.charAt(i);
        let cp = value.charCodeAt(i);
        if (!varMode && char == '$') {
            replaceMap.push({s:sb,r:false});
            sb = ''; varMode = true;
        }
        else if (varMode && !(cp >= 48 && cp <= 57 || cp >= 65 && cp <= 90 || cp == 95 || cp >= 97 && cp <= 122)) {
            replaceMap.push({s:sb,r:true});
            sb = ''+char; varMode = false;
        }
        else sb += char;
    }; replaceMap.push({s:sb,r:(varMode)});

    return replaceMap.map(it => (it.r) ? _TVDOS.variables[it.s] : it.s).join('');
}
shell.getPwd = function() { return shell_pwd; }
shell.getPwdString = function() { return "\\" + (shell_pwd.concat([""])).join("\\"); }
shell.getCurrentDrive = function() { return CURRENT_DRIVE; }
// example input: echo "the string" > subdir\test.txt
shell.parse = function(input) {
    let tokens = [];
    let stringBuffer = "";
    let mode = "LITERAL"; // LITERAL, QUOTE, ESCAPE, LIMBO, OP
    let i = 0
    while (i < input.length) {
        const c = input[i];
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
                tokens.push(stringBuffer); stringBuffer = "";
                mode = "LIMBO";
            }
            else if ('"' == c) {
                tokens.push(stringBuffer); stringBuffer = "";
                mode = "QUOTE";
            }
            else if ('|' == c || '>' == c || '&' == c || '<' == c) {
                tokens.push(stringBuffer); stringBuffer = "";
                mode = "OP"
            }
            else {
                stringBuffer += c;
            }
        }
        else if ("LIMBO" == mode) {
            if ('"' == c) {
                mode = "QUOTE";
            }
            else if ('|' == c || '>' == c || '&' == c || '<' == c) {
                mode = "OP"
                stringBuffer += c
            }
            else if (c != ' ') {
                mode = "LITERAL";
                stringBuffer += c;
            }
        }
        else if ("QUOTE" == mode) {
            if ('"' == c) {
                tokens.push(stringBuffer); stringBuffer = "";
                mode = "LIMBO";
            }
            else if ('^' == c) {
                mode = "ESCAPE";
            }
            else {
                stringBuffer += c;
            }
        }
        else if ("OP" == mode) {
            if (' ' == c) {
                tokens.push(stringBuffer); stringBuffer = "";
                mode = "LIMBO";
            }
            else if ('|' == c || '>' == c || '&' == c || '<' == c) {
                stringBuffer += c
            }
            else if ('"' == c) {
                tokens.push(stringBuffer); stringBuffer = "";
                mode = "QUOTE";
            }
            else {
                tokens.push(stringBuffer); stringBuffer = "";
                mode = "LITERAL";
            }
        }
        else if ("ESCAPE" == mode) {
            TODO();
        }

        i += 1;
    }

    if (stringBuffer.length > 0) {
        tokens.push(stringBuffer);
    }

    return tokens;
}
shell.resolvePathInput = function(input) {
    // replace revslashes into rslashes
    var pathstr = input.replaceAll('\\','/');
    var startsWithSlash = input.startsWith('/');
    var newPwd = [];

    // split them into an array while filtering empty elements except for the root 'head'
    var ipwd = (startsWithSlash ? [""] : shell_pwd).concat(pathstr.split("/").filter(function(it) { return (it.length > 0); }));

    serial.println("command.js > resolvePathInput > ipwd = "+ipwd);
    serial.println("command.js > resolvePathInput > newPwd = "+newPwd);

    // process dots
    ipwd.forEach(function(it) {
        serial.println("command.js > resolvePathInput > ipwd.forEach > it = "+it);
        if (it === ".." && newPwd[1] !== undefined) {
            newPwd.pop();
        }
        else if (it !== ".." && it !== ".") {
            newPwd.push(it);
        }
        serial.println("command.js > resolvePathInput > newPwd = "+newPwd);
    });

    // construct new pathstr from pwd arr so it will be sanitised
    pathstr = newPwd.join('/').substring(1);

    return { string: pathstr, pwd: newPwd };
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
    cd: function(args) {
        if (args[1] === undefined) {
            println(CURRENT_DRIVE+":"+shell_pwd.join("/"));
            return
        }
        var path = shell.resolvePathInput(args[1])
        if (DEBUG_PRINT) serial.println("command.js > cd > pathstr = "+path.string);

        // check if path is valid
        var dirOpenedStatus = filesystem.open(CURRENT_DRIVE, path.string, 'R');
        var isDir = filesystem.isDirectory(CURRENT_DRIVE); // open a dir; if path is nonexistent, file won't actually be opened
        if (!isDir) { printerrln("CHDIR failed for '"+path.string+"'"); return dirOpenedStatus; } // if file is not opened, IO error code will be returned

        shell_pwd = path.pwd;
    },
    mkdir: function(args) {
        if (args[1] === undefined) {
            printerrln("Syntax error");
            return
        }
        var path = shell.resolvePathInput(args[1])
        if (DEBUG_PRINT) serial.println("command.js > mkdir > pathstr = "+path.string);

        // check if path is valid
        var dirOpenedStatus = filesystem.open(CURRENT_DRIVE, path.string, 'W');
        var mkdird = filesystem.mkDir(CURRENT_DRIVE);
        if (!mkdird) { printerrln("MKDIR failed for '"+path.string+"'"); return dirOpenedStatus; }
    },
    cls: function(args) {
        con.clear();
        graphics.clearPixels(255);
        graphics.clearPixels2(240);
    },
    exit: function(args) {
        cmdExit = true;
    },
    ver: function(args) {
        println(welcome_text);
    },
    echo: function(args) {
        if (args[1] !== undefined) {
            args.forEach(function(it,i) { if (i > 0) print(shell.replaceVarCall(it)+" ") });
        }
        println();
    },
    rem: function(args) {
        return 0;
    },
    set: function(args) {
        // print all the env vars
        if (args[1] === undefined) {
            Object.entries(_TVDOS.variables).forEach(function(a) { println(a[0]+"="+a[1]); })
        }
        else {
            // parse key-value pair with splitter '='
            var key = undefined; var value = undefined;
            // if syntax "<key> = <value>" is used?
            if ('=' == args[2]) {
                key = args[1].toUpperCase(); value = args[3];
            }
            else if (args[2] === undefined) {
                var pair = args[1].split('=');
                key = pair[0].toUpperCase(); value = pair[1];
            }

            if (key == undefined) throw SyntaxError("Input format must be 'key=value'");

            // if value is undefined, show what envvar[key] has
            if (value === undefined) {
                if (_TVDOS.variables[key] === undefined)
                    println("Environment variable '"+key+"' not found");
                else
                    println(_TVDOS.variables[key])
            }
            else {
                _TVDOS.variables[key] = shell.replaceVarCall(value);

                // if key is KEYBOARD, reload the keyboard layout
                if ("KEYBOARD" == key)
                    input.changeKeyLayout(_TVDOS.variables.KEYBOARD || "us_qwerty");
            }
        }
    },
    dir: function(args) {
        var pathstr = (args[1] !== undefined) ? args[1] : shell.getPwdString();

        // check if path is valid
        var pathOpenedStatus = filesystem.open(CURRENT_DRIVE, pathstr, 'R');
        if (pathOpenedStatus != 0) { printerrln("File not found"); return pathOpenedStatus; }

        var port = filesystem._toPorts(CURRENT_DRIVE)[0]
        com.sendMessage(port, "LIST");
        println(com.pullMessage(port));
    },
    cat: function(args) {
        var pathstr = (args[1] !== undefined) ? args[1] : shell.getPwdString();

        var pathOpenedStatus = filesystem.open(CURRENT_DRIVE, pathstr, 'R');
        if (pathOpenedStatus != 0) { printerrln("File not found"); return pathOpenedStatus; }
        let contents = filesystem.readAll(CURRENT_DRIVE);
        // TODO just print out what's there
        print(contents);
    }
};
shell.coreutils.chdir = shell.coreutils.cd;
Object.freeze(shell.coreutils);
shell.execute = function(line) {
    if (0 == line.size) return;
    let parsedTokens = shell.parse(line); // echo, "hai", |, less
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
        let op = operators[c]

        // TODO : if operator is not undefined, swap built-in print functions with ones that 'prints' on pipes instead of stdout


        let tokens = statements[c]

        let cmd = tokens[0];
        if (cmd === undefined || cmd === '') {
            retValue = 0;
            continue
        }

        // handle Ctrl-C
        if (con.hitterminate()) {
            retValue = 1;
            continue
        }

        if (shell.coreutils[cmd.toLowerCase()] !== undefined) {
            var retval = shell.coreutils[cmd.toLowerCase()](tokens);
            retValue = retval|0; // return value of undefined will cast into 0
            continue
        }
        else {
            // search through PATH for execution

            var fileExists = false;
            var searchDir = (cmd.startsWith("/")) ? [""] : ["/"+shell_pwd.join("/")].concat(_TVDOS.getPath());

            var pathExt = []; // it seems Nashorn does not like 'let' too much? this line gets ignored sometimes
            // fill pathExt using %PATHEXT% but also capitalise them
            if (cmd.split(".")[1] === undefined)
                _TVDOS.variables.PATHEXT.split(';').forEach(function(it) { pathExt.push(it); pathExt.push(it.toUpperCase()); });
            else
                pathExt.push(""); // final empty extension

            searchLoop:
            for (var i = 0; i < searchDir.length; i++) {
                for (var j = 0; j < pathExt.length; j++) {
                    var search = searchDir[i]; if (!search.endsWith('\\')) search += '\\';
                    var path = trimStartRevSlash(search + cmd + pathExt[j]);

                    if (DEBUG_PRINT) {
                        serial.println("[command.js > shell.execute] file search path: "+path);
                    }

                    if (0 == filesystem.open(CURRENT_DRIVE, path, "R")) {
                        fileExists = true;
                        break searchLoop;
                    }
                }
            }

            if (!fileExists) {
                printerrln('Bad command or filename: "'+cmd+'"');
                retValue = 127;
                continue
            }
            else {
                var programCode = filesystem.readAll(CURRENT_DRIVE);
                var extension = undefined;
                // get proper extension
                var dotSepTokens = cmd.split('.');
                if (dotSepTokens.length > 1) extension = dotSepTokens[dotSepTokens.length - 1].toUpperCase();

                if ("BAT" == extension) {
                    // parse and run as batch file
                    var lines = programCode.split('\n').filter(function(it) { return it.length > 0 }); // this return is not shell's return!
                    lines.forEach(function(line) {
                        shell.execute(line);
                    });
                }
                else {
                    let gotError = false;

                    try {
                        errorlevel = 0; // reset the number

                        if (_G.shellProgramTitles === undefined) _G.shellProgramTitles = [];
                        _G.shellProgramTitles.push(cmd.toUpperCase())
                        sendLcdMsg(_G.shellProgramTitles[_G.shellProgramTitles.length - 1]);
                        //serial.println(_G.shellProgramTitles);

                        errorlevel = execApp(programCode, tokens); // return value of undefined will cast into 0
                    }
                    catch (e) {
                        gotError = true;

                        serial.printerr(`[command.js] program quit with ${e}:\n${e.stack || '(stack trace unavailable)'}`);

                        if (`${e}`.startsWith("InterruptedException"))
                            errorlevel = SIGTERM.name;
                        else if (e instanceof IllegalAccessException || `${e}`.startsWith("net.torvald.tsvm.ErrorIllegalAccess"))
                            errorlevel = SIGSEGV.name;

                        // exception catched means something went wrong, so if errorlevel is found to be zero, force set to 1.
                        if (errorlevel === 0 || errorlevel == undefined)
                            errorlevel = 1;
                    }
                    finally {
                        // sometimes no-error program may return nothing as the errorlevel; force set to 0 then.
                        if (!gotError && (errorlevel == undefined || (typeof errorlevel.trim == "function" && errorlevel.trim().length == 0) || isNaN(errorlevel)))
                            errorlevel = 0;

                        serial.printerr(`errorlevel: ${errorlevel}`);

                        _G.shellProgramTitles.pop();
                        sendLcdMsg(_G.shellProgramTitles[_G.shellProgramTitles.length - 1]);
                        //serial.println(_G.shellProgramTitles);

                        retValue = errorlevel;
                        continue
                    }
                }
            }
        }

        return retValue
    }
};
shell.pipes = {}; // syntax: _G.shell.pipes[name] = contents; all pipes are named pipes just like in Windows
shell.currentlyActivePipes = []; // pipe queue. Use shell.getPipe() to dequeue and shell.pushPipe() to enqueue.
shell._rndstr = '0123456789+qwfpgjluyarstdhneiozxcvbkm/QWFPGJLUYARSTDHNEIOZXCVBKM'
shell.generateRandomName = function() {
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
    let n = shell.currentlyActivePipes.shift()
    return (n != undefined) ? shell.pipes[n] : undefined
}
shell.pushAnonPipe = function(contents) {
    let name = shell.generateRandomName()
    shell.pushPipe(name, contents)
}
shell.pushPipe = function(name, contents) {
    shell.pipes[name] = contents
    shell.currentlyActivePipes.unshift(name)
}
shell.hasPipe = function() {
    return shell.currentlyActivePipes[0] != undefined
}
Object.freeze(shell);
_G.shell = shell;

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

if (exec_args[1] !== undefined) {
    // only meaningful switches would be either /c or /k anyway
    var firstSwitch = exec_args[1].toLowerCase();

    // command /c   <commands>
    // ^[0]    ^[1] ^[2]
    if ("/c" == firstSwitch) {
        if ("" == exec_args[2]) return 0; // no commands were given, just exit successfully
        return shell.execute(exec_args[2]);
    }
    else if ("/k" == firstSwitch) {
        if ("" == exec_args[2]) return 0; // no commands were given, just exit successfully
        shell.execute(exec_args[2]);
        goInteractive = true;
    }
    else if ("/fancy" == firstSwitch) {
        graphics.setBackground(2,3,4);
        goFancy = true;
        goInteractive = true;
    }
    else {
        printerrln("Invalid switch: "+exec_args[1]);
        return 1;
    }
}
else {
    goInteractive = true;
}

let cmdExit = false;
if (goInteractive) {
    con.curs_set(1);
    greet();

    let cmdHistory = []; // zeroth element is the oldest
    let cmdHistoryScroll = 0; // 0 for outside-of-buffer, 1 for most recent
    while (!cmdExit) {
        con.curs_set(1);
        print_prompt_text();

        var cmdbuf = "";

        while (true) {
            let key = con.getch();

            // printable chars
            if (key >= 32 && key <= 126) {
                var s = String.fromCharCode(key);
                cmdbuf += s;
                print(s);
            }
            // backspace
            else if (key === con.KEY_BACKSPACE && cmdbuf.length > 0) {
                cmdbuf = cmdbuf.substring(0, cmdbuf.length - 1);
                print(String.fromCharCode(key));
            }
            // enter
            else if (key === 10 || key === con.KEY_RETURN) {
                println();

                shell.execute(cmdbuf);

                if (cmdbuf.trim().length > 0)
                    cmdHistory.push(cmdbuf);

                cmdHistoryScroll = 0;
                con.curs_set(1);

                break;
            }
            // up arrow
            else if (key === con.KEY_UP && cmdHistory.length > 0 && cmdHistoryScroll < cmdHistory.length) {
                cmdHistoryScroll += 1;

                // back the cursor in order to type new cmd
                var x = 0;
                for (x = 0; x < cmdbuf.length; x++) print(String.fromCharCode(8));
                cmdbuf = cmdHistory[cmdHistory.length - cmdHistoryScroll];
                // re-type the new command
                print(cmdbuf);

            }
            // down arrow
            else if (key === con.KEY_DOWN) {
                if (cmdHistoryScroll > 0) {
                    // back the cursor in order to type new cmd
                    var x = 0;
                    for (x = 0; x < cmdbuf.length; x++) print(String.fromCharCode(8));
                    cmdbuf = cmdHistory[cmdHistory.length - cmdHistoryScroll];
                    // re-type the new command
                    print(cmdbuf);

                    cmdHistoryScroll -= 1;
                }
                else {
                    // back the cursor in order to type new cmd
                    var x = 0;
                    for (x = 0; x < cmdbuf.length; x++) print(String.fromCharCode(8));
                    cmdbuf = "";
                }
            }
        }
    }
}

return 0;