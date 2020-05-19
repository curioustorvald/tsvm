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
Object.freeze(con);
// system management  function
var sys = new Object();
sys.maxmem = function() {
    return vm.peek(-65) | (vm.peek(-66) << 8) | (vm.peek(-67) << 16) | (vm.peek(-68) << 24);
};
Object.freeze(sys);