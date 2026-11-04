# 桌面运行图与提示词检查

聊天页右上角的「运行图」打开当前会话的运行检查器。选择一次运行，再选择模型或工具调用，可查看节点状态和模型请求。运行中自动刷新只读快照；历史运行可翻页加载，重启后仍可查看。

## 开发环境后端同步

Vite 热更新只更新界面，不会把新的 Agent 源码装入已经运行的 sidecar。`pnpm desktop:dev` 的启动前置命令才会编译配套后端；长时间运行开发进程时，后端源码修改后需要在任务结束后正常退出当前桌面和开发命令，再启动 `pnpm desktop:dev`。仅刷新 WebView、重新连接或让 Rust 自动重编译，都不等于重新编译 Agent sidecar。

`GET /global/health` 现在返回 `capabilities.runInspection=1` 和 `capabilities.persistedReasoning=1`。桌面会检查这些能力；同一版本号的旧二进制也会被识别，显示更新提示，而不是把缺失路由解释为「暂无运行记录」。二进制验收测试会直接启动编译产物，验证运行图路由、最终请求及重启后的 reasoning，不能只用前端模拟测试代替这一步。

配套构建脚本使用 `pnpm --workspace-root run build:windows|build:linux`。不要改回根项目名称 filter：当前工作区下该 filter 可能输出 `No projects matched` 却以成功状态退出，导致构建脚本误报完成并继续使用旧文件。开发态原生宿主优先加载 `src-tauri/binaries` 中的已准备产物；发行态仍加载安装目录中的配套程序。

## 展示内容

- 拓扑来自当前 LangGraph 编译图的 `getGraphAsync()`，同时保留 `drawMermaid()` 输出；桌面根据实际节点和边绘制，不依赖 LangSmith 云服务或远程渲染。
- 调用列表按执行顺序显示每轮模型调用、工具调用和上下文摘要调用。工具节点本身不调用模型，其输出会出现在下一轮模型请求的 tool 消息中。
- 模型请求在上下文整理/压缩完成后、实际调用网关前保存：模型名、messages、工具定义和 maxOutputTokens。标题生成是独立应用任务，不属于这张主运行图。
- 请求快照位于 SDK 序列化前；例如 OpenAI-compatible 适配器随后将多个 system 消息合并为 instructions。此处不是包含 Authorization 等请求头的 HTTP 抓包。
- 检查器不会执行节点、重放工具或重新发送模型请求。没有快照的旧运行显示不可用，不根据当前配置伪造过去的提示词。

## 持久化与边界

`store-11-run-traces` 在 Agent 数据库中保存 `run_trace_graphs`、`run_trace_nodes` 和 `run_trace_requests`。这是本机检查数据，已配置的模型/API/MCP 凭据在写入前脱敏；完整提示词不进入 JSONL 诊断日志或 SSE，诊断导出也不复制会话数据库。

单次模型请求快照上限 4 MiB，每次运行的请求快照预算 32 MiB；超限记录明确标记 truncated，可保存有界预览。检查快照的截取不改变实际模型输入。节点事件详情有单独的大小限制。检查数据保存失败不会触发模型或工具重试，也不会覆盖执行审计。

## 思考内容

模型返回或流式发送的 reasoning 与回答分开保存。新运行将多次模型调用的 reasoning 按顺序合并；失败/取消时保留已收到的部分。桌面历史消息中始终有可展开的「思考过程」，包括切换会话后重新加载的消息。

默认消息 API 和 CLI JSON 保持只返回普通消息。桌面明确请求 `GET /session/:id/message?reasoning=true` 获取可选 reasoning 字段。旧消息只能显示当时实际保存的内容，无法恢复过去未保存的流式片段。展示的是模型提供的 reasoning，不是推测或重新生成的过程。

## 只读 API

- `GET /session/:sessionId/runs?limit=50&offset=0`：分页运行记录。
- `GET /session/:sessionId/runs/:runId/trace`：图与调用列表，不携带大段请求内容。
- `GET /session/:sessionId/runs/:runId/trace?node=model%3A1`：指定调用的请求快照。

以上接口使用既有鉴权，并验证 run 属于指定 session。原生桥只允许相应 GET 请求。选择节点按需加载请求，切换会话/节点时忽略过期响应，关闭窗口后停止轮询。

## 验证

回归覆盖实际拓扑导出、最终请求一致性、凭据脱敏、会话隔离、快照重启读取、超限标记、多轮与失败 reasoning 保留，以及桌面思考历史加载和节点查看。全量 Bun 根测试 370 通过、9 跳过；工作区包测试 16 通过；Playwright 23 通过；原生请求范围针对性测试通过。
