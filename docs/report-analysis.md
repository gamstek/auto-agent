# SiCOPE 报告分析

`report_analysis` 通过 Corax 在本机读取带文本层的 SiCOPE PDF。`analyze` 返回样品、SAM 文件名、分析口、原报告概要和有效点数；可一并运行 BET 和一至四组 NLDFT。`get_points` 分页返回等温线原始行，`list_models` 列出内置模型，`inspect_model` 按 `modelId` 显示单个核的信息。实验上下文已有 SAM 文件名或分析口时，传 `expectedSamName` / `expectedPort` 做关联校验。

- BET 默认按 SiCOPE 常用范围 0.045–0.31 进行线性拟合，报告 C 常数和一致性提示；用户可指定区间和吸附质分子横截面积。
- NLDFT 按 `modelId` 选择内置核，例如 `nldft: [{ "modelId": "model001" }]`。15 个 G12 `.mod` 随应用离线分发，部署和加载时校验 SHA-256。根据模型头校验气体、温度和指定分支；材料和孔形由用户需求或已确认条件确定。
- 不明确的 PDF 分支需要用户确认后指定 `adsorptionPointCount`。程序保留实测行序，不从图上补点。等温线吸附量统一为 cm³(STP)/g；明确标为 mmol/g 的数据按 22.414 换算，单位缺失或不受支持时报告页码并停止复算。

## NLDFT 运算与可比性

首版解码 G12 `.mod` 并复用其压力/孔宽网格和 `22.414` 的 STP 换算。在模型覆盖的实测压力点上，按对数压力插值构造响应矩阵 `A`，保留核中的跃迁边界。以非负孔容贡献 `v` 重建 `q ≈ Av`，最小化 `||Av - q||² / (点数 × 核响应的均方值) + λ||Dv||²`，其中 `D` 是同孔几何的相邻孔宽 bin 差分。可以给定 λ，也可返回扫描结果并按 L 曲线选取。`converged` 为假时结果只供诊断。

输出包括每个孔宽 bin 的孔容和累计孔容（cm³/g）、实测和重建吸附量（cm³(STP)/g）、残差、RMSE、λ、核文件哈希及方法标识。此版本采用离散 NNLS；SiCOPE 的样条反演、插值和 λ 的尺度不同，同名参数不保证逐项数值等同。SiCOPE 校验应使用同一份等温线和核，并对照重建曲线和累计孔容。

## 验证

`node --import tsx --test tests/node/report-analysis.test.ts` 运行合成回归和内置模型校验。设置 `SICOPE_REPORT_FIXTURE` 为 `1-空气_微孔_Port1_20261113174333.PDF` 的绝对路径，可一并验证真实 PDF 与内置模型核。
