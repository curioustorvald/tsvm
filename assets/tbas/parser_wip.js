class ParserError extends Error {
    constructor(...args) {
        super(...args);
        Error.captureStackTrace(this, ParserError);
    }
}
let bF = {};
bF.parserPrintdbg = any => serial.println(any);
bF.parserPrintdbg2 = function(icon, lnum, tokens, states, recDepth) {
    let treeHead = String.fromCharCode(0x2502,32).repeat(recDepth);
    bF.parserPrintdbg(`${icon}${lnum} ${treeHead}${tokens.join(' ')}`);
    bF.parserPrintdbg(`${icon}${lnum} ${treeHead}${states.join(' ')}`);
}
bF.parserPrintdbgline = function(icon, msg, lnum, recDepth) {
    let treeHead = String.fromCharCode(0x2502,32).repeat(recDepth);
    bF.parserPrintdbg(`${icon}${lnum} ${treeHead}${msg}`);
}

/**
 * @return ARRAY of BasicAST
 */
bF._parseTokens = function(lnum, tokens, states) {
    bF.parserPrintdbg2('Line ', lnum, tokens, states, 0);
    
    /*************************************************************************/

    let parenDepth = 0;
    let parenStart = -1;
    let parenEnd = -1;
    let seps = [];
    
    // scan for parens and (:)s
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

        if (parenDepth == 0 && tokens[k] == ":" && states[k] == "seq")
            seps.push(k);
    }
    
    let startPos = [0].concat(seps.map(k => k+1));
    let stmtPos = startPos.map((s,i) => {return{start:s, end:(seps[i] || tokens.length)}}); // use end of token position as separator position
    
    return stmtPos.map((x,i) => {
        if (stmtPos.length > 1)
            bF.parserPrintdbgline('Line ', 'Statement #'+(i+1), lnum, 0);
        
        // check for empty tokens
        if (x.end - x.start <= 0) throw new ParserError("Malformed Line");
        
        return bF._parseStmt(lnum,
            tokens.slice(x.start, x.end),
            states.slice(x.start, x.end),
            1
        );
    });
}


/** Parses following EBNF rule:
stmt =
      "IF" , expr_sans_asgn , "THEN" , stmt , ["ELSE" , stmt]
    | "DEFUN" , [ident] , "(" , [ident , {" , " , ident}] , ")" , "=" , expr
    | "ON" , expr_sans_asgn , ident , expr_sans_asgn , {"," , expr_sans_asgn}
    | "(" , stmt , ")"
    | expr ;
 * @return: BasicAST
 */
