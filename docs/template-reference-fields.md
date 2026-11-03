# 历史模板参考库：核心字段入库清单

核对日期：2026-10-30。用途：从历史案例中找到相近材料的实验条件、采集程序和分析设置，帮助准备下一次实验。

本文定义核心字段提取策略。`wiki-templates-v3` 已按此策略补齐原始参考值、来源、单位与启用/上下文标记，并重建 `wiki/indexes/library.sqlite`；第2节记录改造前的审计基线，第9节记录本次实现结果。

## 1. 取舍原则

核心字段应能回答五个问题：**什么样品与处理条件、用什么产品/气体/温度、怎样准备和采集、怎样分析、设置出自哪里**。

- 保存会影响测量、模型选择或计算解释的设置，以及理解这些设置所需的上下文。
- 历史样品称量、校准体积等可供判断条件，标为“历史上下文”，不作为新样品的默认输入。
- 产品、版本、模式和字段来源随参数一起保存；不凭目录名、文件名或数值推断未经确认的科学含义。
- 用“实验参考参数集”组织内容，不要求无损还原原文件。新模板的完整原生结构仍由 SAM 的产品配置库提供。

## 2. 改造前审计：关键缺口

改造前已对比案例库的178个 SAM 与178条库记录，原文件路径和 SHA-256 全部一致。当时记录存的是 `inspectSam()` 摘要，尚无专用核心参考参数集。

| 核对项             | 实际情况                                                                               | 对参考的影响                             |
| ------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------- |
| 预处理文字         | 129份文件的 `base infos` 有非空 `Pretreatment` 或 `处理条件`，共133项，当前未入库      | 缺少与材料方案直接相关的处理条件         |
| 采集程序           | 基础压力段、增量段及活动路径的部分低压选项已存；首点注气、相对公差、高压平衡延时等未存 | 只能比较部分采集设置                     |
| P0/温度            | 数值已存；取得方式、气体关联及物性表未完整保存                                         | 相同温度/P0数值不等于取得方式一致        |
| 准备、样品管、回填 | 已核对字段未进入当前配置摘要                                                           | 无法完整比较这些实验设置                 |
| 报告               | 原文件共1946项，库中仅有 type/name/selected                                            | 能识别选了什么报告，不能比较具体计算设置 |
| 实验模式           | 178份源文件均有 `labType`，库中均未保存                                                | 不能仅凭当前索引判断常规/高通量配置      |

字段总数或原始 JSON 保存百分比不作为本方案的验收指标：大量原字段是采集结果、报告缓存和显示设置。

## 3. 必须入库的核心字段

以下字段在源文件存在时提取；缺失时明确标记未知，不补造默认值。

### 3.1 材料、预处理和来源

| 内容                   | 来源/字段                                                                                      | 保存规则                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 材料线索、历史样品名称 | 相对目录、`sample name`                                                                        | 目录分类保留 directory-hint 依据；名称是历史标识，不自动解释为成分或新任务样品名                   |
| 预处理条件原文         | `base infos[]` 中标题为 `Pretreatment`、`处理条件` 或经确认的等价标签的条目                    | 保留 title、完整 value 与原始数组下标；有多项时逐项保存，不静默覆盖                                |
| 可确认的预处理结构化值 | 上述原文中明确给出的温度、时长、气氛/真空条件等                                                | 本轮完整保存原文供 AI 参考；后续结构化解析需与原文并存并记录依据，不能把文本直接当作已确认的下发值 |
| 来源定位               | 相对路径、SHA-256、文件字节数、格式、提取时间与修订号                                          | 每组参数均能追溯到原始字段路径；入库时间不是实验发生时间                                           |
| 产品与版本             | 文件状态家族、`softwareVersion`、`clientVersion`                                               | 保存原值、归一化结果及判断依据；不同产品/版本不能仅靠改名称互换                                    |
| 文件用途与模式         | 文件头状态、`analysisStatus`、`analysis conditions.analysis type`、`labType`、`manuallyImport` | 历史状态与当前设备状态分开；模式保留原始值                                                         |

