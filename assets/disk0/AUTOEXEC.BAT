rem AUTOEXEC.BAT -- per-console launch script. Run once for every console:
rem each virtual-console pane runs it (via vtmgr's bootstrap), and the boot
rem shell runs it as the fallback once vtmgr exits (Alt-0). Environment setup
rem (`set` commands) lives in \commandrc, which TVDOS.SYS runs before this.
rem
rem Korean IME registers a per-CONTEXT handler (unicode.uniprint), so it must
rem run per-console here rather than once at boot.
tvdos/i18n/korean

rem The interactive shell for this console.
zfm
command -fancy
