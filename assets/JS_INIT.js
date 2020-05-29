// standard print functions
function print(s) {
    vm.print(s);
}
function println(s) {
    if (typeof s == "undefined")
        vm.print("\n");
    else
        vm.println(s);
}
function read() {
    return vm.read();
}
// ncurses-like terminal control
var con = new Object();
con.getch = function() {
    return vm.readKey();
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
    vm.poke(-40, 1);
    return (vm.peek(-41) == 31 && (vm.peek(-41) == 129 || vm.peek(-41) == 130));
};
con.hiteof = function() { // ^D
    vm.poke(-40, 1);
    return (vm.peek(-41) == 32 && (vm.peek(-41) == 129 || vm.peek(-41) == 130));
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
var sys = new Object();
sys.maxmem = function() {
    return vm.peek(-65) | (vm.peek(-66) << 8) | (vm.peek(-67) << 16) | (vm.peek(-68) << 24);
};
sys.halt = function() {
    exit();
};
Object.freeze(sys);