const englishDiagnostics = new Map<string, string>([
  ['等温线吸附量单位未得到验证。', 'The isotherm uptake unit has not been verified.'],
  ['报告缺少实验气体或温度。', 'The report is missing the experimental gas or temperature.'],
  [
    '等温线分支不明确，请先确认分界。',
    'The isotherm branch boundary is unclear. Confirm it before calculation.',
  ],
  ['所需分支没有足够的等温线点。', 'The requested branch does not have enough isotherm points.'],
  [
    '请按已确认的材料、孔形及分支选择模型核。',
    'Choose a model kernel using the confirmed material, pore geometry and isotherm branch.',
  ],
  [
    '没有匹配气体、温度和可用压力范围的内置核。',
    'No built-in kernel matches the gas, temperature and available pressure range.',
  ],
  [
    '起始相对压力必须小于结束相对压力。',
    'The minimum relative pressure must be below the maximum.',
  ],
  ['吸附量换算后超出可计算范围。', 'The converted uptake is outside the numerical range.'],
  [
    '该 .ADS 未提供有效的 BET 分子横截面积。',
    'The selected ADS file does not provide a valid BET molecular cross-sectional area.',
  ],
  [
    '所选 .ADS 缺少有效的本分支 BJH 系数，请提供已确认的 kelvinFactorNm。',
    'The selected ADS file lacks a valid BJH coefficient for this branch. Provide a confirmed Kelvin factor (kelvinFactorNm).',
  ],
  [
    '实验气体或温度与模型核不匹配。',
    'The experimental gas or temperature does not match the model kernel.',
  ],
  [
    '选定的分支与模型文件标明的分支不一致。',
    'The selected branch does not match the branch recorded in the model file.',
  ],
  [
    'BET 拟合区间内至少需要两个不同压力点。',
    'The BET fit range requires at least two distinct pressure points.',
  ],
  [
    '只有两个拟合点，R² 不能用于判断拟合可靠性。',
    'Only two points were fitted; R² cannot establish fit reliability.',
  ],
  ['BET 常数 C 不为有限正值。', 'The BET constant C is not finite and positive.'],
  ['单层吸附量不为有限正值。', 'The monolayer uptake is not finite and positive.'],
  ['BET 比表面积超出可计算范围。', 'The BET surface area is outside the numerical range.'],
  ['q(1−p/p₀) 在拟合区间内并非单调不减。', 'q(1−p/p₀) is not nondecreasing in the fit range.'],
  [
    '模型给出的单层压力在实际选点范围之外。',
    'The model monolayer pressure is outside the selected pressure range.',
  ],
  [
    'BETSI 搜索范围超过 2000 点，请缩小压力范围。',
    'The BETSI search range has more than 2,000 points. Narrow the pressure range.',
  ],
  [
    'BETSI 搜索范围含重复相对压力点，请先确认选点。',
    'The BETSI search range contains duplicate relative pressures. Confirm the selected points.',
  ],
  ['BETSI 所选窗口复核未通过。', 'The selected BETSI fit window did not pass validation.'],
  ['BJH 相对压力或孔径范围无效。', 'The BJH relative pressure or pore diameter range is invalid.'],
  [
    'BJH 需要正的液体体积换算系数及 Kelvin 系数。',
    'BJH requires positive liquid-volume conversion and Kelvin factors.',
  ],
  [
    'BJH 分数修正仅用于吸附支。',
    'The BJH fraction correction applies only to the adsorption branch.',
  ],
  [
    'BJH 需要所选分支和压力范围内至少三个实测有效点。',
    'BJH requires at least three valid measured points in the selected branch and pressure range.',
  ],
  [
    'BJH 压力范围内有重复相对压力点，请确认选点。',
    'The BJH range contains duplicate relative pressures. Confirm the selected points.',
  ],
  ['BJH 孔径或体积计算无效。', 'The BJH pore diameter or volume calculation is invalid.'],
  [
    '所选 BJH 孔径范围未得到有效的正孔容分布。',
    'The selected BJH diameter range yielded no valid positive pore-volume distribution.',
  ],
  [
    'BJH 使用圆柱孔 Kelvin 模型，不用于定量解释微孔。',
    'BJH uses a cylindrical-pore Kelvin model and is not suitable for quantitative micropore interpretation.',
  ],
  ['孔宽分段边界必须严格递增。', 'Pore-width band boundaries must be strictly increasing.'],
  ['模型核在选定区间内没有有效响应。', 'The kernel has no valid response in the selected range.'],
  [
    '模型核与实测数据的重叠区间须有至少三个不同压力点和正吸附量。',
    'The overlap between the kernel and measurements requires at least three distinct pressure points and positive uptake.',
  ],
  [
    '拟合数据超过 2000 点，请缩小压力范围。',
    'The fit contains more than 2,000 points. Narrow the pressure range.',
  ],
  ['模型核没有可用的有限吸附响应。', 'The kernel has no usable finite adsorption response.'],
  ['相对压力超出模型核范围。', 'The relative pressure is outside the model kernel range.'],
  [
    'G12 模型配置 RepCalcModel.xml 校验失败。',
    'The G12 RepCalcModel.xml configuration failed verification.',
  ],
  ['文件为空、过大或不是普通文件。', 'The file is empty, too large, or not a regular file.'],
  [
    '读取时文件发生变化，请重新选择报告或模型。',
    'The file changed while being read. Select the report or model again.',
  ],
]);

