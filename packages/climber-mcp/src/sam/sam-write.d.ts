export function writeSam(
  input: Record<string, unknown>,
  command: 'create' | 'modify' | 'save-as',
): Promise<Record<string, unknown>>;