预处理文字是本轮优先补齐项。`analysis conditions.preparation options.evacuation time` 是仪器准备阶段抽真空时间，不能代替样品预处理时长，更不能从它推导预处理温度。

### 3.2 气体、温度和 P0

路径前缀为 `analysis conditions`。

| 参数组           | 应保存的实际字段                                                                                                                                                                              | 参考方式                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 气体身份与关联   | `adsorptive properties` 下的 `id`、`gas type`、`name`、`mnemonic`，存在时的 `fluid properties file`                                                                                           | 保存为同一来源的关联组，不通过替换气体缩写拼出新物性                                          |
| 气体物性         | `molecular cross sectional area`、`adsorbate molecular weight`、`density`、`non-ideality factor`、`Psat vs Temperature Table`；以及已有文档说明的直径、亲和系数、热迁移参数、吸脱附物性因子等 | 按产品/版本保存小型物性参数快照和引用，避免 AI 用名称猜参数；未核实单位时只保留原值与未知单位 |
| 注气/修正方式    | `maximum manifold pressure`、`dosing method`、`charge from inlet`、`purify adsorptive`、非凝结/非理想气体/自由空间修正等开关                                                                  | 保存原始布尔值、编号及启用关系；设置不等于当前气路或设备能力                                  |
| P0/温度模式      | `p0 and temperature options.choose one option`                                                                                                                                                | 保留取得方式，不只存两个数值                                                                  |
| P0与分析浴温     | `p0`、`temperature`                                                                                                                                                                           | 保存原值、归一化值及单位，注明是配置值                                                        |
| P0气体关联与表格 | `p0 and temp adsorptive id/name/mnemonic`、`p0 and temp dose gas`、`Psat vs Temperature Table`                                                                                                | 与吸附质配置一起核对，但不与回填气体合并                                                      |

FPI、参考曲线和模型文件只保存已有的逻辑标识及来源引用。外部文件的哈希/可用性只有核验后才填写；存了路径文字，不代表已保存文件内容或目标机器已经安装。

原文件中的气体关联或物性配置若不一致，保留证据并标记问题，不在索引提取时改成“看起来一致”的值。

### 3.3 压力、注气和平衡

路径：`analysis conditions.isotherm collection`。这是可以直接对比不同案例采集策略的重点。

| 参数组           | 应保存的实际字段                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| 活动模式         | `use target pressure`、`absolute pressure dosing`，以及 `analysis conditions.charge template` 作为策略名称线索       |
| 目标压力段       | `pressures[]` 的 `start_p/end_p/increment_p/interval`，保留数组顺序                                                  |
| 增量段           | `increments[]` 的 `end_p/use dose increment/dose increment/percent of previous/interval`，保留数组顺序               |
| 首点与最大注气量 | `options.first dose isActive`、`first pressure fixed dose`、`maximum increment isActive`、`maximum volume increment` |
| 压力公差         | `options.absolute pressure tolerance`、`relative pressure tolerance`                                                 |
| 低压注气与平衡   | `options` 中 T_、D_ 两组 `LPressIncrementalDoseMode/DoseAmount/MinEquilibrationDelay/MaxEquilibrationDelay`          |
| 高压平衡         | `minimum equilibration delay at p/p0 >= 0.995`                                                                       |

同时保存两张分段表和两组低压选项，但明确哪一条路径启用。未启用内容标为 inactive，不当作该案例实际执行程序；T_/D_ 表示目标压力/注气增量路径，不是吸附/脱附分支。

旧文件中的 `advanced mode`、`dose target pressure`、`use fixed dose` 只作为版本相关扩展记录。未确认含义时保留有限的原值、来源及未解释标记，不映射成当前执行选项。

### 3.4 仪器准备、自由空间和回填

