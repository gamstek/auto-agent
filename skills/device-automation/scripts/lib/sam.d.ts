export interface SamSummary {
  file: { path: string; bytes: number; sha256: string; format: string };
  status: { raw: number | null; family: string | null; state: string; analysisStatus: unknown };
  identity: { sampleName: unknown; uuid: string | null; unit: unknown; port: unknown };
  facts: Record<
    string,
    {
      value: string | number | boolean | null;
      source: (string | number)[];
      presence: string;
      rawValue?: unknown;
      unit?: string;
    }
  >;
  warnings: { code: string; message: string }[];
  [key: string]: unknown;
}
export function inspectSam(
  input: {
    path: string;
    product: 'g5' | 'g12' | 's60pro';
    requirements?: Record<string, unknown>;
    tolerances?: Record<string, number>;
  },
  command?: 'inspect' | 'compare',
): Promise<SamSummary>;
