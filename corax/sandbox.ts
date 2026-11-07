import { defineSandbox } from '@coraxjs/core/sandbox';
import { HostSandbox } from './lib/host/provider';

export const environment = HostSandbox.environment();
export default defineSandbox(() => environment.open());
