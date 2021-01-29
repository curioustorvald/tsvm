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

class Demo extends SimpleScreen {
    constructor(title) {
        super(title);
        let mainCanvas = new Canvas("main");
        con.curs_set(0);

        mainCanvas.redraw = () => {

        }

        this.ballX = 1 + ((Math.random() * this.termWidth)|0);
        this.ballY = 1 + ((Math.random() * (this.termHeight-1))|0)
        this.ballMomentumX = (Math.random() < 0.5) ? -1 : 1;
        this.ballMomentumY = (Math.random() < 0.5) ? -1 : 1;
        this.collision = 0;

        mainCanvas.update = () => {
            // erase a track
            con.mvaddch(this.ballY, this.ballX, 0);

            // collide
            if (this.ballX <= 1) this.ballMomentumX = 1;
            if (this.ballX >= this.termWidth) this.ballMomentumX = -1;
            if (this.ballY <= 2) this.ballMomentumY = 1;
            if (this.ballY >= this.termHeight) this.ballMomentumY = -1;

            // collision counter
            if (this.ballX <= 1 || this.ballX >= this.termWidth || this.ballY <= 2 || this.ballY >= this.termHeight) {
                this.collision += 1;
                this.title = "Ctrl-C to exit - "+this.collision;
                this.drawTitlebar();
            }

            // move
            this.ballX += this.ballMomentumX;
            this.ballY += this.ballMomentumY;

            // draw
            con.mvaddch(this.ballY, this.ballX, 2);
            sys.spin();sys.spin();sys.spin();sys.spin();
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