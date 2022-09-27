let port = Number.parseInt(exec_args[1])

let [scrh, scrw] = con.getmaxyx()
let status = 0
let focus = 0
let statusStr = ["Not Connected", "Idle", "Sending", "Receiving"]
let getFocusStr = [()=>"CMD", ()=>`COM${port}`]

if (Number.isNaN(port)) {
    port = undefined
}
else {
    focus = 1
}


function greet() {
    if (!port) {
        println("COM port not specified; please run 'listen [1|2|3|4]' to open a port first.")
        println("In listening mode, any text entered will be sent right to the COM")
        println("Hit Ctrl+A while listening to return to the prompt.")
        println("On the prompt, enter 'pull' to pull the message.")
        println("Enter 'exit' to exit.")
    }
}


function drawStatusBar() {
    let [oy, ox] = con.getyx()

    con.curs_set(0)
    con.move(scrh, 0)
    con.video_reverse()

    print(` ${getFocusStr[focus]()}  ${statusStr[0]} `)

    con.video_reverse()
    con.move(oy, ox)
    con.curs_set(1)
}

function sendMessage(line) {
    if (0 == line.size) return;
    var tokens = _G.shell.parse(line);
    var cmd = tokens[0];
    if (cmd === undefined || cmd === '') return 0;

    // handle Ctrl-C
    if (con.hitterminate()) {
        cmdExit = true
    }

    if (focus == 0) {
        if ("exit" == cmd || "quit" == cmd) cmdExit = true
        else if ("listen" == cmd) {
            port = Number.parseInt(tokens[1])
            if (Number.isNaN(port)) {
                port = undefined
            }
            else {
                focus = 1
            }
        }
        else if ("pull" == cmd && port) {
            println(com.pullMessage(port - 1))
        }
    }
    else {
        if (line.charAt(line.length - 1) == '\\')
            line = line.substring(0, line.length - 1) + '\x17'
        com.sendMessage(port - 1, line)
        com.waitUntilReady(port - 1)
        println(com.pullMessage(port - 1))
    }
}

function print_prompt_text() {
    print(`${getFocusStr[focus]()}>`)
}

con.curs_set(1)
greet()
let cmdExit = false
while (!cmdExit) {
//    drawStatusBar()
    print_prompt_text()

    let cmdbuf = ""

    while (true) {
        // TODO event-ify key in and serial in so that they can run simultaneously

        let key = con.getch()

        // printable chars
        if (key == 1) { // Ctrl+A
            println()
            focus = 0
            break
        }
        else if (key >= 32 && key <= 126) {
            let s = String.fromCharCode(key)
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

            sendMessage(cmdbuf)

            con.curs_set(1)

            break
        }
    }
}