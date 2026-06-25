// Terran BASIC runtime helper for compiled programs
// Compiled-by: assets/disk0/tbas/compile.js
// Loaded at runtime by `let bS = require("tbas")`
//
// Contract with compiler:
//   - The compiler has lowered every BASIC expression to a JS expression
//     that produces the *raw* JS value (number, string, array, ForGen,
//     function, BasicMemoMonad, …). Builtins take such raw values, NOT
//     SyntaxTreeReturnObj wrappers.
//   - Variable reads: bS.__state.vars.X    (key always uppercased)
//   - Variable writes: bS.__state.vars.X = v
//   - Control flow (GOTO/GOSUB/RETURN/FOR/NEXT/IF/ON/END/READ/RESTORE/LABEL/DATA)
//     is *not* exposed here — the compiler emits inline JS that updates the
//     `pc` and `gosubStack` directly.
//
// Naming: BASIC builtins exposed under their UPPERCASE name (bS.PRINT,
// bS.PLOT, bS.SIN). Compiler-only helpers prefixed with __.

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

function isNumable(s) {
    if (Array.isArray(s)) return false
    if (s === undefined) return false
    if (typeof s.trim == "function" && s.trim().length == 0) return false
    return !isNaN(s)
}
const tonum = (t) => t * 1.0

function ForGen(s, e, t) {
    this.start = s
    this.end = e
    this.step = t || 1
    this.current = this.start
    this.stepsgn = (this.step > 0) ? 1 : -1
}
const isGenerator = (o) =>
    o !== undefined && o !== null &&
    o.start !== undefined && o.end !== undefined &&
    o.step !== undefined && o.stepsgn !== undefined
const genToArray = (gen) => {
    let a = []
    let cur = gen.start
    while (cur * gen.stepsgn + gen.step * gen.stepsgn <= (gen.end + gen.step) * gen.stepsgn) {
        a.push(cur)
        cur += gen.step
    }
    return a
}
const genHasNext = (o) => o.current * o.stepsgn + o.step * o.stepsgn <= (o.end + o.step) * o.stepsgn
const genGetNext = (gen, mutated) => {
    if (mutated !== undefined) gen.current = tonum(mutated)
    gen.current += gen.step
    return genHasNext(gen) ? gen.current : undefined
}

function BasicMemoMonad(m) { this.mType = "value"; this.mVal = m }
function BasicListMonad(m) { this.mType = "list";  this.mVal = [m] }
function BasicFunSeq(f)    { this.mType = "funseq"; this.mVal = f }
const isMonad = (o) => o !== undefined && o !== null && o.mType !== undefined

function arrayToString(a) {
    let acc = ""
    for (let k = 0; k < a.length; k++) {
        if (k > 0) acc += ","
        acc += (Array.isArray(a[k])) ? arrayToString(a[k]) : a[k]
    }
    return "{" + acc + "}"
}

// ---------------------------------------------------------------------------
// State container
// ---------------------------------------------------------------------------

const _initialConsts = () => ({
    NIL: [],
    PI: Math.PI,
    TAU: Math.PI * 2,
    EULER: Math.E,
    UNDEFINED: undefined,
    TRUE: true,
    FALSE: false,
    // ID is identity-function: emitted as JS arrow when needed
    ID: (x) => x,
})

const state = {
    vars: _initialConsts(),
    indexBase: 0,
    dataConsts: [],
    dataCursor: 0,
    gotoLabels: {},   // labelName -> [lnum, stmt]
    lineList: [],     // sorted ascending list of existing source lines (for GOTO snap)
    rnd: Math.random(),
    forVar: {},       // varname -> generator|array (the iterable we still owe to FOR/FOREACH)
    forLnums: {},     // varname -> [lnum, stmt of the FOR/FOREACH header]
    forStack: [],
    trace: false,
    debug: false,
}

function __reset() {
    state.vars = _initialConsts()
    state.indexBase = 0
    state.dataConsts = []
    state.dataCursor = 0
    state.gotoLabels = {}
    state.lineList = []
    state.rnd = Math.random()
    state.forVar = {}
    state.forLnums = {}
    state.forStack = []
}