| 路径                                          | 应保存的实际字段                                                                                                                       | 迁移注意点                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `analysis conditions.preparation options`     | `fast evacuation`、`evacuation rate`、`unresticted evac. from`、`evacuation time`、`leak test`、`leak test duration`、`UseTranSeal`    | 保留原拼写、开关及对应数值，不能只存抽真空时长                   |
| `analysis conditions.free space options`      | `free space option type`、`lower dewar for evacuation`、`evacuation time`、`outgas test`、`outgas test duration`；文档确认的后标定扩展 | 模式按产品/版本解释；手动/测量/后标定/计算不能混为一类           |
| 上述自由空间数值                              | `ambient free space`、`analysis free space`、`enter ambient free space`、`enter analysis free space` 及实际存在的 after 值             | 分开记录“手动输入设置”和“历史测量上下文”；旧体积不是新样品默认值 |
| `analysis conditions.sample backfill options` | `backfill sample at start of analysis`、`backfill sample at end of analysis`、`backfill gas`                                           | 与吸附质/P0气体分开保存                                          |

案例中还出现 `VaccumSetPoint` 等版本扩展。名称及数值存在不等于语义、单位已确认，应进入待解释扩展清单。

### 3.5 样品、样品管和修正设置

| 内容             | 应保存的字段                                                                                         | 使用范围                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 历史称量与密度   | `mass.sample mass/tube mass/density/isEnter`                                                         | 净样质量可作历史装样量参考；空管质量、密度与手动输入方式有上下文意义。新实验使用本次实际值 |
| 样品管类型与附件 | `sample tube.name`、`use isothermal jacket`、`use filter rod`、`use air isolation plug`              | 判断是否使用相同管型与附件                                                                 |
| 样品管参数       | `sample tube.ambient free space/analysis free space/non-ideality factor`                             | 与实验自由空间配置分开；历史管参数不自动迁移                                               |
| 产品修正开关     | `thermalCorrection`、`enableNoiseRejection`、`enableReferenceTube`；存在且已有版本说明的漏率校正模式 | 保存其原值、启用条件与版本                                                                 |

`originalVolume`、`systemVolume`、`upperVolume`、`lowerVolume`、`leakRate` 等保留在设备/版本上下文中，不作为通用推荐参数。单位或含义未确认时不换算、不把旧仪器校准值赋给新设备。

## 4. 报告：保存选择和计算规则，不保存整个 options

所有报告保留 `type/name/selected`；再提取与计算有关的白名单参数。报告编号与产品、客户端版本一起保存，不把它当作跨版本通用枚举，也不与实验类型编号混淆。

以下名称和编号来自本次178份案例的实际字段盘点，不表示全部厂家版本只允许这些报告。