bF._parseStmt = function(lnum, tokens, states, recDepth) {
    bF.parserPrintdbg2('$', lnum, tokens, states, recDepth);

    /*************************************************************************/

    let headTkn = tokens[0].toUpperCase();
    let headSta = states[0];
    
    let treeHead = new BasicAST();
    treeHead.astLnum = lnum;

    let parenDepth = 0;
    let parenStart = -1;
    let parenEnd = -1;
    let onGoPos = -1;
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

        if (parenDepth == 0 && states[k] == "sep")
            sepsZero.push(k);
        if (parenDepth == 1 && states[k] == "sep")
            sepsOne.push(k);
        
        if (parenDepth == 0) {
            let tok = tokens[k].toUpperCase();
            if (-1 == onGoPos && ("GOTO" == tok || "GOSUB" == tok) && "lit" == states[k])
                onGoPos = k;
        }
    }

    // unmatched brackets, duh!
    if (parenDepth != 0) throw lang.syntaxfehler(lnum, lang.unmatchedBrackets);

    /*************************************************************************/

    // ## case for:
    //      "IF" , expr_sans_asgn , "THEN" , stmt , ["ELSE" , stmt]
    try {
        bF.parserPrintdbgline('$', "Trying IF Statement...", lnum, recDepth);
        return bF._parseIfMode(lnum, tokens, states, recDepth + 1, false);
    }
    // if ParserError is raised, continue to apply other rules
    catch (e) {
        bF.parserPrintdbgline('$', 'It was NOT!', lnum, recDepth);
        if (!(e instanceof ParserError)) throw e;
    }
    
    /*************************************************************************/
    
    // ## case for:
    //    | "DEFUN" , [ident] , "(" , [ident , {" , " , ident}] , ")" , "=" , expr
    if ("DEFUN" == headTkn && "lit" == headSta &&
        parenStart == 2 && tokens[parenEnd + 1] == "=" && states[parenEnd + 1] == "op"
    ) {
        bF.parserPrintdbgline('$', 'DEFUN Stmt', lnum, recDepth);

        treeHead.astValue = "DEFUN";
        treeHead.astType = "function";
        
        // parse function name
        if (tokens[1] == "(") {
            // anonymous function
            treeHead.astLeaves[0] = BasicAST();
            treeHead.astLeaves[0].astLnum = lnum;
            treeHead.astLeaves[0].astType = "lit";
        }
        else {
            treeHead.astLeaves[0] = bF._parseIdent(lnum, [tokens[1]], [states[1]], recDepth + 1);
        }
        
        // parse function arguments
        treeHead.astLeaves[0].astLeaves = sepsOne.map(i=>i-1).concat([parenEnd - 1])
            .map(i=>bF._parseIdent(lnum, [tokens[i]], [states[i]], recDepth + 2));
        
        // parse function body
        treeHead.astLeaves[1] = bF._parseExpr(lnum,
            tokens.slice(parenEnd + 2, tokens.length),
            states.slice(parenEnd + 2, states.length),
            recDepth + 1
        );
        
        return treeHead;
    }

    /*************************************************************************/

    // ## case for:
    //    | "ON" , if_equation , ident , if_equation , {"," , if_equation}
    if ("ON" == headTkn && "lit" == headSta) {
        bF.parserPrintdbgline('$', 'ON Stmt', lnum, recDepth);
        
        if (onGoPos == -1) throw ParserError("Malformed ON Statement");

        treeHead.astValue = "ON";
        treeHead.astType = "function";
        
        // parse testvalue
        let testvalue = bF._parseExpr(lnum,
            tokens.slice(1, onGoPos),
            states.slice(1, onGoPos),
            recDepth + 1,
            true
        );
        
        // parse functionname
        let functionname = bF._parseExpr(lnum,
            [tokens[onGoPos]],
            [states[onGoPos]],
            recDepth + 1,
            true
        );
        
        // parse arguments
        // get list of comma but filter ones appear before GOTO/GOSUB
        let onArgSeps = sepsZero.filter(i => (i > onGoPos));
        let onArgStartPos = [onGoPos + 1].concat(onArgSeps.map(k => k + 1));
        let onArgPos = onArgStartPos.map((s,i) => {return{start:s, end: (onArgSeps[i] || tokens.length)}}); // use end of token position as separator position
        
        // recursively parse expressions
        treeHead.astLeaves = [testvalue, functionname].concat(onArgPos.map((x,i) => {
            bF.parserPrintdbgline('$', 'ON GOTO/GOSUB Arguments #'+(i+1), lnum, recDepth);

            // check for empty tokens
            if (x.end - x.start <= 0) throw new ParserError("Malformed ON arguments");

            return bF._parseExpr(lnum,
                tokens.slice(x.start, x.end),
                states.slice(x.start, x.end),
                recDepth + 1,
                true
            );
        }));

        return treeHead;
    }
    
    /*************************************************************************/

    // ## case for:
    //    | "(" , stmt , ")"
    if (parenStart == 0 && parenEnd == tokens.length - 1) {
        bF.parserPrintdbgline('$', '( Stmt )', lnum, recDepth);
        return bF._parseStmt(lnum,
            tokens.slice(parenStart + 1, parenEnd),
            states.slice(parenStart + 1, parenEnd),
            recDepth + 1
        );
    }
    
    /*************************************************************************/

    // ## case for:
    //    | expr ;
    try {
        bF.parserPrintdbgline('$', 'Trying Expression Call...', lnum, recDepth);
        return bF._parseExpr(lnum, tokens, states, recDepth + 1);
    }
    catch (e) {
        bF.parserPrintdbgline('$', 'Error!', lnum, recDepth);
        throw new ParserError("Statement cannot be parsed: "+e.stack);
    }
    
    /*************************************************************************/
    
    throw new ParserError("Statement cannot be parsed");
} // END of STMT


