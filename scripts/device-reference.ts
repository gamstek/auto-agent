import { resolve } from 'node:path';
import { referenceInput, queryReference } from 'auto-agent/wiki/reference';
import { referenceSource } from 'auto-agent/wiki';

const request = process.argv[2] ? JSON.parse(process.argv[2]) : { action: 'catalog' };
console.log(
  JSON.stringify(
    queryReference(
      referenceInput.parse(request),
      referenceSource(resolve(import.meta.dirname, '../corax')),
    ),
    null,
    2,
  ),
);
