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
lang.badNumberFormat = "Illegal number format";
lang.badOperatorFormat = "Illegal operator format";
lang.badFunctionCallFormat = "Illegal function call";
lang.unmatchedBrackets = "Unmatched brackets";
lang.syntaxfehler = function(line, reason) {
    //serial.printerr("Syntax error" + ((line !== undefined) ? (" in "+line) : "") + ((reason !== undefined) ? (": "+reason) : ""));
    //serial.printerr(new Error().stack);
    return "Syntax error" + ((line !== undefined) ? (" in "+line) : "") + ((reason !== undefined) ? (": "+reason) : "");
};
lang.illegalType = function(line, obj) {
    //serial.printerr("Type mismatch" + ((line !== undefined) ? (" in "+line) : ""));
    //serial.printerr(new Error().stack);
    return "Type mismatch" + ((obj !== undefined) ? " \"" + obj + "\"" : "") + ((line !== undefined) ? (" in "+line) : "");
 };
lang.refError = function(line, obj) {
    //serial.printerr("Unresolved reference" + ((line !== undefined) ? (" in "+line) : ""));
    //serial.printerr(new Error().stack);
    return "Unresolved reference" + ((obj !== undefined) ? " \"" + obj + "\"" : "") + ((line !== undefined) ? (" in "+line) : "");
};
lang.nowhereToReturn = function(line) { return "RETURN without GOSUB in " + line; };
lang.errorinline = function(line, stmt, errobj) {
    return "Error on statement \""+stmt+"\": " + errobj;
};
lang.parserError = function(line, errorobj) {
    return "Parser error in " + line + ": " + errorobj;
};
Object.freeze(lang);

function getUsedMemSize() {
    return cmdbufMemFootPrint; // + array's dimsize * 8 + variables' sizeof literal + functions' expression length
}


var reLineNum = /^[0-9]+ /;
//var reFloat = /^([\-+]?[0-9]*[.][0-9]+[eE]*[\-+0-9]*[fF]*|[\-+]?[0-9]+[.eEfF][0-9+\-]*[fF]?)$/;
//var reDec = /^([\-+]?[0-9_]+)$/;
//var reHex = /^(0[Xx][0-9A-Fa-f_]+)$/;
//var reBin = /^(0[Bb][01_]+)$/;

// must match partial
var reNumber = /([0-9]*[.][0-9]+[eE]*[\-+0-9]*[fF]*|[0-9]+[.eEfF][0-9+\-]*[fF]?)|([0-9_]+)|(0[Xx][0-9A-Fa-f_]+)|(0[Bb][01_]+)/;
var reOps = /\^|;|\*|\/|\+|\-|[<>=]{1,2}/;

var reNum = /[0-9]+/;
var tbasexit = false;

println("Terran BASIC 1.0  "+vmemsize+" bytes free");
println(prompt);

