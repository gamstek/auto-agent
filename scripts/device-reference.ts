import { resolve } from 'node:path';
import { referenceInput, queryReference } from '../lib/wiki/reference';
import { referenceSource } from '../lib/wiki';

const request = process.argv[2] ? JSON.parse(process.argv[2]) : { action: 'catalog' };
console.log(
  JSON.stringify(
    queryReference(
      referenceInput.parse(request),
      referenceSource(resolve(import.meta.dirname, '..')),
    ),
    null,
    2,
  ),
);
