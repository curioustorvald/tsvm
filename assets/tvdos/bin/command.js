let PROMPT_TEXT = ">";
let CURRENT_DRIVE = "A";
let executableExtensions = [".com",".bat",".js", ""]; Object.freeze(executableExtensions);
let shell_pwd = [];

const welcome_text = "TSVM Disk Operating System, version " + _TVDOS.VERSION;

function print_prompt_text() {
    print(CURRENT_DRIVE + ":\\" + shell_pwd.join("\\") + PROMPT_TEXT);
}

function greet() {
    println(welcome_text);
}


let shell = {};
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
        if (mode == "LITERAL") {
            if (c == ' ') {
                tokens.push(stringBuffer); stringBuffer = "";
                mode = "LIMBO";
            }
            else if (c == '"') {
                tokens.push(stringBuffer); stringBuffer = "";
                mode = "QUOTE";
            }
            else {
                stringBuffer += c;
            }
        }
        else if (mode == "LIMBO") {
            if (c == '"') {
                mode = "QUOTE";
            }
            else if (c != ' ') {
                mode = "LITERAL";
                stringBuffer += c;
            }
        }
        else if (mode == "QUOTE") {
            if (c == '"') {
                tokens.push(stringBuffer); stringBuffer = "";
                mode = "LIMBO";
            }
            else if (c == '^') {
                mode = "ESCAPE";
            }
            else {
                stringBuffer += c;
            }
        }
        else if (mode == "ESCAPE") {

        }

        i += 1;
    }

    if (stringBuffer.length > 0) {
        tokens.push(stringBuffer);
    }

    return tokens;
}

shell.coreutils = {
    cd: function(args) {
        if (args[1] === undefined) {
            println(shell_pwd.join("\\"));
            return
        }

        shell_pwd = args[1].split("\\");
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
    }
};
Object.freeze(shell.coreutils);
shell.execute = function(line) {
    if (line.size == 0) return;
    let tokens = shell.parse(line);
    let cmd = tokens[0];

    // handle Ctrl-C
    if (con.hitterminate()) return 1;

    if (shell.coreutils[cmd.toLowerCase()] !== undefined) {
        let retval = shell.coreutils[cmd.toLowerCase()](tokens);
        return retval|0; // return value of undefined will cast into 0
    }
    else {
        // search through PATH for execution

        let fileExists = false;
        let searchDir = (cmd.startsWith("\\")) ? [""] : ["\\"+shell_pwd.join("\\")].concat(_TVDOS.defaults.path);

        searchDir.forEach(function(it) { serial.println("Searchdir: "+it); });

        searchLoop:
        for (let i = 0; i < searchDir.length; i++) {
            for (let j = 0; j < executableExtensions.length; j++) {
                let path = (searchDir[i] + cmd + executableExtensions[j]).substring(1); // without substring, this will always prepend revslash
                if (filesystem.open(CURRENT_DRIVE, path, "R")) {
                    fileExists = true;
                    break searchLoop;
                }
            }
        }

        if (!fileExists) {
            printerrln('Bad command or filename: "'+cmd+'"');
            return -1;
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


///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


if (exec_args[1] !== undefined) {
    // command /c   <commands>
    // ^[0]    ^[1] ^[2]
    if (exec_args[1].toLowerCase() == "/c") {
        if (exec_args[2] == "") return 0; // no commands were given, just exit successfully
        return shell.execute(exec_args[2]);
    }
    else {
        printerrln("Invalid switch: "+exec_args[1]);
        return 1;
    }
}
else {
    con.reset_graphics();
    println("Starting TVDOS...");
    greet();

    let cmdHistory = []; // zeroth element is the oldest
    let cmdHistoryScroll = 0; // 0 for outside-of-buffer, 1 for most recent
    let cmdExit = false;
    while (!cmdExit) {
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
                    shell.execute(cmdbuf);
                }
                catch (e) {
                    printerrln(e);
                }
                finally {
                    if (cmdbuf.trim().length > 0)
                        cmdHistory.push(cmdbuf);

                    cmdHistoryScroll = 0;
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