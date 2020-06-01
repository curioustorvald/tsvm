/*
NOTE: do not allow concatenation of commands!

Operators

; - When used by PRINT and INPUT, concatenates two printables; numbers will have one space between them while strings
    will not.
, - Function argument separator
+ - Just as in JS; concatenates two strings

*/

var vmemsize = system.maxmem() - 5236;

var cmdbuf = []; // index: line number
var cmdbufMemFootPrint = 0;
var prompt = "Ok";

var lang = {};
lang.syntaxfehler = function(line) {
    if (typeof line == "undefined")
        return "Syntax error";
    return "Syntax error in " + line;
};

function getUsedMemSize() {
    return cmdbufMemFootPrint; // + array's dimsize * 8 + variables' sizeof literal + functions' expression length
}


var reLineNum = /^[0-9]+ +[^0-9]/;
var reFloat = /^([\-+]?[0-9]*[.][0-9]+[eE]*[\-+0-9]*[fF]*|[\-+]?[0-9]+[.eEfF][0-9+\-]*[fF]?)$/;
var reDec = /^([\-+]?[0-9_]+)$/;
var reHex = /^(0[Xx][0-9A-Fa-f_]+?)$/;
var reBin = /(0[Bb][01_]+)$/;
var reBool = /true|false/;

var reNum = /[0-9]+/;
var charsetNumMeta = /[.BbFfXx_]/;
var charsetOp = /[()\/|&,]+/;
var tbasexit = false;

println("Terran BASIC 1.0  "+vmemsize+" bytes free");
println(prompt);

