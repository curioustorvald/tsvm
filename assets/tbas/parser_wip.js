class ParserError extends Error {
    constructor(...args) {
        super(...args);
        Error.captureStackTrace(this, ParserError);
    }
}
let bF = {};

/** Parses following EBNF rule:
 * stmt =  
 *       "IF" , if_equation , "THEN" , stmt , ["ELSE" , stmt]
 *     | "DEFUN" , [ident] , "(" , [ident , {" , " , ident}] , ")" , "=" , stmt
 *     | "ON" , ident , ident , equation , {"," , equation}
 *     | "(" , stmt , ")"
 *     | function_call ;
 * @return: BasicAST
 */
bF._parseStmt = function(lnum, tokens, states, recDepth) {
    let headTkn = tokens[0].toUpperCase();
    let headSta = states[0];
    
    let treeHead = new BasicAST();
    treeHead.astDepth = recDepth;
    treeHead.astLnum = lnum;

    let thenPos = -1;
    let elsePos = -1;
    let parenDepth = 0;
    let parenStart = -1;
    let parenEnd = -1;
    let sepsZero = [];
    let sepsOne = [];

    // scan for parens that will be used for several rules
    // also find nearest THEN and ELSE but also take parens into account
    for (let k = 0; k < tokens.length; k++) {
        // increase paren depth and mark paren start position
        if (tokens[k] == "(" && states[k] != "qot") {
            parenDepth += 1;
            if (parenStart == -1 && parenDepth == 1) parenStart = k;
        }
        // decrease paren depth
        else if (tokens[k] == ")" && states[k] != "qot") {
            if (parenEnd == -1 && parenDepth == 1) parenEnd = k;
            parenDepth -= 1;
        }

        if (parenDepth == 0) {
            if (-1 == thenPos && "THEN" == tokens[k].toUpperCase() && "lit" == states[k])
                thenPos = k;
            else if (-1 == elsePos && "ELSE" == tokens[k].toUpperCase() && "lit" == states[k])
                elsePos = k;
        }
        
        if (parenDepth == 0 && states[k] == "sep")
            sepsZero.push(k);
        if (parenDepth == 1 && states[k] == "sep")
            sepsOne.push(k);
    }

    // unmatched brackets, duh!
    if (parenDepth != 0) throw lang.syntaxfehler(lnum, lang.unmatchedBrackets);


    // ## case for:
    //    "IF" , if_equation , "THEN" , stmt , ["ELSE" , stmt]
    if ("IF" == headTkn && "lit" == headSta) {
        // "THEN" not found, raise error!
        if (thenPos == -1) throw new ParserError("IF without THEN in " + lnum);
        
        treeHead.astValue = "IF";
        treeHead.astType = "function";
        
        treeHead.astLeaves[0] = bF._parseEquation(lnum,
            tokens.slice(1, thenPos),
            states.slice(1, thenPos),
            recDepth + 1,
            true // if_equation mode
        );
        treeHead.astLeaves[1] = bF._parseStmt(lnum,
            tokens.slice(thenPos + 1, (elsePos != -1) ? elsePos : tokens.length),
            states.slice(thenPos + 1, (elsePos != -1) ? elsePos : tokens.length),
            recDepth + 1
        );
        if (elsePos != -1)
            treeHead.astLeaves[2] = bF._parseStmt(lnum,
                tokens.slice(elsePos + 1, tokens.length),
                states.slice(elsePos + 1, tokens.length),
                recDepth + 1
            );
        
        return treeHead;
    }
    // ## case for:
    //    | "DEFUN" , [ident] , "(" , [ident , {" , " , ident}] , ")" , "=" , stmt
    if ("DEFUN" == headTkn && "lit" == headSta &&
        parenStart == 2 && tokens[parenEnd + 1] == "=" && states[parenEnd + 1] == "op"
    ) {
        treeHead.astValue = "DEFUN";
        treeHead.astType = "function";
        
        // parse function name
        if (tokens[1] == "(") {
            // anonymous function
            treeHead.astLeaves[0] = BasicAST();
            treeHead.astLeaves[0].astLnum = lnum;
            treeHead.astLeaves[0].astDepth = recDepth;
            treeHead.astLeaves[0].astType = "lit";
        }
        else {
            treeHead.astLeaves[0] = bF._parseIdent(lnum, [tokens[1]], [states[1]], recDepth + 1);
        }
        
        // parse function arguments
        treeHead.astLeaves[0].astLeaves = sepsOne.map(i=>i-1).concat([parenEnd - 1])
            .map(i=>bF._parseIdent(lnum, [tokens[i]], [states[i]], recDepth + 2));
        
        // parse function body
        treeHead.astLeaves[1] = bF._parseStmt(lnum,
            tokens.slice(parenEnd + 2, tokens.length),
            states.slice(parenEnd + 2, states.length),
            recDepth + 1
        );
        
        return treeHead;
    }
    // ## case for:
    //    | "ON" , if_equation , ident , if_equation , {"," , if_equation}
    if ("ON" == headTkn && "lit" == headSta) {
        // TODO
    }
    // ## case for:
    //    | "(" , stmt , ")"
    if (parenStart == 0 && parenEnd == tokens.length - 1) {
        return bF._parseStmt(lnum,
            tokens.slice(parenStart + 1, parenEnd),
            states.slice(parenStart + 1, parenEnd),
            recDepth
        );
    }
    
    // ## case for:
    //    | function_call ;
    try {
        return bF._parseFunctionCall(lnum, tokens, states, recDepth);
    }
    catch (e) {
        throw new ParserError("Statement cannot be parsed: "+e+" in "+lnum);
    }
}
/** Parses following EBNF rule:
 *       equation
 *     | ident , "(" , [function_call , {argsep , function_call} , [argsep]] , ")"
 *     | ident , function_call , {argsep , function_call} , [argsep]
 * @return: BasicAST
 */
