/*
Screen:
===================
Titlebar
===================

C A N V A S

===================

there are usually two separate canvases: main-screen and menu-screen
*/

class SimpleScreen {

    constructor(title) {
        this.title = title;
        this.termWidth = con.getmaxyx()[1];
        this.termHeight = con.getmaxyx()[0];
    }

    drawTitlebar() {

        let titleLeftPad = (this.termWidth - this.title.length - 6) >> 1;
        let titleRightPad = this.termWidth - titleLeftPad - this.title.length - 6;

        con.move(1,1);
        con.color_pair(253,255);
        print('  ');con.addch(17);
        con.color_pair(0,253);
        print(" ".repeat(titleLeftPad)+this.title+" ".repeat(titleRightPad));
        con.color_pair(253,255);
        con.addch(16);print('  ');
    }
    redraw() {
        con.color_pair(239,255);
        con.clear();
        this.drawTitlebar();
        if (this.canvas !== undefined) this.canvas.redraw();
    }
    update() {
        if (this.canvas !== undefined) this.canvas.update();
    }
}

class Canvas {
    constructor(identifier) {
        this.id = identifier;
    }
    redraw() {}
    update() {}
}

class Demo extends SimpleScreen {
    constructor(title) {
        super(title);
        let mainCanvas = new Canvas("main");
        mainCanvas.redraw = () => {

        }
        mainCanvas.update = () => {
            con.move(2 + (Math.random()*(this.termHeight - 1)), 1 + (Math.random()*this.termWidth));
            con.addch(0xB3 + (Math.random()*39));
        }

        this.mainCanvas = mainCanvas
        this.canvas = this.mainCanvas;
    }
}

let s = new Demo("Ctrl-C to exit");
s.redraw();
while (!con.hitterminate()) {
    s.update();
}
con.clear();