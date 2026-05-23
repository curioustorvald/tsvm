# fSh Interactive Widgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `com.fsh.todo_list` and `com.fsh.quick_access` widgets in `assets/disk0/home/fsh.js` fully interactive — mouse + keyboard navigation, a modal add/edit/delete popup, item launching for Quick Access, and state persistence to `assets/disk0/home/config/fshrc`.

**Architecture:** All UI work lives in `assets/disk0/home/fsh.js`. One small engine change in `tsvm_core/src/net/torvald/tsvm/peripheral/IOSpace.kt` widens MMIO[36] from a single boolean to a two-bit field so JS can distinguish left and right clicks. See `docs/superpowers/specs/2026-05-24-fsh-interactive-widgets-design.md` for the full design.

**Tech Stack:** JavaScript (GraalVM, ES5-ish dialect used by TSVM), Kotlin (libGDX). The TSVM cannot be machine-invoked, so verification is `node --check` for JS syntax and manual review for runtime behaviour. The spec explicitly waived automated tests for this iteration — final verification is a manual smoke test in the running emulator.

---

## File Structure

| File                                                            | Action  | Responsibility                                                                |
|-----------------------------------------------------------------|---------|-------------------------------------------------------------------------------|
| `tsvm_core/src/net/torvald/tsvm/peripheral/IOSpace.kt`          | Modify  | Replace `mouseDown: Boolean` with `mouseButtons: Int` (bit 0 = L, bit 1 = R)  |
| `assets/disk0/home/fsh.js`                                      | Modify  | All widget interaction, focus, dialog, dispatcher, config I/O                 |
| `assets/disk0/home/config/fshrc`                                | (lazy)  | Persistent state — created by fsh on first save; do **not** commit it        |

The whole feature stays in one JS file because the existing `fsh.js` is organised around widget object literals inside one script. Splitting now would force a new module-loading pattern that doesn't exist in this codebase.

---

## Verification approach

After each task that edits JS, run:

```bash
node --check assets/disk0/home/fsh.js
```

Expected: no output, exit code 0. Any output means a syntax error — fix and re-check before committing.

The Kotlin change cannot be checked from the CLI (no Gradle wrapper). The diff is small enough to verify by inspection; the user will rebuild via IntelliJ when they smoke-test.

---

## Task 1: Engine change — expose right-click bit in MMIO

**Files:**
- Modify: `tsvm_core/src/net/torvald/tsvm/peripheral/IOSpace.kt`

- [ ] **Step 1: Read the current state of the three touch points**

Run:
```bash
sed -n '99,105p;281,285p;298,318p' tsvm_core/src/net/torvald/tsvm/peripheral/IOSpace.kt
```

Expected lines (line numbers may shift slightly): the read at `36L`, the field declaration `private var mouseDown = false`, the assignment `mouseDown = Gdx.input.isTouched`, and the clear `mouseDown = false`.

- [ ] **Step 2: Replace the field declaration**

Locate (around line 283):

```kotlin
    private var mouseDown = false
```

Replace with:

```kotlin
    private var mouseButtons: Int = 0  // bit 0 = LEFT, bit 1 = RIGHT
```

- [ ] **Step 3: Update the MMIO read**

Locate (around line 101):

```kotlin
            36L -> mouseDown.toInt().toByte()
```

Replace with:

```kotlin
            36L -> mouseButtons.toByte()
```

- [ ] **Step 4: Update the assignment inside the `isFocused` branch**

Locate (around line 302):

```kotlin
                mouseDown = Gdx.input.isTouched
```

Replace with:

```kotlin
                mouseButtons = (if (Gdx.input.isButtonPressed(Input.Buttons.LEFT))  1 else 0) or
                               (if (Gdx.input.isButtonPressed(Input.Buttons.RIGHT)) 2 else 0)
```

(The file already imports `com.badlogic.gdx.Input`, so `Input.Buttons.LEFT/RIGHT` resolve.)

- [ ] **Step 5: Update the clear in the `else` branch**

Locate (around line 316):

```kotlin
                mouseDown = false
```

Replace with:

```kotlin
                mouseButtons = 0
```

- [ ] **Step 6: Verify no other references remain**

Run:
```bash
grep -n "mouseDown" tsvm_core/src/net/torvald/tsvm/peripheral/IOSpace.kt
```

Expected: no output. If anything remains, it's a missed reference — update it to `mouseButtons` with the appropriate bit test.

- [ ] **Step 7: Commit**

```bash
git add tsvm_core/src/net/torvald/tsvm/peripheral/IOSpace.kt
git commit -m "$(cat <<'EOF'
IOSpace: expose right-click as MMIO[36] bit 1

MMIO[36] becomes a two-bit field (bit 0 = left, bit 1 = right) so JS
programs can distinguish mouse buttons. Existing callers that read this
byte as a truthy/falsy "is pressed" still work because left-click sets
bit 0.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Constants block at top of fsh.js

**Files:**
- Modify: `assets/disk0/home/fsh.js`

- [ ] **Step 1: Add constants after the existing `_fsh` initialisation**

Locate the line `let _fsh = {};` (around line 13). Immediately after it, before `_fsh.titlebarTex = ...`, insert:

```javascript
// Config file path
_fsh.CONFIG_PATH = "A:/home/config/fshrc";

// Widget row caps (must match the loop bounds in draw())
_fsh.TODO_MAX_ROWS = 13;       // todoWidget draws i = 0..12
_fsh.QA_MAX_ROWS = 22;         // quickAccessWidget draws i = 0..21
_fsh.TODO_TEXT_WIDTH = 24;     // visible characters per todo row
_fsh.QA_LABEL_WIDTH = 24;      // visible characters per QA label
_fsh.QA_CMD_WIDTH = 60;        // command path field width in dialog

// Highlight colour pair (used for hover / keyboard focus)
_fsh.HL_FG = 255;
_fsh.HL_BG = 17;

// Default Quick Access entries when fshrc is missing or empty
_fsh.DEFAULT_QA = [
    ["Files",     "/tvdos/bin/zsh.js"],
    ["Editor",    "/tvdos/bin/edit.js"],
    ["BASIC",     "/tbas/basic.js"],
    ["DOS Shell", "/tvdos/bin/command.js /fancy"]
];

