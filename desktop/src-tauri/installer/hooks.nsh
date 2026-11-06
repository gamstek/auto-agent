; Run the explicit layout cutover only during installation, using the bundled Node.
; The script preserves the current data layout and never follows directory links.
!macro NSIS_HOOK_POSTINSTALL
  ClearErrors
  ExecWait '"$INSTDIR\backend\node.exe" "$INSTDIR\backend\install-reset.mjs" --install' $0
  IfErrors corax_install_reset_failed
  StrCmp $0 0 corax_install_reset_done
  corax_install_reset_failed:
  MessageBox MB_ICONSTOP|MB_OK "Unable to initialize .auto-agent. Close Auto-Agent and its CLI, then run installation again."
  Abort
  corax_install_reset_done:
!macroend
