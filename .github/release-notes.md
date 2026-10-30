## v0.1.10 主要更新

### SAM 模板与 Climber

- G5 新建采用已核对的 `2.11.1 / 2.11.1.26.1028` 完整配置，保留版本相关报告 options、勾选项、原生扩展和空运行字段，重置历史身份与已识别的计算缓存；G12 保留独立产品版本。
- 新建、修改和另存为支持 `reportTypes` 选择已有完整报告，仅切换 selected；保留方法来源的实际压力/注气增量采集模式，以及各自的 T_/D_ 低压选项。
- 明确 `labType=0` 为常规模式、`labType=1` 为高通量模式。当前厂家接口只支持常规模式：新建固定数值0，修改/另存为将继承的非零或缺失值修正为0并返回 normalizedFields，显式指定非零值会在写入前被拒绝。只读检查保留历史原值。
- `experiments[].samPath` 仅接受厂家 Windows 主机上盘符开头、含具体文件名的绝对 `.SAM` 路径，例如 `E:\templates\example.SAM`；目录、相对路径和网络路径在 HTTP 请求前被拒绝。异机生成文件按部署规则取得厂家 Windows 盘符路径，接口本身不传输文件。
- Climber start 解析两种已记录的厂家 v1 回执结构，同时严格核对批次与状态；身份或状态矛盾仍按效果未知处理，不自动重试写入。

### 文件日志与执行对账

- 自动写入 `dataDir/logs/agent.jsonl` 和 `skills.jsonl`，按文件2 MiB轮转、保留3份备份，关联 run/execution 标识并脱敏；记录有界错误、HTTP阶段及结构摘要，不保存完整参数、原始 stdout 或 token 流。
- 持久化未知执行的结构化诊断；待对账会话的后续消息直接返回诊断。新增终端 `/review`、`/resolve <runId> <核对说明>` 以及鉴权 HTTP review/resolve_review 接口，显式记录操作者核对结论，原 execution 保持 unknown，不重放旧 checkpoint。
- 改进子进程输出收集及技能诊断通道，将诊断预算与命令结果分开；模型请求超时显示明确的 `model_timeout`，停止后续依赖工具。

### 交互与技能

- 终端支持流式及历史 GFM 表格，适配中文、emoji、列宽、长路径和窄屏布局。
- 设备技能按当前目标选择资料与操作入口，增加方法/单位和诊断恢复参考，复用已知样品信息；新增显式真实模型多场景评测脚本与回归问法集合。
- 默认 `maxSteps` 从12调整为24，减少多步骤文件准备时过早耗尽预算。

### 配置说明

新生成配置使用 `"systemPrompt": ""` 跟随当前内置角色，并使用 `"maxSteps": 24`。已有配置原样保留；如希望采用本版默认角色和步数，请修改对应字段后重启。

**从旧版升级时，已有配置不会自动覆盖。** 将配置中的连接地址改为厂家 API 基址，包含 `/api/v1`，然后重启：

```json
{
  "scriptEnv": {
    "CLIMBER_SERVICE_URL": "http://127.0.0.1:18080/api/v1",
    "CLIMBER_TIMEOUT_MS": "5000"
  }
}
```

回环地址适用于同机部署；异机部署时改为厂家 PC 的实际地址。登记接口接收厂家可读的 Windows 盘符 `.SAM` 完整文件路径，需按部署规则配置模板目录与访问权限。接口测试使用本地 HTTP mock，生成文件的结构验证不等于真实仪器已完成现场验收。

## 下载与运行要求

| 平台        | 下载文件         |
| ----------- | ---------------- |
| Windows x64 | `auto-agent.exe` |
| Linux x64   | `auto-agent`     |

可执行文件无需安装 Bun。技能脚本优先使用已安装的 Node.js，找不到默认 Node.js 命令时自动使用内嵌运行时。自动化流程脚本为模拟实现，运行状态会持久化；Climber 脚本直连厂家 HTTP API，使用前配置厂家地址并确认对应服务可用。

## 快速开始

下载对应平台的文件，在所在目录执行：

### Windows（PowerShell）

```powershell
$env:AUTO_AGENT_API_KEY = '替换为模型服务的 API Key'
.\auto-agent.exe
```

### Linux（Bash）

```bash
chmod +x ./auto-agent
export AUTO_AGENT_API_KEY='替换为模型服务的 API Key'
./auto-agent
```

首次运行会创建 `~/.auto-agent/config.json`，默认模型为 `deepseek-flash`，服务地址为 `https://api.deepseek.com`。已有配置不会被覆盖；如使用其他模型，请修改 `model` 和 `baseURL` 后重启。API Key 通过环境变量提供，不要写入配置或提交到仓库。

聊天输入 `/exit` 退出；Ctrl+C 在回复期间请求取消，在空闲时退出。使用 `--help` 查看全部选项，或用 `--config PATH` 指定配置文件。

## 启动 HTTP 服务

默认需要至少 16 个字符的随机访问令牌，它与模型 API Key 不同。保留上面的 `AUTO_AGENT_API_KEY`，再执行：

```powershell
# Windows
$env:AUTO_AGENT_TOKEN = [guid]::NewGuid().ToString('N')
.\auto-agent.exe serve
```

```bash
# Linux：替换下方占位值，使用自己的随机令牌
export AUTO_AGENT_TOKEN='替换为至少16个字符的随机令牌'
./auto-agent serve
```

默认地址：`http://127.0.0.1:4096`。客户端请求需携带 `Authorization: Bearer <访问令牌>`。仅限可信本机使用时，可通过 `serve --no-token` 关闭本地鉴权；不要通过代理或端口转发公开无鉴权服务。

服务启动后，访问：

- [服务首页](http://127.0.0.1:4096/)
- [集成指南 llm.txt](http://127.0.0.1:4096/llm.txt)：包含会话、消息、事件流和取消接口
- [健康检查](http://127.0.0.1:4096/global/health)：不代表模型凭据有效

完整说明见 [README](https://github.com/gamstek/auto-agent#readme)。启动诊断和进度写入 stderr，回复和 JSON 数据写入 stdout。

---
