import { resolve } from 'node:path';
import { main } from '../src';
import { errorText } from '../src/shared/types';
await main(process.argv.slice(2), {
  development: true,
  defaultConfig: resolve(import.meta.dir, '..', 'examples', 'config.json'),
}).catch((error) => {
  console.error(errorText(error));
  process.exitCode = 1;
});
