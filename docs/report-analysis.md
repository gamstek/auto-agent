# SiCOPE 报告分析

`report_analysis` 通过 Corax 在本机读取带文本层的 SiCOPE PDF。`analyze` 返回样品、SAM 文件名、分析口、原报告概要、已识别模型章节和有效点数，也可显式复算 BET、BJH、NLDFT。`supplement` 按 `targets`（`bet`、`bjh_adsorption`、`bjh_desorption`、`nldft`）检查并补算缺项；普通 BET 已有但明确请求 BETSI 时，仍可补做智能选点。缺失 DFT 且未指定核时返回适配候选，待用户确认材料、孔形及分支后再算。`get_points` 分页返回原始点；`list_models` 和 `inspect_model` 查询内置核。可用 `expectedSamName` / `expectedPort` 校验报告归属。

- `calculate` 直接接收 `isotherm: { gas, temperatureK, uptakeUnit, branches }`。分支为 `adsorption` / `desorption`，点格式为 `{ pp0, uptake }`，单位为 `cm3(STP)/g` 或 `mmol/g`。本地 Node 调用方可使用 `auto-agent/report-analysis` 的同一计算入口。
- 普通 BET 默认按 0.045–0.31 拟合，记录实际点数、C、R²、BETSI 开关和一致性提示。两点拟合即使 R² 为 1 也不作为可靠性证据。单层容量不为有限正值时结果为 `invalid`，面积返回 `null`，仍保留诊断。用户可指定区间和吸附质分子横截面积；默认横截面积来自所选 `.ADS`。
- `bet: { "betsi": {} }` 启用 BETSI 智能选点。默认至少 5 点、R² ≥ 0.995、实测单层压力与理论值相差不超过 20%；可覆盖 `minPoints`、`minRSquared`、`maxPressureErrorPercent` 及搜索压力范围。实现沿用 BETSI 的窗口判据与排序，实测单层压力采用线性插值；算法标识为 `betsi-linear-v1`。未找到合格窗口时返回原因，不降级到普通拟合。
- `bjh: [{ "branch": "adsorption" }, { "branch": "desorption" }]` 分别计算吸附支和脱附支。默认压力范围 0.1–0.995、孔径 1.7–300 nm、Harkins–Jura 厚度及 standard 修正；可选 Halsey、KJS 或覆盖压力、孔径和已确认的 Kelvin 系数。计算使用 `.ADS` 液体体积换算及分支系数；G12 氮气约 77 K 的缺省 Kelvin 系数会明确标记。脱附支没有足够的实测点时拒绝计算；有数据时按 G12 处理共享转折点。
- `list_ads` 列出内置 G12 吸附质物性。默认只在气体和标称温度可唯一匹配时选择；候选不唯一或未标温度时须指定已确认的 `adsId`。计算结果记录物性文件标识和哈希。
- NLDFT 按 `modelId` 选择内置核，例如 `nldft: [{ "modelId": "model001" }]`。模型必须同时在 G12 的 `RepCalcModel.xml` 中注册并有内置 `.mod`，部署和加载时校验 SHA-256。根据模型头校验气体、温度和指定分支；材料和孔形由用户需求或已确认条件确定。
- 不明确的 PDF 分支需要用户确认后指定 `adsorptionPointCount`。程序保留实测行序，不从图上补点。等温线吸附量统一为 cm³(STP)/g；明确标为 mmol/g 的数据按 22.414 换算，单位缺失或不受支持时报告页码并停止复算。
- `analyze` 或 `supplement` 可显式设 `exportPdf: true`，生成按 SiCOPE 报告结构组织的补充 PDF，并返回 `supplementPdf` 路径。默认中文（`reportLanguage: "zh-CN"`）；用户要求英文时传 `reportLanguage: "en"`。报告依次展示样品及分析条件、原报告概要、补算结果、分模型曲线与明细表、计算记录；`supplement` 还列出每项请求的处理状态及原因。文件位于应用工作区的 `report-analysis/` 下。

## NLDFT 运算与可比性

首版解码 G12 `.mod` 并复用其压力/孔宽网格和 `22.414` 的 STP 换算。在模型覆盖的实测压力点上，按对数压力插值构造响应矩阵 `A`，保留核中的跃迁边界。以非负孔容贡献 `v` 重建 `q ≈ Av`，最小化 `||Av - q||² / (点数 × 核响应的均方值) + λ||Dv||²`，其中 `D` 是同孔几何的相邻孔宽 bin 差分。可以给定 λ，也可返回扫描结果并按 L 曲线选取。`converged` 为假时结果只供诊断。

输出包括每个孔宽 bin 的孔容和累计孔容（cm³/g）、实测和重建吸附量（cm³(STP)/g）、残差、RMSE、λ、核文件哈希及方法标识。收敛时返回 `poreBands`，默认按 1、2、5、10、20、100 nm 分段，可传 `poreWidthEdgesNm`；左端点包含、右端点不含，最后一段包含余量。此版本采用离散 NNLS；SiCOPE 的样条反演、插值和 λ 的尺度不同，同名参数不保证逐项数值等同。SiCOPE 校验应使用同一份等温线和核，并对照重建曲线和累计孔容。

## 验证

`node --import tsx --test tests/node/report-analysis.test.ts` 运行合成回归和内置模型校验。设置 `SICOPE_REPORT_FIXTURE` 为 `1-空气_微孔_Port1_20261113174333.PDF` 的绝对路径、`SICOPE_PC_FIXTURE` 为 `江苏青昀_PC-C_快速介孔_Port4_20261106095046.PDF` 的绝对路径，可一并验证真实报告的普通 BET、BETSI、BJH、缺项补算、NLDFT 分段和 PDF 导出。
