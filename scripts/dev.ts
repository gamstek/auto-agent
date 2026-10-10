import { resolve } from 'node:path';
import { main } from '../src/app';
import { errorText } from '../src/shared/types';
import { output } from '../src/shared/console';
await main(process.argv.slice(2), {
  development: true,
  defaultConfig: resolve(import.meta.dir, '..', 'examples', 'config.json'),
}).catch((error) => {
  output.error(errorText(error));
  process.exitCode = 1;
});