function __data(values)  { state.dataConsts = values.slice() }
function __labels(map)   { state.gotoLabels = Object.assign({}, map) }
function __setLines(arr) { state.lineList = arr.slice() }

// ---------------------------------------------------------------------------
// Compiler-emitted operator helpers (need behaviour not directly expressible
// in raw JS without losing semantics)
// ---------------------------------------------------------------------------

function __add(lh, rh) {
    return (!isNaN(lh) && !isNaN(rh)) ? (tonum(lh) + tonum(rh)) : (lh + rh)
}
function __div(lh, rh)    { if (rh == 0) throw Error("Division by zero"); return lh / rh }
function __intdiv(lh, rh) { if (rh == 0) throw Error("Division by zero"); return (lh / rh) | 0 }
function __mod(lh, rh)    { if (rh == 0) throw Error("Division by zero"); return lh % rh }
function __pow(lh, rh) {
    let r = Math.pow(lh, rh)
    if (isNaN(r)) throw Error("Illegal function call")
    if (!isFinite(r)) throw Error("Division by zero")
    return r
}

function __test(v) { return !!v }   // matches builtin TEST: string "false" is truthy

function __dim(dims) {
    let revdims = dims.slice().reverse()
    let inner = new Array(revdims[0]).fill(0)
    for (let k = 1; k < revdims.length; k++) {
        const sz = revdims[k]
        const prev = inner
        inner = new Array(sz).fill(0).map(_ => JSON.parse(JSON.stringify(prev)))
    }
    return inner
}

function __subscriptError(idx, dim) {
    return Error("Subscript out of range (index " + idx + ", dim " + dim + ")")
}
function __arrGet(arr, idx) {
    let v = arr
    for (let i = 0; i < idx.length; i++) {
        if (v === undefined || v === null) throw __subscriptError(idx[i], i)
        v = v[idx[i] - state.indexBase]
    }
    return v
}
function __arrSet(arr, idx, value) {
    let v = arr
    for (let i = 0; i < idx.length - 1; i++) {
        if (v === undefined || v === null) throw __subscriptError(idx[i], i)
        v = v[idx[i] - state.indexBase]
    }
    if (v === undefined || v === null) throw __subscriptError(idx[idx.length - 1], idx.length - 1)
    v[idx[idx.length - 1] - state.indexBase] = value
}

// FOR / FOREACH setup. Lowered as:
//   __forSetup(varname, iterable, bodyLnum, bodyStmt)
// where iterable is a ForGen (FOR…TO…STEP) OR an Array (FOREACH IN…), and
// (bodyLnum, bodyStmt) is the PC of the statement immediately following the
// FOR header — i.e. where NEXT should jump back to. The compiler supplies
// this directly so the state machine doesn't rely on fall-through.
function __forSetup(varname, iterable, bodyLnum, bodyStmt) {
    const v = varname.toUpperCase()
    if (isGenerator(iterable)) {
        state.vars[v] = iterable.start
        state.forVar[v] = iterable
    } else if (Array.isArray(iterable)) {
        state.vars[v] = iterable[0]
        state.forVar[v] = iterable.slice(1)  // remainder
    } else {
        throw Error("FOR: not a generator or array")
    }
    state.forLnums[v] = [bodyLnum, bodyStmt]
    state.forStack.push(v)
}

// NEXT [varname]. Without varname, pops the most recent.
// Returns [lnum, stmt] to jump back to (just-after the FOR header) if more
// iterations remain, or undefined if the loop is exhausted (caller falls
// through).
function __forNext(varname) {
    let v
    if (varname === undefined || varname === null) {
        v = state.forStack.pop()
    } else {
        v = varname.toUpperCase()
        // remove this varname from the stack
        const idx = state.forStack.lastIndexOf(v)
        if (idx >= 0) state.forStack.splice(idx, 1)
    }
    if (v === undefined) throw Error("NEXT without FOR")

    const it = state.forVar[v]
    let nextVal
    if (isGenerator(it)) {
        nextVal = genGetNext(it, state.vars[v])
    } else {
        nextVal = it.shift()
    }

    if (nextVal !== undefined) {
        state.vars[v] = nextVal
        state.forStack.push(v)
        return state.forLnums[v]   // already the PC of the loop body
    } else {
        if (isGenerator(it)) state.vars[v] = it.current
        return undefined
    }
}

