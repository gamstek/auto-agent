import { basename } from 'node:path';
import { WikiError, type DocumentParser, type ParsedUnit } from '@auto-agent/wiki-core/contracts';
import { decodeSam, summarizeSam } from './sam';
import { extractReference, type ReferenceField } from './reference';

const pointer = (path: (string | number)[]) =>
  '/' + path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');

export const samParser: DocumentParser = {
  id: 'sam.reference',
  version: '1',
  fields: [
    { name: 'sam.product', type: 'string' },
    { name: 'sam.clientVersion', type: 'string' },
    { name: 'sam.gas', type: 'string' },
    { name: 'sam.analysisType', type: 'string' },
    { name: 'sam.labType', type: 'number' },
    { name: 'sam.temperatureK', type: 'number', unit: 'K' },
  ],
  supports: (path) => /\.(sam|smp)$/i.test(path),
  async parse(source, { signal }) {
    signal.throwIfAborted();
    let decoded: ReturnType<typeof decodeSam>;
    try {
      decoded = decodeSam(source.bytes);
    } catch (error) {
      if (error instanceof WikiError && error.code === 'UNSUPPORTED_FORMAT')
        throw new WikiError('unsupported_format', error.message);
      throw error;
    }
    const summary = summarizeSam(decoded, source.bytes, source.path);
    const reference = extractReference(decoded.root, decoded.product);
    const units: ParsedUnit[] = [];
    // Each field preserves its own units, active state, uncertainty and source path.
    const add = (label: string, value: unknown, path?: (string | number)[]) => {
      signal.throwIfAborted();
      const text = `${label}\n${JSON.stringify(value)}`;
      if (Buffer.byteLength(text) > 12000 && value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) add(`${label}.${key}`, item, path);
        return;
      }
      units.push({
        text,
        locator: path
          ? { kind: 'json-pointer', pointer: pointer(path) }
          : { kind: 'section', name: label },
        data: value,
      });
    };
    add('summary', {
      identity: summary.identity,
      status: summary.status,
      warnings: summary.warnings,
    });
    for (const [name, group] of Object.entries(reference.groups)) {
      for (const [key, field] of Object.entries(group.fields)) {
        const item = field as ReferenceField;
        add(
          `${name}.${key}`,
          item,
          item.presence === 'missing' ? undefined : (item.source ?? [...group.source, key]),
        );
      }
      if (group.uninterpretedKeys.length) add(`${name}.uninterpretedKeys`, group.uninterpretedKeys);
    }
    for (const [index, report] of reference.reports.entries()) {
      const { parameters, ...options } = report;
      add(`reports.${index}`, options);
      for (const [key, field] of Object.entries(parameters))
        add(
          `reports.${index}.${key}`,
          field,
          field.presence === 'missing' ? undefined : (field.source ?? [...report.source, key]),
        );
    }
    const scalar = (name: string) => summary.facts[name]?.value;
    return {
      title: basename(source.path),
      mediaType: 'application/x-sam',
      units,
      attributes: {
        'sam.product': decoded.product,
        'sam.clientVersion':
          typeof scalar('clientVersion') === 'string' ? (scalar('clientVersion') as string) : null,
        'sam.gas':
          typeof scalar('gasMnemonic') === 'string' ? (scalar('gasMnemonic') as string) : null,
        'sam.analysisType':
          typeof scalar('analysisType') === 'string' ? (scalar('analysisType') as string) : null,
        'sam.labType': Number.isInteger(decoded.root.labType) ? decoded.root.labType : null,
        'sam.temperatureK':
          typeof scalar('temperatureK') === 'number' ? (scalar('temperatureK') as number) : null,
      },
      issues: [
        ...reference.issues,
        ...summary.warnings.map((warning) => `${warning.code}: ${warning.message}`),
      ],
    };
  },
};
