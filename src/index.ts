import { main } from './app';
import { errorText } from './shared/types';
import { output } from './shared/console';

await main().catch((error) => {
  output.error(errorText(error));
  process.exitCode = 1;
});