// Mouse button bits (MMIO[36] layout per IOSpace.kt)
_fsh.MB_LEFT = 1;
_fsh.MB_RIGHT = 2;
```

- [ ] **Step 2: Syntax check**

Run:
```bash
node --check assets/disk0/home/fsh.js
```

Expected: exit code 0, no output.

- [ ] **Step 3: Commit**

```bash
git add assets/disk0/home/fsh.js
git commit -m "$(cat <<'EOF'
fsh: introduce constants for widget bounds, colours, defaults

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Config parser and serializer

**Files:**
- Modify: `assets/disk0/home/fsh.js`

This task adds two pure functions that operate only on strings. They can be reviewed by reading the code; no live VM needed.

- [ ] **Step 1: Add the parser**

After the constants block from Task 2 and before `_fsh.titlebarTex`, insert:

```javascript
// Parse fshrc text into {todos: [[text, done], ...], qa: [[label, cmd], ...]}.
// Returns null for both arrays when input is empty/whitespace.
_fsh.parseConfig = function(text) {
    let todos = [];
    let qa = [];
    let section = null;
    if (!text) return {todos: todos, qa: qa};
    let lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        // strip trailing \r if any
        if (line.length && line.charCodeAt(line.length - 1) === 13) {
            line = line.substring(0, line.length - 1);
        }
        if (line.length === 0) continue;
        if (line.charAt(0) === "[") {
            let close = line.indexOf("]");
            if (close > 0) {
                let name = line.substring(1, close).trim().toUpperCase();
                if (name === "TODO" || name === "QUICK_ACCESS") section = name;
                else section = null;  // unknown section: ignore until next header
            }
            continue;
        }
        if (section === "TODO") {
            if (line.length < 2) continue;
            let marker = line.charAt(0);
            if ((marker === "+" || marker === "-") && line.charAt(1) === " ") {
                todos.push([line.substring(2), marker === "+"]);
            }
        } else if (section === "QUICK_ACCESS") {
            let comma = line.indexOf(",");
            if (comma <= 0) continue;     // need a non-empty label
            let label = line.substring(0, comma);
            let cmd = line.substring(comma + 1);
            qa.push([label, cmd]);
        }
    }
    return {todos: todos, qa: qa};
};
```

- [ ] **Step 2: Add the serializer**

Immediately after `_fsh.parseConfig`:

```javascript
// Build fshrc text from in-memory model. Inverse of parseConfig.
_fsh.serializeConfig = function(todos, qa) {
    let out = "[TODO]\n";
    for (let i = 0; i < todos.length; i++) {
        let t = todos[i];
        out += (t[1] ? "+ " : "- ") + t[0] + "\n";
    }
    out += "\n[QUICK_ACCESS]\n";
    for (let i = 0; i < qa.length; i++) {
        out += qa[i][0] + "," + qa[i][1] + "\n";
    }
    return out;
};
```

- [ ] **Step 3: Add the load function**

Immediately after `_fsh.serializeConfig`:

```javascript
// Read fshrc; populate todoWidget.todoList and quickAccessWidget.entries.
// Falls back to defaults on missing/empty/malformed file.
_fsh.loadConfig = function() {
    let f = files.open(_fsh.CONFIG_PATH);
    let parsed = {todos: [], qa: []};
    if (f.exists) {
        try {
            parsed = _fsh.parseConfig(f.sread());
        } catch (e) {
            serial.printerr("fsh.loadConfig: parse failed: " + e);
            parsed = {todos: [], qa: []};
        }
    }
    todoWidget.todoList = parsed.todos;
    quickAccessWidget.entries = (parsed.qa.length > 0)
        ? parsed.qa
        : _fsh.DEFAULT_QA.slice();   // copy so saves don't mutate the constant
};
```

- [ ] **Step 4: Add the save function**

Immediately after `_fsh.loadConfig`:

```javascript
// Persist the current in-memory todos + QA entries to fshrc.
_fsh.saveConfig = function() {
    try {
        let f = files.open(_fsh.CONFIG_PATH);
        if (!f.exists) f.mkFile();
        f.swrite(_fsh.serializeConfig(todoWidget.todoList, quickAccessWidget.entries));
    } catch (e) {
        serial.printerr("fsh.saveConfig: write failed: " + e);
    }
};
```

- [ ] **Step 5: Syntax check**

Run:
```bash
node --check assets/disk0/home/fsh.js
```

Expected: exit code 0.

- [ ] **Step 6: Sanity test the parser/serializer round-trip with Node**

This catches logic mistakes without needing TSVM. Run:

```bash
node -e '
const fs = require("fs");
const src = fs.readFileSync("assets/disk0/home/fsh.js", "utf8");
// Extract just the parseConfig + serializeConfig bodies by eval-ing the whole file
// is not feasible because of TSVM-specific globals. So copy the two functions inline:
function parseConfig(text) {
    let todos = []; let qa = []; let section = null;
    if (!text) return {todos, qa};
    let lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (line.length && line.charCodeAt(line.length - 1) === 13)
            line = line.substring(0, line.length - 1);
        if (line.length === 0) continue;
        if (line.charAt(0) === "[") {
            let close = line.indexOf("]");
            if (close > 0) {
                let name = line.substring(1, close).trim().toUpperCase();
                if (name === "TODO" || name === "QUICK_ACCESS") section = name;
                else section = null;
            }
            continue;
        }
        if (section === "TODO") {
            if (line.length < 2) continue;
            let m = line.charAt(0);
            if ((m === "+" || m === "-") && line.charAt(1) === " ")
                todos.push([line.substring(2), m === "+"]);
        } else if (section === "QUICK_ACCESS") {
            let c = line.indexOf(",");
            if (c <= 0) continue;
            qa.push([line.substring(0, c), line.substring(c + 1)]);
        }
    }
    return {todos, qa};
}
function serializeConfig(todos, qa) {
    let out = "[TODO]\n";
    for (let i = 0; i < todos.length; i++)
        out += (todos[i][1] ? "+ " : "- ") + todos[i][0] + "\n";
    out += "\n[QUICK_ACCESS]\n";
    for (let i = 0; i < qa.length; i++) out += qa[i][0] + "," + qa[i][1] + "\n";
    return out;
}
const sample = "[TODO]\n+ Buy groceries\n- Read CLAUDE.md\n\n[QUICK_ACCESS]\nFiles,/tvdos/bin/zsh.js\nEditor,/tvdos/bin/edit.js\n";
const parsed = parseConfig(sample);
console.log("parsed:", JSON.stringify(parsed));
const re = serializeConfig(parsed.todos, parsed.qa);
console.log("re-serialized:", JSON.stringify(re));
const reparsed = parseConfig(re);
console.log("round-trip equal:", JSON.stringify(parsed) === JSON.stringify(reparsed));
// commas-in-cmd test
const cmdWithComma = parseConfig("[QUICK_ACCESS]\nThing,/bin/x,--flag\n");
console.log("cmd-with-comma:", JSON.stringify(cmdWithComma.qa));
// malformed test
const malformed = parseConfig("garbage\n[UNKNOWN]\nfoo\n[TODO]\n+ ok\n");
console.log("malformed-ok:", JSON.stringify(malformed.todos));
'
```

