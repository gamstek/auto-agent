; Clean obsolete application resources and run the explicit data-layout cutover.
; The script preserves compatible user data and never follows directory links.
!macro NSIS_HOOK_POSTINSTALL
  ; nsExec hides console applications and still returns their exit status/output.
  nsExec::ExecToStack '"$INSTDIR\runtime\node.exe" "$INSTDIR\runtime\install-reset.mjs" --install "$INSTDIR"'
  Pop $0
  Pop $1
  StrCmp $0 0 corax_install_reset_done
  MessageBox MB_ICONSTOP|MB_OK "Unable to complete installation. Close Auto-Agent and its CLI, then run installation again." /SD IDOK
  Abort
  corax_install_reset_done:
!macroend
