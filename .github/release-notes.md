## v0.1.9 主要更新

本版包含 v0.1.7 以来的厂家接口调整和 CI 修复。v0.1.8 因发布流水线失败未发布，相关功能随本版一并交付。

- Climber 改为直接连接厂家 PC 软件的 18080 HTTP API，默认基址为 `http://127.0.0.1:18080/api/v1`，不再通过 Python 子服务。
- 使用 `health`、`status`、`register`、`start` 四个命令。登记发送 `{batchId, experiments}`；明确成功后，再以独立请求启动已登记批次。移除旧命令别名及 commandId/payload 等子服务封套。
- 原管号在登记前按 `n % 72 or 72` 转换为厂家接口管号，拒绝取余重号，返回原管号与厂家管号映射。保留批次、实验与操作阶段，校验厂家响应封套及批次身份。
- 写请求超时、无效回执或身份不匹配返回 `OUTCOME_UNKNOWN`；脚本工具会将其持久化为 unknown，阻断后续依赖操作，防止登记效果不明时继续启动。
- 测样时优先复用已知信息及工具返回的模板路径，没有合适模板时自行生成；只询问实际缺少的称量、物理位置或访问条件，不再默认要求用户提供现成 SAM 或完整接口字段表。
- 同步默认配置、开发配置、技能和集成文档，补充厂家接口 HTTP mock、SAM 登记/启动链路及未知登记结果阻断测试。
- 修复 Windows CRLF 换行导致 SAM 参考文档超过16 KiB读取限额的问题：解析与写入说明拆分，补充 LF/CRLF 资源加载回归测试。
- 改进 Windows Climber CLI 测试：等待子进程 close 并完整收集 stdout/stderr 后解析，补充空输出诊断，批量 CLI 用例使用独立测试时间预算，保留全部接口校验与禁止重试断言。

### 配置说明

新生成配置使用 `"systemPrompt": ""` 跟随当前内置角色。已有配置原样保留；如希望采用本版默认提示词，可将该字段设为空并重启。

**从旧版升级时，已有配置不会自动覆盖。** 将配置中的连接地址改为厂家 API 基址，包含 `/api/v1`，然后重启：

```json
{
  "scriptEnv": {
    "CLIMBER_SERVICE_URL": "http://127.0.0.1:18080/api/v1",
    "CLIMBER_TIMEOUT_MS": "5000"
  }
}
```

回环地址适用于同机部署；异机部署时改为厂家 PC 的实际地址。登记接口接收厂家可读的 `.SAM` 绝对路径，需按部署规则配置模板目录与访问权限。接口测试使用本地 HTTP mock，不等于真实仪器已完成现场验收。

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