Expected output:
```
parsed: {"todos":[["Buy groceries",true],["Read CLAUDE.md",false]],"qa":[["Files","/tvdos/bin/zsh.js"],["Editor","/tvdos/bin/edit.js"]]}
re-serialized: "[TODO]\n+ Buy groceries\n- Read CLAUDE.md\n\n[QUICK_ACCESS]\nFiles,/tvdos/bin/zsh.js\nEditor,/tvdos/bin/edit.js\n"
round-trip equal: true
cmd-with-comma: [["Thing","/bin/x,--flag"]]
malformed-ok: [["ok",true]]
```

If `round-trip equal` is not `true`, or `cmd-with-comma` doesn't preserve the trailing flag, the parser logic is wrong — fix and re-run.

- [ ] **Step 7: Commit**

```bash
git add assets/disk0/home/fsh.js
git commit -m "$(cat <<'EOF'
fsh: add fshrc parser, serializer, load, and save

Pure-data round-trip verified via Node.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Hit-test helpers on widgets

**Files:**
- Modify: `assets/disk0/home/fsh.js`

The current `todoWidget.draw` and `quickAccessWidget.draw` use `charXoff` / `charYoff` passed by the main loop. The known positions from the existing loop are:

```javascript
_fsh.widgets["com.fsh.todo_list"].draw(10, 17);
_fsh.widgets["com.fsh.quick_access"].draw(47, 8);
```

We need hit-test functions that take the **mouse char coords** and the widget's draw offsets, and return `null`, `{kind: "add"}`, or `{kind: "item", index}`.

Looking at the draw loops (already in the file): each row `i` in `0..max-1` is rendered at `con.move(charYoff + i + 2, charXoff)` (icon col) and `con.move(charYoff + i + 2, charXoff + 2)` (text col). Rows with `i < list.length` show an entry; row `i === list.length` shows "Click to add"; rows `i > list.length` show underscores. Text spans 24 chars (`charXoff + 2 .. charXoff + 25`).

- [ ] **Step 1: Add a generic hit-test helper**

After `_fsh.saveConfig`, before `_fsh.Widget`:

```javascript
// Map (mouse char x, mouse char y) to a row index for a widget drawn at
// (xoff, yoff) with `length` existing entries and `maxRows` total rows.
// Returns null / {kind:"add"} / {kind:"item", index: i}.
_fsh.hitTestList = function(charX, charY, xoff, yoff, textWidth, length, maxRows) {
    // Each row sits at (yoff + i + 2, xoff..xoff + textWidth + 1).
    // Column range: icon at xoff, text at xoff+2 .. xoff+1+textWidth.
    // Allow clicks anywhere on the row's char cells (icon + text region).
    let relY = charY - yoff - 2;
    if (relY < 0 || relY >= maxRows) return null;
    if (charX < xoff || charX > xoff + 1 + textWidth) return null;
    if (relY < length) return {kind: "item", index: relY};
    if (relY === length) return {kind: "add"};
    return null;
};
```

- [ ] **Step 2: Attach widget-specific hit-test**

Right after the `quickAccessWidget.draw = function(...) { ... }` block (last line is `}` near the bottom of the file before `// change graphics mode`), add:

```javascript
todoWidget.hitTest = function(charX, charY, xoff, yoff) {
    return _fsh.hitTestList(charX, charY, xoff, yoff,
        _fsh.TODO_TEXT_WIDTH, todoWidget.todoList.length, _fsh.TODO_MAX_ROWS);
};

quickAccessWidget.hitTest = function(charX, charY, xoff, yoff) {
    return _fsh.hitTestList(charX, charY, xoff, yoff,
        _fsh.QA_LABEL_WIDTH, quickAccessWidget.entries.length, _fsh.QA_MAX_ROWS);
};
```

- [ ] **Step 3: Syntax check**

```bash
node --check assets/disk0/home/fsh.js
```

Expected: exit code 0.

- [ ] **Step 4: Sanity-test the hit-test math in Node**

```bash
node -e '
function hitTestList(charX, charY, xoff, yoff, textWidth, length, maxRows) {
    let relY = charY - yoff - 2;
    if (relY < 0 || relY >= maxRows) return null;
    if (charX < xoff || charX > xoff + 1 + textWidth) return null;
    if (relY < length) return {kind: "item", index: relY};
    if (relY === length) return {kind: "add"};
    return null;
}
// Todo widget at xoff=10, yoff=17, 3 entries
const T = (x,y) => hitTestList(x,y,10,17,24,3,13);
console.log("above:",        T(15,18));  // null (relY=-1)
console.log("first item:",   T(15,19));  // {kind:"item",index:0}
console.log("third item:",   T(15,21));  // {kind:"item",index:2}
console.log("add row:",      T(15,22));  // {kind:"add"}
console.log("filler row:",   T(15,23));  // null
console.log("right of text:",T(40,19));  // null (xoff+1+textWidth = 35)
console.log("on icon col:",  T(10,19));  // {kind:"item",index:0}
'
```

Expected output:
```
above: null
first item: { kind: 'item', index: 0 }
third item: { kind: 'item', index: 2 }
add row: { kind: 'add' }
filler row: null
right of text: null
on icon col: { kind: 'item', index: 0 }
```

- [ ] **Step 5: Commit**

