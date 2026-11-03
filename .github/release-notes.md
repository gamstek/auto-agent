## v0.1.11 主要更新

### 历史模板核心参考库

- 重建178条历史SAM参考的内置 `library.sqlite`，索引修订为 `wiki-templates-v3`。补齐129份模板的133条非空预处理原文，以及气体/物性、P0取得方式、采集/平衡、准备/检漏、自由空间、样品管和回填等核心设置。
- 1946项报告除类型、名称和勾选状态外，保存已识别的拟合、选点、模型和修正参数；保留原始字段来源、单位、启用状态和样品/设备上下文，排除绘图样式与历史计算缓存。
- 历史 `labType` 保留原值；当前厂家接口要求常规模式0的执行约束继续由SAM写入和设备契约落实，历史高通量模式1不会被改写成0。
- Wiki直接解析索引器已读取的字节，不再导入技能包内部源码或重复读取源文件。新增架构边界、格式解析与核心字段回归测试。
- Wiki搜索新增 `labType`、`hasPretreatment` 条件；工具与HTTP读取支持 `sections` 分组获取核心参数。新增显式离线导出脚本，完成完整性与读取限额验证后发布快照。

### 执行、历史上下文和服务修复

- 已启动脚本的超时、取消或输出超限按效果未知处理，即使进程已清理也会阻断后续操作并要求对账；确认未启动的取消保持 cancelled。
- 明确的工具失败会跳过同一模型回合的剩余调用，返回 `dependency_blocked` 结果，让模型先检查错误再重新规划。
- 修复历史消息在摘要前静默截断：使用近期窗口和持久化连续历史前缀摘要，重启可复用；原消息保留，摘要失败不推进对应保存位置。
- 修复复用新版内置知识时更新返回成功却仍保留过期快照的问题。
- 关闭服务时结束SSE订阅和心跳，再清理剩余HTTP连接。

### 模型诊断与终端显示

- HTTP402单独显示余额/计费提示，DNS、连接、TLS和响应解析错误分别分类。新增有界 `model.diagnostic` 文件日志，关联run/step并记录可用的HTTP状态、已知传输错误码与请求ID，不记录原始请求/响应正文。
- 普通stdout/stderr正文不写入文件日志；保留字节数、状态和筛选后的结构化诊断。
- 终端普通回复在短暂Markdown前瞻后增量显示，不必等待整行结束；未及时闭合的标记有界退化为字面文本，表格和代码块保持结构化处理。

### 配置说明

升级会自动新增历史摘要表 `session_context`，原消息、执行审计和待对账状态保留。长历史摘要是可能产生费用的无工具模型请求，每次用户请求最多处理8批，失败不会静默删除历史。

内置模板快照随程序更新，无需用户手动导入。已配置外部 `wikiIndexRoots` 的部署需要显式执行 `--wiki-index` 或 `POST /wiki/index/update` 重建旧版索引，以采用新增字段；不会在启动或聊天时自动扫描原件。

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
