if (exec_args[1] === undefined) {
    println('Missing filename ("less -?" for help)');
    return 0;
}

/*let help = "\n
SUMMARY OF COMMANDS\n
\n
  h   H            Display this help\n
  q   Q            Exit
\n"*/

if (exec_args[1].startsWith("-?")) {
    println("less <filename>");
    return 0;
}

let fileOpened = filesystem.open(_G.shell.getCurrentDrive(), _G.shell.resolvePathInput(exec_args[1]).string, "R");
if (!fileOpened) {
    printerrln(_G.shell.resolvePathInput(exec_args[1]).string+": cannot open");
    return 1;
}

let scroll = 0;
let termW = con.getmaxyx()[1];
let termH = con.getmaxyx()[0] - 1;
let buf = "";
let fileContent = filesystem.readAll(_G.shell.getCurrentDrive());
let key = -1;

// initialise some helper variables
let lineToBytes = [0];
for (let i = 0; i < fileContent.length; i++) {
    let char = fileContent.charCodeAt(i);
    if (char == 10 || char == 13) {
        lineToBytes.push(i + 1);
    }
}

serial.println(lineToBytes);

let startAddr = -1;
let paintCur = 0;
let cy = 1;
let cx = 1;
let char = -1;

let repaint = function() {
    con.move(1,1); con.clear();

    startAddr = lineToBytes[scroll];
    cy = 1; cx = 1; paintCur = 0;
    while (cy <= termH) {
        char = fileContent.charCodeAt(startAddr + paintCur);
        if (isNaN(char)) break;
        if (cy <= termH) {
            con.move(cy, cx);
            if (char != 10 && char != 13)
                con.addch(char);
            cx += 1;
        }
        if (char == 10 || char == 13) {
            cy += 1;
            cx = 1;
        }
        paintCur += 1;
    }
}

repaint();
while (true) {
    // read a key
    con.mvaddch(termH + 1,1,58);
    con.move(termH + 1, 2);
    key = con.getch();
    // do something with key read
    /*Q*/if (key == 113 || key == 81) break;
    /*R*/else if (key == 114 || key == 82) repaint();
    /*up*/else if (key == 19 && scroll > 0) {
        scroll -= 1;
        repaint();
    }
    /*down*/else if (key == 20 && scroll < lineToBytes.length - termH) {
        scroll += 1;
        repaint();
    }
}

con.move(termH + 1, 1);
return 0;