```bash
git add assets/disk0/home/fsh.js
git commit -m "$(cat <<'EOF'
fsh: add hit-test helpers for todo and quick-access widgets

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Focus state model and highlight in draw()

**Files:**
- Modify: `assets/disk0/home/fsh.js`

- [ ] **Step 1: Initialise focus state**

After the constants block in Task 2, append:

```javascript
// Current focus: null or {widgetId: string, index: number}.
// Index uses the same convention as hitTest: 0..length-1 are entries,
// `length` is the "+ Click to add" row.
_fsh.focus = null;
```

- [ ] **Step 2: Update `todoWidget.draw` to accept a focus argument**

Replace the entire `todoWidget.draw = function(charXoff, charYoff) { ... }` body with:

```javascript
todoWidget.draw = function(charXoff, charYoff) {
    let focusIndex = (_fsh.focus && _fsh.focus.widgetId === todoWidget.identifier)
        ? _fsh.focus.index : -1;

    con.color_pair(254, 255)
    let xoff = charXoff * 7
    let yoff = charYoff * 14 + 3

    con.move(charYoff, charXoff)
    print('Í'.repeat(10)+" TODO "+'Í'.repeat(10))

    for (let i = 0; i <= 12; i++) {
        let list = todoWidget.todoList[i] || ["Click to add", null]
        let isFocused = (i === focusIndex);

        if (isFocused) con.color_pair(_fsh.HL_FG, _fsh.HL_BG)
        else if (list[1] === null) con.color_pair(249, 255)
        else con.color_pair(254, 255)

        con.move(charYoff + i + 2, charXoff)
        con.addch((list[1] === null) ? 43 : (list[1]) ? 0x9F : 0x9E)

        if (i > todoWidget.todoList.length) {
            // Filler row — keep underscores but don't highlight (can't focus here)
            con.color_pair(254, 255)
            for (let k = 0; k < 24; k++) {
                con.mvaddch(charYoff + i + 2, charXoff + 2 + k, 95)
            }
        }
        else {
            con.move(charYoff + i + 2, charXoff + 2)
            // Pad text to TODO_TEXT_WIDTH so the highlight bar covers full row
            let text = `${list[0]}`;
            if (text.length > _fsh.TODO_TEXT_WIDTH) text = text.substring(0, _fsh.TODO_TEXT_WIDTH);
            if (isFocused) text = text + " ".repeat(_fsh.TODO_TEXT_WIDTH - text.length);
            print(text)
        }
    }
}
```

- [ ] **Step 3: Update `quickAccessWidget.draw` the same way**

Replace its body with:

```javascript
quickAccessWidget.draw = function(charXoff, charYoff) {
    let focusIndex = (_fsh.focus && _fsh.focus.widgetId === quickAccessWidget.identifier)
        ? _fsh.focus.index : -1;

    con.color_pair(254, 255)
    let xoff = charXoff * 7
    let yoff = charYoff * 14 + 3

    con.move(charYoff, charXoff)
    print('Í'.repeat(6)+" QUICK ACCESS "+'Í'.repeat(6))

    for (let i = 0; i <= 21; i++) {
        let list = quickAccessWidget.entries[i] || ["Click to add", null]
        let isFocused = (i === focusIndex);

        if (isFocused) con.color_pair(_fsh.HL_FG, _fsh.HL_BG)
        else if (list[1] === null) con.color_pair(249, 255)
        else con.color_pair(254, 255)

        con.move(charYoff + i + 2, charXoff)
        con.addch((list[1] === null) ? 0xF9 : (list[1]) ? 7 : 0x7F)

        if (i > quickAccessWidget.entries.length) {
            con.color_pair(254, 255)
            for (let k = 0; k < 24; k++) {
                con.mvaddch(charYoff + i + 2, charXoff + 2 + k, 95)
            }
        }
        else {
            con.move(charYoff + i + 2, charXoff + 2)
            let text = `${list[0]}`;
            if (text.length > _fsh.QA_LABEL_WIDTH) text = text.substring(0, _fsh.QA_LABEL_WIDTH);
            if (isFocused) text = text + " ".repeat(_fsh.QA_LABEL_WIDTH - text.length);
            print(text)
        }
    }
}
```

- [ ] **Step 4: Syntax check**

```bash
node --check assets/disk0/home/fsh.js
```

Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add assets/disk0/home/fsh.js
git commit -m "$(cat <<'EOF'
fsh: render row highlight when focused

Each interactive widget now consults _fsh.focus and inverts the matching
row's colour pair so hover and keyboard navigation share one visual.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Modal dialog primitive

**Files:**
- Modify: `assets/disk0/home/fsh.js`

The dialog is the biggest single piece. It draws a centred box, edits one or more text fields, and returns a tagged result. It blocks the main loop while open by running its own `con.getch()` loop (matching the pattern in `command.js`).

- [ ] **Step 1: Add dialog drawing helpers**

After `_fsh.saveConfig`, insert:

```javascript
// Draw a double-line bordered box. (row, col) is the top-left, (h, w) the size.
_fsh.drawDialogFrame = function(row, col, h, w, title) {
    con.color_pair(254, 255);
    // Top
    con.move(row, col);
    con.addch(0xC9);                                  // ╔
    for (let i = 0; i < w - 2; i++) con.addch(0xCD);  // ═
    con.addch(0xBB);                                  // ╗
    // Sides + interior fill
    for (let y = 1; y < h - 1; y++) {
        con.move(row + y, col);
        con.addch(0xBA);                              // ║
        for (let i = 0; i < w - 2; i++) con.addch(32);
        con.addch(0xBA);                              // ║
    }
    // Bottom
    con.move(row + h - 1, col);
    con.addch(0xC8);                                  // ╚
    for (let i = 0; i < w - 2; i++) con.addch(0xCD);  // ═
    con.addch(0xBC);                                  // ╝
    // Title centred on top border
    if (title) {
        let t = " " + title + " ";
        let tcol = col + Math.floor((w - t.length) / 2);
        con.move(row, tcol);
        print(t);
    }
};

// Draw a single-line bordered input field at (row, col) with given width.
// content is the current text; cursorPos the caret position; focused styles
// the frame with a brighter colour.
_fsh.drawDialogField = function(row, col, width, content, focused) {
    con.color_pair(focused ? 254 : 249, 255);
    con.move(row, col);
    con.addch(0xDA);                                  // ┌
    for (let i = 0; i < width; i++) con.addch(0xC4);  // ─
    con.addch(0xBF);                                  // ┐
    con.move(row + 1, col);
    con.addch(0xB3);                                  // │
    con.color_pair(254, 255);
    let visible = content.length > width ? content.substring(content.length - width) : content;
    print(visible + " ".repeat(width - visible.length));
    con.color_pair(focused ? 254 : 249, 255);
    con.addch(0xB3);
    con.move(row + 2, col);
    con.addch(0xC0);                                  // └
    for (let i = 0; i < width; i++) con.addch(0xC4);
    con.addch(0xD9);                                  // ┘
    con.color_pair(254, 255);
};