/** Parses following EBNF rule:
expr = (* this basically blocks some funny attemps such as using DEFUN as anon function because everything is global in BASIC *)
      lit
    | "(" , expr , ")"
    | "IF" , expr_sans_asgn , "THEN" , expr , ["ELSE" , expr]
    | function_call
    | expr , op , expr
    | op_uni , expr ;
 
 * @return: BasicAST
 */
bF._parseExpr = function(lnum, tokens, states, recDepth, ifMode) {
    bF.parserPrintdbg2('E', lnum, tokens, states, recDepth);

    /*************************************************************************/

    // ## case for:
    //    lit
    let headTkn = tokens[0].toUpperCase();
    if (!bF._EquationIllegalTokens.includes(headTkn) && tokens.length == 1) {
        bF.parserPrintdbgline('E', 'Literal Call', lnum, recDepth);
        return bF._parseLit(lnum, tokens, states, recDepth + 1);
    }
    
    /*************************************************************************/
    
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

    /*************************************************************************/
    
    // ## case for:
    //    | "(" , expr , ")"
    if (parenStart == 0 && parenEnd == tokens.length - 1) {
        bF.parserPrintdbgline('E', '( Expr )', lnum, recDepth);
        
        return bF._parseExpr(lnum,
            tokens.slice(parenStart + 1, parenEnd),
            states.slice(parenStart + 1, parenEnd),
            recDepth + 1
        );
    }
    
    /*************************************************************************/

    // ## case for:
    //    | "IF" , expr_sans_asgn , "THEN" , expr , ["ELSE" , expr]
    try {
        bF.parserPrintdbgline('E', "Trying IF Expression...", lnum, recDepth);
        return bF._parseIfMode(lnum, tokens, states, recDepth + 1, false);
    }
    // if ParserError is raised, continue to apply other rules
    catch (e) {
        bF.parserPrintdbgline('E', 'It was NOT!', lnum, recDepth);
        if (!(e instanceof ParserError)) throw e;
    }
    
    /*************************************************************************/
    
    // ## case for:
    //    (* at this point, if OP is found in paren-level 0, skip function_call *)
    //    | function_call ;
    if (topmostOp === undefined) {
        try {
            bF.parserPrintdbgline('E', "Trying Function Call...", lnum, recDepth);
            return bF._parseFunctionCall(lnum, tokens, states, recDepth + 1);
        }
        // if ParserError is raised, continue to apply other rules
        catch (e) {
            bF.parserPrintdbgline('E', 'It was NOT!', lnum, recDepth);
            if (!(e instanceof ParserError)) throw e;
        }
    }
    
    /*************************************************************************/
    
    // ## case for:
    //    | expr , op, expr
    //    | op_uni , expr
    // if operator is found, split by the operator and recursively parse the LH and RH
    if (topmostOp !== undefined) {
        bF.parserPrintdbgline('E', 'Operators', lnum, recDepth);

        if (ifMode && topmostOp == "=") throw lang.syntaxfehler(lnum, "'=' used on IF, did you mean '=='?");
        if (ifMode && topmostOp == ":") throw lang.syntaxfehler(lnum, "':' used on IF");
        
        
        // this is the AST we're going to build up and return
        // (other IF clauses don't use this)
        let treeHead = new BasicAST();
        treeHead.astLnum = lnum;
        treeHead.astValue = topmostOp;
        treeHead.astType = "op";
        
        // BINARY_OP?
        if (operatorPos > 0) {
            let subtknL = tokens.slice(0, operatorPos);
            let substaL = states.slice(0, operatorPos);
            let subtknR = tokens.slice(operatorPos + 1, tokens.length);
            let substaR = states.slice(operatorPos + 1, tokens.length);

            treeHead.astLeaves[0] = bF._parseExpr(lnum, subtknL, substaL, recDepth + 1);
            treeHead.astLeaves[1] = bF._parseExpr(lnum, subtknR, substaR, recDepth + 1);
        }
        else {
            treeHead.astValue = (topmostOp === "-") ? "UNARYMINUS" : "UNARYPLUS";
            treeHead.astLeaves[0] = bF._parseExpr(lnum,
                tokens.slice(operatorPos + 1, tokens.length),
                states.slice(operatorPos + 1, states.length),
                recDepth + 1
            );
        }
        
        return treeHead;
    }
    
    /*************************************************************************/
    
    throw new ParserError("Expression cannot be parsed");
} // END of EXPR


