# fSh Interactive Widgets — Design

**Date**: 2026-05-24
**Scope**: Make `com.fsh.todo_list` and `com.fsh.quick_access` widgets in
`assets/disk0/home/fsh.js` functional. Persist state to
`assets/disk0/home/config/fshrc`. Add a single `IOSpace.kt` change to expose
the right mouse button.

## Goals

1. Click "Click to add" → modal popup that adds a new entry.
2. Click an existing todo → toggle done. Click an existing QA entry → launch
   its program via `execApp`, then return to fsh.
3. Right-click any existing entry → modal popup for edit / delete.
4. Hover (or keyboard focus) highlights the row under the pointer.
5. Keyboard navigation: arrows move focus; Enter = left-click; Shift+Enter =
   right-click; Esc exits fsh.
6. State persists across runs via `A:/home/config/fshrc`.

## Non-goals

- Drag-and-drop reordering of items.
- Multi-line todos.
- Validation or autocomplete on the QA "Command" field — whatever the user
  types is stored verbatim and passed to `execApp`.
- Any UI for resolving errors in a malformed `fshrc`: invalid lines are
  silently dropped on load. fsh is the only writer.
- Right-click support exposed via any new dedicated MMIO range; we just
  promote the existing single-bit `mouseDown` byte to a two-bit field.

## Architecture

### Source files touched

| File                                                            | Change                                                                 |
|-----------------------------------------------------------------|------------------------------------------------------------------------|
| `assets/disk0/home/fsh.js`                                      | Widget interaction, dialog primitive, config I/O, new main loop.       |
| `tsvm_core/src/net/torvald/tsvm/peripheral/IOSpace.kt`          | MMIO[36] becomes a button bitfield (bit 0 = left, bit 1 = right).      |

No new files. `assets/disk0/home/config/fshrc` is created lazily on first
save.

### High-level units in fsh.js

1. **Input polling layer** — reads mouse position (MMIO 32–35), mouse buttons
   (MMIO 36), and keyboard events (existing `captureUserInput()` /
   `getKeyPushed()`). Provides edge-detected click events and a per-frame
   "cursor moved?" signal.
2. **Focus state** — single `_fsh.focus = {widgetId, index}` driven by
   whichever input device moved last. Cleared when neither mouse nor keyboard
   selects anything actionable.
3. **Widget hit-test + draw** — each interactive widget gains a
   `hitTest(charX, charY)` returning `{kind: "add"|"item", index}` or `null`,
   and its `draw()` accepts the focus state to invert the highlighted row.
4. **Modal dialog primitive** — `_fsh.showDialog(opts)` blocks input until
   the user submits or cancels. Returns a tagged result.
5. **Config I/O** — `_fsh.loadConfig()` runs once at startup;
   `_fsh.saveConfig()` runs after every mutation.
6. **Dispatcher** — translates click / keyboard events into widget mutations,
   `execApp` invocations, or dialog opens.

## Detailed behaviour

### Input polling

```
Mouse X = (sys.peek(-33) & 0xFF) | ((sys.peek(-34) & 0xFF) << 8)
Mouse Y = (sys.peek(-35) & 0xFF) | ((sys.peek(-36) & 0xFF) << 8)
Buttons = sys.peek(-37) & 0xFF       // bit 0 = left, bit 1 = right
```

Mouse pixel → char-grid conversion: `charX = mouseX / 7`, `charY = mouseY / 14`
(matching the existing widget coordinate system).

Each frame the loop computes `(prevButtons, currButtons)` and emits at most
one event:

- left-pressed edge (`!(prev & 1) && (curr & 1)`) → `leftClick(charX, charY)`
- right-pressed edge (`!(prev & 2) && (curr & 2)`) → `rightClick(charX, charY)`

Keyboard events use the existing `captureUserInput() / getKeyPushed(k)` mechanism
the file already uses. We don't need `con.getch()` in the main loop because the
dialog handles its own text input.

### Focus state

- `_fsh.focus = null | {widgetId: string, index: number}`.
- After each frame's input poll, focus is reassigned by the most recent input:
  - If mouse moved since last frame: focus = hit-test under cursor (or `null`).
  - If a nav key was pressed: focus = computed from previous focus + key.
- Drawing always honours `_fsh.focus`; widgets that don't match `widgetId` draw
  normally.

Keyboard nav rules:

- Indexing convention (matches the existing draw): for a list of length `N`,
  indices `0..N-1` are existing entries and index `N` is the `+ Click to
  add` row. Indices past `N` are not focusable.
- `↑` / `↓`: move `index` ± 1, clamped to `[0, min(N, maxRows-1)]` for the
  current widget. No wrap.
- `←` / `→`: switch `widgetId` between `com.fsh.todo_list` and
  `com.fsh.quick_access`, with `index` clamped to the target widget's range.
- If focus is `null` on key press, default to `{widgetId: "com.fsh.todo_list",
  index: 0}`.

### Hit-testing

Each interactive widget exports:

```
widget.hitTest(charX, charY) → null
                              | {kind: "add"}
                              | {kind: "item", index: i}   // i is the 0-based model index
```

The hit region is the widget's rendered row range. For the Todo widget that's
charY in `[charYoff + 2, charYoff + 14]` for rows 0..12; charX in
`[charXoff, charXoff + 26)`. Same shape for QA, with its own `charYoff`,
`charXoff`, and 22 rows. The widget owns these magic numbers because they
already live in its `draw()`.

The clicked row index maps to:

- `0..N-1` (existing entries) → `{kind: "item", index}`.
- `N` (the row that draws "Click to add") → `{kind: "add"}`.
- `> N` (the underscore filler rows) → `null`.

### Dispatcher

```
on leftClick(cx, cy):
    hit = widget.hitTest(cx, cy)
    if hit is null: return
    if hit.kind == "add":
        openAddDialog(widget)
    elif widget == todo:
        toggleDone(hit.index); saveConfig()
    elif widget == qa:
        launchEntry(qa.entries[hit.index])

on rightClick(cx, cy):
    hit = widget.hitTest(cx, cy)
    if hit is null or hit.kind == "add": return
    openEditDialog(widget, hit.index)

on Enter:           leftClick at focus
on Shift+Enter:     rightClick at focus
```

`launchEntry({label, cmd})`:

1. Read the file at `cmd` (using the existing path-resolution pattern from
   `command.js`).
2. `execApp(programCode, [cmd])`.
3. On return, redraw wallpaper + titlebar + all widgets.
4. Errors from `execApp` are caught and logged via `serial.printerr`; fsh
   continues running. No bulletin shown (out of scope).

### Modal dialog

```
_fsh.showDialog({
  title: "New Todo",
  fields: [{label: "Text", initial: "", width: 24}],
  allowDelete: false,                 // adds [Delete] button when true
}) → {action: "ok"|"delete"|"cancel", values: [string, ...]}
```

Render:

- Centred on a `_fsh.scrwidth × _fsh.scrheight` grid. Width = max(title length
  + 4, longest field width + 6, 16). Height = 4 + 3 × fields.length + 1.
- Frame: `╔═╗ ║ ╚═╝` (double-line). Inner field box: `┌─┐ │ └─┘`.
- Saves a snapshot of the underlying char cells via `con.peekch`-style reads
  (if available) or simply redraws wallpaper + widgets after close. The
  simpler "redraw everything" approach is acceptable given the small screen
  budget.

Input loop inside the dialog (separate from the main loop):

- Uses `con.getch()` for character entry, matching `command.js` line 505.
- Printable ASCII (32..126) and the TSVM extended chars append to the active
  field.
- Backspace deletes one char.
- Tab cycles fields (forward).
- Enter: if active field is not last, advance to next field; if last, submit.
- Esc: cancel.
- Mouse: re-uses the main-loop hit-tester logic to detect clicks on `[OK]`,
  `[Cancel]`, or `[Delete]` buttons, and to focus a field when clicked.

The dialog drives its own input loop. The main loop is **not** running while a
dialog is open. This avoids race conditions on shared input state.

### Config (fshrc)

Path: `A:/home/config/fshrc`.

Format (re-stated for the spec):

```
[TODO]
+ Buy groceries
- Read CLAUDE.md
+ Take out trash

[QUICK_ACCESS]
Files,/tvdos/bin/zsh.js
Editor,/tvdos/bin/edit.js
BASIC,/tbas/basic.js
```

Parse rules:

- Lines starting with `[` open a new section. Recognised names: `TODO`,
  `QUICK_ACCESS`. Unknown sections cause subsequent lines to be ignored until
  the next header.
- Inside `[TODO]`: line must match `^[+-] (.*)$`. `+` → done; `-` → not done.
  Whitespace-only lines skipped.