var basicInterpreterStatus = {};
// variable object constructor
function BasicVar(linenum, literal, type) {
    this.literal = literal;
    this.type = type;
}
// DEFUN (GW-BASIC equiv. of DEF FN) constructor
function BasicFun(linenum, params, expression) {
    this.params = params;
    this.expression = expression;
}
// DIM (array) constructor
function BasicArr() {
    var args = Array.from(arguments);
    if (args.length == 1)
        throw lang.syntaxfehler(args[0]);
    else if (args.length == 0)
        throw "InternalError: pass the line number!";
    else {
        // create nested array as defined
        var dimsize = Number(args[1]);
        var a = new Array(args[1]);
        var internal = a;
        for (var i = 2; i < args.length; i++) {
            dimsize *= Number(args[i]);
            var inner = new Array(args[i]);
            internal.push(inner);
            internal = inner;
        }

        this.array = a;
        this.dimsize = dimsize;
    }
}
basicInterpreterStatus.gosubStack = [];
basicInterpreterStatus.variables = {};
basicInterpreterStatus.defuns = {};
basicInterpreterStatus.builtin = {};
basicInterpreterStatus.builtin.print = function() {
    var args = Array.from(arguments);
    if (args.length == 0)
        println();
    else
        println(args.join("\t"));
};
Object.freeze(basicInterpreterStatus.builtin);
var basicFunctions = {};
basicFunctions._isNumber = function(code) {
    return (code >= 0x30 && code <= 0x39) || code == 0x2E;
};
basicFunctions._isParenOpen = function(code) {
    return (code == 0x28 || code == 0x5B);
};
basicFunctions._isParenClose = function(code) {
    return (code == 0x29 || code == 0x5D);
};
basicFunctions._isParen = function(code) {
    return basicFunctions._isParenOpen(code) || basicFunctions._isParenClose(code);
};
basicFunctions._isSeparator = function(code) {
    return code == 0x2C;
};
basicFunctions._isOperator = function(code) {
    return (code == 0x21 || code == 0x23 || code == 0x25 || code == 0x2A || code == 0x2B || code == 0x2D || code == 0x2E || code == 0x2F || (code >= 0x3C && code <= 0x3E) || code == 0x5E || code == 0x7C);
};
// @returns: line number for the next command, normally (lnum + 1); if GOTO or GOSUB was met, returns its line number
basicFunctions._interpretLine = function(lnum, cmd) {
    var _debugprintStateTransition = false;
    var tokens = [];
    var modes = [];
    var sb = "";
    var mode = "literal"; // literal, escape, number, quote, quote_end, operator, paren, sep, limbo

    if (_debugprintStateTransition) println("Ln "+lnum+" cmd "+cmd);

    // TOKENISE
    // TODO add separator
    for (var k = 0; k < cmd.length; k++) {
        var char = cmd.charAt(k);
        var charCode = cmd.charCodeAt(k);

        if (_debugprintStateTransition) print("Char: "+char+"("+charCode+"), state: "+mode);

        if (mode == "literal") {
            if (0x22 == charCode) { // "
                tokens.push(sb); sb = ""; modes.push(mode);
                mode = "quote";
            }
            /*else if (charCode == 0x5C) { // reverse solidus
                tokens.push(sb); sb = "";
                mode = "escape";
            }*/
            else if (basicFunctions._isOperator(charCode)) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "operator";
            }
            else if (basicFunctions._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "paren";
            }
            else if (" " == char) {
                tokens.push(sb); sb = ""; modes.push(mode);
                mode = "limbo";
            }
            else if (basicFunctions._isSeparator(charCode)) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "sep";
            }
            else {
                sb += char;
            }
        }
        else if ("escape" == mode) {
            if (0x5C == charCode) // reverse solidus
                sb += String.fromCharCode(0x5C);
            else if ("n" == char)
                sb += String.fromCharCode(0x0A);
            else if ("t" == char)
                sb += String.fromCharCode(0x09);
            else if (0x22 == charCode) // "
                sb += String.fromCharCode(0x22);
            else if (0x27 == charCode)
                sb += String.fromCharCode(0x27);
            else if ("e" == char)
                sb += String.fromCharCode(0x1B);
            else if ("a" == char)
                sb += String.fromCharCode(0x07);
            else if ("b" == char)
                sb += String.fromCharCode(0x08);
            mode = "quote"; // ESCAPE is only legal when used inside of quote
        }
        else if ("quote" == mode) {
            if (0x22 == charCode) {
                tokens.push(sb); sb = ""; modes.push(mode);
                mode = "quote_end";
            }
            else {
                sb += char;
            }
        }
        else if ("quote_end" == mode) {
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
        else if ("number" == mode) {
            if (basicFunctions._isNumber(charCode)) {
                sb += char;
            }
            else if (" " == char) {
                tokens.push(sb); sb = ""; modes.push(mode);
                mode = "limbo";
            }
            else if (basicFunctions._isOperator(charCode)) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "operator";
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "quote";
            }
            else if (basicFunctions._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "paren";
            }
            else if (basicFunctions._isSeparator(charCode)) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "sep";
            }
            else {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "literal";
            }
        }
        else if ("operator" == mode) {
            if (basicFunctions._isOperator(charCode)) {
                sb += char;
            }
            else if (basicFunctions._isNumber(charCode)) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "number";
            }
            else if (" " == char) {
                tokens.push(sb); sb = ""; modes.push(mode);
                mode = "limbo";
            }
            else if (basicFunctions._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "paren";
            }
            else if (basicFunctions._isSeparator(charCode)) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "sep";
            }
            else {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "literal";
            }
        }
        else if ("limbo" == mode) {
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
            else if (0x22 == charCode) {
                sb = "";
                mode = "quote"
            }
            else if (basicFunctions._isParen(charCode)) {
                sb = "";
                mode = "paren";
            }
            else if (basicFunctions._isSeparator(charCode)) {
                sb = "";
                mode = "sep";
            }
            else {
                sb = "" + char;
                mode = "literal";
            }
        }
        else if ("paren" == mode) {
            if (char == " ") {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "limbo";
            }
            else if (basicFunctions._isNumber(charCode)) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "number"
            }
            else if (basicFunctions._isOperator(charCode)) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "operator"
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "quote"
            }
            else if (basicFunctions._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "paren";
            }
            else if (basicFunctions._isSeparator(charCode)) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "sep";
            }
            else {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "literal";
            }
        }
        else if ("sep" == mode) {
            if (char == " ") {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "limbo";
            }
            else if (basicFunctions._isNumber(charCode)) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "number"
            }
            else if (basicFunctions._isOperator(charCode)) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "operator"
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "quote"
            }
            else if (basicFunctions._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "paren";
            }
            else if (basicFunctions._isSeparator(charCode)) {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "sep";
            }
            else {
                tokens.push(sb); sb = "" + char; modes.push(mode);
                mode = "literal";
            }
        }
        else {
            throw "Unknown parser state: " + mode;
        }

        if (_debugprintStateTransition) println("->"+mode);
    }

    if (sb.length > 0) {
        tokens.push(sb); modes.push(mode);
    }

    // END TOKENISE

    println(tokens.join("~"));
    println(modes.join(" "));



    return lnum + 1;
}; // end INTERPRETLINE
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
basicFunctions.renum = function(args) { // RENUM function
    var newcmdbuf = [];
    var linenumRelation = [[]];
    var cnt = 10;
    for (var k = 0; k < cmdbuf.length; k++) {
        if (typeof cmdbuf[k] != "undefined") {
            newcmdbuf[cnt] = cmdbuf[k];
            linenumRelation[k] = cnt;
            cnt += 10;
        }
    }
    // deal with goto/gosub line numbers
    for (k = 0; k < newcmdbuf.length; k++) {
        if (typeof newcmdbuf[k] != "undefined" && newcmdbuf[k].toLowerCase().startsWith("goto ")) {
            newcmdbuf[k] = "goto " + linenumRelation[newcmdbuf[k].match(reNum)[0]];
        }
        else if (typeof newcmdbuf[k] != "undefined" && newcmdbuf[k].toLowerCase().startsWith("gosub ")) {
            newcmdbuf[k] = "gosub " + linenumRelation[newcmdbuf[k].match(reNum)[0]];
        }
    }
    cmdbuf = newcmdbuf.slice(); // make shallow copy

    // recalculate memory footprint
    cmdbufMemFootPrint = 0;
    cmdbuf.forEach(function(v, i, arr) {
        cmdbufMemFootPrint += ("" + i).length + 1 + v.length;
    });
};
basicFunctions.fre = function(args) {
    println(vmemsize - getUsedMemSize());
};
basicFunctions.run = function(args) { // RUN function
    var linenumber = 1;
    var oldnum = 1;
    do {
        if (typeof cmdbuf[linenumber] != "undefined") {
            oldnum = linenumber;
            linenumber = basicFunctions._interpretLine(linenumber, cmdbuf[linenumber]);
        }
        else {
            linenumber += 1;
        }
        if (con.hitterminate()) {
            println("Break in "+oldnum);
            break;
        }
    } while (linenumber < cmdbuf.length)
};
Object.freeze(basicFunctions);
while (!tbasexit) {
    var line = sys.read();
    line = line.trim();

    cmdbufMemFootPrint += line.length;

    if (reLineNum.test(line)) {
        var i = line.indexOf(" ");
        cmdbuf[line.slice(0, i)] = line.slice(i + 1, line.length);
    }
    else if (line.length > 0) {
        cmdbufMemFootPrint -= line.length;
        try {
            var cmd = line.split(" ");
            basicFunctions[cmd[0]](cmd);
        }
        catch (e) {
            println(e);
            println(lang.syntaxfehler());
        }
        println(prompt);
    }
}