// Draw a button as "[ Label ]" at the given position; highlights when focused.
_fsh.drawDialogButton = function(row, col, label, focused) {
    if (focused) con.color_pair(_fsh.HL_FG, _fsh.HL_BG);
    else con.color_pair(254, 255);
    con.move(row, col);
    print("[ " + label + " ]");
    con.color_pair(254, 255);
};
```

- [ ] **Step 2: Add the dialog driver**

Immediately after the helpers:

```javascript
// Modal dialog. opts = {
//   title: string,
//   fields: [{label, initial, width}, ...],
//   allowDelete: bool,
// }
// Returns {action: "ok"|"cancel"|"delete", values: [string, ...]}.
_fsh.showDialog = function(opts) {
    let fields = opts.fields;
    let values = fields.map(function(f) { return f.initial || ""; });

    // Layout
    let maxFieldW = fields.reduce(function(m, f) { return Math.max(m, f.width); }, 16);
    let titleW = (opts.title ? opts.title.length : 0) + 4;
    let w = Math.max(maxFieldW + 6, titleW + 4, 24);
    let buttonsRow = 2 + fields.length * 4 + 1;  // 1 label + 3 field rows per field
    let h = buttonsRow + 2;
    let screen = con.getmaxyx();
    let row = Math.max(2, Math.floor((screen[0] - h) / 2));
    let col = Math.max(2, Math.floor((screen[1] - w) / 2));

    // Buttons list: indices follow Tab order after the last field
    let buttons = [{label: "OK", action: "ok"}, {label: "Cancel", action: "cancel"}];
    if (opts.allowDelete) buttons.splice(1, 0, {label: "Delete", action: "delete"});

    let focusIdx = 0;            // 0..fields.length-1 = field; then buttons
    let totalFocus = fields.length + buttons.length;
    let done = null;             // {action, values} when set

    // Hide the main wallpaper region we cover; we'll redraw fully after close.

    function render() {
        _fsh.drawDialogFrame(row, col, h, w, opts.title);
        // Fields
        for (let i = 0; i < fields.length; i++) {
            let labelRow = row + 1 + i * 4;
            let fieldRow = labelRow + 1;
            con.color_pair(254, 255);
            con.move(labelRow, col + 2);
            print(fields[i].label + ":");
            _fsh.drawDialogField(fieldRow, col + 2, fields[i].width, values[i], i === focusIdx);
        }
        // Buttons centred on buttonsRow
        let totalBtnW = buttons.reduce(function(s, b) { return s + b.label.length + 5; }, 0) - 1;
        let bx = col + Math.floor((w - totalBtnW) / 2);
        for (let i = 0; i < buttons.length; i++) {
            let bIdx = fields.length + i;
            _fsh.drawDialogButton(row + buttonsRow, bx, buttons[i].label, bIdx === focusIdx);
            bx += buttons[i].label.length + 5;
        }
    }

    render();

    // Note: con.getch() returns TSVM scancodes (defined in JS_INIT.js as
    // con.KEY_UP=200, KEY_DOWN=208, KEY_LEFT=203, KEY_RIGHT=205,
    // KEY_BACKSPACE=8, KEY_TAB=9, KEY_RETURN=10). Esc isn't in JS_INIT's
    // map — it arrives as ASCII 27 via keyTyped().
    while (done === null) {
        let k = con.getch();

        if (k === 27) {  // Esc
            done = {action: "cancel", values: values};
            break;
        }
        if (k === con.KEY_TAB) {
            focusIdx = (focusIdx + 1) % totalFocus;
            render();
            continue;
        }
        // On a field
        if (focusIdx < fields.length) {
            if (k === con.KEY_RETURN) {
                if (focusIdx < fields.length - 1) {
                    focusIdx += 1;
                } else {
                    focusIdx = fields.length;  // move to OK button
                }
                render();
                continue;
            }
            if (k === con.KEY_BACKSPACE) {
                if (values[focusIdx].length > 0)
                    values[focusIdx] = values[focusIdx].substring(0, values[focusIdx].length - 1);
                render();
                continue;
            }
            // Printable
            if (k >= 32 && k < 256 && values[focusIdx].length < fields[focusIdx].width * 4) {
                values[focusIdx] += String.fromCharCode(k);
                render();
            }
            continue;
        }
        // On a button
        if (k === con.KEY_RETURN || k === 32) {
            done = {action: buttons[focusIdx - fields.length].action, values: values};
            break;
        }
        // Arrow keys cycle buttons too
        if (k === con.KEY_LEFT) {
            focusIdx = (focusIdx - 1 + totalFocus) % totalFocus;
            render();
        } else if (k === con.KEY_RIGHT) {
            focusIdx = (focusIdx + 1) % totalFocus;
            render();
        }
    }

    return done;
};
```

- [ ] **Step 3: Syntax check**

```bash
node --check assets/disk0/home/fsh.js
```

Expected: exit code 0.

- [ ] **Step 4: Logic walkthrough — verify by reading**

Read your inserted `_fsh.showDialog` carefully and confirm:

1. `totalFocus = fields.length + buttons.length` matches the focus index range.
2. The buttons array order is `[OK, (Delete?), Cancel]`.
3. Pressing Enter on the last field jumps to OK (`focusIdx = fields.length`).
4. Esc returns `{action: "cancel"}` without saving.
5. Backspace truncates the current field; no underflow when empty.
6. Printable check `k >= 32 && k < 256` admits TSVM extended chars.

If any of these fails to hold by inspection, fix the code before committing.

- [ ] **Step 5: Commit**

```bash
git add assets/disk0/home/fsh.js
git commit -m "$(cat <<'EOF'
fsh: add modal dialog primitive for add/edit/delete popups

Centred bordered dialog with one or more text fields plus OK/Cancel
(and optional Delete) buttons. Driven by con.getch() so it blocks the
main loop cleanly while open. Returns {action, values}.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Dispatcher — add/edit/delete handlers

**Files:**
- Modify: `assets/disk0/home/fsh.js`

These functions translate hits into mutations on `todoWidget.todoList` and `quickAccessWidget.entries`, save the config, and force a redraw of the whole screen (wallpaper + titlebar + widgets) when a dialog has been on screen.

- [ ] **Step 1: Add a redraw-all helper**

After `quickAccessWidget.hitTest` (added in Task 4), append:

```javascript
// Re-render the whole shell. Use after a dialog closes (which clobbered
// the underlying char cells) or after execApp returns.
_fsh.redrawAll = function() {
    con.color_pair(254, 255);
    con.clear();
    graphics.clearPixels(255);
    graphics.clearPixels2(255);
    graphics.setFramebufferScroll(0, 0);
    _fsh.drawWallpaper();
    _fsh.drawTitlebar();
    _fsh.widgets["com.fsh.clock"].draw(25, 3);
    _fsh.widgets["com.fsh.calendar"].draw(12, 8);
    _fsh.widgets["com.fsh.todo_list"].draw(10, 17);
    _fsh.widgets["com.fsh.quick_access"].draw(47, 8);
};
```

- [ ] **Step 2: Add the dispatcher functions**

Immediately after `_fsh.redrawAll`:

```javascript
_fsh.openAddTodoDialog = function() {
    let res = _fsh.showDialog({
        title: "New Todo",
        fields: [{label: "Text", initial: "", width: _fsh.TODO_TEXT_WIDTH}],
        allowDelete: false
    });
    _fsh.redrawAll();
    if (res.action !== "ok") return;
    let text = res.values[0].trim();
    if (text.length === 0) return;
    if (todoWidget.todoList.length >= _fsh.TODO_MAX_ROWS) return;
    todoWidget.todoList.push([text, false]);
    _fsh.saveConfig();
};

_fsh.openEditTodoDialog = function(index) {
    let entry = todoWidget.todoList[index];
    if (!entry) return;
    let res = _fsh.showDialog({
        title: "Edit Todo",
        fields: [{label: "Text", initial: entry[0], width: _fsh.TODO_TEXT_WIDTH}],
        allowDelete: true
    });
    _fsh.redrawAll();
    if (res.action === "cancel") return;
    if (res.action === "delete") {
        todoWidget.todoList.splice(index, 1);
        _fsh.saveConfig();
        return;
    }
    let text = res.values[0].trim();
    if (text.length === 0) return;
    todoWidget.todoList[index] = [text, entry[1]];
    _fsh.saveConfig();
};

_fsh.openAddQaDialog = function() {
    let res = _fsh.showDialog({
        title: "New Quick Access",
        fields: [
            {label: "Label",   initial: "", width: _fsh.QA_LABEL_WIDTH},
            {label: "Command", initial: "", width: _fsh.QA_CMD_WIDTH}
        ],
        allowDelete: false
    });
    _fsh.redrawAll();
    if (res.action !== "ok") return;
    let label = res.values[0].trim();
    let cmd = res.values[1].trim();
    if (label.length === 0 || cmd.length === 0) return;
    if (quickAccessWidget.entries.length >= _fsh.QA_MAX_ROWS) return;
    quickAccessWidget.entries.push([label, cmd]);
    _fsh.saveConfig();
};

_fsh.openEditQaDialog = function(index) {
    let entry = quickAccessWidget.entries[index];
    if (!entry) return;
    let res = _fsh.showDialog({
        title: "Edit Quick Access",
        fields: [
            {label: "Label",   initial: entry[0], width: _fsh.QA_LABEL_WIDTH},
            {label: "Command", initial: entry[1], width: _fsh.QA_CMD_WIDTH}
        ],
        allowDelete: true
    });
    _fsh.redrawAll();
    if (res.action === "cancel") return;
    if (res.action === "delete") {
        quickAccessWidget.entries.splice(index, 1);
        _fsh.saveConfig();
        return;
    }
    let label = res.values[0].trim();
    let cmd = res.values[1].trim();
    if (label.length === 0 || cmd.length === 0) return;
    quickAccessWidget.entries[index] = [label, cmd];
    _fsh.saveConfig();
};

_fsh.toggleTodoDone = function(index) {
    let entry = todoWidget.todoList[index];
    if (!entry) return;
    entry[1] = !entry[1];
    _fsh.saveConfig();
};
```

- [ ] **Step 3: Add the launcher**

Immediately after `_fsh.toggleTodoDone`:

```javascript
// Launch a Quick Access entry. cmd is the verbatim string the user typed.
// We split on first space to derive a program path + args; if the path
// has no leading "/", we treat it as relative to the current drive.
_fsh.launchEntry = function(label, cmd) {
    let firstSpace = cmd.indexOf(" ");
    let progPath = (firstSpace >= 0) ? cmd.substring(0, firstSpace) : cmd;
    let argTail = (firstSpace >= 0) ? cmd.substring(firstSpace + 1) : "";
    let fullPath = progPath.startsWith("/") ? ("A:" + progPath) : progPath;

    try {
        let f = files.open(fullPath);
        if (!f.exists) {
            serial.printerr("fsh.launchEntry: not found: " + fullPath);
            return;
        }
        let code = f.sread();
        let tokens = [progPath].concat(argTail.length ? argTail.split(" ") : []);
        execApp(code, tokens);
    } catch (e) {
        serial.printerr("fsh.launchEntry: " + label + " failed: " + e);
    }
    _fsh.redrawAll();
};
```

- [ ] **Step 4: Syntax check**

```bash
node --check assets/disk0/home/fsh.js
```

Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add assets/disk0/home/fsh.js
git commit -m "$(cat <<'EOF'
fsh: add dispatcher handlers for add/edit/delete + QA launch

Each handler opens a modal, forces a full screen redraw on close, and
saves the mutated config. launchEntry resolves QA commands against the
A: drive and execApps them, redrawing on return.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Main loop — input polling, dispatch, keyboard nav

**Files:**
- Modify: `assets/disk0/home/fsh.js`

The existing main loop is small:

```javascript
while (true) {
    captureUserInput();
    if (getKeyPushed(0) == 67) break;

    _fsh.widgets["com.fsh.clock"].draw(25, 3);
    _fsh.widgets["com.fsh.calendar"].draw(12, 8);
    _fsh.widgets["com.fsh.todo_list"].draw(10, 17);
    _fsh.widgets["com.fsh.quick_access"].draw(47, 8);

    sys.spin();sys.spin()
}
```

We replace it with one that polls mouse + buttons + keys, edge-detects clicks, manages focus, dispatches actions, and uses Esc to exit.

- [ ] **Step 1: Add a click-dispatch helper**

After `_fsh.launchEntry`, insert:

```javascript
// Layout map: widget positions hard-coded to match the draw calls below.
_fsh.layouts = {
    "com.fsh.todo_list":    {xoff: 10, yoff: 17, widget: null},
    "com.fsh.quick_access": {xoff: 47, yoff: 8,  widget: null}
};

// Find which widget (if any) was hit by (charX, charY). Returns
// {widgetId, hit} or null.
_fsh.findHit = function(charX, charY) {
    let ids = ["com.fsh.todo_list", "com.fsh.quick_access"];
    for (let i = 0; i < ids.length; i++) {
        let id = ids[i];
        let layout = _fsh.layouts[id];
        let widget = _fsh.widgets[id];
        let hit = widget.hitTest(charX, charY, layout.xoff, layout.yoff);
        if (hit) return {widgetId: id, hit: hit};
    }
    return null;
};

_fsh.dispatchLeft = function(widgetId, hit) {
    if (hit.kind === "add") {
        if (widgetId === "com.fsh.todo_list") _fsh.openAddTodoDialog();
        else                                  _fsh.openAddQaDialog();
        return;
    }
    // hit.kind === "item"
    if (widgetId === "com.fsh.todo_list") {
        _fsh.toggleTodoDone(hit.index);
    } else {
        let entry = quickAccessWidget.entries[hit.index];
        if (entry) _fsh.launchEntry(entry[0], entry[1]);
    }
};

_fsh.dispatchRight = function(widgetId, hit) {
    if (hit.kind !== "item") return;
    if (widgetId === "com.fsh.todo_list") _fsh.openEditTodoDialog(hit.index);
    else                                  _fsh.openEditQaDialog(hit.index);
};
```

- [ ] **Step 2: Add mouse + key helpers near the top of the file**

After `getKeyPushed` (around line 9-11), insert:

```javascript
function readMousePos() {
    let lx = sys.peek(-33) & 0xFF;
    let hx = sys.peek(-34) & 0xFF;
    let ly = sys.peek(-35) & 0xFF;
    let hy = sys.peek(-36) & 0xFF;
    return [(hx << 8) | lx, (hy << 8) | ly];
}

function readMouseButtons() {
    return sys.peek(-37) & 0xFF;
}

// Returns true if any of the eight key event buffer slots holds keycode `kc`.
function isKeyDown(kc) {
    for (let i = 0; i < 8; i++) {
        if ((sys.peek(-41 - i) & 0xFF) === kc) return true;
    }
    return false;
}
```

- [ ] **Step 3: Replace the main loop**

Locate the existing block:

```javascript
// TODO update for events: key down (updates some widgets), timer (updates clock and calendar widgets)
while (true) {
    captureUserInput();
    if (getKeyPushed(0) == 67) break;

    _fsh.widgets["com.fsh.clock"].draw(25, 3);
    _fsh.widgets["com.fsh.calendar"].draw(12, 8);
    _fsh.widgets["com.fsh.todo_list"].draw(10, 17);
    _fsh.widgets["com.fsh.quick_access"].draw(47, 8);

    sys.spin();sys.spin()
}
```

Replace with:

```javascript
// Load persisted state before the first draw
_fsh.loadConfig();

// keyEventBuffers (read via sys.peek(-41-i)) holds *raw libGDX keycodes*,
// not the cooked TSVM scancodes that con.getch() returns. Existing fsh.js
// already uses 67 for Backspace (libGDX DEL); follow the same scheme here.
const KEY_ESC    = 131;  // Input.Keys.ESCAPE
const KEY_ENTER  = 66;   // Input.Keys.ENTER
const KEY_UP     = 19;   // Input.Keys.UP
const KEY_DOWN   = 20;   // Input.Keys.DOWN
const KEY_LEFT   = 21;   // Input.Keys.LEFT
const KEY_RIGHT  = 22;   // Input.Keys.RIGHT
const KEY_LSHIFT = 59;   // Input.Keys.SHIFT_LEFT
const KEY_RSHIFT = 60;   // Input.Keys.SHIFT_RIGHT

let prevButtons = 0;
let prevMouseCharX = -1;
let prevMouseCharY = -1;
let keyLatch = {};   // {keycode: true} while the key is held — debounces "just pressed"

while (true) {
    captureUserInput();

    // -- keyboard --
    if (isKeyDown(KEY_ESC)) break;

    let shiftDown = isKeyDown(KEY_LSHIFT) || isKeyDown(KEY_RSHIFT);
    let enterPressed = false;

    // Edge-detect each navigation key
    function edge(kc) {
        let down = isKeyDown(kc);
        let was  = !!keyLatch[kc];
        keyLatch[kc] = down;
        return down && !was;
    }

    if (edge(KEY_ENTER)) enterPressed = true;
    let navUp    = edge(KEY_UP);
    let navDown  = edge(KEY_DOWN);
    let navLeft  = edge(KEY_LEFT);
    let navRight = edge(KEY_RIGHT);

    // -- mouse --
    let pos = readMousePos();
    let charX = (pos[0] / 7) | 0;
    let charY = (pos[1] / 14) | 0;
    let mouseMoved = (charX !== prevMouseCharX || charY !== prevMouseCharY);
    prevMouseCharX = charX;
    prevMouseCharY = charY;

    let buttons = readMouseButtons();
    let leftEdge  = ((buttons & _fsh.MB_LEFT)  !== 0) && ((prevButtons & _fsh.MB_LEFT)  === 0);
    let rightEdge = ((buttons & _fsh.MB_RIGHT) !== 0) && ((prevButtons & _fsh.MB_RIGHT) === 0);
    prevButtons = buttons;

    // -- focus update --
    if (navUp || navDown || navLeft || navRight) {
        if (!_fsh.focus) _fsh.focus = {widgetId: "com.fsh.todo_list", index: 0};
        if (navUp || navDown) {
            let layout = _fsh.layouts[_fsh.focus.widgetId];
            let maxRows = (_fsh.focus.widgetId === "com.fsh.todo_list")
                ? _fsh.TODO_MAX_ROWS : _fsh.QA_MAX_ROWS;
            let length = (_fsh.focus.widgetId === "com.fsh.todo_list")
                ? todoWidget.todoList.length : quickAccessWidget.entries.length;
            let maxIdx = Math.min(length, maxRows - 1);
            let next = _fsh.focus.index + (navDown ? 1 : -1);
            if (next < 0) next = 0;
            if (next > maxIdx) next = maxIdx;
            _fsh.focus.index = next;
        } else {
            // Left/right switches widget
            let other = (_fsh.focus.widgetId === "com.fsh.todo_list")
                ? "com.fsh.quick_access" : "com.fsh.todo_list";
            let otherLength = (other === "com.fsh.todo_list")
                ? todoWidget.todoList.length : quickAccessWidget.entries.length;
            let otherMaxRows = (other === "com.fsh.todo_list")
                ? _fsh.TODO_MAX_ROWS : _fsh.QA_MAX_ROWS;
            let otherMaxIdx = Math.min(otherLength, otherMaxRows - 1);
            _fsh.focus = {widgetId: other, index: Math.min(_fsh.focus.index, otherMaxIdx)};
        }
    } else if (mouseMoved) {
        let h = _fsh.findHit(charX, charY);
        _fsh.focus = h ? {widgetId: h.widgetId, index: h.hit.kind === "add"
                            ? ((h.widgetId === "com.fsh.todo_list")
                                ? todoWidget.todoList.length
                                : quickAccessWidget.entries.length)
                            : h.hit.index} : null;
    }

    // -- mouse click dispatch --
    if (leftEdge) {
        let h = _fsh.findHit(charX, charY);
        if (h) _fsh.dispatchLeft(h.widgetId, h.hit);
    } else if (rightEdge) {
        let h = _fsh.findHit(charX, charY);
        if (h) _fsh.dispatchRight(h.widgetId, h.hit);
    }

    // -- keyboard dispatch (synthesise click at focus) --
    if (enterPressed && _fsh.focus) {
        let layout = _fsh.layouts[_fsh.focus.widgetId];
        let widget = _fsh.widgets[_fsh.focus.widgetId];
        let length = (_fsh.focus.widgetId === "com.fsh.todo_list")
            ? todoWidget.todoList.length : quickAccessWidget.entries.length;
        let hit = (_fsh.focus.index < length)
            ? {kind: "item", index: _fsh.focus.index}
            : (_fsh.focus.index === length ? {kind: "add"} : null);
        if (hit) {
            if (shiftDown) _fsh.dispatchRight(_fsh.focus.widgetId, hit);
            else           _fsh.dispatchLeft(_fsh.focus.widgetId, hit);
        }
    }

    // -- redraw --
    _fsh.widgets["com.fsh.clock"].draw(25, 3);
    _fsh.widgets["com.fsh.calendar"].draw(12, 8);
    _fsh.widgets["com.fsh.todo_list"].draw(10, 17);
    _fsh.widgets["com.fsh.quick_access"].draw(47, 8);

    sys.spin(); sys.spin();
}
```

