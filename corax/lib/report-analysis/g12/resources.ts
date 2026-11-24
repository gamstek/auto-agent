import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SaxesParser } from 'saxes';
import { z } from 'zod';

export const analysisProjectRoot = () =>
  process.env.AUTO_AGENT_PROJECT_ROOT ?? process.env.CORAX_PROJECT_ROOT ?? process.cwd();

const adsSchema = z.object({
  name: z.string().min(1),
  mnemonic: z.string().min(1),
  'molecular cross sectional area': z.number().nonnegative(),
  'density conversion factor': z.number().nonnegative(),
  'adsorbate molecular weight': z.number().nonnegative(),
  'adsorbate property factor ads': z.number().nonnegative().optional(),
  'adsorbate property factor des': z.number().nonnegative().optional(),
});

export function parseAds(id: string, bytes: Buffer) {
  if (
    bytes.length < 10 ||
    bytes.readUInt32BE(0) !== 0x2200 ||
    bytes.readUInt32BE(4) !== bytes.length - 8 ||
    bytes.length % 2
  ) {
    throw new Error(`G12 吸附质物性文件格式无效：${id}`);
  }
  const raw = adsSchema.parse(
    JSON.parse(new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(8))),
  );
  const temperature = /@\s*(\d+(?:\.\d+)?)\s*K\b/i.exec(raw.name);
  return {
    id,
    name: raw.name,
    gas: normalizeGas(raw.mnemonic),
    temperatureK: temperature ? Number(temperature[1]) : null,
    crossSectionNm2: raw['molecular cross sectional area'],
    densityConversionFactor: raw['density conversion factor'],
    molecularWeight: raw['adsorbate molecular weight'],
    bjhAdsorbateFactorAngstrom: {
      adsorption: raw['adsorbate property factor ads'],
      desorption: raw['adsorbate property factor des'],
    },
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export const normalizeGas = (gas: string) => gas.normalize('NFKC').trim().toUpperCase();

type ModelEntry = { id: string; gas: string; family: string; geometry: string; label: string };
export async function loadModelCatalog(root = analysisProjectRoot()) {
  const bytes = await readFile(join(root, 'assets/g12/RepCalcModel.xml'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== '091e77130d5d877bda3320f00e706c0a8e9ffe26b17a4d954591c733de18ac19')
    throw new Error('G12 模型配置 RepCalcModel.xml 校验失败。');
  const entries = new Map<string, ModelEntry>();
  const parser = new SaxesParser();
  let gas = '',
    family = '',
    geometry = '',
    key = '',
    label = '';
  let inLabel = false;
  parser.on('opentag', ({ name, attributes }) => {
    if (name === 'GasNode') gas = normalizeGas(attributes.name ?? '');
    if (name === 'ReportNode') family = attributes.name ?? '';
    if (name === 'GeometryNode') geometry = attributes.name ?? '';
    if (name === 'CalcModel') {
      key = attributes.id ?? '';
      label = '';
    }
    if (name === 'LangName') inLabel = attributes.lang === 'zh-CN';
  });
  parser.on('text', (text) => {
    if (inLabel) label += text;
  });
  parser.on('closetag', ({ name }) => {
    if (name === 'LangName') inLabel = false;
    if (name === 'CalcModel') {
      if (!key || !gas || !family || !geometry || !label.trim() || entries.has(key))
        throw new Error(`G12 模型配置条目无效：${key}`);
      entries.set(key, { id: key, gas, family, geometry, label: label.trim() });
    }
  });
  parser.write(bytes.toString('utf8')).close();
  return { entries, sha256 };
}

export async function loadAdsCatalog(root = analysisProjectRoot()) {
  const dir = join(root, 'assets/g12/Adsorptive Properties');
  const names = (await readdir(dir)).filter((name) => name.endsWith('.ADS')).sort();
  return Promise.all(names.map(async (name) => parseAds(name, await readFile(join(dir, name)))));
}

export async function selectAds(gas: string, temperatureK: number, adsId?: string, root?: string) {
  const candidates = (await loadAdsCatalog(root)).filter(
    (profile) => profile.gas === normalizeGas(gas),
  );
  const nearby = candidates.filter(
    (profile) =>
      profile.temperatureK !== null && Math.abs(profile.temperatureK - temperatureK) <= 1,
  );
  if (adsId) {
    const chosen = candidates.find((profile) => profile.id === adsId);
    if (!chosen) throw new Error(`.ADS ${adsId} 不存在或与实验气体 ${gas} 不匹配。`);
    if (chosen.temperatureK !== null && !nearby.includes(chosen))
      throw new Error(`.ADS ${adsId} 的标称温度与实验不匹配。`);
    return chosen;
  }
  if (nearby.length === 1) return nearby[0];
  if (nearby.length > 1) {
    throw new Error(
      `${gas} ${temperatureK} K 有多个匹配的 .ADS 物性文件：${nearby.map((profile) => profile.id).join('、')}。请确认 adsId。`,
    );
  }
  const unspecified = candidates.filter((profile) => profile.temperatureK === null);
  if (unspecified.length) {
    throw new Error(
      `${gas} ${temperatureK} K 没有温度匹配的内置 .ADS；以下同气体文件未标温度：${unspecified.map((profile) => profile.id).join('、')}。确认文件适用后再指定 adsId。`,
    );
  }
  throw new Error(`没有与实验气体 ${gas} 及温度 ${temperatureK} K 匹配的内置 .ADS 物性文件。`);
}