- Inside `[QUICK_ACCESS]`: split on the **first** comma. Label = left side
  (trimmed); cmd = right side (verbatim, no trim — leading space may be
  intentional). Lines without a comma are skipped.
- Blank lines anywhere are ignored.
- Trailing newline tolerated.

Load behaviour:

- If file does not exist: todoList stays `[]`, QA falls back to the hardcoded
  default entries (`Files / Editor / BASIC / DOS Shell`). On first save, the
  file is created and defaults are written out.
- If file exists but is empty or only contains unknown sections: same as
  above (defaults for QA, empty todo).

Save behaviour:

- Whole file rewrite via `file.swrite(serialized)` on every mutation.
- Order in file matches in-memory order; in-memory order matches click order
  (newest at the bottom for new adds).

### Engine change (`IOSpace.kt`)

Convert MMIO[36] from a single boolean to a two-bit field. Touch points
(all within `IOSpace.kt`):

```kotlin
// ~line 283: rename and retype
private var mouseButtons: Int = 0  // bit 0 = LEFT, bit 1 = RIGHT

// ~line 101: change the read
36L -> mouseButtons.toByte()

// ~line 302: set both bits in the touched branch
mouseButtons = (if (Gdx.input.isButtonPressed(Buttons.LEFT))  1 else 0) or
               (if (Gdx.input.isButtonPressed(Buttons.RIGHT)) 2 else 0)

// ~line 316: clear when no touch
mouseButtons = 0
```

Backwards compatibility: existing JS does `sys.peek(-37)` and treats non-zero
as "pressed." Since LEFT (the only previously available button) is bit 0,
non-zero is preserved for left-click. No JS callers currently inspect the
high bits, so no callers break.

## Data flow

```
startup
  └─ loadConfig() → populates todoWidget.todoList and quickAccessWidget.entries
     └─ registerNewWidget(...)
        └─ enter main loop

main loop, per frame
  ├─ poll mouse pos + buttons + keyboard
  ├─ update _fsh.focus
  ├─ if leftClick edge:  dispatchLeftClick()
  ├─ if rightClick edge: dispatchRightClick()
  ├─ if Enter / Shift+Enter: synthesize click at focus
  ├─ if Esc: break
  └─ redraw widgets (each receives _fsh.focus)

dispatch
  ├─ openAddDialog → showDialog → mutate model → saveConfig() → redraw all
  ├─ openEditDialog → showDialog → mutate model → saveConfig() → redraw all
  ├─ toggleDone → mutate model → saveConfig() → no full redraw needed
  └─ launchEntry → execApp → redraw all on return

shutdown (Esc)
  └─ con.reset_graphics(); con.clear()
```

## Error handling

- `loadConfig`: any parse failure on a single line → drop the line, keep
  parsing. No user-visible error.
- `saveConfig`: file open failure → log via `serial.printerr`, continue.
  In-memory state is still correct for the session.
- `execApp` throws → caught, logged via `serial.printerr`, fsh continues.
- Dialog cancel → model untouched, no save, redraw.

## Testing

Manual verification path (the project doesn't have a JS test harness for
fsh):

1. **First run**: delete `fshrc`, launch fsh — expect default QA entries and
   empty todo list with a single `+ Click to add` row.
2. **Add todo**: left-click `+ Click to add` on todo widget → dialog appears →
   type "Buy groceries" → Enter. Row added. Restart fsh — row persists.
3. **Toggle done**: left-click an existing todo → checkbox flips. Restart →
   state preserved.
4. **Edit todo**: right-click an existing todo → dialog opens pre-filled. OK
   saves edit; Delete removes; Cancel discards.
5. **Add QA**: left-click `+ Click to add` on QA widget → dialog with two
   fields (Label, Command). Submit.
6. **Launch QA**: left-click `Editor` → `edit.js` runs. Quit edit → fsh
   redraws.
7. **Edit/Delete QA**: right-click an entry → edit dialog (with Delete button)
   appears.
8. **Keyboard nav**: cursor not over any item — press ↓ — first todo
   highlights. Use arrows to traverse, ← / → to switch widgets, Enter to
   activate.
9. **Hover highlight**: move mouse over items — row inverts under cursor.
10. **Esc**: exits fsh cleanly.
11. **Malformed fshrc**: hand-edit the file to contain garbage — fsh should
    start with defaults and not crash.

## Open questions

None — all design decisions are settled. Implementation can begin.
