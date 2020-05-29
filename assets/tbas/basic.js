var vmemsize = 60300;
var vmemused = 0;
var cmdbuf = []; // index: line number
var prompt = "Ok";

var lang = {
    syntaxfehler: "Syntax error"
};

var reLineNum = /^[0-9]+ +[^0-9]/;
var reFloat = /^([\-+]?[0-9]*[.][0-9]+[eE]*[\-+0-9]*[fF]*|[\-+]?[0-9]+[.eEfF][0-9+\-]*[fF]?)$/;
var reDec = /^([\-+]?[0-9_]+)$/;
var reHex = /^(0[Xx][0-9A-Fa-f_]+?)$/;
var reBin = /(0[Bb][01_]+)$/;
var reBool = /true|false/;

var charsetNum = /[0-9]+/;
var charsetNumMeta = /[.BbFfXx_]/;
var charsetOp = /[()\/|&,]+/;
var tbasexit = false;

println("Terran BASIC 1.0  "+vmemsize+" bytes free");
println(prompt);

var basicFunctions = new Object();
basicFunctions._isNumber = function(code) {

};
basicFunctions._isOperator = function(code) {

};
// @returns: line number for the next command, normally (lnum + 1); if GOTO or GOSUB was met, returns its line number
basicFunctions._interpretLine = function(lnum, cmd) {
    var tokens = [];
    var sb = "";
    var mode = "literal"; // literal, escape, number, quote, quote_end, operator, limbo

    // TOKENISE
    for (var k = 0; k < cmd.length; k++) {
        var char = cmd.charAt(k);
        var charCode = cmd.charCodeAt(k);

        if (mode == "literal") {
            if (charCode == 0x22) { // "
                tokens.push(sb); sb = "";
                mode = "quote";
            }
            /*else if (charCode == 0x5C) { // reverse solidus
                tokens.push(sb); sb = "";
                mode = "escape";
            }*/
            else if (basicFunctions._isOperator(charCode)) {
                tokens.push(sb); sb = "" + char;
                mode = "operator";
            }
            else if (char == " ") {
                tokens.push(sb); sb = "";
                mode = "limbo";
            }
            else {
                sb += char;
            }
        }
        else if (mode == "escape") {
            if (charCode == 0x5C) // reverse solidus
                sb += String.fromCharCode(0x5C);
            else if (char == "n")
                sb += String.fromCharCode(0x0A);
            else if (char == "t")
                sb += String.fromCharCode(0x09);
            else if (charCode == 0x22) // "
                sb += String.fromCharCode(0x22);
            else if (charCode == 0x27)
                sb += String.fromCharCode(0x27);
            else if (char == "e")
                sb += String.fromCharCode(0x1B);
            else if (char == "a")
                sb += String.fromCharCode(0x07);
            else if (char == "b")
                sb += String.fromCharCode(0x08);
            mode = "quote"; // ESCAPE is only legal when used inside of quote
        }
        else if (mode == "quote") {
            if (charCode = 0x22) {
                tokens.push(sb); sb = "";
                mode = "quote_end";
            }
            else {
                sb += char;
            }
        }
        else if (mode == "quote_end") {
            if (basicFunctions._isNumber(charCode)) {
                mode = "number";
            }
            else if (basicFunctions._isOperator(charCode)) {
                mode = "operator";
            }
            else {
                mode = "limbo";
            }
        }
        else if (mode == "number") {
            if (basicFunctions._isNumber(charCode)) {
                sb += char;
            }
            else if (char == " ") {
                tokens.push(sb); sb = "";
                mode = "limbo";
            }
            else if (basicFunctions._isOperator(charCode)) {
                tokens.push(sb); sb = "" + char;
                mode = "operator";
            }
            else if (charCode == 0x22) {
                tokens.push(sb); sb = "" + char;
                mode = "quote";
            }
            else {
                tokens.push(sb); sb = "" + char;
                mode = "literal";
            }
        }
        else if (mode == "operator") {
            if (basicFunctions._isOperator(charCode)) {
                sb += char;
            }
            else if (basicFunctions._isNumber(charCode)) {
                tokens.push(sb); sb = "" + char;
                mode = "number";
            }
            else if (char == " ") {
                tokens.push(sb); sb = "";
                mode = "limbo";
            }
            else {
                tokens.push(sb); sb = "" + char;
                mode = "lteral";
            }
        }
        else if (mode == "limbo") {
            if (char == " ") {
                /* do nothing */
            }
            else if (basicFunctions._isNumber(charCode)) {
                sb = "" + char;
                mode = "number"
            }
            else if (basicFunctions._isOperator(charCode)) {
                sb = "" + char;
                mode = "operator"
            }
            else if (charCode == 0x22) {
                sb = "" + char;
                mode = "quote"
            }
            else {
                sb = "" + char;
                mode = "literal";
            }
        }
        else {
            throw "Unknown parser state: " + mode;
        }
    }
    // END TOKENISE

    println(tokens);

    return lnum + 1;
};
basicFunctions._basicList = function(v, i, arr) {
    if (i < 10) print(" ");
    if (i < 100) print(" ");
    print(i);
    print(" ");
    println(v);
};
basicFunctions.list = function(args) { // LIST function
    if (args.length == 1) {
        cmdbuf.forEach(basicFunctions._basicList);
    }
    else if (args.length == 2) {
        if (typeof cmdbuf[args[1]] != "undefined")
            basicFunctions._basicList(cmdbuf[args[1]], args[1], undefined);
    }
    else {
        var lastIndex = (args[2] === ".") ? cmdbuf.length - 1 : (args[2] | 0);
        var i = 0;
        for (i = args[1]; i <= lastIndex; i++) {
            var cmd = cmdbuf[i];
            if (typeof cmd != "undefined") {
                basicFunctions._basicList(cmd, i, cmdbuf);
            }
        }
    }
};
basicFunctions.system = function(args) { // SYSTEM function
    tbasexit = true;
};
basicFunctions.new = function(args) { // NEW function
    cmdbuf = [];
};
basicFunctions.run = function(args) { // RUN function
    var linenumber = 1;
    var oldnum = 1;
    do {
        if (typeof cmd != "undefined") {
            oldnum = linenumber;
            linenumber = basicFunctions._interpretLine(linenumber, cmdbuf[linenumber]);
        }
        else {
            linenumber += 1;
        }
        if (con.hitterminate) {
            println("Break in "+oldlnum);
            break;
        }
    } while (linenumber < cmdbuf.length)
};
Object.freeze(basicFunctions);
while (!tbasexit) {
    var line = vm.read();
    line = line.trim();

    if (reLineNum.test(line)) {
        var i = line.indexOf(" ");
        cmdbuf[line.slice(0, i)] = line.slice(i + 1, line.length);
    }
    else if (line.length > 0) {
        try {
            var cmd = line.split(" ");
            basicFunctions[cmd[0]](cmd);
        }
        catch (e) {
            println(e);
            println(lang.syntaxfehler);
        }
        println(prompt);
    }
}