function __readData() {
    const r = state.dataConsts[state.dataCursor++]
    if (r === undefined) throw Error("Out of DATA")
    return r
}

// Resolve a GOTO/GOSUB target — accepts numeric line, label string, or
// already-evaluated expression. For numeric targets that don't match an
// existing source line, snap upward to the next one (matches the
// interpreter's behaviour, where the main loop simply increments lnum until
// it finds a populated cmdbuf entry).
function __resolveTarget(t) {
    if (typeof t === "string" && state.gotoLabels[t] !== undefined) {
        return state.gotoLabels[t]
    }
    let target
    if (typeof t === "number")    target = t
    else if (isNumable(t))        target = tonum(t)
    else throw Error("Invalid jump target: " + t)

    const lines = state.lineList
    if (lines.length === 0) return [target, 0]
    // linear scan is fine for the line counts BASIC programs reach
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] >= target) return [lines[i], 0]
    }
    return [Infinity, 0]
}

// Invoke a usrdefun (compiled to a JS function), or — when the parser
// couldn't tell array-indexing apart from function-call (e.g. `A(5)` for an
// unknown identifier) — index into an array. Used by MAP/FOLD/FILTER, monad
// operators, and the compiler's default `function` lowering.
function __runFn(fn, args) {
    if (typeof fn === "function") return fn.apply(null, args)
    if (Array.isArray(fn)) return __arrGet(fn, args)
    if (isMonad(fn) && fn.mType === "funseq") {
        let arg = args[0]
        for (let i = 0; i < fn.mVal.length; i++) arg = __runFn(fn.mVal[i], [arg])
        return arg
    }
    throw Error("Not a callable: " + fn)
}

// ---------------------------------------------------------------------------
// Operator builtins (where JS doesn't already do the right thing)
// ---------------------------------------------------------------------------

function _AND(a, b) { if (typeof a !== "boolean" || typeof b !== "boolean") throw Error("Type mismatch"); return a && b }
function _OR (a, b) { if (typeof a !== "boolean" || typeof b !== "boolean") throw Error("Type mismatch"); return a || b }
function _NOT(a)    { return !a }

function _CONS(lh, rh) {  // !
    if (Array.isArray(rh)) return [lh].concat(rh)
    if (rh && rh.mType === "list") { rh.mVal = [lh].concat(rh.mVal); return rh }
    throw Error("Type mismatch")
}
function _PUSH(lh, rh) {  // ~
    if (Array.isArray(lh)) return lh.concat([rh])
    if (lh && lh.mType === "list") { lh.mVal = [lh.mVal].concat([rh]); return lh }
    throw Error("Type mismatch")
}
function _CONCAT(lh, rh) {  // #
    if (Array.isArray(lh) && Array.isArray(rh)) return lh.concat(rh)
    if (lh && rh && lh.mType === "list" && rh.mType === "list") return new BasicListMonad(lh.mVal.concat(rh.mVal))
    throw Error("Type mismatch")
}

function _TO(from, to)        { return new ForGen(from, to, 1) }
function _STEP(gen, step) {
    if (!isGenerator(gen)) throw Error("Type mismatch (STEP)")
    return new ForGen(gen.start, gen.end, step)
}

// ---------------------------------------------------------------------------
// I/O builtins
// ---------------------------------------------------------------------------