bF._parseFunctionCall = function(lnum, tokens, states, recDepth) {
    // ## case for:
    //    equation
    try {
        return bF._parseEquation(lnum, tokens, states, recDepth);
    }
    // if ParserError is raised, continue to apply other rules
    catch (e) {
        if (!(e instanceof ParserError)) throw e;
    }
    
    let parenDepth = 0;
    let parenStart = -1;
    let parenEnd = -1;
    let _argsepsOnLevelZero = []; // argseps collected when parenDepth == 0
    let _argsepsOnLevelOne = []; // argseps collected when parenDepth == 1
    
    // Scan for unmatched parens and mark off the right operator we must deal with
    // every function_call need to re-scan because it is recursively called
    for (let k = 0; k < tokens.length; k++) {
        // increase paren depth and mark paren start position
        if (tokens[k] == "(" && states[k] != "qot") {
            parenDepth += 1;
            if (parenStart == -1 && parenDepth == 1) parenStart = k;
        }
        // decrease paren depth
        else if (tokens[k] == ")" && states[k] != "qot") {
            if (parenEnd == -1 && parenDepth == 1) parenEnd = k;
            parenDepth -= 1;
        }
        
        if (parenDepth == 0 && states[k] == "sep")
            _argsepsOnLevelZero.push(k);
        if (parenDepth == 1 && states[k] == "sep")
            _argsepsOnLevelOne.push(k);
    }
    
    // unmatched brackets, duh!
    if (parenDepth != 0) throw lang.syntaxfehler(lnum, lang.unmatchedBrackets);
    let parenUsed = (parenStart == 1 && parenEnd == states.length - 1);
    
    // ## case for:
    //    | ident , "(" , [function_call , {argsep , function_call} , [argsep]] , ")"
    //    | ident , function_call , {argsep , function_call} , [argsep]
    let treeHead = new BasicAST();
    treeHead.astDepth = recDepth;
    treeHead.astLnum = lnum;
    
    // set function name and also check for syntax by deliberately parsing the word
    treeHead.astValue = bF._parseIdent(lnum, [tokens[0]], [states[0]], recDepth + 1).astValue; // always UPPERCASE

    // 5 8 11 [end]
    let argSeps = parenUsed ? _argsepsOnLevelOne : _argsepsOnLevelZero; // choose which "sep tray" to use
    // 1 6 9 12
    let argStartPos = [1 + (parenUsed)].concat(argSeps.map(k => k+1));
    // [1,5) [6,8) [9,11) [12,end)
    let argPos = argStartPos.map((s,i) => {return{start:s, end:(argSeps[i] || tokens.length - (parenUsed))}}); // use end of token position as separator position
    
    // check for trailing separator
    let hasTrailingSep = (states[states.length - 1 - (parenUsed)] == "sep");
    // exclude last separator from recursion if input tokens has trailing separator
    if (hasTrailingSep) argPos.pop();
    
    // recursively parse function arguments
    treeHead.astLeaves = argPos.map(x => bF._parseFunctionCall(lnum,
        tokens.slice(x.start, x.end),
        states.slice(x.start, x.end),
        recDepth + 1
    ));
    treeHead.astType = "function";
    treeHead.astSeps = argSeps.map(i => tokens[i]);
    
    return treeHead;
}
bF._parseIdent = function(lnum, tokens, states, recDepth) {
    if (!Array.isArray(tokens) && !Array.isArray(states)) throw new ParserError("Tokens and states are not array");
    if (tokens.length > 1 || states[0] != "lit") throw new ParserError(`illegal token count '${tokens.length}' with states '${states}' in ${lnum}`);
    
    let treeHead = new BasicAST();
    treeHead.astDepth = recDepth;
    treeHead.astLnum = lnum;
    treeHead.astValue = tokens[0].toUpperCase();
    treeHead.astType = "lit";
    
    return treeHead;
}
/**
 * @return: BasicAST
 */
