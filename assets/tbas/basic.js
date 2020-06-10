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
    if (line === undefined)
        return "Syntax error";
    return "Syntax error in " + line;
};

function getUsedMemSize() {
    return cmdbufMemFootPrint; // + array's dimsize * 8 + variables' sizeof literal + functions' expression length
}


var reLineNum = /^[0-9]+ +[^0-9]/;
//var reFloat = /^([\-+]?[0-9]*[.][0-9]+[eE]*[\-+0-9]*[fF]*|[\-+]?[0-9]+[.eEfF][0-9+\-]*[fF]?)$/;
//var reDec = /^([\-+]?[0-9_]+)$/;
//var reHex = /^(0[Xx][0-9A-Fa-f_]+)$/;
//var reBin = /^(0[Bb][01_]+)$/;

// must match partial
var reNumber = /([0-9]*[.][0-9]+[eE]*[\-+0-9]*[fF]*|[0-9]+[.eEfF][0-9+\-]*[fF]?)|([0-9_]+)|(0[Xx][0-9A-Fa-f_]+)|(0[Bb][01_]+)/g;
var reOps = /\^|\*|\/|\+|\-|[<>=]{1,2}/g;

var reNum = /[0-9]+/;
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
// Abstract Syntax Tree
// creates empty tree node
function BasicAST() {
    this.lnum = 0;
    this.depth = 0;
    this.leaves = [];
    this.value = undefined;
    this.type = "null"; // literal, operator, variable, function, null

    this.toString = function() {
        var sb = "";
        var marker = ("literal" == this.type) ? ">" : ("operator" == this.type) ? "=" : "#";
        sb += "| ".repeat(this.depth) + marker+" Line "+this.lnum+" ("+this.type+")\n";
        sb += "| ".repeat(this.depth+1) + "leaves: "+(this.leaves.length)+"\n";
        sb += "| ".repeat(this.depth+1) + "value: "+this.value+"\n";
        for (var k = 0; k < this.leaves.length; k++) {
            sb += this.leaves[k].toString(); + "\n";
        }
        sb += "| ".repeat(this.depth+1) + "----------------\n";
        return sb;
    };
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
    return (code >= 0x30 && code <= 0x39) || code == 0x5F;
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
    "^":13,
    "UNARYPLUS":12,"UNARYMINUS":12,"NOT":12,
    "*":11,"/":11,
    "MOD":10,
    "+":9,"-":9,
    "<<":8,">>":8,
    "==":7,"<>":7,"><":7,"<":7,">":7,"<=":7,"=<":7,">=":7,"=>":7,
    "BAND":6,
    "BXOR":5,
    "BOR":4,
    "AND":3,
    "OR":2,
    "=":1
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
                tokens.push(sb); sb = "" + char; states.push(mode);
            }
            else if (basicFunctions._isNumberSep(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
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
            if (basicFunctions._isNumber(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "number2";
            }
            else {
                throw lang.syntaxfehler(lnum);
            }
        }
        else if ("number2" == mode) {
            if (basicFunctions._isNumber(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("number");
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
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "operator2";
            }
            else if (basicFunctions._isFirstOp(charCode)) {
                throw lang.syntaxfehler(lnum);
            }
            if (basicFunctions._isNumber(charCode)) {
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
                throw lang.syntaxfehler(lnum);
            }
            if (basicFunctions._isNumber(charCode)) {
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
    if (tokens.length != states.length) throw "InternalError: size of tokens and states does not match (line: "+lnum+")";

    return { "tokens": tokens, "states": states };
};
basicFunctions._parserElaboration = function(lnum, tokens, states) {
    var _debugprintElaboration = true;
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

        k += 1;
    }
};
basicFunctions._parserLukasiewiczation = function(lnum, tokens, states) {
    // for the test input string of:
    // cin(tan(getch() MOD 5),4+sin(32 AND 7))+cin(-2)
    //
    //
    // cin(tan(getch() MOD 5),4+sin(32 AND 7))+cin(-2)
    // cin(tan(getch() MOD 5),4+sin(32 AND 7)) cin(-2)
    //     tan(getch() MOD 5) 4+sin(32 AND 7)      -2
    //         getch() MOD 5  4 sin(32 AND 7)       2
    //         getch()     5        32 AND 7
    //                              32     7
    //                                             32 7
    //                  getch() 5              and(32,7)
    //              MOD(getch(),5)       4 sin(and(32,7))                  2
    //          tan(MOD(getch(),5)) plus(4,sin(and(32,7)))      unaryMinus(2)
    //      cin(tan(MOD(getch(),5)),plus(4,sin(and(32,7)))) cin(unaryMinus(2))
    // plus(cin(tan(MOD(getch(),5)),plus(4,sin(and(32,7)))),cin(unaryMinus(2)))

    var _debugprintLuka = true;

    if (_debugprintLuka) println("@@ LUKASIEWICZATION @@")
};
basicFunctions._parseTokens = function(lnum, tokens, states, recDepth) {
    // DO NOT PERFORM SEMANTIC ANALYSIS HERE
    // at this point you can't (and shouldn't) distinguish whether or not defuns/variables are previously declared

    // a line has one of these forms:
    // VARIABLE = LITERAL
    // VARIABLE = FUNCTION ARGUMENTS
    // FUNCTION
    // FUNCTION ARGUMENTS --arguments may contain another function call
    // "FOR" VARIABLE "=" ARGUMENT "TO" ARGUMENT
    // "FOR" VARIABLE "=" ARGUMENT "TO" ARGUMENT "STEP" ARGUMENT
    // "IF" EXPRESSION "THEN" EXPRESSION
    // "IF" EXPRESSION "THEN" EXPRESSION "ELSE" EXPRESSION
    // "IF" EXPRESSION "GOTO" ARGUMENT
    // "IF" EXPRESSION "GOTO" ARGUMENT "ELSE" EXPRESSION
    // "WHILE" EXPRESSION
    // additionally, sub-line also has one of these:
    // LITERAL (leaf node)
    // VARIABLE (leaf node)
    // {VARIABLE, LITERAL} COMPARISON_OP {VARIABLE, LITERAL}

    // THIS FUNCTION CANNOT PARSE ANY OPERATORS, THEY MUST BE CONVERTED TO POLISH NOTATION BEFOREHAND!
    // providing a test string:
    //     cin(tan(2-5),4+sin(32))+cin(-2)
    // must be converted to:
    //     plus(cin(tan(minus(2,5)),plus(4,sin(32))),cin(unaryMinus(2)))
    // prior to the calling of this function

    var _debugSyntaxAnalysis = true;

    if (_debugSyntaxAnalysis) println("@@ SYNTAX ANALYSIS @@");

    if (_debugSyntaxAnalysis) println("Parser Ln "+lnum+", Rec "+recDepth+", Tkn: "+tokens.join("/"));

    if (tokens.length != states.length) throw "InternalError: size of tokens and states does not match (line: "+lnum+", recursion depth: "+recDepth+")";
    if (tokens.length == 0) throw "InternalError: empty tokens";

    var k;
    var headWord = tokens[0].toLowerCase();
    var treeHead = new BasicAST();
    treeHead.depth = recDepth;
    treeHead.lnum = lnum;

    // TODO ability to parse arbitrary parentheses
    // test string: print((minus(plus(3,2),times(8,7))))
    //                   ^                             ^ these extra parens break your parser

    // IF statement
    if ("IF" == tokens[0].toUpperCase()) {
        throw "TODO";
    }
    // LEAF: is this a literal?
    else if (recDepth > 0 && ("quote" == states[0] || "number" == states[0])) {
        treeHead.value = tokens[0];
        treeHead.type = "literal";
    }
    // is this a function/operators?
    else {
        // find and mark position of separators and parentheses
        // properly deal with the nested function calls
        var parenDepth = 0;
        var parenStart = 0;
        var parenEnd = -1;
        var separators = [];

        for (k = 0; k < tokens.length; k++) {
            if (tokens[k] == "(") {
                parenDepth += 1;
                if (parenDepth == 1) parenStart = k;
            }
            else if (tokens[k] == ")") {
                if (parenDepth == 1) parenEnd = k;
                parenDepth -= 1;
            }

            if (parenDepth == 1 && states[k] == "sep") {
                separators.push(k);
            }
        }

        if (parenDepth != 0) throw "Unmatched brackets";

        var currentFunction = (states[0] == "paren") ? undefined : tokens[0];
        treeHead.value = currentFunction;
        treeHead.type = (currentFunction === undefined) ? "null" : "function";
        var leaves = [];

        // if there is no paren
        if (parenStart == 0 && parenEnd == -1 && tokens.length > 1) {
            var subtkn = tokens.slice(1, tokens.length);
            var substa = states.slice(1, tokens.length);

            if (_debugSyntaxAnalysis) println("subtokenA: "+subtkn.join("/"));

            leaves.push(basicFunctions._parseTokens(lnum, subtkn, substa, recDepth + 1));
        }
        else if (parenEnd > parenStart) {
            separators = [parenStart].concat(separators, [parenEnd]);
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
        treeHead.leaves = leaves;//.filter(function(__v) { return __v !== undefined; });
    }


    return treeHead;

};
// @returns: line number for the next command, normally (lnum + 1); if GOTO or GOSUB was met, returns its line number
basicFunctions._interpretLine = function(lnum, cmd) {
    var _debugprintHighestLevel = true;

    // TOKENISE
    var tokenisedObject = basicFunctions._tokenise(lnum, cmd);
    var tokens = tokenisedObject.tokens;
    var states = tokenisedObject.states;

    if (_debugprintHighestLevel) println(tokens.join("~"));
    if (_debugprintHighestLevel) println(states.join(" "));


    // ELABORATION : distinguish numbers and operators from literals
    basicFunctions._parserElaboration(lnum, tokens, states);


    if (_debugprintHighestLevel) println(tokens.join("~"));
    if (_debugprintHighestLevel) println(states.join(" "));


    // ŁUKASIEWICZATION : turn infix notation into polish notation
    basicFunctions._parserLukasiewiczation(lnum, tokens, states);


    if (_debugprintHighestLevel) println(tokens.join("~"));
    if (_debugprintHighestLevel) println(states.join(" "));


    // PARSING (SYNTAX ANALYSIS)
    var syntaxTree = basicFunctions._parseTokens(lnum, tokens, states, 0);


    serial.println(syntaxTree.toString());


    // EXECUTO
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