// variable object constructor
function BasicVar(literal, type) {
    this.literal = literal;
    this.type = type;
}
// DEFUN (GW-BASIC equiv. of DEF FN) constructor
function BasicFun(params, expression) {
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
// Abstract Syntax Tree
// creates empty tree node
function BasicAST() {
    this.lnum = 0;
    this.depth = 0;
    this.leaves = [];
    this.value = undefined;
    this.type = "null"; // literal, operator, string, number, function, null

    this.toString = function() {
        var sb = "";
        var marker = ("literal" == this.type) ? "i" : ("operator" == this.type) ? "+" : "f";
        sb += "| ".repeat(this.depth) + marker+" Line "+this.lnum+" ("+this.type+")\n";
        sb += "| ".repeat(this.depth+1) + "leaves: "+(this.leaves.length)+"\n";
        sb += "| ".repeat(this.depth+1) + "value: "+this.value+" (type: "+typeof this.value+")\n";
        for (var k = 0; k < this.leaves.length; k++) {
            sb += this.leaves[k].toString(); + "\n";
        }
        sb += "| ".repeat(this.depth) + "`-----------------\n";
        return sb;
    };
}
function parseSigil(s) {
    var rettype;
    if (s.endsWith("$"))
        rettype = "string";
    else if (s.endsWith("%"))
        rettype = "integer";
    else if (s.endsWith("!") || s.endsWith("#"))
        rettype = "float";

    return {name:(rettype === undefined) ? s.toUpperCase() : s.substring(0, s.length - 1).toUpperCase(), type:rettype};
}
/*
@param variable object in following structure: {type: (String), value: (String}. The type is defined in BasicAST.
@return a value, if the input type if string or number, its literal value will be returned. Otherwise will search the
        BASIC variable table and return the literal value of the BasicVar; undefined will be returned if no such var exists.
*/
function resolve(variable) {
    if (variable.type == "string" || variable.type == "number" || variable.type == "bool")
        return variable.value;
    else if (variable.type == "literal") {
        var basicvar = basicInterpreterStatus.variables[parseSigil(variable.value).name];
        return (basicvar !== undefined) ? basicvar.literal : undefined;
    }
    else if (variable.type == "null")
        return undefined;
    else
        throw "InternalError: unknown variable with type "+variable.type+", with value "+variable.value
}
function oneArgNonNull(lnum, args, predicate) {
    if (args.length != 1) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var resolvedargs = args.map(function(it) { return resolve(it); });
    resolvedargs.forEach(function(v) {
        if (v === undefined) throw lang.refError(lnum, v.value);
    });
    var argum = resolvedargs.map(function(it) {
        if (it === undefined) throw lang.refError(lnum, it.value);
        return it;
    });
    return predicate(argum[0]);
}
function oneArgNonNullNumeric(lnum, args, predicate) {
    if (args.length != 1) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var resolvedargs = args.map(function(it) { return resolve(it); });
    resolvedargs.forEach(function(v) {
        if (v === undefined) throw lang.refError(lnum, v.value);
        if (isNaN(v)) throw lang.illegalType(lnum, v.value);
    });
    var argum = resolvedargs.map(function(it) {
        if (it === undefined) throw lang.refError(lnum, it.value);
        return it;
    });
    return predicate(argum[0]);
}
function twoArgNonNull(lnum, args, predicate) {
    if (args.length != 2) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var resolvedargs = args.map(function(it) { return resolve(it); });
    resolvedargs.forEach(function(v) {
        if (v === undefined) throw lang.refError(lnum, v.value);
    });
    var argum = resolvedargs.map(function(it) {
        if (it === undefined) throw lang.refError(lnum, it.value);
        return it;
    });
    return predicate(argum[0], argum[1]);
}
function twoArgNonNullNumeric(lnum, args, predicate) {
    if (args.length != 2) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var resolvedargs = args.map(function(it) { return resolve(it); });
    resolvedargs.forEach(function(v) {
        if (v === undefined) throw lang.refError(lnum, v.value);
        if (isNaN(v)) throw lang.illegalType(lnum, v.value);
    });
    var argum = resolvedargs.map(function(it) {
        if (it === undefined) throw lang.refError(lnum, it.value);
        return it;
    });
    return predicate(argum[0], argum[1]);
}
function threeArgNonNull(lnum, args, predicate) {
    if (args.length != 3) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var resolvedargs = args.map(function(it) { return resolve(it); });
    resolvedargs.forEach(function(v) {
        if (v === undefined) throw lang.refError(lnum, v.value);
    });
    var argum = resolvedargs.map(function(it) {
        if (it === undefined) throw lang.refError(lnum, it.value);
        return it;
    });
    return predicate(argum[0], argum[1], argum[2]);
}
function threeArgNonNullNumeric(lnum, args, predicate) {
    if (args.length != 3) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var resolvedargs = args.map(function(it) { return resolve(it); });
    resolvedargs.forEach(function(v) {
        if (v === undefined) throw lang.refError(lnum, v.value);
        if (isNaN(v)) throw lang.illegalType(lnum, v.value);
    });
    var argum = resolvedargs.map(function(it) {
        if (it === undefined) throw lang.refError(lnum, it.value);
        return it;
    });
    return predicate(argum[0], argum[1], argum[2]);
}
var basicInterpreterStatus = {};
basicInterpreterStatus.gosubStack = [];
basicInterpreterStatus.variables = {};
basicInterpreterStatus.defuns = {};
/*
@param lnum line number
@param args instance of the SyntaxTreeReturnObj
*/
basicInterpreterStatus.builtin = {
"=" : function(lnum, args) {
    if (args.length != 2) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var parsed = parseSigil(args[0].value); var rh = resolve(args[1]);
    if (rh === undefined) throw lang.refError(lnum, args[1].value);

    basicInterpreterStatus.variables[parsed.name] = new BasicVar(rh, (parsed.type === undefined) ? "float" : parsed.type);
},
"==" : function(lnum, args) {
    return twoArgNonNull(lnum, args, function(lh, rh) { return lh == rh; });
},
"<>" : function(lnum, args) {
    return twoArgNonNull(lnum, args, function(lh, rh) { return lh != rh; });
},
"><" : function(lnum, args) {
    return twoArgNonNull(lnum, args, function(lh, rh) { return lh != rh; });
},
"<=" : function(lnum, args) {
    return twoArgNonNullNumeric(lnum, args, function(lh, rh) { return lh <= rh; });
},
"=<" : function(lnum, args) {
    return twoArgNonNullNumeric(lnum, args, function(lh, rh) { return lh <= rh; });
},
">=" : function(lnum, args) {
    return twoArgNonNullNumeric(lnum, args, function(lh, rh) { return lh >= rh; });
},
"=>" : function(lnum, args) {
    return twoArgNonNullNumeric(lnum, args, function(lh, rh) { return lh >= rh; });
},
"<" : function(lnum, args) {
    return twoArgNonNullNumeric(lnum, args, function(lh, rh) { return lh < rh; });
},
">" : function(lnum, args) {
    return twoArgNonNullNumeric(lnum, args, function(lh, rh) { return lh > rh; });
},
"<<" : function(lnum, args) {
    return twoArgNonNullNumeric(lnum, args, function(lh, rh) { return lh << rh; });
},
">>" : function(lnum, args) {
    return twoArgNonNullNumeric(lnum, args, function(lh, rh) { return lh >> rh; });
},
"UNARYMINUS" : function(lnum, args) {
    return oneArgNonNullNumeric(lnum, args, function(lh) { return -lh; });
},
"UNARYPLUS" : function(lnum, args) {
    return oneArgNonNullNumeric(lnum, args, function(lh) { return +lh; });
},
"BAND" : function(lnum, args) {
    return twoArgNonNullNumeric(lnum, args, function(lh, rh) { return lh & rh; });
},
"BOR" : function(lnum, args) {
    return twoArgNonNullNumeric(lnum, args, function(lh, rh) { return lh | rh; });
},
"BXOR" : function(lnum, args) {
    return twoArgNonNullNumeric(lnum, args, function(lh, rh) { return lh ^ rh; });
},
"+" : function(lnum, args) {
    return twoArgNonNull(lnum, args, function(lh, rh) { return lh + rh; });
},
"-" : function(lnum, args) {
    return twoArgNonNullNumeric(lnum, args, function(lh, rh) { return lh - rh; });
},
"*" : function(lnum, args) {
    return twoArgNonNullNumeric(lnum, args, function(lh, rh) { return lh * rh; });
},
"/" : function(lnum, args) {
    return twoArgNonNullNumeric(lnum, args, function(lh, rh) { return lh / rh; });
},
"MOD" : function(lnum, args) {
    return twoArgNonNullNumeric(lnum, args, function(lh, rh) { return lh % rh; });
},
"^" : function(lnum, args) {
    return twoArgNonNullNumeric(lnum, args, function(lh, rh) { Math.pow(lh, rh); });
},
"PRINT" : function(lnum, args) {
    //serial.println("BASIC func: PRINT -- args="+(args.map(function(it) { return it.type+" "+it.value; })).join(", "));

    if (args.length == 0)
        println();
    else {
        if (args[args.length - 1].type == "null") {
            print(args.slice(0, args.length - 1).map(function(it) {
                var it2 = resolve(it);
                return ((!isNaN(it2)) ? " " : "") + it2; // BASIC always put a space before a number
            }).join("\t"));
        }
        else {
            println(args.map(function(it) {
                var it2 = resolve(it);
                return ((!isNaN(it2)) ? " " : "") + it2; // BASIC always put a space before a number
            }).join("\t"));
        }
    }
},
"EMIT" : function(lnum, args) {
    if (args.length > 0) {
        for (var llll = 0; llll < args.length; llll++) {
            var lvalll = resolve(args[llll]);
            if (isNaN(lvalll)) {
                print(lvalll);
            }
            else {
                con.addch(lvalll);
            }
        }
    }
},
"POKE" : function(lnum, args) {
    twoArgNonNullNumeric(lnum, args, function(lh, rh) { sys.poke(lh, rh); });
},
"PEEK" : function(lnum, args) {
    return oneArgNonNullNumeric(lnum, args, function(lh) { return sys.peek(lh); });
},
"GOTO" : function(lnum, args) {
    return oneArgNonNullNumeric(lnum, args, function(lh) { return lh; });
},
"GOSUB" : function(lnum, args) {
    return oneArgNonNullNumeric(lnum, args, function(lh) {
        basicInterpreterStatus.gosubStack.push(lnum + 1);
        return lh;
    });
},
"RETURN" : function(lnum, args) {
    var r = basicInterpreterStatus.gosubStack.pop();
    if (r === undefined) throw lang.nowhereToReturn(lnum);
    return r;
},
"CLEAR" : function(lnum, args) {
    basicInterpreterStatus.variables = {};
},
"PLOT" : function(lnum, args) {
    threeArgNonNullNumeric(lnum, args, function(xpos, ypos, color) { graphics.plotPixel(xpos, ypos, color); });
},
"AND" : function(lnum, args) {
    if (args.length != 2) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var resolvedargs = args.map(function(it) { return resolve(it); });
    resolvedargs.forEach(function(v) {
        if (v === undefined) throw lang.refError(lnum, v.value);
        if (typeof v !== "boolean") throw lang.illegalType(lnum, v.value);
    });
    var argum = resolvedargs.map(function(it) {
        if (it === undefined) throw lang.refError(lnum, it.value);
        return it;
    });
    return argum[0] && argum[1];
},
"OR" : function(lnum, args) {
    if (args.length != 2) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var resolvedargs = args.map(function(it) { return resolve(it); });
    resolvedargs.forEach(function(v) {
        if (v === undefined) throw lang.refError(lnum, v.value);
        if (typeof v !== "boolean") throw lang.illegalType(lnum, v.value);
    });
    var argum = resolvedargs.map(function(it) {
        if (it === undefined) throw lang.refError(lnum, it.value);
        return it;
    });
    return argum[0] || argum[1];
},
"TEST" : function(lnum, args) {
    if (args.length != 1) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    return resolve(args[0]);
}
};
Object.freeze(basicInterpreterStatus.builtin);
var basicFunctions = {};
basicFunctions._isNumber = function(code) {
    return (code >= 0x30 && code <= 0x39) || code == 0x5F;
};
basicFunctions._isNumber2 = function(code) {
    return (code >= 0x30 && code <= 0x39) || code == 0x5F || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
};
basicFunctions._isNumberSep = function(code) {
    return code == 0x2E || code == 0x42 || code == 0x58 || code == 0x62 || code == 0x78;
};
basicFunctions._isFirstOp = function(code) {
    return (code >= 0x3C && code <= 0x3E) || code == 0x2A || code == 0x2B || code == 0x2D || code == 0x2F || code == 0x5E;
};
basicFunctions._isSecondOp = function(code) {
    return (code >= 0x3C && code <= 0x3E);
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
basicFunctions._operatorPrecedence = {
    // function call in itself has highest precedence
    "^":0,
    // precedence of 1 are unary plus/minus which are pre-parenthesized
    "*":2,"/":2,
    "MOD":3,
    "+":4,"-":4,
    ";":5,
    "<<":6,">>":6,
    "==":7,"<>":7,"><":7,"<":7,">":7,"<=":7,"=<":7,">=":7,"=>":7,
    "BAND":8,
    "BXOR":9,
    "BOR":10,
    "AND":11,
    "OR":12,
    "=":13
};
basicFunctions._isUnaryOp = function(word) {
    return 5 == basicFunctions._operatorPrecedence[word];
};
basicFunctions._isOperatorWord = function(word) {
    return (basicFunctions._operatorPrecedence[word] !== undefined) // force the return type to be a boolean
};
basicFunctions._keywords = {

};
basicFunctions._tokenise = function(lnum, cmd) {
    var _debugprintStateTransition = false;
    var k;
    var tokens = [];
    var states = [];
    var sb = "";
    var mode = "literal"; // literal, quote, paren, sep, operator, number; operator2, numbersep, number2, limbo, escape, quote_end

    // NOTE: malformed numbers (e.g. "_b3", "_", "__") must be re-marked as literal or syntax error in the second pass

    if (_debugprintStateTransition) println("@@ TOKENISE @@");
    if (_debugprintStateTransition) println("Ln "+lnum+" cmd "+cmd);

    // TOKENISE
    for (k = 0; k < cmd.length; k++) {
        var char = cmd[k];
        var charCode = cmd.charCodeAt(k);

        if (_debugprintStateTransition) print("Char: "+char+"("+charCode+"), state: "+mode);

        if ("literal" == mode) {
            if (0x22 == charCode) { // "
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "quote";
            }
            else if (basicFunctions._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "paren";
            }
            else if (" " == char) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "limbo";
            }
            else if (basicFunctions._isSeparator(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "sep";
            }
            else if (basicFunctions._isNumber(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "number";
            }
            else if (basicFunctions._isFirstOp(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "operator";
            }
            else {
                sb += char;
            }
        }
        else if ("number" == mode) {
            if (basicFunctions._isNumber(charCode)) {
                sb += char;
            }
            else if (basicFunctions._isNumberSep(charCode)) {
                sb += char;
                mode = "numbersep";
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "quote";
            }
            else if (" " == char) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "limbo";
            }
            else if (basicFunctions._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "paren"
            }
            else if (basicFunctions._isSeparator(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "sep";
            }
            else if (basicFunctions._isFirstOp(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "operator";
            }
            else {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "literal";
            }
        }
        else if ("numbersep" == mode) {
            if (basicFunctions._isNumber2(charCode)) {
                sb += char;
                mode = "number2";
            }
            else {
                throw lang.syntaxfehler(lnum, lang.badNumberFormat);
            }
        }
        else if ("number2" == mode) {
            if (basicFunctions._isNumber2(charCode)) {
                sb += char;
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push("number");
                mode = "quote";
            }
            else if (" " == char) {
                tokens.push(sb); sb = ""; states.push("number");
                mode = "limbo";
            }
            else if (basicFunctions._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("number");
                mode = "paren"
            }
            else if (basicFunctions._isSeparator(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("number");
                mode = "sep";
            }
            else if (basicFunctions._isFirstOp(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("number");
                mode = "operator";
            }
            else {
                tokens.push(sb); sb = "" + char; states.push("number");
                mode = "literal";
            }
        }
        else if ("operator" == mode) {
            if (basicFunctions._isSecondOp(charCode)) {
                sb += char;
                mode = "operator2";
            }
            else if (basicFunctions._isFirstOp(charCode)) {
                throw lang.syntaxfehler(lnum, lang.badOperatorFormat);
            }
            else if (basicFunctions._isNumber(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "number";
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "quote";
            }
            else if (" " == char) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "limbo";
            }
            else if (basicFunctions._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "paren"
            }
            else if (basicFunctions._isSeparator(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "sep";
            }
            else {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "literal";
            }
        }
        else if ("operator2" == mode) {
            if (basicFunctions._isFirstOp(charCode)) {
                throw lang.syntaxfehler(lnum, lang.badOperatorFormat);
            }
            else if (basicFunctions._isNumber(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("operator");
                mode = "number";
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push("operator");
                mode = "quote";
            }
            else if (" " == char) {
                tokens.push(sb); sb = ""; states.push("operator");
                mode = "limbo";
            }
            else if (basicFunctions._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("operator");
                mode = "paren"
            }
            else if (basicFunctions._isSeparator(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("operator");
                mode = "sep";
            }
            else {
                tokens.push(sb); sb = "" + char; states.push("operator");
                mode = "literal";
            }
        }
        else if ("quote" == mode) {
            if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "quote_end";
            }
            else if (charCode == 0x5C) { // reverse solidus
                tokens.push(sb); sb = "";
                mode = "escape";
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
        else if ("quote_end" == mode) {
            if (" " == char) {
                sb = "";
                mode = "limbo";
            }
            else if (0x22 == charCode) {
                sb = "" + char;
                mode = "quote";
            }
            else if (basicFunctions._isParen(charCode)) {
                sb = "" + char;
                mode = "paren";
            }
            else if (basicFunctions._isSeparator(charCode)) {
                sb = "" + char;
                mode = "sep";
            }
            else if (basicFunctions._isNumber(charCode)) {
                sb = "" + char;
                mode = "number";
            }
            else if (basicFunctions._isFirstOp(charCode)) {
                sb = "" + char;
                mode = "operator"
            }
            else {
                sb = "" + char;
                mode = "literal";
            }
        }
        else if ("limbo" == mode) {
            if (char == " ") {
                /* do nothing */
            }
            else if (0x22 == charCode) {
                mode = "quote"
            }
            else if (basicFunctions._isParen(charCode)) {
                sb = "" + char;
                mode = "paren";
            }
            else if (basicFunctions._isSeparator(charCode)) {
                sb = "" + char;
                mode = "sep";
            }
            else if (basicFunctions._isNumber(charCode)) {
                sb = "" + char;
                mode = "number";
            }
            else if (basicFunctions._isFirstOp(charCode)) {
                sb = "" + char;
                mode = "operator"
            }
            else {
                sb = "" + char;
                mode = "literal";
            }
        }
        else if ("paren" == mode) {
            if (char == " ") {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "limbo";
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "quote"
            }
            else if (basicFunctions._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "paren";
            }
            else if (basicFunctions._isSeparator(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "sep";
            }
            else if (basicFunctions._isNumber(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "number";
            }
            else if (basicFunctions._isFirstOp(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "operator"
            }
            else {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "literal";
            }
        }
        else if ("sep" == mode) {
            if (char == " ") {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "limbo";
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "quote"
            }
            else if (basicFunctions._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "paren";
            }
            else if (basicFunctions._isSeparator(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "sep";
            }
            else if (basicFunctions._isNumber(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "number";
            }
            else if (basicFunctions._isFirstOp(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "operator"
            }
            else {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "literal";
            }
        }
        else {
            throw "Unknown parser state: " + mode;
        }

        if (_debugprintStateTransition) println("->"+mode);
    }

    if (sb.length > 0) {
        tokens.push(sb); states.push(mode);
    }

    // filter off initial empty token if the statement does NOT start with literal (e.g. "-3+5")
    if (tokens[0].length == 0) {
        tokens = tokens.slice(1, tokens.length);
        states = states.slice(1, states.length);
    }
    // clean up operator2 and number2
    for (k = 0; k < states.length; k++) {
        if (states[k] == "operator2") states[k] = "operator";
        else if (states[k] == "number2" || states[k] == "numbersep") states[k] = "number";
    }

    if (tokens.length != states.length) throw "InternalError: size of tokens and states does not match (line: "+lnum+")";

    return { "tokens": tokens, "states": states };
};
basicFunctions._parserElaboration = function(lnum, tokens, states) {
    var _debugprintElaboration = false;
    if (_debugprintElaboration) println("@@ ELABORATION @@");
    var k = 0;

    // NOTE: malformed numbers (e.g. "_b3", "_", "__") must be re-marked as literal or syntax error

    while (k < states.length) { // using while loop because array size will change during the execution
        if (states[k] == "number" && !reNumber.test(tokens[k]))
            states[k] = "literal";
        else if (states[k] == "literal" && basicFunctions._operatorPrecedence[tokens[k].toUpperCase()] !== undefined)
            states[k] = "operator";
        else if (tokens[k].toUpperCase() == "TRUE" || tokens[k].toUpperCase() == "FALSE")
            states[k] = "bool";

        // decimalise hex/bin numbers (because Nashorn does not support binary literal)
        if (states[k] == "number") {
            if (tokens[k].toUpperCase().startsWith("0B")) {
                tokens[k] = parseInt(tokens[k].substring(2, tokens[k].length), 2) + "";
            }
        }

        k += 1;
    }
};
basicFunctions._parseTokens = function(lnum, tokens, states, recDepth) {
    // DO NOT PERFORM SEMANTIC ANALYSIS HERE
    // at this point you can't (and shouldn't) distinguish whether or not defuns/variables are previously declared

    // a line has one of these forms:
    // EXPRESSION -> LITERAL |
    //               BINARY_OP |
    //               UNARY_OP |
    //               FOR_LOOP |
    //               IF_STMT |
    //               WHILE_LOOP |
    //               FUNCTION_CALL |
    //               GROUPING
    //
    // LITERAL -> NUMBERS | FUNCTION_OR_VARIABLE_NAME | BOOLS | QUOTES
    // IF_STMT -> "IF" EXPRESSION "THEN" EXPRESSION "ELSE" EXPRESSION |
    //            "IF" EXPRESSION "GOTO" NUMBERS "ELSE" NUMBERS |
    //            "IF" EXPRESSION "THEN" EXPRESSION |
    //            "IF" EXPRESSION "GOTO" NUMBERS
    // FOR_LOOP -> "FOR" FUNCTION_OR_VARIABLE_NAME "=" EXPRESSION "TO" EXPRESSION "STEP" EXPRESSION |
    //             "FOR" FUNCTION_OR_VARIABLE_NAME "=" EXPRESSION "TO" EXPRESSION
    // WHILE_LOOP -> "WHILE" EXPERSSION
    // BINARY_OP -> EXPRSSION OPERATOR EXPRESSION
    // UNARY_OP -> OPERATOR EXPRESSION
    // FUNCTION_CALL -> LITERAL GROUPING
    // GROUPING -> "(" EXPRESSION ")"

/*
for DEF*s, you might be able to go away with BINARY_OP, as the parsing tree would be:

f Line 10 (function)
| leaves: 1
| value: defun
| + Line 10 (operator)
| | leaves: 2
| | value: =
| | f Line 10 (function)
| | | leaves: 1
| | | value: sinc
| | | i Line 10 (literal)
| | | | leaves: 0
| | | | value: X
| | | `-----------------
| | `-----------------
| | + Line 10 (operator)
| | | leaves: 2
| | | value: /
| | | f Line 10 (function)
| | | | leaves: 1
| | | | value: sin
| | | | i Line 10 (literal)
| | | | | leaves: 0
| | | | | value: X
| | | | `-----------------
| | | `-----------------
| | | i Line 10 (literal)
| | | | leaves: 0
| | | | value: X
| | | `-----------------
| | `-----------------
| `-----------------
`-----------------

for input "DEFUN sinc(x) = sin(x) / x"
 */

    function isSemanticLiteral(token, state) {
        return "]" == token || ")" == token ||
               "quote" == state || "number" == state || "bool" == state || "literal" == state;
    }

    var _debugSyntaxAnalysis = false;

    if (_debugSyntaxAnalysis) println("@@ SYNTAX ANALYSIS @@");

    if (_debugSyntaxAnalysis) println("Parser Ln "+lnum+", Rec "+recDepth+", Tkn: "+tokens.join("/"));

    if (tokens.length != states.length) throw "InternalError: size of tokens and states does not match (line: "+lnum+", recursion depth: "+recDepth+")";
    if (tokens.length == 0) {
        if (_debugSyntaxAnalysis) println("*empty tokens*");
        var retTreeHead = new BasicAST();
        retTreeHead.depth = recDepth;
        retTreeHead.lnum = lnum;
        return retTreeHead;
    }

    var k;
    var headWord = tokens[0].toLowerCase();
    var treeHead = new BasicAST();
    treeHead.depth = recDepth;
    treeHead.lnum = lnum;

    // TODO ability to parse arbitrary parentheses
    // test string: print((minus(plus(3,2),times(8,7))))
    //                   ^                             ^ these extra parens break your parser

    // LITERAL
    if (tokens.length == 1 && (isSemanticLiteral(tokens[0], states[0]))) {
        if (_debugSyntaxAnalysis) println("literal/number: "+tokens[0]);
        treeHead.value = ("quote" == states[0]) ? tokens[0] : tokens[0].toUpperCase();
        treeHead.type = ("quote" == states[0]) ? "string" : ("number" == states[0]) ? "number" : "literal";
    }
    else if (tokens[0].toUpperCase() == "IF" && states[0] != "quote") {
        // find ELSE and THEN
        var indexElse = undefined;
        var indexThen = undefined;
        for (k = tokens.length - 1; k >= 1; k--) {
            if (indexElse === undefined && tokens[k].toUpperCase() == "ELSE" && states[k] != "quote") {
                indexElse = k;
            }
            else if (indexThen === undefined && tokens[k].toUpperCase() == "THEN" && states[k] != "quote") {
                indexThen = k;
            }
        }
        // find GOTO and use it as THEN
        var useGoto = false;
        if (indexThen === undefined) {
            for (k = (indexElse !== undefined) ? indexElse - 1 : tokens.length - 1; k >= 1; k--) {
                if (indexThen == undefined && tokens[k].toUpperCase() == "GOTO" && states[k] != "quote") {
                    useGoto = true;
                    indexThen = k;
                    break;
                }
            }
        }

        // generate tree
        if (indexThen === undefined) throw lang.syntaxfehler(lnum);

        treeHead.value = "if";
        treeHead.type = "function";
        treeHead.leaves[0] = basicFunctions._parseTokens(
                lnum,
                tokens.slice(1, indexThen),
                states.slice(1, indexThen),
                recDepth + 1
        );
        if (!useGoto)
            treeHead.leaves[1] = basicFunctions._parseTokens(
                    lnum,
                    tokens.slice(indexThen + 1, (indexElse !== undefined) ? indexElse : tokens.length),
                    states.slice(indexThen + 1, (indexElse !== undefined) ? indexElse : tokens.length),
                    recDepth + 1
            );
        else
            treeHead.leaves[1] = basicFunctions._parseTokens(
                    lnum,
                    [].concat("goto", tokens.slice(indexThen + 1, (indexElse !== undefined) ? indexElse : tokens.length)),
                    [].concat("literal", states.slice(indexThen + 1, (indexElse !== undefined) ? indexElse : tokens.length)),
                    recDepth + 1
            );
        if (indexElse !== undefined) {
            treeHead.leaves[2] = basicFunctions._parseTokens(
                    lnum,
                    tokens.slice(indexElse + 1, tokens.length),
                    states.slice(indexElse + 1, tokens.length),
                    recDepth + 1
            );
        }
    }
    else {
        // scan for operators with highest precedence, use rightmost one if multiple were found
        var topmostOp;
        var topmostOpPrc = 0;
        var operatorPos = -1;

        // find and mark position of separators and parentheses
        // properly deal with the nested function calls
        var parenDepth = 0;
        var parenStart = -1;
        var parenEnd = -1;
        var separators = [];

        // initial scan
        for (k = 0; k < tokens.length; k++) {
            if (tokens[k] == "(" && states[k] != "quote") {
                parenDepth += 1;
                if (parenStart == -1 && parenDepth == 1) parenStart = k;
            }
            else if (tokens[k] == ")" && states[k] != "quote") {
                if (parenEnd == -1 && parenDepth == 1) parenEnd = k;
                parenDepth -= 1;
            }

            if (parenDepth == 0) {
                if (states[k] == "operator" && isSemanticLiteral(tokens[k-1], states[k-1]) && basicFunctions._operatorPrecedence[tokens[k].toUpperCase()] > topmostOpPrc) {
                    topmostOp = tokens[k].toUpperCase();
                    topmostOpPrc = basicFunctions._operatorPrecedence[tokens[k]];
                    operatorPos = k;
                }
            }
        }

        if (parenDepth != 0) throw lang.syntaxfehler(lnum, lang.unmatchedBrackets);
        if (_debugSyntaxAnalysis) println("Paren position: "+parenStart+", "+parenEnd);

        // if there is no paren or paren does NOT start index 1
        // e.g. negative three should NOT require to be written as "-(3)"
        if ((parenStart > 1 || parenStart == -1) && (operatorPos != 1 && operatorPos != 0) && states[0] != "operator") {
            // make a paren!
            tokens = [].concat(tokens[0], "(", tokens.slice(1, tokens.length), ")");
            states = [].concat(states[0], "paren", states.slice(1, states.length), "paren");

            if (_debugSyntaxAnalysis) println("inserting paren at right place");
            if (_debugSyntaxAnalysis) println(tokens.join(","));

            return basicFunctions._parseTokens(lnum, tokens, states, recDepth);
        }

        // get the position of parens and separators
        parenStart = -1; parenEnd = -1; parenDepth = 0;
        for (k = 0; k < tokens.length; k++) {
            if (tokens[k] == "(" && states[k] != "quote") {
                parenDepth += 1;
                if (parenStart == -1 && parenDepth == 1) parenStart = k;
            }
            else if (tokens[k] == ")" && states[k] != "quote") {
                if (parenEnd == -1 && parenDepth == 1) parenEnd = k;
                parenDepth -= 1;
            }

            if (parenDepth == 1 && states[k] == "sep") {
                separators.push(k);
            }
            if (parenDepth == 0) {
                if (states[k] == "operator" && isSemanticLiteral(tokens[k-1], states[k-1]) && basicFunctions._operatorPrecedence[tokens[k].toUpperCase()] > topmostOpPrc) {
                    topmostOp = tokens[k].toUpperCase();
                    topmostOpPrc = basicFunctions._operatorPrecedence[tokens[k]];
                    operatorPos = k;
                }
            }
        }

        if (parenDepth != 0) throw lang.syntaxfehler(lnum, lang.unmatchedBrackets);
        if (_debugSyntaxAnalysis) println("NEW Paren position: "+parenStart+", "+parenEnd);

        // BINARY_OP/UNARY_OP
        if (topmostOp !== undefined) {
            if (_debugSyntaxAnalysis) println("operator: "+topmostOp+", pos: "+operatorPos);

            // BINARY_OP?
            if (operatorPos > 0) {
                var subtknL = tokens.slice(0, operatorPos);
                var subtknR = tokens.slice(operatorPos + 1, tokens.length);
                var substaL = states.slice(0, operatorPos);
                var substaR = states.slice(operatorPos + 1, tokens.length);

                treeHead.value = topmostOp;
                treeHead.type = "operator";
                treeHead.leaves[0] = basicFunctions._parseTokens(lnum, subtknL, substaL, recDepth + 1);
                treeHead.leaves[1] = basicFunctions._parseTokens(lnum, subtknR, substaR, recDepth + 1);
            }
            else {
                if (_debugSyntaxAnalysis) println("re-parenthesising unary op");

                // parenthesize the unary op
                var unaryParenEnd = 1;
                while (unaryParenEnd < tokens.length) {
                    if (states[unaryParenEnd] == "operator" && basicFunctions._operatorPrecedence[tokens[unaryParenEnd]] > 1)
                        break;

                    unaryParenEnd += 1;
                }

                var newTokens = [].concat("(", tokens.slice(0, unaryParenEnd), ")", tokens.slice(unaryParenEnd, tokens.length));
                var newStates = [].concat("paren", states.slice(0, unaryParenEnd), "paren", states.slice(unaryParenEnd, tokens.length));

                return basicFunctions._parseTokens(lnum, newTokens, newStates, recDepth + 1);
            }
        }
        // FUNCTION CALL
        else {
            if (_debugSyntaxAnalysis) println("function call");
            var currentFunction = (states[0] == "paren") ? undefined : tokens[0];
            treeHead.value = ("-" == currentFunction) ? "UNARYMINUS" : ("+" == currentFunction) ? "UNARYPLUS" : currentFunction;
            treeHead.type = (currentFunction === undefined) ? "null" : "function";
            if (_debugSyntaxAnalysis) println("function name: "+treeHead.value);

            var leaves = [];

            // if there is no paren (this part deals with unary ops ONLY!)
            if (parenStart == -1 && parenEnd == -1) {
                var subtkn = tokens.slice(1, tokens.length);
                var substa = states.slice(1, tokens.length);

                if (_debugSyntaxAnalysis) println("subtokenA: "+subtkn.join("/"));

                leaves.push(basicFunctions._parseTokens(lnum, subtkn, substa, recDepth + 1))
            }
            else if (parenEnd > parenStart) {
                separators = [parenStart].concat(separators, [parenEnd]);
                if (_debugSyntaxAnalysis) println("separators: "+separators.join(","));
                // recursively parse comma-separated arguments

                // print ( plus ( 3 , 2 ) , times ( 8 , 7 ) )
                //       s                ^                 e
                // separators = [1,8,15]
                //         plus ( 3 , 2 ) / times ( 8 , 7 )
                //              s   ^   e         s   ^   e
                // separators = [1,5] ; [1,5]
                //                3 / 2   /         8 / 7
                for (k = 1; k < separators.length; k++) {
                    var subtkn = tokens.slice(separators[k - 1] + 1, separators[k]);
                    var substa = states.slice(separators[k - 1] + 1, separators[k]);

                    if (_debugSyntaxAnalysis) println("subtokenB: "+subtkn.join("/"));

                    leaves.push(basicFunctions._parseTokens(lnum, subtkn, substa, recDepth + 1));
                }
            }
            else throw lang.syntaxfehler(lnum, lang.badFunctionCallFormat);
            treeHead.leaves = leaves;//.filter(function(__v) { return __v !== undefined; });
        }
    }


    return treeHead;

};
// @return is defined in BasicAST
function JStoBASICtype(object) {
    if (typeof object === "boolean") return "bool";
    else if (!isNaN(object)) return "number";
    else if (typeof object === "string" || object instanceof String) return "string";
    else if (object === undefined) return "null";
    else throw "InternalError: un-translatable object with typeof "+(typeof object)+"\n"+object;
}
function SyntaxTreeReturnObj(type, value, nextLine) {
    this.type = type;
    this.value = value;
    this.nextLine = nextLine;
}
basicFunctions._gotoCmds = { GOTO:1, GOSUB:1 };
basicFunctions._executeSyntaxTree = function(lnum, syntaxTree, recDepth) {
    var _debugExec = false;
    var recWedge = "> ".repeat(recDepth);

    if (_debugExec) serial.println(recWedge+"@@ EXECUTE @@");

    if (syntaxTree === undefined)
        return new SyntaxTreeReturnObj("null", undefined, lnum + 1);
    else if (syntaxTree.type == "function" || syntaxTree.type == "operator") {
        if (_debugExec) serial.println(recWedge+"function|operator");
        if (_debugExec) serial.println(recWedge+syntaxTree.toString());
        var funcName = syntaxTree.value.toUpperCase();
        var func = basicInterpreterStatus.builtin[funcName];

        if (funcName == "IF") {
            if (syntaxTree.leaves.length != 2 && syntaxTree.leaves.length != 3) throw lang.syntaxfehler(lnum);
            var testedval = basicFunctions._executeSyntaxTree(lnum, syntaxTree.leaves[0], recDepth + 1);

            if (_debugExec) {
                serial.println(recWedge+"testedval:");
                serial.println(recWedge+"type="+testedval.type);
                serial.println(recWedge+"value="+testedval.value);
                serial.println(recWedge+"nextLine="+testedval.nextLine);
            }

            try {
                var iftest = basicInterpreterStatus.builtin["TEST"](lnum, [testedval]);

                if (!iftest && syntaxTree.leaves[2] !== undefined)
                    return basicFunctions._executeSyntaxTree(lnum, syntaxTree.leaves[2], recDepth + 1);
                else if (iftest)
                    return basicFunctions._executeSyntaxTree(lnum, syntaxTree.leaves[1], recDepth + 1);
                else
                    return new SyntaxTreeReturnObj("null", undefined, lnum + 1);
            }
            catch (eeeee) {
                throw lang.errorinline(lnum, "TEST", eeeee);
            }
        }
        else {
            var args = syntaxTree.leaves.map(function(it) { return basicFunctions._executeSyntaxTree(lnum, it, recDepth + 1); });

            if (_debugExec) {
                serial.println(recWedge+"fn call name: "+funcName);
                serial.println(recWedge+"fn call args: "+(args.map(function(it) { return it.type+" "+it.value; })).join(", "));
            }

            if (func === undefined) {
                serial.printerr(lang.syntaxfehler(lnum, funcName + " is not defined"));
                throw lang.syntaxfehler(line, funcName + " is not defined");
            }
            else {
                try {
                    var funcCallResult = func(lnum, args);

                    return new SyntaxTreeReturnObj(
                            JStoBASICtype(funcCallResult),
                            funcCallResult,
                            (basicFunctions._gotoCmds[funcName] !== undefined) ? funcCallResult : lnum + 1
                    );
                }
                catch (eeeee) {
                    throw lang.errorinline(lnum, funcName, eeeee);
                }
            }
        }
    }
    else if (syntaxTree.type == "number") {
        if (_debugExec) serial.println(recWedge+"number");
        return new SyntaxTreeReturnObj(syntaxTree.type, +(syntaxTree.value), lnum + 1);
    }
    else if (syntaxTree.type == "string" || syntaxTree.type == "literal" || syntaxTree.type == "bool") {
        if (_debugExec) serial.println(recWedge+"string|literal|bool");
        return new SyntaxTreeReturnObj(syntaxTree.type, syntaxTree.value, lnum + 1);
    }
    else if (syntaxTree.type == "null") {
        return new basicFunctions._executeSyntaxTree(lnum, syntaxTree.leaves[0], recDepth + 1);
    }
    else {
        serial.println(recWedge+"Parse error in "+lnum);
        serial.println(recWedge+syntaxTree.toString());
        throw "Parse error";
    }
};
// @returns: line number for the next command, normally (lnum + 1); if GOTO or GOSUB was met, returns its line number
basicFunctions._interpretLine = function(lnum, cmd) {
    var _debugprintHighestLevel = false;

    // TOKENISE
    var tokenisedObject = basicFunctions._tokenise(lnum, cmd);
    var tokens = tokenisedObject.tokens;
    var states = tokenisedObject.states;


    // ELABORATION : distinguish numbers and operators from literals
    basicFunctions._parserElaboration(lnum, tokens, states);

    // PARSING (SYNTAX ANALYSIS)
    var syntaxTree = basicFunctions._parseTokens(lnum, tokens, states, 0);
    if (_debugprintHighestLevel) serial.println("Final syntax tree:");
    if (_debugprintHighestLevel) serial.println(syntaxTree.toString());

    var execResult = basicFunctions._executeSyntaxTree(lnum, syntaxTree, 0);



    // EXECUTE
    try {
        return execResult.nextLine;
    }
    catch (e) {
        throw lang.parserError(lnum, e);
    }


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
        if (cmdbuf[args[1]] !== undefined)
            basicFunctions._basicList(cmdbuf[args[1]], args[1], undefined);
    }
    else {
        var lastIndex = (args[2] === ".") ? cmdbuf.length - 1 : (args[2] | 0);
        var i = 0;
        for (i = args[1]; i <= lastIndex; i++) {
            var cmd = cmdbuf[i];
            if (cmd !== undefined) {
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
        if (cmdbuf[k] !== undefined) {
            newcmdbuf[cnt] = cmdbuf[k];
            linenumRelation[k] = cnt;
            cnt += 10;
        }
    }
    // deal with goto/gosub line numbers
    for (k = 0; k < newcmdbuf.length; k++) {
        if (newcmdbuf[k] !== undefined && newcmdbuf[k].toLowerCase().startsWith("goto ")) {
            newcmdbuf[k] = "goto " + linenumRelation[newcmdbuf[k].match(reNum)[0]];
        }
        else if (newcmdbuf[k] !== undefined && newcmdbuf[k].toLowerCase().startsWith("gosub ")) {
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
        if (cmdbuf[linenumber] !== undefined) {
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
    con.resetkeybuf();
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