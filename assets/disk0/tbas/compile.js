// Terran BASIC -> JavaScript compiler
// Loaded into basic.js's context by `bF.compile`. Re-uses bF._interpretLine
// (tokeniser + elaborator + parser + pruner) verbatim and emits a self-
// contained JS program that does its work via `let bS = require("tbas")`.
//
// On load, attaches `bS._compileImpl` to the live bS object.

;(function() {

// ---------- helpers ----------------------------------------------------------

function isValidJsId(s) {
    return /^[A-Z_][A-Z0-9_]*$/i.test(s)
}
function varRef(name) {
    const u = String(name).toUpperCase()
    return isValidJsId(u) ? `bS.__state.vars.${u}` : `bS.__state.vars[${JSON.stringify(u)}]`
}
function jsLit(v) { return JSON.stringify(v) }

// Resolve a literal AST node down to a raw JS value at compile time. Used
// for harvesting DATA constants. Only constant-propagatable types are
// permitted; otherwise compile-time evaluation fails.
function literalValue(node) {
    if (!node) return undefined
    switch (node.astType) {
        case "num":    return Number(node.astValue)
        case "string": return String(node.astValue)
        case "bool":   return Boolean(node.astValue)
        case "null":   return undefined
        case "lit":    return String(node.astValue) // bare identifier in DATA: keep as string
        default:
            throw Error("DATA: unsupported literal node type: " + node.astType)
    }
}

// Returns the maximum varIndex used at the immediate scope of a lambda body,
// hence its arity.
function lambdaArity(body) {
    let maxIdx = -1
    function walk(t, level) {
        if (!t || !t.astType) return
        if (t.astType === "defun_args" && t.astValue[0] === level) {
            if (t.astValue[1] > maxIdx) maxIdx = t.astValue[1]
        }
        // descend into nested usrdefun (its body lives in astValue, not leaves)
        if (t.astType === "usrdefun" && t.astValue && t.astValue.astLeaves !== undefined) {
            walk(t.astValue, level + 1)
        }
        // generic descent
        if (t.astLeaves) {
            for (let i = 0; i < t.astLeaves.length; i++) walk(t.astLeaves[i], level)
        }
    }
    walk(body, 0)
    return maxIdx + 1
}

// ---------- expression lowering ---------------------------------------------

// `depth` tracks the number of enclosing lambdas during emission. When we
// emit a lambda we increment it; defun_args [d, i] becomes _aN_i where
// N = depth - 1 - d  (the absolute lambda index of the binding scope).
function compileExpr(tree, depth) {
    if (tree === undefined || tree === null) return "undefined"

    // Empty parens / wrapper node: descend into the single child
    if (tree.astType === "null") {
        if (tree.astLeaves && tree.astLeaves[0] !== undefined) return compileExpr(tree.astLeaves[0], depth)
        return "undefined"
    }
    if (tree.astValue === undefined && tree.astLeaves && tree.astLeaves.length === 1) {
        return compileExpr(tree.astLeaves[0], depth)
    }

    switch (tree.astType) {
        case "num":    return String(Number(tree.astValue))
        case "string": return jsLit(String(tree.astValue))
        case "bool":   return tree.astValue ? "true" : "false"
        case "lit":    return compileLit(tree)
        case "defun_args": {
            const d = tree.astValue[0], i = tree.astValue[1]
            const scope = depth - 1 - d
            if (scope < 0) throw Error("defun_args refers to a scope outside the program (depth=" + depth + ", d=" + d + ")")
            return "_a" + scope + "_" + i
        }
        case "usrdefun": return compileLambdaExpr(tree, depth)
        case "array":    return compileArrayRef(tree, depth)
        case "function": return compileFunctionExpr(tree, depth)
        case "op":       return compileOpExpr(tree, depth)
        default:
            throw Error("Cannot compile expression node of type: " + tree.astType + " (value=" + tree.astValue + ")")
    }
}

function compileLit(tree) {
    const name = String(tree.astValue).toUpperCase()
    // Built-in zero-arg / pass-as-value functions: when a builtin name is
    // referenced as a value (e.g. assigned to a variable for later use as a
    // higher-order arg), emit a JS function reference. For a plain variable
    // read, emit the vars table lookup.
    // Heuristic: if the name matches a builtin we know about, prefer the
    // function; otherwise, vars lookup.
    if (RUNTIME_BUILTINS.has(name)) {
        return "bS." + (isValidJsId(name) ? name : `[${jsLit(name)}]`)
    }
    return varRef(name)
}

function compileArrayRef(tree, depth) {
    // tree.astValue = array variable name; tree.astLeaves = index expressions
    if (!tree.astLeaves || tree.astLeaves.length === 0) {
        return varRef(tree.astValue)
    }
    const indices = tree.astLeaves.map(l => compileExpr(l, depth))
    return `bS.__arrGet(${varRef(tree.astValue)}, [${indices.join(",")}])`
}

function compileFunctionExpr(tree, depth) {
    const name = String(tree.astValue).toUpperCase()

    if (name === "PRINT" || name === "EMIT") {
        // PRINT/EMIT used as expression — emit as IIFE returning undefined
        return "(" + compilePrintLike(tree, name, depth) + ", undefined)"
    }
    // user function call by name: <varname>(args)  — when astType is "function"
    // and astValue is a string that matches a variable, the parser may have
    // generated this. Treat it as: invoke the var.
    if (!RUNTIME_BUILTINS.has(name)) {
        // Not a known builtin: treat as a user defined function call
        const args = (tree.astLeaves || []).map(l => compileExpr(l, depth))
        return `bS.__runFn(${varRef(name)}, [${args.join(",")}])`
    }

    const args = (tree.astLeaves || []).map(l => compileExpr(l, depth))
    return `bS.${isValidJsId(name) ? name : `[${jsLit(name)}]`}(${args.join(",")})`
}

const ARITH_OP = {
    "+":  (l,r) => `bS.__add(${l},${r})`,
    "-":  (l,r) => `((${l})-(${r}))`,
    "*":  (l,r) => `((${l})*(${r}))`,
    "/":  (l,r) => `bS.__div(${l},${r})`,
    "\\": (l,r) => `bS.__intdiv(${l},${r})`,
    "MOD":(l,r) => `bS.__mod(${l},${r})`,
    "^":  (l,r) => `bS.__pow(${l},${r})`,
    "==": (l,r) => `((${l})==(${r}))`,
    "<>": (l,r) => `((${l})!=(${r}))`,
    "><": (l,r) => `((${l})!=(${r}))`,
    "<":  (l,r) => `((${l})<(${r}))`,
    ">":  (l,r) => `((${l})>(${r}))`,
    "<=": (l,r) => `((${l})<=(${r}))`,
    "=<": (l,r) => `((${l})<=(${r}))`,
    ">=": (l,r) => `((${l})>=(${r}))`,
    "=>": (l,r) => `((${l})>=(${r}))`,
    "AND":(l,r) => `bS.AND(${l},${r})`,
    "OR": (l,r) => `bS.OR(${l},${r})`,
    "<<": (l,r) => `((${l})<<(${r}))`,
    ">>": (l,r) => `((${l})>>>(${r}))`,
    "BAND":(l,r) => `((${l})&(${r}))`,
    "BOR": (l,r) => `((${l})|(${r}))`,
    "BXOR":(l,r) => `((${l})^(${r}))`,
}
const UNARY_OP = {
    "UNARYMINUS":   (a) => `(-(${a}))`,
    "UNARYPLUS":    (a) => `(+(${a}))`,
    "UNARYLOGICNOT":(a) => `(!(${a}))`,
    "UNARYBNOT":    (a) => `(~(${a}))`,
}

function compileOpExpr(tree, depth) {
    const op = String(tree.astValue)
    const leaves = tree.astLeaves || []

    // Unary
    if (UNARY_OP[op] && (leaves.length === 1 || leaves[1] === undefined)) {
        return UNARY_OP[op](compileExpr(leaves[0], depth))
    }

    // Binary arithmetic / comparison / logic
    if (ARITH_OP[op] && leaves.length === 2) {
        return ARITH_OP[op](compileExpr(leaves[0], depth), compileExpr(leaves[1], depth))
    }

    // Generator / range
    if (op === "TO" && leaves.length === 2) {
        return `new bS.__ForGen(${compileExpr(leaves[0], depth)}, ${compileExpr(leaves[1], depth)}, 1)`
    }
    if (op === "STEP" && leaves.length === 2) {
        return `bS.STEP(${compileExpr(leaves[0], depth)}, ${compileExpr(leaves[1], depth)})`
    }

    // List ops
    if ((op === "!" || op === "~" || op === "#") && leaves.length === 2) {
        const fn = (op === "!") ? "['!']" : (op === "~") ? "['~']" : "['#']"
        return `bS${fn}(${compileExpr(leaves[0], depth)}, ${compileExpr(leaves[1], depth)})`
    }

    // Assignment as expression — returns the assigned value
    if (op === "=" && leaves.length === 2) {
        return "(" + compileAssignExpr(tree, depth) + ")"
    }
    if (op === "IN" && leaves.length === 2) {
        // Used inside FOR/FOREACH; compileFor unwraps these. As a value, treat
        // as { asgnVarName, asgnValue } so a stray IN still works.
        const name = jsLit(String(leaves[0].astValue).toUpperCase())
        const rhs = compileExpr(leaves[1], depth)
        return `({asgnVarName: ${name}, asgnValue: ${rhs}})`
    }

    // Functional / monad ops
    if ((op === ">>=" || op === ">>~" || op === "." || op === "$" ||
         op === "&"   || op === "~<"  || op === "<*>" || op === "<$>" ||
         op === "<~>") && leaves.length === 2) {
        return `bS[${jsLit(op)}](${compileExpr(leaves[0], depth)}, ${compileExpr(leaves[1], depth)})`
    }
    if (op === "@" && leaves.length === 1) {
        // Monad return as prefix
        return `bS.MRET(${compileExpr(leaves[0], depth)})`
    }
    if (op === "~>") {
        throw Error("Compiler: bare ~> survived prune (should be usrdefun)")
    }

    throw Error("Cannot compile op '" + op + "' with " + leaves.length + " operand(s)")
}

function compileLambdaExpr(tree, depth) {
    // tree.astType === "usrdefun"; tree.astValue holds the body AST; if
    // tree.astLeaves is non-empty, this is an immediate application.
    const body = tree.astValue
    if (!body || !body.astType) throw Error("Malformed usrdefun")

    const arity = lambdaArity(body)
    const newDepth = depth + 1
    const params = []
    for (let i = 0; i < arity; i++) params.push("_a" + (newDepth - 1) + "_" + i)
    const bodyJs = compileExpr(body, newDepth)
    const arrow = `((${params.join(",")}) => (${bodyJs}))`

    if (tree.astLeaves && tree.astLeaves.length > 0) {
        const args = tree.astLeaves.map(l => compileExpr(l, depth))
        return `${arrow}(${args.join(",")})`
    }
    return arrow
}

function compileAssignExpr(tree, depth) {
    // op "=" with leaves[0] as target, leaves[1] as RHS
    const lhs = tree.astLeaves[0]
    const rhs = compileExpr(tree.astLeaves[1], depth)

    if (lhs.astType === "lit") {
        const name = String(lhs.astValue).toUpperCase()
        return `(${varRef(name)} = ${rhs})`
    }
    // The parser emits "function" or "array" for `A(i,j) = ...` — both mean
    // "store into element of A".
    if (lhs.astType === "array" || lhs.astType === "function") {
        const indices = lhs.astLeaves.map(l => compileExpr(l, depth))
        return `(bS.__arrSet(${varRef(lhs.astValue)}, [${indices.join(",")}], ${rhs}), ${rhs})`
    }
    throw Error("Cannot assign to LHS of type " + lhs.astType)
}

// ---------- statement lowering ----------------------------------------------

function compilePrintLike(tree, fname, depth) {
    const leaves = (tree.astLeaves || []).slice()
    const seps = (tree.astSeps || []).slice()

    let suppressNewline = false
    if (leaves.length > 0 && leaves[leaves.length - 1] !== undefined &&
        leaves[leaves.length - 1].astType === "null") {
        suppressNewline = true
        leaves.pop()
    }

    const valueExprs = leaves.map(l => compileExpr(l, depth))
    if (suppressNewline) valueExprs.push("bS.__PRINT_NONL")
    const sepArr = seps.slice(0, leaves.length - 1)

    return `bS.${fname}([${valueExprs.join(", ")}], ${jsLit(sepArr)})`
}

function setPc(pc) {
    if (pc[0] === Infinity) return "pc=[Infinity,0];"
    return "pc=[" + pc[0] + "," + pc[1] + "];"
}

function compileStatement(tree, lnum, stmt, nextPc) {
    if (!tree) return setPc(nextPc)
    if (tree.astType === "null" && tree.astLeaves && tree.astLeaves[0]) {
        return compileStatement(tree.astLeaves[0], lnum, stmt, nextPc)
    }

    const isFn = (tree.astType === "function" || tree.astType === "op")
    const fname = isFn ? String(tree.astValue).toUpperCase() : null

    switch (fname) {
    case "GOTO": {
        const target = compileGotoTarget(tree.astLeaves[0])
        return `pc=${target};`
    }
    case "GOSUB": {
        const target = compileGotoTarget(tree.astLeaves[0])
        return `gosubStack.push([${nextPc[0]},${nextPc[1]}]); pc=${target};`
    }
    case "RETURN":
        return `pc=gosubStack.pop(); if(!pc) throw new Error("RETURN without GOSUB");`
    case "END":
        return "pc=[Infinity,0];"
    case "IF":
        return compileIf(tree, lnum, stmt, nextPc)
    case "ON":
        return compileOn(tree, lnum, stmt, nextPc)
    case "FOR":
    case "FOREACH":
        return compileFor(tree, lnum, stmt, nextPc, fname === "FOREACH")
    case "NEXT":
        return compileNext(tree, lnum, stmt, nextPc)
    case "READ": {
        const target = tree.astLeaves[0]
        if (target.astType !== "lit") throw Error("READ: target must be a variable")
        return `${varRef(target.astValue)}=bS.__readData(); ${setPc(nextPc)}`
    }
    case "RESTORE":
        return `bS.__state.dataCursor=0; ${setPc(nextPc)}`
    case "DATA":
    case "LABEL":
        return setPc(nextPc) // harvested at compile time
    case "DIM":
        return compileDim(tree, lnum, stmt, nextPc)
    case "PRINT":
    case "EMIT":
        return `${compilePrintLike(tree, fname, 0)}; ${setPc(nextPc)}`
    case "OPTIONBASE":
        return `bS.OPTIONBASE(${compileExpr(tree.astLeaves[0], 0)}); ${setPc(nextPc)}`
    case "OPTIONDEBUG":
        return `bS.OPTIONDEBUG(${compileExpr(tree.astLeaves[0], 0)}); ${setPc(nextPc)}`
    case "OPTIONTRACE":
        return `bS.OPTIONTRACE(${compileExpr(tree.astLeaves[0], 0)}); ${setPc(nextPc)}`
    case "INPUT": {
        // INPUT <var> -> read into var
        const target = tree.astLeaves[tree.astLeaves.length - 1]
        if (target.astType !== "lit") throw Error("INPUT: target must be a variable")
        return `${varRef(target.astValue)}=bS.INPUT(); ${setPc(nextPc)}`
    }
    case "=":
        return `${compileAssignExpr(tree, 0)}; ${setPc(nextPc)}`
    case "IN":
        // bare IN as a statement is unusual but harmless
        return `${compileExpr(tree, 0)}; ${setPc(nextPc)}`
    case "REM":
        return setPc(nextPc)
    }

    // Default: evaluate as an expression for side effect, then advance
    return `${compileExpr(tree, 0)}; ${setPc(nextPc)}`
}

function compileGotoTarget(leaf) {
    // Always route through __resolveTarget so non-existent line numbers snap
    // upward to the next existing line — matching basic.js's main loop,
    // which increments lnum until it finds a populated cmdbuf entry.
    if (leaf.astType === "num") return `bS.__resolveTarget(${Number(leaf.astValue)})`
    if (leaf.astType === "string") return `bS.__resolveTarget(${jsLit(leaf.astValue)})`
    if (leaf.astType === "lit") {
        const name = String(leaf.astValue)
        return `bS.__resolveTarget(bS.__state.gotoLabels[${jsLit(name)}]!==undefined ? ${jsLit(name)} : ${varRef(name)})`
    }
    return `bS.__resolveTarget(${compileExpr(leaf, 0)})`
}

function compileIf(tree, lnum, stmt, nextPc) {
    const test = compileExpr(tree.astLeaves[0], 0)
    const thenStmt = compileStatement(tree.astLeaves[1], lnum, stmt, nextPc)
    const elseStmt = (tree.astLeaves[2])
        ? compileStatement(tree.astLeaves[2], lnum, stmt, nextPc)
        : setPc(nextPc)
    return `if(bS.__test(${test})){${thenStmt}}else{${elseStmt}}`
}

function compileOn(tree, lnum, stmt, nextPc) {
    // children: testExpr, jumpFnLit, target0, target1, ...
    const testExpr = compileExpr(tree.astLeaves[0], 0)
    const jmpFn    = String(tree.astLeaves[1].astValue).toUpperCase()
    const targets  = tree.astLeaves.slice(2)

    const cases = targets.map((t, i) => {
        const tgt = compileGotoTarget(t)
        if (jmpFn === "GOSUB") {
            return `case ${i}: gosubStack.push([${nextPc[0]},${nextPc[1]}]); pc=${tgt}; break;`
        }
        return `case ${i}: pc=${tgt}; break;`
    })
    return `{const _o=(${testExpr})-bS.__state.indexBase; switch(_o){${cases.join(" ")} default: ${setPc(nextPc)}}}`
}

function compileFor(tree, lnum, stmt, nextPc, isForEach) {
    const child = tree.astLeaves[0]
    if (child.astType !== "op" || (child.astValue !== "=" && child.astValue !== "IN")) {
        throw Error("FOR/FOREACH: expected = or IN, got " + child.astType + ":" + child.astValue)
    }
    const varname = String(child.astLeaves[0].astValue).toUpperCase()
    let iter = compileExpr(child.astLeaves[1], 0)
    if (isForEach) {
        // ensure we coerce generators into arrays for FOREACH semantics
        iter = `(function(_x){return bS.__isGenerator(_x)?bS.__genToArray(_x):_x})(${iter})`
    }
    // Pass nextPc — the PC of the loop body's first statement — so NEXT can
    // jump straight back without relying on fall-through.
    return `bS.__forSetup(${jsLit(varname)}, ${iter}, ${nextPc[0]}, ${nextPc[1]}); ${setPc(nextPc)}`
}

function compileNext(tree, lnum, stmt, nextPc) {
    let argExpr = "undefined"
    const leaves = tree.astLeaves || []
    if (leaves.length === 1 && leaves[0] && leaves[0].astType === "lit") {
        argExpr = jsLit(String(leaves[0].astValue).toUpperCase())
    }
    return `{const _n=bS.__forNext(${argExpr}); if(_n){pc=_n;}else{${setPc(nextPc)}}}`
}

function compileDim(tree, lnum, stmt, nextPc) {
    // tree.astLeaves contains array constructor calls: each leaf is either
    //   an `array` node OR a `function` node (the parser doesn't distinguish
    //   `A(5)` from a function call until runtime). astValue is the variable
    //   name and astLeaves are the dimension expressions.
    const stmts = []
    for (let i = 0; i < tree.astLeaves.length; i++) {
        const leaf = tree.astLeaves[i]
        if (leaf.astType !== "array" && leaf.astType !== "function") {
            throw Error("DIM: expected array decl, got " + leaf.astType)
        }
        const name = String(leaf.astValue).toUpperCase()
        const dims = leaf.astLeaves.map(l => compileExpr(l, 0))
        stmts.push(`${varRef(name)}=bS.__dim([${dims.join(",")}]);`)
    }
    return stmts.join(" ") + " " + setPc(nextPc)
}

// ---------- top-level entry --------------------------------------------------

// Set of builtin names exposed by tbas.mjs. Used to decide whether a `lit`
// in expression position is a variable or a function reference.
const RUNTIME_BUILTINS = new Set([
    "PRINT","EMIT","INPUT","CIN",
    "ABS","SGN","INT","FLOOR","CEIL","FIX","ROUND","SQR","CBR",
    "SIN","COS","TAN","ASN","ACO","ATN","SINH","COSH","TANH",
    "EXP","LOG","MIN","MAX","RND",
    "SPC","LEFT","RIGHT","MID","CHR",
    "LEN","HEAD","TAIL","INIT","LAST","MAP","FOLD","FILTER","ARRAY",
    "CLS","CLPX","PLOT","GOTOYX","TEXTFORE","TEXTBACK",
    "POKE","PEEK","GETKEYSDOWN","CPUT","CGET","CSTA",
    "TYPEOF","OPTIONBASE","OPTIONDEBUG","OPTIONTRACE",
    "MRET","MLIST","MJOIN",
    "AND","OR","NOT",
    "DO","CLEAR","END","TO","STEP",
    "FOR","FOREACH","NEXT","IF","ON","GOTO","GOSUB","RETURN",
    "DIM","DATA","READ","RESTORE","LABEL","REM",
    "TEST",
])

bS._compileImpl = function(outpath) {
    if (typeof cmdbuf === "undefined") throw Error("compile.js: cmdbuf not available")
    if (typeof bF === "undefined")     throw Error("compile.js: bF not available")
    if (typeof bF._interpretLine !== "function") throw Error("compile.js: bF._interpretLine not available")

    // Reset parser-side state so we don't pollute the live interpreter
    if (typeof lambdaBoundVars !== "undefined") lambdaBoundVars.length = 0
    const savedPrescan = (typeof prescan !== "undefined") ? prescan : false
    if (typeof prescan !== "undefined") prescan = true   // suppress execution of LABEL/DATA prescan side-effects

    // ---- pass 1: parse every line ----
    const programTrees = []   // [lnum] -> array of statements
    for (let lnum = 0; lnum < cmdbuf.length; lnum++) {
        const linestr = cmdbuf[lnum]
        if (linestr === undefined) continue
        const trees = bF._interpretLine(lnum, String(linestr).trim())
        if (trees !== undefined) programTrees[lnum] = trees
    }
    if (typeof prescan !== "undefined") prescan = savedPrescan

    // ---- pass 2: ordered list of populated lnums and successor table ----
    const linenums = []
    for (let lnum = 0; lnum < programTrees.length; lnum++) {
        if (programTrees[lnum] !== undefined) linenums.push(lnum)
    }

    function nextPcOf(idx, stmtIdx) {
        const lnum = linenums[idx]
        const stmts = programTrees[lnum]
        if (stmtIdx + 1 < stmts.length) return [lnum, stmtIdx + 1]
        if (idx + 1 < linenums.length)  return [linenums[idx + 1], 0]
        return [Infinity, 0]
    }

    // ---- pass 3: harvest DATA constants and LABEL definitions ----
    const dataConsts = []
    const labelMap = {}
    for (let i = 0; i < linenums.length; i++) {
        const lnum = linenums[i]
        const stmts = programTrees[lnum]
        for (let s = 0; s < stmts.length; s++) {
            const t = stmts[s]
            if (!t) continue
            if (t.astValue === "DATA") {
                for (let k = 0; k < t.astLeaves.length; k++) {
                    dataConsts.push(literalValue(t.astLeaves[k]))
                }
            } else if (t.astValue === "LABEL") {
                const lblNode = t.astLeaves[0]
                if (!lblNode) throw Error("LABEL with no name on line " + lnum)
                const lblName = String(lblNode.astValue)
                labelMap[lblName] = [lnum, s]
            }
        }
    }

    // ---- pass 4: emit case bodies ----
    const cases = []
    for (let i = 0; i < linenums.length; i++) {
        const lnum = linenums[i]
        const stmts = programTrees[lnum]
        for (let s = 0; s < stmts.length; s++) {
            const next = nextPcOf(i, s)
            const body = compileStatement(stmts[s], lnum, s, next)
            cases.push(`    case ${lnum}*32+${s}: { ${body} break; }`)
        }
    }

    // ---- pass 5: assemble final output ----
    const firstPc = (linenums.length > 0) ? `[${linenums[0]},0]` : `[Infinity,0]`
    const labelMapJs = "{" + Object.keys(labelMap).map(k =>
        `${jsLit(k)}: [${labelMap[k][0]}, ${labelMap[k][1]}]`
    ).join(", ") + "}"

    const out =
`// Compiled by Terran BASIC -> JS compiler (assets/disk0/tbas/compile.js)
// Source line count: ${linenums.length}
let bS = require("tbas")
bS.__reset()
bS.__data(${jsLit(dataConsts)})
bS.__labels(${labelMapJs})
bS.__setLines(${jsLit(linenums)})
let pc = ${firstPc}
const gosubStack = []
while (pc[0] !== Infinity) {
  switch (pc[0]*32 + pc[1]) {
${cases.join("\n")}
    default: pc = [Infinity, 0]; break;
  }
}
`

    // ---- write to disk via basic.js's fs (writes under BASIC_HOME_PATH) ----
    const opened = fs.open(outpath, "W")
    if (!opened) throw Error("Cannot open " + outpath + " for writing")
    fs.write(out)
    return out.length
}

})();