/*
digraph G {
  start -> LITERAL
  start -> LINENUMBER [label="reDec"]

  LINENUMBER -> LINENUMBER [label="numbers"]
  LINENUMBER -> limbo [label="space"]
  LINENUMBER -> LITERAL [label="otherwise"]

  LITERAL -> limbo [label="space"]
  LITERAL -> OPERATOR [label="reOps"]
  LITERAL -> ESCAPE [label="\\"]
  LITERAL -> QUOTE [label="\""]
  LITERAL -> PAREN [label="()[]"]
  LITERAL -> SEP [label=","]
  LITERAL -> LITERAL [label="otherwise"]

  limbo -> NUMBER [label="numbers"]
  limbo -> OPERATOR [label="reOps"]
  limbo -> QUOTE [label="\""]
  limbo -> LITERAL [label="otherwise"]
  limbo -> PAREN [label="()[]"]
  limbo -> SEP [label=","]
  limbo -> limbo [label="space"]

  ESCAPE -> LITERAL
  QUOTE -> QUOTE_END [label="\""]
  QUOTE -> QUOTE [label="otherwise"]

  QUOTE_END -> limbo [label="space"]
  QUOTE_END -> NUMBER [label="numbers"]
  QUOTE_END -> OPERATOR [label="reOps"]
  QUOTE_END -> PAREN [label="()[]"]
  QUOTE_END -> SEP [label=","]
  QUOTE_END -> LITERAL [label="otherwise"]

  OPERATOR -> NUMBER [label="numbers"]
  OPERATOR -> limbo [label="space"]
  OPERATOR -> OPERATOR [label="reOps"]
  OPERATOR -> PAREN [label="()[]"]
  OPERATOR -> SEP [label=","]
  OPERATOR -> LITERAL [label="otherwise"]

  NUMBER -> NUMBER [label="numbers"]
  NUMBER -> OPERATOR [label="reOps"]
  NUMBER -> QUOTE [label="\""]
  NUMBER -> limbo [label="space"]
  NUMBER -> PAREN [label="()[]"]
  NUMBER -> SEP [label=","]
  NUMBER -> LITERAL [label="otherwise"]

  PAREN -> PUSH_AND_PAREN [label="()[]"]
  PAREN -> NUMBER [label="numbers"]
  PAREN -> OPERATOR [label="reOps"]
  PAREN -> QUOTE [label="\""]
  PAREN -> limbo [label="space"]
  PAREN -> SEP [label=","]
  PAREN -> LITERAL [label="otherwise"]

  SEP -> PAREN [label="()[]"]
  SEP -> NUMBER [label="numbers"]
  SEP -> OPERATOR [label="reOps"]
  SEP -> QUOTE [label="\""]
  SEP -> limbo [label="space"]
  SEP -> PUSH_AND_SEP [label=","]
  SEP -> LITERAL [label="otherwise"]

  LITERAL -> end [label="\\n"]
  NUMBER -> end [label="\\n"]
  QUOTE_END -> end  [label="\\n"]
  OPERATOR -> end [label="\\n"]
  PAREN -> end [label="\\n"]

  start [shape=Mdiamond];
  end [shape=Msquare];

  concentrate=true;
}
*/