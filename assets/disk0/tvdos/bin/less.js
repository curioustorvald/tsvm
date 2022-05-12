let filename = exec_args[1]

/*let help = "\n
SUMMARY OF COMMANDS\n
\n
  h   H            Display this help\n
  q   Q            Exit
\n"*/

let scroll = 0;
let pan = -1;
let termW = con.getmaxyx()[1];
let termH = con.getmaxyx()[0] - 1;
let buf = "";
let fileContent = undefined
let key = -1;
let panSize = termW >> 1;
let scrollSize = termH >> 3;

let startAddr = -1;
let paintCur = 0;
let cy = 1;
let cx = 1;
let char = -1;

let numbuf = 0;

if (filename === undefined && _G.shell.hasPipe()) {
    fileContent = _G.shell.getPipe()
}
else if (filename === undefined) {
    println('Missing filename ("less -?" for help)');
    return 0;
}
else {
    if (filename.startsWith("-?")) {
        println("less <filename>");
        return 0;
    }

    let fileOpened = filesystem.open(_G.shell.getCurrentDrive(), _G.shell.resolvePathInput(filename).string, "R");
    if (fileOpened != 0) {
        printerrln(_G.shell.resolvePathInput(filename).string+": cannot open");
        return 1;
    }

    fileContent = filesystem.readAll(_G.shell.getCurrentDrive());
}

// initialise some helper variables
let lineToBytes = [0];
let maxPan = 0;
let maxPanCur = 0;
for (let i = 0; i < fileContent.length; i++) {
    let char = fileContent.charCodeAt(i);
    maxPanCur += 1;
    if (char == 10 || char == 13) {
        lineToBytes.push(i + 1);
        if (maxPanCur > maxPan) maxPan = maxPanCur;
        maxPanCur = 0;
    }
}




let resetKeyReadStatus = function() {
    numbuf = 0;
}

let repaint = function() {
    con.move(1,1); con.clear();

    startAddr = lineToBytes[scroll];
    cy = 1; cx = -pan; paintCur = 0;
    while (cy <= termH) {
        char = fileContent.charCodeAt(startAddr + paintCur);
        if (isNaN(char)) break;
        if (cy <= termH) {
            if (cx >= 0 && cx < termW) {
                con.move(cy, cx);
                if (char != 10 && char != 13)
                    con.addch(char);con.curs_right();
            }
            cx += 1;
        }
        if (char == 10 || char == 13) {
            cy += 1;
            cx = -pan;
        }
        paintCur += 1;
    }
}

repaint();
con.move(termH + 1, 1);
print(":"+" ".repeat(termW - 2));
con.move(termH + 1, 2);
while (true) {
    // read a key
    key = con.getch();

    //serial.println("key = "+key);

    // do something with key read
    /*Q*/if (key == 113 || key == 81) break;
    /*R*/else if (key == 114 || key == 82) repaint();
    /*up*/else if (key == con.KEY_UP) {
        scroll -= scrollSize;
        if (scroll < 0) scroll = 0;
        repaint();
    }
    /*down*/else if (key == con.KEY_DOWN) {
        scroll += scrollSize;
        if (scroll > lineToBytes.length - termH) scroll = lineToBytes.length - termH;
        repaint();
    }
    /*left*/else if (key == con.KEY_LEFT && pan > 0) {
        pan -= panSize;
        repaint();
    }
    /*right*/else if (key == con.KEY_RIGHT && pan < maxPan - termW) {
        pan += panSize;
        repaint();
    }
    /*0-9*/else if (key >= 48 && key <= 57) {
        print(String.fromCharCode(key));
        numbuf = (numbuf * 10) + (key - 48);
    }
    /*bksp*/else if (key == con.KEY_BACKSPACE) {
        if (numbuf > 0) print(String.fromCharCode(key));
        numbuf = (numbuf / 10)|0;
    }
    /*u*/else if (key == 117) {
        scroll -= numbuf;
        if (scroll < 0) scroll = 0;
        repaint();
    }
    /*d*/else if (key == 100) {
        scroll += numbuf;
        if (scroll > lineToBytes.length - termH) scroll = lineToBytes.length - termH;
        repaint();
    }


    if (!(key >= 48 && key <= 57 || key == con.KEY_BACKSPACE)) {
        resetKeyReadStatus();
        con.move(termH + 1, 1);
        print(":"+" ".repeat(termW - 2));
        con.move(termH + 1, 2);
    }

    //serial.println("numbuf = "+numbuf);
}

con.move(termH + 1, 1);
return 0;