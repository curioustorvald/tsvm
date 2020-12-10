class ParserError extends Error {
    constructor(...args) {
        super(...args);
        Error.captureStackTrace(this, ParserError);
    }
}

/** Parses following EBNF rule:
 * stmt =  
 *       "IF" , equation , "THEN" , stmt , ["ELSE" , stmt]
 *     | "DEFUN" , [lit] , "(" , [lit , {" , " , lit}] , ")" , "=" , stmt
 *     | "ON" , lit , function , equation , [{"," , equation}]
 *     | function , [equation , {argsep , equation}]
 *     | function , "(" , [equation , {argsep , equation}] , ")"
 *     | equation 
 *     | "(" , stmt , ")" ;
 * @return: BasicAST
 */
bF._parseStmt = function(lnum, tokens, states, recDepth) {
    let headTkn = tokens[0].toUpperCase();
    let headSta = states[0];
    
    let treeHead = new BasicAST();
    treeHead.astDepth = recDepth;
    treeHead.astLnum = lnum;
    
    if ("IF" == headTkn && "lit" == headSta) {
        // find nearest THEN and ELSE but also take parens into account
        let thenPos = -1;
        let elsePos = -1;
        let parenDepth = 0;
        let parenStart = -1;
        let parenEnd = -1;
        
        // Scan for unmatched parens and mark off the right operator we must deal with
        for (k = 0; k < tokens.length; k++) {
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
        
        // "THEN" not found, raise error!
        if (thenPos == -1) throw ParserError("IF without THEN in " + lnum);
        
        // TODO gotta go home :)
    }
}
/** Parses following EBNF rule:
 * lit (* which is parsed by the tokeniser already *)
 * @return: BasicAST
 */
bF._parseLit = function(lnum, tokens, states, recDepth) {
    let treeHead = new BasicAST();
    treeHead.astDepth = recDepth;
    treeHead.astLnum = lnum;
    
    // special case where there /were only one word
    if (recDepth == 0) {
        // if that word is literal (e.g. "10 CLEAR"), interpret it as a function
        if (states[0] == "lit") {
            treeHead.astValue = tokens[0];
            treeHead.astType = "function";

            return treeHead;
        }
        // else, screw it
        else {
            throw lang.syntaxfehler(lnum, "TRAP_LITERALLY_LITERAL");
        }
    }

    if (_debugSyntaxAnalysis) serial.println("literal/number: "+tokens[0]);
    treeHead.astValue = ("qot" == states[0]) ? tokens[0] : tokens[0].toUpperCase();
    treeHead.astType = ("qot" == states[0]) ? "string" : ("num" == states[0]) ? "num" : "lit";
}
/** Parses following EBNF rule:
 * equation = equation , op , equation
 *     | op_uni , equation
 *     | lit
 *     | "(" , equation , ")"
 * @return: BasicAST
 */
bF._EquationIllegalTokens = ["IF","THEN","ELSE","DEFUN","ON"];
bF._parseEquation = function(lnum, tokens, states, recDepth) {
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
    for (k = 0; k < tokens.length; k++) {
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
            if (states[k] == "op" && isSemanticLiteral(tokens[k-1], states[k-1]) &&
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
            recDepth + 1
        );
    }
    // ## case for:
    //      lit , op, lit
    //    | op_uni , lit
    // if operator is found, split by the operator and recursively parse the LH and RH
    if (topmostOp !== undefined) {
        if (_debugSyntaxAnalysis) serial.println("operator: "+topmostOp+", pos: "+operatorPos);

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
    // ## case for:
    //    lit
    let headTkn = tokens[0].toUpperCase();
    if (!bF._EquationIllegalTokens.includes(headTkn)) {
        return bF._parseLit(lnum, tokens, states, recDepth + 1);
    }
    
    throw ParserError(`Equation - illegal token "${headTkn}" in ${lnum}`);
    
}