| 报告                   | 应进入参考库的计算配置                                                                                                                                                | 不作为可迁移配置的内容                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Summary / 概要（1）    | `adsorptionPoresAtPP0`、`desorptionPoresAtPP0`，以及由已确认显示开关表达的关注指标清单                                                                                | 版式及普通显示开关；“关注指标”只表示用户选择，不是已有结果                                                    |
| Isotherm / 等温线（5） | `selectPerGram/selectPerBetSurfaceArea/selectPerOtherSurfaceArea`、手动面积基准、单点计算阈值等已确认的计算设置                                                       | 已匹配点下标、已计算单点面积；报告内部的 P0/温度/质量可能是覆盖值或哨兵值，未确认模式前不能代替主实验设置     |
| BET（6）               | `BETSmartPointSelection`、`fitRange`、`fitRangeSmart`、`isothermRange`、`isothermRangeSmart`、`MinNumOfPoints`、`MinSquaredR`、`ErrorLimit`、`RouquerolCriterion1..5` | `selectedIndex_min/max` 等旧数据点位置，以及面积、选点结果数组和拟合缓存                                      |
| Langmuir（7）          | `fitRange`、`isothermRange`，保留该版本的区间含义与原单位                                                                                                             | 旧数据点排除下标和计算结果                                                                                    |
| t-Plot（10）           | `thicknessFunc`、`thicknessRange`、`isothermRange`、所选厚度方程及系数、reference/referenceFile、面积修正设置                                                         | 计算得到的 surfaceArea、数据点下标                                                                            |
| BJH 吸附/脱附（13/14） | 分支、`thicknessFunc`、厚度模型系数及引用、`isothermRange`、`poreWidthRange`、`BJHCorrection`、`smoothDifferentials`；该版本确认的点集/固定孔径、孔端修正和物性设置   | 图形轴样式、数据点排除下标和计算结果                                                                          |
| Horvath-Kawazoe（17）  | `currentAdsorbent/currentAdsorptive` 及对应条目参数、`poreGeometry`、`isothermRange`、`applyChengYangCorrection`、交互参数取得方式及手动值                            | `computedInteractionParameter` 等派生结果；`computed` 布尔值可能控制计算方式，不能因键名而删掉                |
| DFT Advanced PSD（18） | 模型/核文件逻辑引用、`geometry` 及适用模型关联、`isothermRange`、`useVersion2Deconvolution`、`userRegularization` 和已确认的取得方式                                  | 最优正则化/误差/粗糙度结果、旧样品身份、显示样式；`curRegularization`、`poreVolumes` 等候选项需确认语义后分类 |
| Dubinin（21）          | `astakhovSelected/radushkevichSelected`、`fitRange_da/fitRange_dr`、`isothermRange`、`exponent/optimizeExponent`、配套物性                                            | 点下标、拟合结果和普通显示配置                                                                                |
| Manufacturing（26）    | 先保留报告选择；其余放入产品/设备专项待解释项                                                                                                                         | 不因有 `calibrationVolume` 字样就归为材料实验的通用体积设置                                                   |

### 4.1 三个容易误分的情况

1. **区间数值相同或相近，单位可能不同。** 实际案例的 BET 与 Langmuir 原生区间明显不同，不能把所有 `fitRange` 都统一称作 P/P0；BJH 孔径区间也不能凭数值猜 nm。`isothermRange/fitRange` 还需确认各版本用于显示、数据选择还是拟合，不能把显示范围当作拟合规则。保留原始字段与版本，确认语义和单位后再归一化。
2. **字段名不像结果，不代表它是输入。** `selectedIndex_*`、`adsMatchIndex/desMatchIndex` 指向特定旧数据；复制到新实验会指向不同点。需要保留人工排除依据时记录原案例条件，不复制下标。
3. **字段名像结果，也可能是配置。** HK 的 `computed` 是布尔值，DFT 的 `poreVolumes` 在已查实例中是小型数值数组；不能用 `computed`、`volume`、`show`、`plot` 的正则表达式一概决定保留或删除。计算/模型参数应逐类型维护白名单及待解释项。

### 4.2 明确不属于核心参考配置的报告内容

- `reports[].result`、计算得到的 `surfaceArea`、`bet_areas`、`valid_*`、`error_vector_2d`、`min_i/min_j`、`optRMSError/optRegularization/optRoughness` 等已确认结果或缓存。
- 坐标轴上下限、颜色、线型、自动缩放、叠图窗口状态、普通图表/表格开关。
- 指向原始采集点或计算缓存的 `excludes`、旧点下标；不能把它们当作新样品选点规则。
- 未经确认的 `errorLevel/errCode` 等字段，先记录其待解释状态，不把它们当作误差阈值或推荐参数。

这里定义的是“参考库提取范围”。生成/修改原生 SAM 时仍应使用版本完整的报告结构，不能依据参考库白名单删减原生文件的 options。

## 5. 来源上下文与无需入库的内容