// PRINT(values, seps) — values: array of resolved JS values; seps: array of
// length values.length-1 with "," | ";" between each consecutive pair.
// Trailing semicolon? The compiler signals "no newline" by passing a final
// `null` element in `values` and "noNewline" flag — we use the convention
// that the LAST entry of `values` being a marker `__noNewline` suppresses
// the newline (matches basic.js trailing-null behaviour).
const __PRINT_NONL = Symbol("PRINT_NONL")
function PRINT(values, seps) {
    seps = seps || []
    if (values.length === 0) {
        println()
        return
    }
    let suppressNewline = false
    let realLen = values.length
    if (values[realLen - 1] === __PRINT_NONL) {
        suppressNewline = true
        realLen -= 1
    }
    for (let i = 0; i < realLen; i++) {
        if (i >= 1 && seps[i - 1] === ",") print("\t")
        const v = values[i]
        let s
        if (Array.isArray(v))            s = arrayToString(v)
        else if (v === undefined || v === "") s = ""
        else if (v.toString !== undefined)    s = v.toString()
        else                                  s = v
        print(s)
    }
    if (!suppressNewline) println()
}
function EMIT(values, seps) {
    seps = seps || []
    if (values.length === 0) { println(); return }
    let suppressNewline = false
    let realLen = values.length
    if (values[realLen - 1] === __PRINT_NONL) { suppressNewline = true; realLen -= 1 }
    for (let i = 0; i < realLen; i++) {
        if (i >= 1 && seps[i - 1] === ",") print("\t")
        const v = values[i]
        if (v === undefined) print("")
        else if (isNumable(v)) {
            const c = con.getyx()
            con.addch(tonum(v))
            con.move(c[0], c[1] + 1)
        } else if (v.toString !== undefined) print(v.toString())
        else print(v)
    }
    if (!suppressNewline) println()
}

function INPUT(promptOrVarname) {
    print("? ")
    let r = read().trim()
    if (!isNaN(r)) r = tonum(r)
    return r
}
function CIN() { return read().trim() }

// ---------------------------------------------------------------------------
// Numeric builtins
// ---------------------------------------------------------------------------

const _num = (f) => (x) => { if (!isNumable(x)) throw Error("Type mismatch"); return f(tonum(x)) }
const _num2 = (f) => (a, b) => {
    if (!isNumable(a) || !isNumable(b)) throw Error("Type mismatch")
    return f(tonum(a), tonum(b))
}

const ABS   = _num(Math.abs)
const SGN   = _num(x => x > 0 ? 1 : x < 0 ? -1 : 0)
const INT   = _num(Math.floor)
const FLOOR = _num(Math.floor)
const CEIL  = _num(Math.ceil)
const FIX   = _num(x => x | 0)
const ROUND = _num(Math.round)
const SQR   = _num(Math.sqrt)
const CBR   = _num(Math.cbrt)
const SIN   = _num(Math.sin)
const COS   = _num(Math.cos)
const TAN   = _num(Math.tan)
const ASN   = _num(Math.asin)
const ACO   = _num(Math.acos)
const ATN   = _num(Math.atan)
const SINH  = _num(Math.sinh)
const COSH  = _num(Math.cosh)
const TANH  = _num(Math.tanh)
const EXP   = _num(Math.exp)
const LOG   = _num(Math.log)
const MIN   = _num2((a,b) => a > b ? b : a)
const MAX   = _num2((a,b) => a < b ? b : a)

function RND(x) {
    // matches basic.js:1199 — only re-roll when arg !== 0
    if (!(x === 0)) state.rnd = Math.random()
    return state.rnd
}

// ---------------------------------------------------------------------------
// String builtins
// ---------------------------------------------------------------------------

function SPC(n)  { return " ".repeat(n) }
function LEFT(s, n)         { return String(s).substring(0, n) }
function RIGHT(s, n)        { return String(s).substring(String(s).length - n) }
function MID(s, start, len) { return String(s).substring(start - state.indexBase, start - state.indexBase + len) }
function CHR(n)  { return String.fromCharCode(n) }

// ---------------------------------------------------------------------------
// List builtins
// ---------------------------------------------------------------------------

function LEN(x)  { if (x === undefined || x.length === undefined) throw Error("Type mismatch"); return x.length }
function HEAD(x) { if (!x || x.length < 1) throw Error("Type mismatch"); return x[0] }
function TAIL(x) { if (!x || x.length < 1) throw Error("Type mismatch"); return x.slice(1) }
function INIT(x) { if (!x || x.length < 1) throw Error("Type mismatch"); return x.slice(0, x.length - 1) }
function LAST(x) { if (!x || x.length < 1) throw Error("Type mismatch"); return x[x.length - 1] }

