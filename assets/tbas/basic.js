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
lang.badNumberFormat = "Bad number format";
lang.badOperatorFormat = "Bad number format";
lang.badFunctionCallFormat = "Bad function call format";
lang.unmatchedBrackets = "Unmatched brackets";
lang.syntaxfehler = function(line, reason) {
    if (line === undefined)
        return "Syntax error";
    else if (reason === undefined)
        return "Syntax error in " + line;
    else
        return "Syntax error in " + line + ": " + reason;
};
lang.illegalType = function(line) {
   if (line === undefined)
       return "Type mismatch";
   else
       return "Type mismatch in " + line;
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

    return {name:(rettype === undefined) ? s : s.substring(0, s.length - 1), type:rettype};
}
var basicInterpreterStatus = {};
basicInterpreterStatus.gosubStack = [];
basicInterpreterStatus.variables = {};
basicInterpreterStatus.defuns = {};
basicInterpreterStatus.builtin = {};
basicInterpreterStatus.builtin["="] = function(lnum, args) {
    var parsed = parseSigil(args[0].value);
    basicInterpreterStatus.variables[parsed.name] = new BasicVar(args[1].value, (parsed.type === undefined) ? "float" : parsed.type);
};
basicInterpreterStatus.builtin["+"] = function(lnum, args) {
    // TODO read from variables
    return args[0].value + args[1].value;
};
basicInterpreterStatus.builtin["-"] = function(lnum, args) {
    // TODO read from variables
    if (args[0].type != "number" || args[1].type != "number") throw lang.illegalType(lnum);
    return args[0].value - args[1].value;
};
basicInterpreterStatus.builtin.PRINT = function(lnum, args) {
    if (args.length == 0)
        println();
    else
        println(args.map(function(it) {
            return (it.type == "literal")
                    ? basicInterpreterStatus.variables[parseSigil(it.value).name].literal
                    : args.value;
        } ).join("\t"));
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
    "^":1,
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
        if ((parenStart > 1 || parenStart == -1) && (operatorPos != 1 && operatorPos != 0)) {
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

            var subtknL = tokens.slice(0, operatorPos);
            var subtknR = tokens.slice(operatorPos + 1, tokens.length);
            var substaL = states.slice(0, operatorPos);
            var substaR = states.slice(operatorPos + 1, tokens.length);

            // BINARY_OP?
            if (operatorPos > 0) {
                treeHead.value = topmostOp;
                treeHead.type = "operator";
                treeHead.leaves[0] = basicFunctions._parseTokens(lnum, subtknL, substaL, recDepth + 1);
                treeHead.leaves[1] = basicFunctions._parseTokens(lnum, subtknR, substaR, recDepth + 1);
            }
            else { // TODO do I ever reach this branch?
                // this also takes care of nested unary ops (e.g. "- NOT 43")
                treeHead.value = (topmostOp == "+") ? "UNARYPLUS" : (topmostOp == "-") ? "UNARYMINUS" : topmostOp;
                treeHead.type = "operator";
                treeHead.leaves[0] = basicFunctions._parseTokens(lnum, subtknR, substaR, recDepth + 1);
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

            // if there is no paren or paren does NOT start index 1
            // e.g. negative three should NOT require to be written as "-(3)"
            /*if (parenStart > 1 || parenStart == -1) {
                // make a paren!
                tokens = [].concat(tokens[0], "(", tokens.slice(1, tokens.length), ")");
                states = [].concat(states[0], "paren", states.slice(1, states.length), "paren");
                parenStart = 1;
                parenEnd = states.length - 1;

                // get the position of parens and separators AGAIN
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

                if (_debugSyntaxAnalysis) println("inserting paren at right place");
                if (_debugSyntaxAnalysis) println(tokens.join(","));
            }*/

            if (parenEnd > parenStart) {
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
basicFunctions._executeSyntaxTree = function(lnum, syntaxTree) {
    var _debugExec = true;

    if (_debugExec) serial.println("@@ EXECUTE @@");
    if (_debugExec) serial.println(syntaxTree.toString());

    if (syntaxTree === undefined)
        throw "InternalError: tree is undefined";
    else if (syntaxTree.type == "function" || syntaxTree.type == "operator") {
        var func = basicInterpreterStatus.builtin[syntaxTree.value.toUpperCase()];
        var args = syntaxTree.leaves.map(function(it) { return basicFunctions._executeSyntaxTree(lnum, it); });
        if (_debugExec)
            serial.println("fn call args: "+(args.map(function(it) { return it.type+" "+it.value; })).join(", "));

        return func(lnum, args);
    }
    else if (syntaxTree.type == "number") {
        return {type:syntaxTree.type, value:+(syntaxTree.value)};
    }
    else if (syntaxTree.type == "string" || syntaxTree.type == "literal") {
        return {type:syntaxTree.type, value:syntaxTree.value};
    }
    else {
        serial.println("Parse error in "+lnum);
        serial.println(syntaxTree.toString());
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

    if (_debugprintHighestLevel) println(tokens.join("~"));
    if (_debugprintHighestLevel) println(states.join(" "));


    // ELABORATION : distinguish numbers and operators from literals
    basicFunctions._parserElaboration(lnum, tokens, states);


    if (_debugprintHighestLevel) println(tokens.join("~"));
    if (_debugprintHighestLevel) println(states.join(" "));


    // PARSING (SYNTAX ANALYSIS)
    var syntaxTree = basicFunctions._parseTokens(lnum, tokens, states, 0);

    basicFunctions._executeSyntaxTree(lnum, syntaxTree);

    serial.println(syntaxTree.toString());


    // EXECUTE
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
