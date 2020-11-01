let PROMPT_TEXT = ">";
let CURRENT_DRIVE = "A";

let shell_pwd = [""];

const welcome_text = "TSVM Disk Operating System, version " + _TVDOS.VERSION;

function get_prompt_text() {
    return CURRENT_DRIVE + ":\\" + shell_pwd.join("\\") + PROMPT_TEXT;
}

function greet() {
    println(welcome_text);
    println();
}


let shell = {};
shell.test = "command.js test string";
if (exec_args !== undefined) return shell;


///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

println("Starting TVDOS...");

greet();

let cmdHistory = []; // zeroth element is the oldest
let cmdHistoryScroll = 0; // 0 for outside-of-buffer, 1 for most recent
while (true) {
    print(get_prompt_text());

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
                println("You entered: " + cmdbuf);

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

return 0;