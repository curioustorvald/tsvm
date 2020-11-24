let PROMPT_TEXT = ">";
let CURRENT_DRIVE = "A";
let shell_pwd = [""];

let goInteractive = false;
let goFancy = false;

let DEBUG_PRINT = true;

let errorlevel = 0;

const welcome_text = "TSVM Disk Operating System, version " + _TVDOS.VERSION;

function print_prompt_text() {
    if (goFancy) {
        con.color_pair(239,161);
        print(" "+CURRENT_DRIVE+":");
        con.color_pair(161,253);
        con.addch(16);
        con.color_pair(0,253);
        print(" \\"+shell_pwd.join("\\").substring(1)+" ");
        if (errorlevel != 0) {
            con.color_pair(166,253);
            print("["+errorlevel+"] ");
        }
        con.color_pair(253,255);
        con.addch(16);
        con.addch(32);
        con.color_pair(239,255);
    }
    else {
        if (errorlevel != 0)
            print(CURRENT_DRIVE + ":\\" + shell_pwd.join("\\") + " [" + errorlevel + "]" + PROMPT_TEXT);
        else
            print(CURRENT_DRIVE + ":\\" + shell_pwd.join("\\") + PROMPT_TEXT);
    }
}

function greet() {
    if (goFancy) {
        con.color_pair(0,253);
        //print(welcome_text + " ".repeat(_fsh.scrwidth - welcome_text.length));
        print(welcome_text + " ".repeat(80 - welcome_text.length));
        con.color_pair(239,255);
        println();
    }
    else
        println(welcome_text);
}

function trimStartRevSlash(s) {
    let cnt = 0;
    while (cnt < s.length) {
        let chr = s[cnt];

        if (chr != '\\') break;

        cnt += 1;
    }

    return s.substring(cnt);
}

