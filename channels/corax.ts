import { coraxChannel } from '@coraxjs/core/channels/corax';
import { httpBasic, localDev } from '@coraxjs/core/channels/auth';

const password = process.env.AUTO_AGENT_TOKEN;
export default coraxChannel({
  auth: password ? [httpBasic({ username: 'auto-agent', password })] : [localDev()],
});
