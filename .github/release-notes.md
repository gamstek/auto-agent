## v0.1.7 主要更新

- 新增 SAM/SMP 模板新建、修改和另存为，写入 Qt 封装，保留产品版本、原始单位、来源哈希及未修改的扩展字段。
- 新增随程序发布的 G5/G12 N₂ 完整配置及 BET、介孔、微孔方法程序；可根据测样参数直接生成 SAM，无需用户提供基准文件或完整 JSON。
- 新模板生成独立 UUID 与产品对应的新建状态，不继承历史样品称量、运行数据和报告结果；缺少样品名或称量时可保存待填草案，逐项修改及另存为，结果明确返回未填项。
- 新建和另存为不覆盖已有目标；修改要求源文件 SHA-256 匹配。写入后可将厂家可读的 SAM 路径交给现有 Climber 批次启动接口。
- 测样流程按需查询参考设置、准备模板并提交仪器，对外以测试任务和结果为主线，不主动将模板内部操作列成功能菜单。
- 提示词按模块归属整理：技能、工具、宿主事实各自维护，Agent 负责请求组装，历史摘要归上下文模块；自定义角色替换及网络策略保持独立。
- 补充无基准文件生成、单位换算、草案编辑、来源追溯、启动接口 mock 和独立二进制离线生成验收。

### 配置说明

新生成配置使用 `"systemPrompt": ""` 跟随当前内置角色。已有配置原样保留；如希望采用本版默认提示词，可将该字段设为空并重启。

按参数生成模板未指定 path 时，默认保存到当前用户主目录的 `Auto-Agent/templates`；可通过配置项 `scriptEnv.SAM_OUTPUT_DIR` 指定绝对输出目录。内置 N₂ 配置来源版本为 softwareVersion=2.1、clientVersion=2.1.26.0416，保留来源哈希；其他气体或版本需要相应完整配置。生成文件、样品字段齐全、仪器受理和实际完成是不同事实，执行前按设备契约核对配置适用性、厂家可读路径和当前状态。

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
