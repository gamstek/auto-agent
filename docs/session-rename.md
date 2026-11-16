# 历史会话重命名

## 自动主题标题

桌面新建会话的首条消息明确受理后，后台使用当前配置的模型和通用 session summary 提示词概括主题与意图，使用输入内容的主要语言，最多 32 字符，不限定业务领域；不等待完整回复，也不阻塞聊天或切换。只发送首条提问的有界文本，不读取历史、不提供工具、不创建额外会话或记忆。生成超时、失败或输出无效时保留 Corax 从首条消息派生的标题，不自动重试。

标题生成使用固定认证的 `POST /session/:id/title-suggestion`，Rust 转发至 `/desktop/session-title`，返回标题及后端 generation；保存仍使用已有原生重命名接口。自动保存绑定生成时的后端身份，配置/连接身份变化后丢弃待处理结果。进程内 `SessionTitles` 仅协调本次新建会话的生成与保存，容量有界，不新增标题数据库或持久化任务。已有历史会话不批量重命名。

手动重命名立即取消同会话尚未提交的自动标题；若自动保存已经发出，手动保存排在它之后，最终仍以手动名称为准。后续聊天不反复生成标题。

## 手动重命名

在侧栏会话上右键，选择“重命名”。聚焦会话后也可按 F2 直接编辑，或 Shift+F10
打开菜单。右键不切换当前会话；菜单定位在窗口内，点击外部、滚动或 Escape 关闭。
弹窗复用共享 Input/Button，名称自动选中，取消时恢复列表焦点；保存失败保留输入。

名称去除首尾空白后须为 1–100 个 Unicode 字符，不接受控制字符。保存期间禁止重复提交。
成功后列表、顶部名称和搜索同步更新；较早发起的列表刷新不能覆盖刚确认的新标题。

## 原生持久化

Corax 0.1.1 没有现成重命名 API。经用户批准，`patches/@coraxjs__core@0.1.1.patch`
新增认证路由 `PATCH /corax/v1/session/:sessionId/title`，JSON 仅允许 `{title}`。
它使用原生 `routeAuth`，并将修改限制在顶层会话的稳定 anchor；不发送消息、回放 workflow、
查询历史、调用模型、替换 session ID 或新增会话数据库。

SDK 内部通过 World 的原生属性更新保存 `$corax.title` 和 `$corax.user_title`。
会话目录始终优先稳定 anchor 的用户标题，使后续生成的标题或 handoff owner 不能覆盖用户命名。
应用与 WebView 只访问固定 HTTP/IPC 接口，不直接读写数据库或导入 SDK 私有实现。

Rust 对 PATCH 路径、字段和长度进行限制，并保留普通写入的生命周期保护。
只在 HTTP 确认后更新显示；网络失败不自动重放，用户可刷新列表核对保存结果。

## 安装和验证

补丁通过 pnpm patchedDependencies、共享锁文件及 `pnpm install --frozen-lockfile` 应用。
部署/安装器要求 SQLite 来源、原生历史与重命名产物同时存在。该补丁没有历史扫描或并发改动。

- `tests/node/corax-session-title.test.ts`：认证、校验、原生 SQLite 持久化、重开、handoff 标题优先级和历史事件不变。
- `tests/corax/runtime.test.ts`：实际编译的 dev/start/packaged 原生 HTTP 路由和目录展示。
- `desktop/e2e/desktop.spec.ts`：目标会话、不切换聊天、键盘、取消、输入校验及保存失败反馈。
- Rust 测试：固定 PATCH 方法和路径白名单。

上游发布等价重命名能力后，应替换此扩展并移除 patchedDependencies，不叠加到其他 SDK 版本。
