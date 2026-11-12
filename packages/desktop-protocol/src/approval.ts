/** Maps directly to Corax's native approval helpers. Not a sandbox permission level. */
export type ApprovalMode = 'always' | 'once' | 'never';
export interface ApprovalSetting {
  mode: ApprovalMode;
  revision: number;
}
export interface DesktopApprovalSetting extends ApprovalSetting {
  generation: string;
}