- [ ] **Step 4: Syntax check**

```bash
node --check assets/disk0/home/fsh.js
```

Expected: exit code 0.

- [ ] **Step 5: Logic walkthrough — verify by reading**

Read the new main loop and confirm:

1. `edge(kc)` returns true exactly once per key press, then false until release.
2. Keyboard nav (arrow press) sets focus, mouse motion sets focus — last-write-wins because both branches are mutually exclusive per frame.
3. The "add" row index is `length` for both widgets, matching `hitTestList`.
4. Enter dispatch correctly skips frames where focus is `null` or out of range.
5. Esc exits without saving (config saves happen synchronously inside each dispatcher anyway).

- [ ] **Step 6: Commit**

```bash
git add assets/disk0/home/fsh.js
git commit -m "$(cat <<'EOF'
fsh: drive interaction from polled mouse + keyboard in the main loop

Edge-detects left/right click and Enter, tracks focus from whichever
input device moved most recently, dispatches into the add/edit/launch
handlers, and exits on Esc instead of Backspace.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Manual smoke test

**Files:**
- (no edits — user-driven verification)

The TSVM is not machine-interactable, so this is a checklist the user runs in the running emulator after rebuilding from IntelliJ.

- [ ] **Step 1: Ask the user to rebuild and launch**

Tell the user:

> "Please rebuild the project in IntelliJ (the `IOSpace.kt` change needs the Kotlin module recompiled) and launch the emulator. Then run `fsh` from the TVDOS prompt."

- [ ] **Step 2: Walk through the spec's testing scenarios**

The user verifies each item from the spec (or you do, if you can see the screen):

1. **First run** — delete `assets/disk0/home/config/fshrc` (if it exists). Launch fsh. Expect: default QA entries (Files / Editor / BASIC / DOS Shell), empty todo list with one `+ Click to add` row.
2. **Add todo** — left-click `+ Click to add` on todo widget. Dialog appears. Type text → Enter → entry added. Quit (Esc) and relaunch fsh. Entry persists.
3. **Toggle done** — left-click an existing todo. Checkbox flips. Relaunch — state persisted.
4. **Edit todo** — right-click an existing todo. Edit dialog opens pre-filled. Test OK / Cancel / Delete paths.
5. **Add QA** — left-click `+ Click to add` on QA widget. Two-field dialog. Submit. Verify file content of `assets/disk0/home/config/fshrc`.
6. **Launch QA** — left-click `Editor`. Verify `edit.js` runs and fsh redraws on return.
7. **Edit/Delete QA** — right-click an entry. Edit dialog with Delete button. Test all three buttons.
8. **Keyboard nav** — no mouse — press ↓ → first todo highlights. Use arrows to traverse, ← / → to switch widgets, Enter to activate, Shift+Enter to edit.
9. **Hover highlight** — move mouse over items — row inverts under cursor.
10. **Esc** — exits fsh cleanly back to TVDOS prompt.
11. **Malformed fshrc** — hand-edit the file to contain garbage. fsh should start with defaults and not crash.

- [ ] **Step 3: If any scenario fails, file a follow-up task with the specific failure**

Don't try to fix-in-place during the smoke test — note the failure, finish the rest of the checklist, then return to writing-plans / inline-execution for the fixes.

---

## Self-review checklist

This was checked before handing the plan off:

- **Spec coverage**: every goal in the spec (popups, click-to-add, right-click edit/delete, persistence, hover, keyboard nav, QA launch, IOSpace right-click bit) has a corresponding task.
- **Placeholders**: no TODOs, no "appropriate error handling," every step has concrete code.
- **Type consistency**: `_fsh.focus.widgetId` / `_fsh.focus.index` is the single shape across all consumers; `{kind, index?}` is the hit-test shape across hit-test and dispatchers; `{action, values}` is the dialog return shape across all dispatch paths.
- **Indexing convention** (the one fix the spec self-review caught): `0..length-1` = items, `length` = add row, `> length` = filler. Used consistently in Task 4 (hit-test), Task 5 (draw), Task 7 (dispatchers), and Task 8 (keyboard nav).