function MAP(fn, functor) {
    if (typeof fn !== "function" && !(isMonad(fn) && fn.mType === "funseq")) throw Error("MAP: not a function")
    if (isGenerator(functor)) functor = genToArray(functor)
    if (!Array.isArray(functor)) throw Error("MAP: not iterable")
    return functor.map(it => __runFn(fn, [it]))
}
function FOLD(fn, init, functor) {
    if (typeof fn !== "function" && !(isMonad(fn) && fn.mType === "funseq")) throw Error("FOLD: not a function")
    if (isGenerator(functor)) functor = genToArray(functor)
    if (!Array.isArray(functor)) throw Error("FOLD: not iterable")
    let akku = init
    for (let i = 0; i < functor.length; i++) akku = __runFn(fn, [akku, functor[i]])
    return akku
}
function FILTER(fn, functor) {
    if (typeof fn !== "function" && !(isMonad(fn) && fn.mType === "funseq")) throw Error("FILTER: not a function")
    if (isGenerator(functor)) functor = genToArray(functor)
    if (!Array.isArray(functor)) throw Error("FILTER: not iterable")
    return functor.filter(it => __runFn(fn, [it]))
}

// Array literal constructor — emitted by the compiler for `[a,b,c]` syntax
function ARRAY() { return Array.prototype.slice.call(arguments) }

// ---------------------------------------------------------------------------
// Graphics / system
// ---------------------------------------------------------------------------

function CLS()   { con.clear() }
function CLPX()  { graphics.clearPixels(255) }
function PLOT(x, y, c) { graphics.plotPixel(x, y, c) }
function GOTOYX(y, x)  { con.move(y + (1 - state.indexBase), x + (1 - state.indexBase)) }
function TEXTFORE(c)   { print(String.fromCharCode(27, 91) + "38;5;" + (c | 0) + "m") }
function TEXTBACK(c)   { print(String.fromCharCode(27, 91) + "48;5;" + (c | 0) + "m") }
function POKE(addr, v) { sys.poke(addr, v) }
function PEEK(addr)    { return sys.peek(addr) }
function GETKEYSDOWN() {
    const keys = []
    sys.poke(-40, 255)
    for (let k = -41; k >= -48; k--) keys.push(sys.peek(k))
    return keys
}

function CPUT(devnum, msg) { com.sendMessage(devnum, msg); return com.getStatusCode(devnum) }
function CGET(devnum, ptr) {
    const msg = com.pullMessage(devnum)
    const len = msg.length | 0
    for (let i = 0; i < len; i++) sys.poke(ptr + i, msg.charCodeAt(i))
    return len
}
function CSTA(devnum) { return com.getStatusCode(devnum) }

// ---------------------------------------------------------------------------
// Type / debug
// ---------------------------------------------------------------------------

function TYPEOF(v) {
    if (v === undefined) return "null"
    if (typeof v === "boolean") return "bool"
    if (Array.isArray(v)) return "array"
    if (isGenerator(v)) return "generator"
    if (isMonad(v)) return v.mType + "-monad"
    if (typeof v === "function") return "usrdefun"
    if (isNumable(v)) return "num"
    if (typeof v === "string") return "string"
    return typeof v
}

function OPTIONBASE(n) {
    if (n != 0 && n != 1) throw Error("Syntax error: OPTIONBASE")
    state.indexBase = n | 0
}
function OPTIONDEBUG(n) { state.debug = (n | 0) === 1 }
function OPTIONTRACE(n) { state.trace = (n | 0) === 1 }

// ---------------------------------------------------------------------------
// Monad / functional ops (best-effort port)
// ---------------------------------------------------------------------------

function MRET(v)  { return new BasicMemoMonad(v) }
function MLIST(v) { return new BasicListMonad(v) }
function MJOIN(m) { if (!isMonad(m)) throw Error("Type mismatch"); return m.mVal }

