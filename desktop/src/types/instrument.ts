export interface InstrumentSnapshot {
  deviceId: string;
  name: string;
  source: string;
  transport: string;
  vendorReachability: string;
  health: {
    softwareReady: boolean | null;
    deviceConnected: boolean | null;
    deviceBusy: boolean | null;
    simulation?: boolean;
  };
  task: {
    batchId: string;
    state: string;
    experiments?: { experimentId: string; analysisPort?: number; state?: string }[];
  } | null;
  taskKnown: boolean;
  observedAt: number | null;
  revision: number;
  stale: boolean;
  error: { code: string; message: string } | null;
}