const branchNames = { 吸附: 'adsorption', 脱附: 'desorption' } as const;

/** Translate calculation-layer diagnostics only; original report text retains its provenance. */
export function reportDiagnostic(message: string, language: 'zh-CN' | 'en'): string {
  if (language === 'zh-CN' || !/\p{Script=Han}/u.test(message)) return message;
  const fixed = englishDiagnostics.get(message);
  if (fixed) return fixed;
  const branch = /^(?:没有可计算的|BJH )(吸附|脱附)支/.exec(message)?.[1] as
    keyof typeof branchNames | undefined;
  if (branch) {
    const name = branchNames[branch];
    if (message.startsWith('没有可计算的'))
      return `No usable ${name} data points. Confirm the isotherm branch.`;
    if (message.includes('高压端吸附量不大于低压端'))
      return `For the BJH ${name} branch, uptake at the high-pressure end does not exceed uptake at the low-pressure end. Check the branch and data.`;
    if (message.includes('累计反向吸附量超过'))
      return `Reverse uptake on the BJH ${name} branch exceeds 1% of the maximum uptake in the range. Check the branch and data.`;
  }
  const steps = /^(\d+) 个压力间隔/.exec(message)?.[1];
  if (steps) {
    const subject = `${steps} pressure ${steps === '1' ? 'interval' : 'intervals'}`;
    if (message.includes('未产生可分配的正孔容'))
      return `${subject} yielded no allocatable positive pore volume.`;
    const uptake = /累计反向吸附量为 (\S+) cm³\(STP\)\/g/.exec(message)?.[1];
    if (uptake)
      return `${subject} showed a small reversal. Cumulative reverse uptake: ${uptake} cm³(STP)/g.`;
  }
  const betsi =
    /^BETSI 未找到满足条件的窗口（(\d+) 个可用点；至少 (\d+) 点、R² ≥ (\S+)、单层压力偏差 ≤ (\S+)%）。$/.exec(
      message,
    );
  if (betsi)
    return `BETSI found no eligible fit window (${betsi[1]} available points; at least ${betsi[2]} points, R² ≥ ${betsi[3]}, monolayer pressure error ≤ ${betsi[4]}%).`;
  const model =
    /^(未知的内置 NLDFT 模型|RepCalcModel\.xml 未配置模型|内置 NLDFT 模型校验失败|模型配置与模型核的气体不一致)：(.+)$/.exec(
      message,
    );
  if (model) {
    const reason =
      model[1] === '未知的内置 NLDFT 模型'
        ? 'Unknown built-in NLDFT model'
        : model[1] === 'RepCalcModel.xml 未配置模型'
          ? 'Model missing from RepCalcModel.xml'
          : model[1] === '内置 NLDFT 模型校验失败'
            ? 'Built-in NLDFT model failed verification'
            : 'Model gas differs from the kernel gas';
    return `${reason}: ${model[2]}.`;
  }
  return 'See the calculation output for the original diagnostic details.';
}