| 类别                                                        | 处理方式                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 历史样品名称、UUID、模组/端口、文件状态                     | 保留用于定位与解释，标为 historical；新任务不继承这些身份和物理位置           |
| 固件版本、历史体积/漏率等设备专属参数                       | 源文件存在时作兼容性或设备上下文；不给出跨设备直接套用的推荐                  |
| `analysis data/dropDatas/labData`、逐点压力/吸附量/时间轨迹 | 不属于本轮配置参考的核心字段                                                  |
| 旧实验的比表面积、孔容、孔径等计算结果                      | 属于历史实测结果，不混入可迁移配置；选了某报告不代表已有有效结果              |
| `started/completed/reportTime/lastModifiedTime` 等运行时间  | 不作为实验时长或默认配置；来源追溯使用文件标识与提取时间                      |
| `save path`、送样人/操作人员、普通 UI 偏好                  | 不作为实验参数提取；模型/参考文件引用与输出目录要区别对待                     |
| 自定义 `base infos` 的其余项                                | 按标题与实际含义提取材料/处理条件，人员字段不混进材料推荐；未知标题不擅自解释 |

## 6. 存储和 AI 读取规则

### 6.1 每个参考参数的最小证据

应能提供：参数名称、原始 JSON 路径、原值、presence、已确认的归一化值与单位、产品/版本、启用条件、来源哈希和引用范围。

引用范围至少区分：

- `setting`：经确认的实验/计算设置，可以供同类方案比较。
- `sample-context`：历史称量、密度、装样等样品相关事实。
- `device-context`：管/腔体校准、漏率等设备相关事实。
- `inactive`：存于文件但未启用的设置或报告。
- `uninterpreted`：存在但语义/单位尚未确认的有限扩展，不自动应用。

当前参数单元用 scope 表达 setting、sample-context、device-context、uninterpreted，用 active=false 表达 inactive，active=null 表示启用条件未确认；这些是返回值标记，不是执行授权。同一字段可同时具有来源范围与启用状态。

必须区分 missing、null、false、0、空字符串及空数组。主配置与报告覆盖配置、吸附质与回填气体、样品管与实验自由空间分别保留，不能按末级字段名合并。

### 6.2 已确认的单位规则

- 样品/空管质量 g；样品密度 g/cm³；自由空间体积 cm³。
- 分析浴温原值℃，可归一化为 K；预处理文本中的温度单独处理。
- G5/G12 压力表先确定模式：相对值为 P/P0；已确认版本的绝对表原值为 mmHg/1000。`p0`、最大歧管压力、绝对公差本身是 mmHg，不套表格倍率。
- 压力/增量段的 interval、高压平衡延时、检漏/放气检测时长为秒；T_/D_最小/最大延时及准备/自由空间抽真空时长为小时。
- 物性专用系数、模型区间及外部表格中未核实的单位保留未知，不从名称或常见数值猜单位。

### 6.3 模式和当前执行限制

历史库保留真实 `labType`：0常规、1高通量。当前厂家接口只支持常规模式，是新文件生成和提交阶段的约束，不能为了适配接口把历史索引的1改成0。

目录类别只是材料线索；文件完成状态只是历史文件记录；未选中的报告不是已执行方法。参考库不据此宣称科学适用、当前设备就绪或新模板已经验收。

### 6.4 检索和读取

- `search` 返回材料线索、产品/版本、气体、温度、方法、历史模式、处理条件是否存在及已选报告，供 AI 选择案例，不一次塞入全部报告参数。
- `read` 提供所选案例的核心参考组、来源路径、单位和未知项；重点问题需要的证据应包含表格段、预处理文字和报告计算参数，不只支持原有标量 facts。
- 预处理原文、已解释的报告名称/计算模型/设置加入有界检索文本；未知扩展和绘图参数不成为主要检索信号。
- 超出工具资源上限应明确报告或按定义的分组读取，不截断后声称完整。read 的 query 选择引用，sections 数组显式选择字段组；HTTP 使用同名的逗号分隔 sections 参数。

## 7. 补齐优先级及验收

### 第一批：补齐可用于实验方案参考的主要缺口

