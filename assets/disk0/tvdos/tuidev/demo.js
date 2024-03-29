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
        print('  ');con.addch(17);con.curs_right();
        con.color_pair(0,253);
        print(" ".repeat(titleLeftPad)+this.title+" ".repeat(titleRightPad));
        con.color_pair(253,255);
        con.addch(16);con.curs_right();print('  ');
        con.move(3,1);
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

class UIItem {
    constructor(w,h,identifier) {
        this.width = w;
        this.height = h;
        this.id = identifier;
    }
    redraw(y,x) {} // index starts from 0 (so that y=1 would starts from the line right after the titlebar)
    update() {} // returns true when the screen must be re-drawn after the update
}

class TextList extends UIItem {
    constructor(w,h,item,selection) {
        super(w,h,"uiitem-textlist");
        this.item = item;
        this.selection = (isNaN(selection)) ? 0 : selection|0;
        this.visible = true;
        this.scroll = 0;
        this.redrawReq = false;
    }

    getInternalHeight() {
        return this.item.length() * 2 + 1;
    }
    getLongestItemLength() {
        return this.item.map(it => (''+it).length).reduce((a,i) => (i>a) ? i : a);
    }

    redraw(y,x) {
        // TODO: up/down scroll mark
        let videoReversed = false
        for (let i = this.scroll; i < this.item.length; i++) {
            let printy = ((i - this.scroll) * 2) + 2;
            if (printy < y + this.termHeight || printy < this.height) {
                if (i == this.scroll + this.selection) {
                    con.video_reverse();
                    videoReversed = true;
                }
                con.move(y + printy, x);
                print(` ${this.item[i]} `);
            }
            // un-reverse the video
            if (videoReversed) {
                con.video_reverse();
                videoReversed = false;
            }
        }
    }

    cursorUp() {
        if ((this.selection + this.scroll) > 0) {
            this.selection -= 1;
            this.redrawReq = true;
        }
    }

    cursorDown() {
        if ((this.selection + this.scroll) < this.item.length - 1) {
            this.selection += 1;
            this.redrawReq = true;
        }
    }

    getSelection() {
        return {index: (this.scroll + this.selection), item: this.item[this.scroll + this.selection]};
    }

    update() {
        let r = this.redrawReq;
        this.redrawReq = false;
        return r;
    }
}

class Demo extends SimpleScreen {
    constructor(title) {
        super(title);
        let mainCanvas = new Canvas("main");
        con.curs_set(0);

        mainCanvas.selector = new TextList(40, 31, ["The", "Quick", "Brown", "Fox", "Jumps"]);

        mainCanvas.redraw = () => {
            mainCanvas.selector.redraw(1,2);
        }

        this.keyLatched = false;

        mainCanvas.update = () => {
            let keys = con.poll_keys();
            let redraw = false;

            // un-latch
            if (this.keyLatched && keys[0] == 0) {
                this.keyLatched = false;
            }

            // up
            if (!this.keyLatched && keys[0] == 19) {
                mainCanvas.selector.cursorUp();
            }
            // down
            else if (!this.keyLatched && keys[0] == 20) {
                mainCanvas.selector.cursorDown();
            }

            if (mainCanvas.selector.update())
                mainCanvas.selector.redraw(1,2);

            if (this.keyLatched && keys[0] == 66) {
                con.mvaddch(20,20); print("SEL:"+mainCanvas.selector.getSelection().item);
            }

            // finally update key latched state
            this.keyLatched = keys[0] != 0;
        }



        this.mainCanvas = mainCanvas
        this.canvas = this.mainCanvas;
    }
}

let s = new Demo("Ctrl-C to exit");
s.redraw();
while (!con.hitterminate()) {
    s.update();
    sys.spin();
}
con.clear();