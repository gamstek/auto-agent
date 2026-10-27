## v0.1.4 主要更新

- 支持模型 reasoning 实时展示：终端使用独立的 `think >` 区域，HTTP/SSE 提供 `message.reasoning.delta` 事件。
- 使用官方 OpenAI-compatible 适配器，保留并回传 DeepSeek 工具调用所需的 reasoning，支持后续对话和重启恢复；公开回答与消息历史保持正文输出。
- 修复无换行思考文本等待结束才显示的问题，并过滤跨分片终端控制序列；保留凭据脱敏和取消行为。
- 更新比表面积及孔径分析模板知识，包含 106 条材料推荐和 11 条测试需求方案，同步内置知识快照和来源引用。

## 下载与运行要求

| 平台        | 下载文件         |
| ----------- | ---------------- |
| Windows x64 | `auto-agent.exe` |
| Linux x64   | `auto-agent`     |

可执行文件无需安装 Bun。技能脚本优先使用已安装的 Node.js，找不到默认 Node.js 命令时自动使用内嵌运行时。自动化流程脚本为模拟实现，运行状态会持久化；Climber 脚本通过配置的 Python 子服务连接实际仪器，使用前需配置并确认对应服务可用。

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
