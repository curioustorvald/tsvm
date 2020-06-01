// standard print functions
function print(s) {
    sys.print(s);
}
function println(s) {
    if (typeof s == "undefined")
        sys.print("\n");
    else
        sys.println(s);
}
function read() {
    return sys.read();
}
// ncurses-like terminal control
var con = {};
con.getch = function() {
    return sys.readKey();
};
con.move = function(y, x) {
    print(String.fromCharCode(27,91)+y+";"+x+"H");
};
con.addch = function(c) {
    graphics.putSymbol(c);
};
con.mvaddch = function(y, x, c) {
    move(y, x); addch(c);
};
con.getmaxyx = function() {
    return graphics.getTermDimension();
};
con.getyx = function() {
    return graphics.getCursorYX();
};
con.hitterminate = function() { // ^C
    sys.poke(-40, 1);
    return (sys.peek(-41) == 31 && (sys.peek(-41) == 129 || sys.peek(-41) == 130));
};
con.hiteof = function() { // ^D
    sys.poke(-40, 1);
    return (sys.peek(-41) == 32 && (sys.peek(-41) == 129 || sys.peek(-41) == 130));
};
con.color_fore = function(n) { // 0..7; -1 for transparent
    if (n < 0)
        print(String.fromCharCode(27,91)+"38;5;255m");
    else
        print(String.fromCharCode(27,91)+((n % 8)+30)+"m");
};
con.color_back = function(n) { // 0..7; -1 for transparent
    if (n < 0)
        print(String.fromCharCode(27,91)+"48;5;255m");
    else
        print(String.fromCharCode(27,91)+((n % 8)+40)+"m");
};
con.color_pair = function(fore, back) { // 0..255
    print(String.fromCharCode(27,91)+"38;5;"+fore+"m");
    print(String.fromCharCode(27,91)+"48;5;"+back+"m");
};
Object.freeze(con);
// system management  function
var system = {};
system.maxmem = function() {
    return sys.peek(-65) | (sys.peek(-66) << 8) | (sys.peek(-67) << 16) | (sys.peek(-68) << 24);
};
system.halt = function() {
    exit();
};
Object.freeze(system);