/** Parses following EBNF rule:
      "IF" , expr_sans_asgn , "THEN" , stmt , ["ELSE" , stmt]
    | "IF" , expr_sans_asgn , "THEN" , expr , ["ELSE" , expr]
    if exprMode is true, only the latter will be used; former otherwise
 * @return: BasicAST
 */
bF._parseIfMode = function(lnum, tokens, states, recDepth, exprMode) {
    bF.parserPrintdbg2('/', lnum, tokens, states, recDepth);

    /*************************************************************************/

    let headTkn = tokens[0].toUpperCase();
    let headSta = states[0];

    let parseFunction = (exprMode) ? bF._parseExpr : bF._parseStmt

    let thenPos = -1;
    let elsePos = -1;
    let parenDepth = 0;
    let parenStart = -1;
    let parenEnd = -1;

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
    }

    // unmatched brackets, duh!
    if (parenDepth != 0) throw lang.syntaxfehler(lnum, lang.unmatchedBrackets);

    let treeHead = new BasicAST();
    treeHead.astLnum = lnum;

    // ## case for:
    //    "IF" , expr_sans_asgn , "THEN" , stmt , ["ELSE" , stmt]
    if ("IF" == headTkn && "lit" == headSta) {
        
        // "THEN" not found, raise error!
        if (thenPos == -1) throw new ParserError("IF without THEN in " + lnum);
        
        treeHead.astValue = "IF";
        treeHead.astType = "function";
        
        treeHead.astLeaves[0] = bF._parseExpr(lnum,
            tokens.slice(1, thenPos),
            states.slice(1, thenPos),
            recDepth + 1,
            true // if_equation mode
        );
        treeHead.astLeaves[1] = parseFunction(lnum,
            tokens.slice(thenPos + 1, (elsePos != -1) ? elsePos : tokens.length),
            states.slice(thenPos + 1, (elsePos != -1) ? elsePos : tokens.length),
            recDepth + 1
        );
        if (elsePos != -1)
            treeHead.astLeaves[2] = parseFunction(lnum,
                tokens.slice(elsePos + 1, tokens.length),
                states.slice(elsePos + 1, tokens.length),
                recDepth + 1
            );
        
        return treeHead;
    }
    
    throw new ParserError("not an IF "+(exprMode) ? "expression" : "statement");
} // END of IF


/** Parses following EBNF rule:
function_call =
      ident , "(" , [expr , {argsep , expr} , [argsep]] , ")"
    | ident , expr , {argsep , expr} , [argsep] ;
 * @return: BasicAST
 */