function _BIND(ma, fn) {     // >>=
    if (!isMonad(ma)) throw Error(">>=: left is not a monad")
    if (typeof fn !== "function") throw Error(">>=: right is not a function")
    const mb = __runFn(fn, [ma.mVal])
    if (!isMonad(mb)) throw Error(">>=: function did not return a monad")
    return mb
}
function _SEQ(ma, mb) {      // >>~
    if (!isMonad(ma) || !isMonad(mb)) throw Error("Type mismatch")
    return mb
}
function _COMPOSE(fa, fb) {  // .
    const ma = (typeof fa === "function") ? [fa] : fa.mVal
    const mb = (typeof fb === "function") ? [fb] : fb.mVal
    return new BasicFunSeq(mb.concat(ma))
}
function _APPLY(fn, value) {  // $
    return __runFn(fn, [value])
}
function _PIPE(value, fn) {   // &
    return _APPLY(fn, value)
}
function _CURRY(fn, value) {  // ~<
    if (typeof fn !== "function") throw Error("~<: left is not a function")
    return function() {
        const rest = Array.prototype.slice.call(arguments)
        return fn.apply(null, [value].concat(rest))
    }
}
function _SEQAPP(fns, functor) {  // <*>
    if (!Array.isArray(fns)) throw Error("<*>: first arg must be an array of functions")
    if (isGenerator(functor)) functor = genToArray(functor)
    if (!Array.isArray(functor)) throw Error("<*>: not iterable")
    let ret = []
    for (let i = 0; i < fns.length; i++) ret = ret.concat(functor.map(it => __runFn(fns[i], [it])))
    return ret
}
function _SEQCURRYMAP(fns, functor) {  // <~>
    if (typeof fns === "function") fns = [fns]
    if (!Array.isArray(fns)) throw Error("<~>: first arg must be a function or array of functions")
    if (isGenerator(functor)) functor = genToArray(functor)
    if (!Array.isArray(functor)) throw Error("<~>: not iterable")
    let ret = []
    for (let i = 0; i < fns.length; i++) ret = ret.concat(functor.map(it => _CURRY(fns[i], it)))
    return ret
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

exports = {
    // state & introspection
    __state: state, __reset, __data, __labels, __setLines,
    __PRINT_NONL,

    // operator helpers
    __add, __div, __intdiv, __mod, __pow, __test,
    __dim, __arrGet, __arrSet,
    __forSetup, __forNext, __readData, __resolveTarget,
    __runFn,

    // type ctors
    __ForGen: ForGen, __isGenerator: isGenerator, __genToArray: genToArray,
    __isMonad: isMonad,

    // operators
    AND: _AND, OR: _OR, NOT: _NOT,
    UNARYLOGICNOT: _NOT,
    UNARYBNOT: (a) => ~a,
    UNARYMINUS: (a) => -a,
    UNARYPLUS: (a) => +a,
    BAND: (a,b)=>a&b, BOR: (a,b)=>a|b, BXOR: (a,b)=>a^b,
    "<<": (a,b)=>a<<b, ">>": (a,b)=>a>>>b,
    "!": _CONS, "~": _PUSH, "#": _CONCAT,
    TO: _TO, STEP: _STEP,

    // i/o
    PRINT, EMIT, INPUT, CIN,

    // numeric
    ABS, SGN, INT, FLOOR, CEIL, FIX, ROUND, SQR, CBR,
    SIN, COS, TAN, ASN, ACO, ATN, SINH, COSH, TANH,
    EXP, LOG, MIN, MAX, RND,

    // strings
    SPC, LEFT, RIGHT, MID, CHR,

    // lists
    LEN, HEAD, TAIL, INIT, LAST, MAP, FOLD, FILTER,
    ARRAY,

    // graphics / system
    CLS, CLPX, PLOT, GOTOYX, TEXTFORE, TEXTBACK,
    POKE, PEEK, GETKEYSDOWN, CPUT, CGET, CSTA,

    // type / option
    TYPEOF, OPTIONBASE, OPTIONDEBUG, OPTIONTRACE,

    // monads / functional
    MRET, MLIST, MJOIN,
    ">>=": _BIND, ">>~": _SEQ,
    ".":   _COMPOSE, "$": _APPLY, "&": _PIPE, "~<": _CURRY,
    "<*>": _SEQAPP, "<$>": MAP, "<~>": _SEQCURRYMAP,

    // misc
    DO: function() { return arguments[arguments.length - 1] },
    CLEAR: function() { state.vars = _initialConsts() },
    END: function() { /* compiler emits pc=[Infinity,0] */ },
    LABEL: function() { /* harvested at compile time */ },
    DATA:  function() { /* harvested at compile time */ },
    // DIM as an expression (e.g. `WS = DIM(H, V)`): allocate and return a
    // freshly zero-filled N-D array. The statement form `DIM A(H, V)` is
    // compiled inline and never reaches this entry.
    DIM: function() { return __dim(Array.prototype.slice.call(arguments)) },
}
