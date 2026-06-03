echo "Starting TVDOS..."

rem put set-xxx commands here:
set PATH=\tvdos\installer;\tvdos\tuidev;\tbas;\hopper\bin;$PATH
set INCLPATH=\hopper\include;$INCLPATH
set HELPPATH=\hopper\help;$HELPPATH
set KEYBOARD=us_colemak

rem load Korean font / IME (font upload is global hardware)
tvdos/i18n/korean

rem Boot into virtual consoles. vtmgr owns the keyboard and screen, and spawns
rem a `command -fancy` shell per VT (Alt-1..6 / chvt to switch, Alt-0 to exit).
rem It snapshots the environment set above and replays it into every pane.
rem NOTE: `fsh` is a graphical shell and must not run inside a VT pane; launch
rem it directly (not via vtmgr) if you want it. (Old boot line: fsh)
tvdos/sbin/vtmgr

rem Fallback shell once vtmgr exits (Alt-0), so the console is never left bare.
command -fancy
