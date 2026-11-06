# 应用接入层

lib 实现配置、Corax 宿主约定、Agent 通用 Wiki 装配及 Climber MCP 调用适配。Agent 循环属于 Corax，知识编译与页面发布属于 packages/llm-wiki；SAM 和设备规则属于 packages/climber-mcp，领域工作流属于 Skill，桌面传输归 Rust，UI 投影归 React。

Corax 将 `lib/` 作为 authored-module 目录编译，其中只放受支持的代码模块；架构说明保存在 docs，不把 README 混入编译目录。

```text
lib/
├─ config/
│  ├─ schema.ts       当前 JSON schema、默认值与 AppConfig 类型，无文件读写
│  ├─ paths.ts        默认配置位置与布局标识，不依赖 schema
│  ├─ index.ts        统一入口：配置 IO、相对路径解析与进程内快照
│  └─ runtime.ts      Corax 数据目录与宿主占用锁
├─ host/              ShellJS 宿主 Provider、进程生命周期和原生路径/文件 I/O
├─ wiki/
│  ├─ index.ts        用户知识库与预置集合装配，不创建另一个聊天循环
│  ├─ ingest.ts       显式两阶段模型调用，无工具执行或自动重试
│  └─ reference.ts    通用只读索引适配，元数据过滤、固定引用与分页
└─ climber/
   ├─ index.ts        固定 Node stdio MCP 调用、预算与可信调用身份
   └─ instruments.ts  临时只读投影，不保存厂家任务数据库
```

## 依赖方向

- config/schema 只依赖 Zod 和纯文本来源契约，不依赖模型、桌面或资料连接。
- `config/index` 负责文件读写。需要布局标识的安装脚本只导入 `config/paths`，不会初始化整个 schema。
- `config/runtime` 只管理数据目录占用，`config/index` 提供单份进程内配置快照；二者不依赖桌面 UI、协议或具体业务工具，也不重建 Corax 的运行循环。不另设 lib/runtime 或保留旧路径转发。
- `desktop/src-tauri/src/corax.rs` 直接启停标准 Corax CLI、管理认证和事件传输；`desktop/src/lib/corax-projection.ts` 使用官方 reducer，不读取配置、不创建 Wiki、不生成本地会话 ID。
- `channels/desktop.ts` 在 Corax 进程内使用官方 reducer 和会话句柄提供退出保护所需的活动状态；聊天命令与事件仍使用原生 Corax 路由。
- 设置中的工具/技能目录由 Rust 读取官方 Corax info 并投影显示字段；`channels/desktop.ts` 仅补充与模型注册共用定义的动态工具元数据，不执行工具或连接仪器。内置能力不可禁用。
- `lib/model.ts` 仅解释模型服务实际返回的认证错误，不按模型名、服务商或 Key 是否为空添加认证要求。
- `sandbox.ts` 仅选择公开 Corax 宿主 Provider，lib/host 负责 ShellJS/文件 I/O；保留原生工具，不在应用里复制 Bash/read_file/write_file/glob/grep 实现。Provider 不需要 JustBash 模板或构建机个人缓存，也不负责设备协议。
- lib/wiki 为统一 Wiki Tool 装配 knowledge/reference 集合；知识编译与只读检索保留各自数据边界。reference 适配器接收应用绑定的数据源，不在工具 schema 中暴露数据库路径、SQL 或领域专用字段；人工材料规则由 Skill references 阅读。
- lib/climber 只启动随应用发布的固定 MCP CLI；不接受模型指定的解释器、脚本、环境或 shell 命令。SAM schema、完整产品配置、单位和文件写入由 MCP 包拥有。Corax 动态工具直接复用包导出的定义；Skill 只维护操作工作流和解释边界。
- channels/instruments 通过同一 MCP 客户端只读查询，提供给受限 Rust IPC；不调用设备写工具，也不绕过 MCP 直接访问厂家。缓存仅用于显示最后已知状态，失败标 stale，不推断物理状态。
- `scripts/` 是入口组合层：选择配置、取得占用锁、启动标准 Corax CLI，并在退出时关闭自己拥有的资源。

## 生命周期

LLM Wiki 写入用独立写入锁和版本发布指针，查询读取既有版本；页面/原文不是缓存。固定内置 SQLite 每次只读访问后关闭，不物化一份用户资料库。Rust 持有令牌、订阅和 Corax 进程树，退出前检查任务。React 只维护投影，重连不重放写入。

MCP 客户端传递 Corax 取消信号，每次调用后关闭自己拥有的 stdio 连接/子进程；不自动重连重放。未发送的写入为 rejected/not-started，发送后回执不明为 unknown。MCP 设备操作和预留存放于 dataDir/climber，重启仍阻断未知写；SAM 未知写入按实际路径/哈希核验。停止 MCP 或取消回复都不证明设备停止。

Rust 的后端生命周期锁只用于取得连接句柄和保留在途写请求，不跨普通 HTTP/历史读取等待。只读请求并行执行；写请求独立串行，在途计数和受理记录共同保护退出/重启。会话历史仍来自 Corax 原生流，当前会话按 generation/startIndex 增量同步，不增加活动缓存、跨会话历史缓存或本地对话数据库。

普通消息发送遵循官方 SDK 的会话就绪协议：仅对 HTTP409 且 code=session_not_ready 的明确未受理响应有界等待；网络错误、响应解析失败和服务端效果未知不重发。明确拒绝与未知受理使用不同错误元数据，界面保留未发送草稿。

移动后的模块不保留旧路径转发文件。修改结构时同步更新 authored modules、CLI/桌面入口、原生配置测试和发布资源验证。

## 构建、安装与验证脚本

- `desktop/scripts/prepare-runtime.ts`：构建与部署 `desktop/src-tauri/runtime` 资源，不执行用户目录清理。
- `desktop/scripts/release.ts`：校验发布版本和签名环境、构建签名安装包并生成 feed manifest；路径从脚本位置确定。
- `scripts/shared/`：入口共用的 Node 子进程和 pnpm 调用辅助，不属于 Corax authored-module 运行层。
- `desktop/src-tauri/installer/`：NSIS hook 和专用 reset-data 实现；只有安装器执行重置。
- `desktop/tests/native/smoke.ts`：原生窗口、配置与会话联调，不混入构建脚本。