bF._parseLit = function(lnum, tokens, states, recDepth) {
    if (!Array.isArray(tokens) && !Array.isArray(states)) throw new ParserError("Tokens and states are not array");
    if (tokens.length > 1) throw new ParserError("parseLit 1");
    
    let treeHead = new BasicAST();
    treeHead.astDepth = recDepth;
    treeHead.astLnum = lnum;
    if (_debugSyntaxAnalysis) serial.println("literal/number: "+tokens[0]);
    treeHead.astValue = ("qot" == states[0]) ? tokens[0] : tokens[0].toUpperCase();
    treeHead.astType = ("qot" == states[0]) ? "string" : ("num" == states[0]) ? "num" : "lit";
    
    return treeHead;
}
bF._EquationIllegalTokens = ["IF","THEN","ELSE","DEFUN","ON"];
bF.isSemanticLiteral = function(token, state) {
    return "]" == token || ")" == token ||
            "qot" == state || "num" == state || "bool" == state || "lit" == state;
}
/** Parses following EBNF rule:
 * equation = 
 *       lit
 *     | "(" , equation , ")"
 *     | equation , op , equation
 *     | op_uni , equation
 * @return: BasicAST
 */
bF._parseEquation = function(lnum, tokens, states, recDepth, ifMode) {

    // ## case for:
    //    lit
    let headTkn = tokens[0].toUpperCase();
    if (!bF._EquationIllegalTokens.includes(headTkn) && tokens.length == 1) {
        return bF._parseLit(lnum, tokens, states, recDepth);
    }
    
    // scan for operators with highest precedence, use rightmost one if multiple were found
    let topmostOp;
    let topmostOpPrc = 0;
    let operatorPos = -1;

    // find and mark position of parentheses
    // properly deal with the nested function calls
    let parenDepth = 0;
    let parenStart = -1;
    let parenEnd = -1;

    // Scan for unmatched parens and mark off the right operator we must deal with
    // every function_call need to re-scan because it is recursively called
    for (let k = 0; k < tokens.length; k++) {
        // increase paren depth and mark paren start position
        if (tokens[k] == "(" && states[k] != "qot") {
            parenDepth += 1;
            if (parenStart == -1 && parenDepth == 1) parenStart = k;
        }
        // decrease paren depth
        else if (tokens[k] == ")" && states[k] != "qot") {
            if (parenEnd == -1 && parenDepth == 1) parenEnd = k;
            parenDepth -= 1;
        }

        // determine the right operator to deal with
        if (parenDepth == 0) {
            if (states[k] == "op" && bF.isSemanticLiteral(tokens[k-1], states[k-1]) &&
                    ((bF._opPrc[tokens[k].toUpperCase()] > topmostOpPrc) ||
                        (!bF._opRh[tokens[k].toUpperCase()] && bF._opPrc[tokens[k].toUpperCase()] == topmostOpPrc))
            ) {
                topmostOp = tokens[k].toUpperCase();
                topmostOpPrc = bF._opPrc[tokens[k].toUpperCase()];
                operatorPos = k;
            }
        }
    }

    // unmatched brackets, duh!
    if (parenDepth != 0) throw lang.syntaxfehler(lnum, lang.unmatchedBrackets);
    if (_debugSyntaxAnalysis) serial.println("Equation NEW Paren position: "+parenStart+", "+parenEnd);
    
    // ## case for:
    //    "(" , equation , ")"
    if (parenStart == 0 && parenEnd == tokens.length - 1) {
        return bF._parseEquation(lnum,
            tokens.slice(parenStart + 1, parenEnd),
            states.slice(parenStart + 1, parenEnd),
            recDepth
        );
    }
    // ## case for:
    //      equation , op, equation
    //    | op_uni , equation
    // if operator is found, split by the operator and recursively parse the LH and RH
    if (topmostOp !== undefined) {
        if (_debugSyntaxAnalysis) serial.println("operator: "+topmostOp+", pos: "+operatorPos);

        if (ifMode && topmostOp == "=") throw lang.syntaxfehler(lnum, "'=' used on IF, did you mean '=='?");
        if (ifMode && topmostOp == ":") throw lang.syntaxfehler(lnum, "':' used on IF");
        
        
        // this is the AST we're going to build up and return
        // (other IF clauses don't use this)
        let treeHead = new BasicAST();
        treeHead.astDepth = recDepth;
        treeHead.astLnum = lnum;
        treeHead.astValue = topmostOp;
        treeHead.astType = "op";
        
        // BINARY_OP?
        if (operatorPos > 0) {
            let subtknL = tokens.slice(0, operatorPos);
            let substaL = states.slice(0, operatorPos);
            let subtknR = tokens.slice(operatorPos + 1, tokens.length);
            let substaR = states.slice(operatorPos + 1, tokens.length);

            treeHead.astLeaves[0] = bF._parseEquation(lnum, subtknL, substaL, recDepth + 1);
            treeHead.astLeaves[1] = bF._parseEquation(lnum, subtknR, substaR, recDepth + 1);
        }
        else {
            treeHead.astValue = (topmostOp === "-") ? "UNARYMINUS" : "UNARYPLUS";
            treeHead.astLeaves[0] = bF._parseEquation(lnum,
                tokens.slice(operatorPos + 1, tokens.length),
                states.slice(operatorPos + 1, states.length),
                recDepth + 1
            );
        }
        
        return treeHead;
    }
    
    throw new ParserError(`Equation - illegal token "${headTkn}" in ${lnum}`);
    
}


