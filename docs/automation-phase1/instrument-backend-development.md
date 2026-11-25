# AI 自动化一期｜自动化仪器后端开发

以下四个批量接口由**自动化仪器控制软件的后端**提供。中控负责模板校验、实验创建、设备调度及状态回传；Auto-Agent 调用接口并解释结果。接口基路径为 `/api/automation/v1`，复用仪器系统的身份与权限校验。

## 接口契约

| 步骤                | 接口                        | 批量请求                                        | 返回（`200`）                       |
| ------------------- | --------------------------- | ----------------------------------------------- | ----------------------------------- |
| 1. 获取可用模板     | `GET /experiment-templates` | 可选的多个 `templateId`                         | `items`：符合条件的可用模板。       |
| 2. 选择模板创建实验 | `POST /experiments`         | `items`：每项一组模板版本和样品管，并带实验编号 | `items`：各实验的受理结果。         |
| 3. 获取中间过程     | `GET /experiments/progress` | 多个 `experimentId`                             | `items`：各实验的状态和阶段时间。   |
| 4. 解析结果         | `GET /experiments/results`  | 多个 `experimentId`                             | `items`：各实验的结果或未就绪状态。 |

`GET` 批量查询使用同名参数多次传值，如 `?experimentId=<编号1>&experimentId=<编号2>`。按实验编号匹配响应项；单项失败放在对应的 `items` 项里（`status: "error"`，带 `code`、`message`），不影响同批其他项。请求格式不正确时整体返回 `400`，错误体为 `{ "code": "…", "message": "…" }`。

### 1. 获取可用模板

不传参数时获取当前用户的全部可用模板；传 `?templateId=bet-n2&templateId=co2-pore` 时，只返回命中的可用版本。示例响应：

```json
{
  "items": [
    {
      "templateId": "bet-n2",
      "versionId": "v3",
      "name": "氮气 BET",
      "description": "比表面积测量"
    },
    {
      "templateId": "co2-pore",
      "versionId": "v2",
      "name": "二氧化碳孔径",
      "description": "孔径分析"
    }
  ]
}
```

### 2. 选择模板创建实验

一次请求提交整批组合，每项一个样品管和一个模板版本。Auto-Agent 为每项生成不同的 `experimentId`（UUID），后续查询沿用该编号。示例请求：

```json
{
  "items": [
    {
      "experimentId": "f9bb4d01-d8aa-466c-83a4-955111cb1170",
      "templateId": "bet-n2",
      "versionId": "v3",
      "tubeCode": "T001"
    },
    {
      "experimentId": "f9bb4d01-d8aa-466c-83a4-955111cb1171",
      "templateId": "co2-pore",
      "versionId": "v2",
      "tubeCode": "T002"
    }
  ]
}
```

逐项校验模板版本和样品管，已创建项返回 `{ "experimentId": "…", "tubeCode": "…", "status": "accepted" }`，表示实验已创建，可查询进度。管不可用等情况返回单项错误。同一编号、同一参数重复提交返回已有的受理结果；同一编号对应不同参数返回该项 `EXPERIMENT_ID_CONFLICT`。中控防止同一管重复创建活动实验。

### 3. 获取中间过程

按请求的实验编号逐项返回实际状态。实验和各阶段的状态为 `pending`、`running`、`completed` 或 `failed`。阶段为 `pretreatment`、`weighing`、`analysis`；时间为带时区的 ISO 8601，未发生时为 `null`。查不到的实验返回单项 `EXPERIMENT_NOT_FOUND`。

```json
{
  "items": [
    {
      "experimentId": "f9bb4d01-d8aa-466c-83a4-955111cb1170",
      "status": "completed",
      "steps": [
        {
          "stage": "analysis",
          "status": "completed",
          "startedAt": "2026-11-24T06:00:00Z",
          "finishedAt": "2026-11-24T07:00:00Z"
        }
      ]
    },
    {
      "experimentId": "f9bb4d01-d8aa-466c-83a4-955111cb1171",
      "status": "running",
      "steps": [
        {
          "stage": "pretreatment",
          "status": "running",
          "startedAt": "2026-11-24T06:30:00Z",
          "finishedAt": null
        }
      ]
    }
  ]
}
```

### 4. 解析结果

已就绪项返回 `ready` 和实际测量数据，结果仍待生成的项返回 `not_ready`。实验查询失败或确定不再产出结果时返回单项错误。示例响应：

```json
{
  "items": [
    {
      "experimentId": "f9bb4d01-d8aa-466c-83a4-955111cb1170",
      "status": "ready",
      "metrics": [{ "name": "BET", "value": 152.4, "unit": "m²/g" }],
      "isotherms": [
        { "branch": "adsorption", "xUnit": "P/P0", "yUnit": "cm³(STP)/g", "points": [[0.1, 12.5]] }
      ]
    },
    { "experimentId": "f9bb4d01-d8aa-466c-83a4-955111cb1171", "status": "not_ready" }
  ]
}
```

`points` 的每一项为 `[x, y]`；已就绪但没有等温线时，`isotherms` 返回空数组。

[一期需求](requirements.md) · [Auto-Agent 接入开发](auto-agent-development.md)