let shell = {};
shell.getPwd = function() { return shell_pwd; }
shell.getCurrentDrive = function() { return CURRENT_DRIVE; }
// example input: echo "the string" > subdir\test.txt
shell.parse = function(input) {
    let tokens = [];
    let stringBuffer = "";
    let mode = "LITERAL"; // LITERAL, QUOTE, ESCAPE, LIMBO
    let i = 0
    while (i < input.length) {
        const c = input[i];
/*digraph g {
	LITERAL -> QUOTE [label="\""]
	LITERAL -> LIMBO [label="space"]
	LITERAL -> LITERAL [label=else]

	QUOTE -> LIMBO [label="\""]
	QUOTE -> ESCAPE [label="\\"]
	QUOTE -> QUOTE [label=else]

	ESCAPE -> QUOTE

	LIMBO -> LITERAL [label="not space"]
	LIMBO -> QUOTE [label="\""]
	LIMBO -> LIMBO [label="space"]
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
            else {
                stringBuffer += c;
            }
        }
        else if ("LIMBO" == mode) {
            if ('"' == c) {
                mode = "QUOTE";
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
    // replace slashes into revslashes
    let pathstr = input.replaceAll('/','\\\\');
    let startsWithSlash = input.startsWith('\\');
    let newPwd = [];

    // split them into an array while filtering empty elements except for the root 'head'
    let ipwd = (startsWithSlash ? [""] : shell_pwd).concat(pathstr.split("\\").filter(function(it) { return (it.length > 0); }));

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
    pathstr = newPwd.join('\\').substring(1);

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
            println(CURRENT_DRIVE+":"+shell_pwd.join("\\"));
            return
        }
        let path = shell.resolvePathInput(args[1])
        if (DEBUG_PRINT) serial.println("command.js > cd > pathstr = "+path.string);

        // check if path is valid
        filesystem.open(CURRENT_DRIVE, path.string, 'R');
        let dirOpened = filesystem.isDirectory(CURRENT_DRIVE); // open a dir; if path is nonexistent, file won't actually be opened
        if (!dirOpened) { printerrln("CHDIR failed for '"+path.string+"'"); return; } // if file is not opened, FALSE will be returned

        shell_pwd = path.pwd;
    },
    mkdir: function(args) {
        if (args[1] === undefined) {
            printerrln("Syntax error");
            return
        }
        let path = shell.resolvePathInput(args[1])
        if (DEBUG_PRINT) serial.println("command.js > mkdir > pathstr = "+path.string);

        // check if path is valid
        let dirOpened = filesystem.open(CURRENT_DRIVE, path.string, 'W');
        let mkdird = filesystem.mkDir(CURRENT_DRIVE);
        if (!mkdird) { printerrln("MKDIR failed for '"+path.string+"'"); return; }
    },
    cls: function(args) {
        con.clear();
    },
    exit: function(args) {
        cmdExit = true;
    },
    ver: function(args) {
        println(welcome_text);
    },
    echo: function(args) {
        if (args[1] !== undefined) {
            args.forEach(function(it,i) { if (i > 0) print(it+" ") });
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
            let key = undefined; let value = undefined;
            // if syntax "<key> = <value>" is used?
            if ('=' == args[2]) {
                key = args[1].toUpperCase(); value = args[3];
            }
            else if (args[2] === undefined) {
                let pair = args[1].split('=');
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
                // TODO parse %var_name% line
                _TVDOS.variables[key] = value;
            }
        }
    },
    dir: function(args) {
        let pathstr = (args[1] !== undefined) ? args[1] : "\\"+shell_pwd.join("\\");

        // check if path is valid
        let pathOpened = filesystem.open(CURRENT_DRIVE, pathstr, 'R');
        if (!pathOpened) { printerrln("File not found"); return; }

        let port = filesystem._toPorts(CURRENT_DRIVE)[0]
        com.sendMessage(port, "LIST");
        println(com.pullMessage(port));
    }
};
shell.coreutils.chdir = shell.coreutils.cd;
Object.freeze(shell.coreutils);
shell.execute = function(line) {
    if (0 == line.size) return;
    let tokens = shell.parse(line);
    let cmd = tokens[0];
    if (cmd === undefined || cmd === '') return 0;

    // handle Ctrl-C
    if (con.hitterminate()) return 1;

    if (shell.coreutils[cmd.toLowerCase()] !== undefined) {
        let retval = shell.coreutils[cmd.toLowerCase()](tokens);
        return retval|0; // return value of undefined will cast into 0
    }
    else {
        // search through PATH for execution

        let fileExists = false;
        let searchDir = (cmd.startsWith("\\")) ? [""] : ["\\"+shell_pwd.join("\\")].concat(_TVDOS.getPath());

        let pathExt = [];
        // fill pathExt using %PATHEXT% but also capitalise them
        if (cmd.split(".")[1] === undefined)
            _TVDOS.variables.PATHEXT.split(';').forEach(function(it) { pathExt.push(it); pathExt.push(it.toUpperCase()); });
        else
            pathExt.push(""); // final empty extension

        searchLoop:
        for (let i = 0; i < searchDir.length; i++) {
            for (let j = 0; j < pathExt.length; j++) {
                let search = searchDir[i]; if (!search.endsWith('\\')) search += '\\';
                let path = trimStartRevSlash(search + cmd + pathExt[j]);

                if (DEBUG_PRINT) {
                    serial.println("[command.js > shell.execute] file search path: "+path);
                }

                if (filesystem.open(CURRENT_DRIVE, path, "R")) {
                    fileExists = true;
                    break searchLoop;
                }
            }
        }

        if (!fileExists) {
            printerrln('Bad command or filename: "'+cmd+'"');
            return 127;
        }
        else {
            let prg = filesystem.readAll(CURRENT_DRIVE);
            let extension = undefined;
            // get proper extension
            let dotSepTokens = cmd.split('.');
            if (dotSepTokens.length > 1) extension = dotSepTokens[dotSepTokens.length - 1].toUpperCase();

            if ("BAT" == extension) {
                // parse and run as batch file
                let lines = prg.split('\n').filter(function(it) { return it.length > 0; });
                lines.forEach(function(line) {
                    shell.execute(line);
                });
            }
            else {
                return execApp(prg, tokens)|0; // return value of undefined will cast into 0
            }
        }
    }
};
Object.freeze(shell);
_G.shell = shell;


///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

if (exec_args[1] !== undefined) {
    // only meaningful switches would be either /c or /k anyway
    let firstSwitch = exec_args[1].toLowerCase();

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

if (goInteractive) {
    con.reset_graphics();
    greet();

    let cmdHistory = []; // zeroth element is the oldest
    let cmdHistoryScroll = 0; // 0 for outside-of-buffer, 1 for most recent
    let cmdExit = false;
    while (!cmdExit) {
        con.reset_graphics();
        print_prompt_text();

        let cmdbuf = "";

        while (true) {
            let key = con.getch();

            // printable chars
            if (key >= 32 && key <= 126) {
                let s = String.fromCharCode(key);
                cmdbuf += s;
                print(s);
            }
            // backspace
            else if (key === 8 && cmdbuf.length > 0) {
                cmdbuf = cmdbuf.substring(0, cmdbuf.length - 1);
                print(String.fromCharCode(key));
            }
            // enter
            else if (key === 10 || key === 13) {
                println();
                try {
                    errorlevel = 0; // reset the number
                    errorlevel = shell.execute(cmdbuf);
                    if (isNaN(errorlevel)) errorlevel = 2;
                }
                catch (e) {
                    printerrln("\n"+e);
                    if (errorlevel === 0 || isNaN(errorlevel)) {
                        errorlevel = 1; // generic failure
                    }
                }
                finally {
                    if (cmdbuf.trim().length > 0)
                        cmdHistory.push(cmdbuf);

                    cmdHistoryScroll = 0;
                    con.curs_set(1);

                    break;
                }
            }
            // up arrow
            else if (key === 19 && cmdHistory.length > 0 && cmdHistoryScroll < cmdHistory.length) {
                cmdHistoryScroll += 1;

                // back the cursor in order to type new cmd
                let x = 0;
                for (x = 0; x < cmdbuf.length; x++) print(String.fromCharCode(8));
                cmdbuf = cmdHistory[cmdHistory.length - cmdHistoryScroll];
                // re-type the new command
                print(cmdbuf);

            }
            // down arrow
            else if (key === 20) {
                if (cmdHistoryScroll > 0) {
                    // back the cursor in order to type new cmd
                    let x = 0;
                    for (x = 0; x < cmdbuf.length; x++) print(String.fromCharCode(8));
                    cmdbuf = cmdHistory[cmdHistory.length - cmdHistoryScroll];
                    // re-type the new command
                    print(cmdbuf);

                    cmdHistoryScroll -= 1;
                }
                else {
                    // back the cursor in order to type new cmd
                    let x = 0;
                    for (x = 0; x < cmdbuf.length; x++) print(String.fromCharCode(8));
                    cmdbuf = "";
                }
            }
        }
    }
}

return 0;