/////// TEST/////////
let astToString = function(ast) {
    if (ast === undefined || ast.astType === undefined) return "";
    var sb = "";
    var marker = ("lit" == ast.astType) ? "i" :
                 ("op" == ast.astType) ? String.fromCharCode(177) :
                 ("string" == ast.astType) ? String.fromCharCode(182) :
                 ("num" == ast.astType) ? String.fromCharCode(162) :
                 ("array" == ast.astType) ? "[" : String.fromCharCode(163);
    sb += "| ".repeat(ast.astDepth) + marker+" Line "+ast.astLnum+" ("+ast.astType+")\n";
    sb += "| ".repeat(ast.astDepth+1) + "leaves: "+(ast.astLeaves.length)+"\n";
    sb += "| ".repeat(ast.astDepth+1) + "value: "+ast.astValue+" (type: "+typeof ast.astValue+")\n";
    for (var k = 0; k < ast.astLeaves.length; k++) {
        if (k > 0)
            sb += "| ".repeat(ast.astDepth+1) + " " + ast.astSeps[k - 1] + "\n";
        sb += astToString(ast.astLeaves[k]);
    }
    sb += "| ".repeat(ast.astDepth) + "`-----------------\n";
    return sb;
}
let BasicAST = function() {
    this.astLnum = 0;
    this.astDepth = 0;
    this.astLeaves = [];
    this.astSeps = [];
    this.astValue = undefined;
    this.astType = "null"; // lit, op, string, num, array, function, null, defun_args (! NOT usrdefun !)
}
bF._opPrc = {
    // function call in itself has highest precedence
    "^":1,
    "*":2,"/":2,
    "MOD":3,
    "+":4,"-":4,
    //";":5,
    "<<":6,">>":6,
    "<":7,">":7,"<=":7,"=<":7,">=":7,"=>":7,
    "==":8,"<>":8,"><":8,
    "BAND":8,
    "BXOR":9,
    "BOR":10,
    "AND":11,
    "OR":12,
    "TO":13,
    "STEP":14,
    "!":15,"~":15, // array CONS and PUSH
    "#": 16, // array concat
    "=":999,
    "IN":1000
};
bF._opRh = {"^":1,"=":1,"!":1,"IN":1};
let lnum = 10;
// FIXME print's last (;) gets parsed but ignored
//let tokens = ["if","s","<","2","then","(","nop1",")","else","(","if","s","<","9999","then","nop2","else","nop3",")"];
//let states = ["lit","lit","op","num","lit","paren","lit","paren","lit","paren","lit","lit","op","num","lit","lit","lit","lit","paren"];
let tokens = ["defun","HYPOT","(","X",",","Y",")","=","SQR","(","X","*","X","+","Y","*","Y",")"];
let states = ["lit","lit","paren","lit","sep","lit","paren","op","lit","paren","lit","op","lit","op","lit","op","lit","paren"];
let _debugSyntaxAnalysis = false;

try  {
    let tree = bF._parseStmt(lnum, tokens, states, 0);
    serial.println(astToString(tree));
}
catch (e) {
    serial.printerr(e);
    serial.printerr(e.stack || "stack trace undefined");
}