1. 材料/预处理原文及来源，优先覆盖这次发现的129份文件。
2. `labType`、P0取得方式与气体关联、完整采集/平衡设置。
3. 准备、检漏、自由空间、样品管、回填，以及样品上下文。
4. 气体身份及成套物性参考，保持版本和原始单位。

### 第二批：补齐报告的计算设置

1. BET 的区间、智能选点与判据，报告选择保持已保存信息。
2. BJH、t-Plot、Langmuir 的模型、系数、区间及修正规则。
3. DFT/HK/Dubinin 的模型关联和计算配置；未确认字段保持待解释，不为追求字段数填入推荐值。

### 提取规则更新后的检查

- 提升提取修订号并显式重新提取/导出快照：源文件 SHA-256 相同不代表旧摘要已有新增字段，不能只按哈希复用旧记录。
- 178份已支持 SAM 均有核心字段覆盖/缺失说明；source 缺失和 extractor 未提取是两种不同状态。
- 129份非空预处理文件保持原文及原始位置；两种语言/重复条目不丢失。
- 两张程序表、T_/D_选项及启用关系保真；数值和单位可对照原文件。
- 对报告做白名单覆盖核对，确认计算设置与显示/缓存分离；选中报告的关键依赖缺失时明确指出。
- 通过实际 search→read 验证 AI 能拿到预处理、采集和平衡设置、所选报告及计算规则，而不只是数据库中有字段。
- 原始案例文件和历史模式不被修改；新实验身份、实际称量和当前设备校准值不从案例直接继承。

## 8. 核对依据

- 案例库178份已支持 SAM、当前内置 SQLite，以及本次逐文件/逐字段审计。
- [Wiki 独立格式解码与基础摘要](../src/wiki/file-index/sam.ts)、[核心参考参数](../src/wiki/file-index/reference.ts)、[索引提取与证据](../src/wiki/file-index/extract.ts)、[索引结构](../src/wiki/file-index/schema.ts)。
- [SAM 读写与单位约定](../skills/device-automation/references/sam.md)、[完整产品配置生成](../skills/device-automation/references/sam-create.md)、[离线配置导入及缓存重置](../scripts/import-sam-profiles.ts)。
- [方法、物理量与适用性](../skills/device-automation/references/methods.md)。现有字段说明未核实的报告专用单位与版本行为仍保留未知。

## 9. 本次实现结果

- `reference.ts` 独立提取核心设置，追加到 `record.configuration.referenceSettings`，保持原有 SAM 检查/写入职责。
- `sam.ts` 直接解析索引器已完成边界校验和哈希计算的字节快照，再将同一个 JSON 对象交给核心提取；不从 `skills/` 导入实现，不重读原件。基础摘要标为 `backend=sam-reference-summary`、`operation=index`，与技能命令结果区分。产品枚举/单位是 Wiki 自己维护的格式契约，有对应回归测试。
- 178份模板均保留历史labType；129份文件的133条非空处理条件原文保留 label、value、presence 与完整原始字段路径。
- 补齐气体/物性与P0关联、采集/平衡、准备/检漏、自由空间、回填、样品管与修正字段。未知参数单位不补默认值，未启用参数保留 active 标记。
- 1946项报告按类型保留计算白名单；结果、缓存和绘图设置不进入参数值。选中DFT报告缺少已提供的模型/文件标识、气体关联冲突、报告类型冲突会保留诊断而不改写来源。
- search 新增 labType/hasPretreatment 条件，摘要提供采集模式和已选报告；read 和 HTTP 都支持11个显式字段组，模型工具端到端测试检查参数实际进入模型上下文。
- 显式导出工具逐条检查完整读取和11个分组的输出预算，成功后原子替换快照；错误保留原快照。当前36个其他厂家SMP仍属于不支持格式。
- 预处理自由文本的结构化解析、尚未确认的报告专用单位和版本参数解释仍属于后续工作；它们的原文/有限候选值已作为来源证据保留，不被包装成已验证执行参数。
