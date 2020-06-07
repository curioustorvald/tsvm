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
// some utilities functions
var base64 = {};
base64._lookup = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
base64._revLookup = {"":0,"=":0,"A":0,"B":1,"C":2,"D":3,"E":4,"F":5,"G":6,"H":7,"I":8,"J":9,"K":10,"L":11,"M":12,"N":13,"O":14,"P":15,"Q":16,"R":17,"S":18,"T":19,"U":20,"V":21,"W":22,"X":23,"Y":24,"Z":25,"a":26,"b":27,"c":28,"d":29,"e":30,"f":31,"g":32,"h":33,"i":34,"j":35,"k":36,"l":37,"m":38,"n":39,"o":40,"p":41,"q":42,"r":43,"s":44,"t":45,"u":46,"v":47,"w":48,"x":49,"y":50,"z":51,"0":52,"1":53,"2":54,"3":55,"4":56,"5":57,"6":58,"7":59,"8":60,"9":61,"+":62,"/":63};
base64.atobarr = function(base64str) {
    var modulo = base64str.length % 4;
    var ret = [];
    for (var i = 0; i < base64str.length + modulo; i += 4) {
        var bits = (base64._revLookup[base64str[i]] << 18) | (base64._revLookup[base64str[i+1]] << 12) | (base64._revLookup[base64str[i+2]] << 6) | (base64._revLookup[base64str[i+3]]);
        var pads = (base64str[i+2] == "=") ? 2 : ((base64str[i+3] == "=") ? 1 : 0);

        ret.push((bits >> 16) & 255);
        if (pads <= 1) ret.push((bits >> 8) & 255);
        if (pads == 0) ret.push(bits & 255);
    }
    return ret;
};
base64.atob = function(base64str) {
    var modulo = base64str.length % 4;
    var ret = "";
    for (var i = 0; i < base64str.length + modulo; i += 4) {
        var bits = (base64._revLookup[base64str[i]] << 18) | (base64._revLookup[base64str[i+1]] << 12) | (base64._revLookup[base64str[i+2]] << 6) | (base64._revLookup[base64str[i+3]]);
        var pads = (base64str[i+2] == "=") ? 2 : ((base64str[i+3] == "=") ? 1 : 0);

        ret += String.fromCharCode((bits >> 16) & 255);
        if (pads <= 1) ret += String.fromCharCode((bits >> 8) & 255);
        if (pads == 0) ret += String.fromCharCode(bits & 255);
    }
    return ret;
};
base64.btoa = function(inputString) {
    var modulo = inputString.length % 3;
    var outStr = "";
    if (Array.isArray(inputString)) {
        for (var i = 0; i < inputString.length + ((modulo == 0) ? 0 : 3 - modulo); i += 3) {
            var bytes = (inputString[i] << 16) | (inputString[i+1] << 8) | inputString[i+2];
            // for arrays, out-of-bounds have value of undefined;
            // for strings, out-of-bounds have value of NaN -- both are casted into int 0 on bitwise operations.

            outStr += base64._lookup[(bytes >> 18) & 63];
            outStr += base64._lookup[(bytes >> 12) & 63];
            if (i < Math.floor(inputString.length / 3) * 3 | (modulo == 2 || modulo == 0)) outStr += base64._lookup[(bytes >> 6) & 63];
            if (i < Math.floor(inputString.length / 3) * 3 | modulo == 0) outStr += base64._lookup[bytes & 63];
        }
        // pad the output
        if (modulo == 1) outStr += "==";
        else if (modulo == 2) outStr += "=";
    }
    else if (typeof inputString == "string") {
        for (var i = 0; i < inputString.length + ((modulo == 0) ? 0 : 3 - modulo); i += 3) {
            var bytes = (inputString.charCodeAt(i) << 16) | (inputString.charCodeAt(i+1) << 8) | inputString.charCodeAt(i+2);
            // for arrays, out-of-bounds have value of undefined;
            // for strings, out-of-bounds have value of NaN -- both are casted into int 0 on bitwise operations.

            outStr += base64._lookup[(bytes >> 18) & 63];
            outStr += base64._lookup[(bytes >> 12) & 63];
            if (i < Math.floor(inputString.length / 3) * 3 | (modulo == 2 || modulo == 0)) outStr += base64._lookup[(bytes >> 6) & 63];
            if (i < Math.floor(inputString.length / 3) * 3 | modulo == 0) outStr += base64._lookup[bytes & 63];
        }
        // pad the output
        if (modulo == 1) outStr += "==";
        else if (modulo == 2) outStr += "=";
    }
    else {
        throw "Unknown byte representation (with typeof "+typeof bytes+")";
    }

    return outStr;
};
Object.freeze(base64);
// Polyfilling some functions from ECMAScript6+
if (!String.prototype.repeat) {
    String.prototype.repeat = function(count) {
        'use strict';
        if (this == null)
            throw new TypeError('can\'t convert ' + this + ' to object');

        var str = '' + this;
        // To convert string to integer.
        count = +count;
        // Check NaN
        if (count != count)
            count = 0;

        if (count < 0)
            throw new RangeError('repeat count must be non-negative');

        if (count == Infinity)
            throw new RangeError('repeat count must be less than infinity');

        count = Math.floor(count);
        if (str.length == 0 || count == 0)
            return '';

        // Ensuring count is a 31-bit integer allows us to heavily optimize the
        // main part. But anyway, most current (August 2014) browsers can't handle
        // strings 1 << 28 chars or longer, so:
        if (str.length * count >= 1 << 28)
            throw new RangeError('repeat count must not overflow maximum string size');

        var maxCount = str.length * count;
        count = Math.floor(Math.log(count) / Math.log(2));
        while (count) {
             str += str;
             count--;
        }
        str += str.substring(0, maxCount - str.length);
        return str;
    }
}