bF._parseFunctionCall = function(lnum, tokens, states, recDepth) {
    bF.parserPrintdbg2(String.fromCharCode(0x192), lnum, tokens, states, recDepth);

    /*************************************************************************/
    
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
    let parenUsed = (parenStart == 1);
    // && parenEnd == tokens.length - 1);
    // if starting paren is found, just use it
    // this prevents "RND(~~)*K" to be parsed as [RND, (~~)*K]
    
    /*************************************************************************/

    // ## case for:
    //      ident , "(" , [expr , {argsep , expr} , [argsep]] , ")"
    //    | ident , expr , {argsep , expr} , [argsep] ;
    bF.parserPrintdbgline(String.fromCharCode(0x192), `Function Call (parenUsed: ${parenUsed})`, lnum, recDepth);
    
    let treeHead = new BasicAST();
    treeHead.astLnum = lnum;

    // set function name and also check for syntax by deliberately parsing the word
    treeHead.astValue = bF._parseIdent(lnum, [tokens[0]], [states[0]], recDepth + 1).astValue; // always UPPERCASE

    // 5 8 11 [end]
    let argSeps = parenUsed ? _argsepsOnLevelOne : _argsepsOnLevelZero; // choose which "sep tray" to use
    // 1 6 9 12
    let argStartPos = [1 + (parenUsed)].concat(argSeps.map(k => k+1));
    // [1,5) [6,8) [9,11) [12,end)
    let argPos = argStartPos.map((s,i) => {return{start:s, end:(argSeps[i] || (parenUsed) ? parenEnd : tokens.length )}}); // use end of token position as separator position

    // check for trailing separator
    let hasTrailingSep = (states[((parenUsed) ? parenEnd : states.length) - 1] == "sep");
    // exclude last separator from recursion if input tokens has trailing separator
    if (hasTrailingSep) argPos.pop();

    // recursively parse function arguments
    treeHead.astLeaves = argPos.map((x,i) => {
        bF.parserPrintdbgline(String.fromCharCode(0x192), 'Function Arguments #'+(i+1), lnum, recDepth);

        // check for empty tokens
        if (x.end - x.start <= 0) throw new ParserError("not a function call because it's malformed");

        return bF._parseExpr(lnum,
            tokens.slice(x.start, x.end),
            states.slice(x.start, x.end),
            recDepth + 1
        )}
    );
    treeHead.astType = "function";
    treeHead.astSeps = argSeps.map(i => tokens[i]);

    return treeHead;
}


bF._parseIdent = function(lnum, tokens, states, recDepth) {
    bF.parserPrintdbg2('i', lnum, tokens, states, recDepth);

    if (!Array.isArray(tokens) && !Array.isArray(states)) throw new ParserError("Tokens and states are not array");
    if (tokens.length != 1 || states[0] != "lit") throw new ParserError(`illegal tokens '${tokens}' with states '${states}' in ${lnum}`);
    
    let treeHead = new BasicAST();
    treeHead.astLnum = lnum;
    treeHead.astValue = tokens[0].toUpperCase();
    treeHead.astType = "lit";
    
    return treeHead;
}
/**
 * @return: BasicAST
 */
bF._parseLit = function(lnum, tokens, states, recDepth) {
    bF.parserPrintdbg2(String.fromCharCode(0xA2), lnum, tokens, states, recDepth);

    if (!Array.isArray(tokens) && !Array.isArray(states)) throw new ParserError("Tokens and states are not array");
    if (tokens.length != 1) throw new ParserError("parseLit 1");
    
    let treeHead = new BasicAST();
    treeHead.astLnum = lnum;
    treeHead.astValue = ("qot" == states[0]) ? tokens[0] : tokens[0].toUpperCase();
    treeHead.astType = ("qot" == states[0]) ? "string" : ("num" == states[0]) ? "num" : "lit";
    
    return treeHead;
}


bF._EquationIllegalTokens = ["IF","THEN","ELSE","DEFUN","ON"];
bF.isSemanticLiteral = function(token, state) {
    return "]" == token || ")" == token ||
            "qot" == state || "num" == state || "bool" == state || "lit" == state;
}


/////// TEST/////////
let astToString = function(ast, depth) {
    let l__ = String.fromCharCode(0x2502,32);
    let recDepth = depth || 0;
    if (ast === undefined || ast.astType === undefined) return "";
    var sb = "";
    var marker = ("lit" == ast.astType) ? "i" :
                 ("op" == ast.astType) ? String.fromCharCode(0xB1) :
                 ("string" == ast.astType) ? String.fromCharCode(0xB6) :
                 ("num" == ast.astType) ? String.fromCharCode(0xA2) :
                 ("array" == ast.astType) ? "[" : String.fromCharCode(0x192);
    sb += l__.repeat(recDepth) + marker+" Line "+ast.astLnum+" ("+ast.astType+")\n";
    sb += l__.repeat(recDepth+1) + "leaves: "+(ast.astLeaves.length)+"\n";
    sb += l__.repeat(recDepth+1) + "value: "+ast.astValue+" (type: "+typeof ast.astValue+")\n";
    for (var k = 0; k < ast.astLeaves.length; k++) {
        if (k > 0)
            sb += l__.repeat(recDepth+1) + " " + ast.astSeps[k - 1] + "\n";
        sb += astToString(ast.astLeaves[k], recDepth + 1);
    }
    sb += l__.repeat(recDepth)+String.fromCharCode(0x2570)+String.fromCharCode(0x2500).repeat(13)+'\n';
    return sb;
}
let BasicAST = function() {
    this.astLnum = 0;
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

// if s<2 then (nop1) else (if s < 9999 then nop2 else nop3)
let tokens1 = ["if","s","<","2","then","(","nop1",")","else","(","if","s","<","9999","then","nop2","else","nop3",")"];
let states1 = ["lit","lit","op","num","lit","paren","lit","paren","lit","paren","lit","lit","op","num","lit","lit","lit","lit","paren"];

// DEFUN HYPOT(X,Y) = SQR(X*X+Y*Y)
let tokens2 = ["defun","HYPOT","(","X",",","Y",")","=","SQR","(","X","*","X","+","Y","*","Y",")"];
let states2 = ["lit","lit","paren","lit","sep","lit","paren","op","lit","paren","lit","op","lit","op","lit","op","lit","paren"];

// DEFUN SINC(X) = SIN(X) / X
let tokens3 = ["DEFUN","SINC","(","X",")","=","SIN","(","X",")","/","X"];
let states3 = ["lit","lit","paren","lit","paren","op","lit","paren","lit","paren","op","lit"];

// PRINT(IF S<2 THEN "111" ELSE IF S<3 THEN "222" ELSE "333")
let tokens4 = ["PRINT","(","IF","S","<","2","THEN","111","ELSE","IF","S","<","3","THEN","222","ELSE","333",")"];
let states4 = ["lit","paren","lit","lit","op","lit","lit","qot","lit","lit","lit","op","lit","lit","qot","lit","qot","paren"];

// ON 6*SQR(X-3) GOTO X+1, X+2, X+3
let tokens5 = ["ON","6","*","SQR","(","X","-","3",")","GOTO","X","+","1",",","X","+","2",",","X","+","3"];
let states5 = ["lit","num","op","lit","paren","lit","op","num","paren","lit","lit","op","num","sep","lit","op","num","sep","lit","op","num"];

// FOR K=1 TO 10
let tokens6 = ["FOR","K","=","1","TO","10"];
let states6 = ["lit","lit","op","num","op","num"];

// FIXME print(chr(47+round(rnd(1))*45);) outputs bad tree
let tokens7 = ["PRINT","(","CHR","(","47","+","ROUND","(","RND","(","1",")",")","*","45",")",";",")"];
let states7 = ["lit","paren","lit","paren","num","op","lit","paren","lit","paren","num","paren","paren","op","num","paren","sep","paren"];

// PRINT 4 + 5 * 9
let tokens8 = ["PRINT","4","+","5","*","9"];
let states8 = ["lit","num","op","num","op","num"];

try  {
    let trees = bF._parseTokens(lnum,
        tokens8,
        states8
    );
    trees.forEach((t,i) => {
        serial.println("\nParsed Statement #"+(i+1));
        serial.println(astToString(t));
    });
}
catch (e) {
    serial.printerr(e);
    serial.printerr(e.stack || "stack trace undefined");
}