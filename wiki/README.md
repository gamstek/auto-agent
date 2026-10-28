# Wiki 目录规划

Wiki同时提供推荐知识查询和历史模板参数参考，两类数据分别维护：

```text
wiki/
├─ README.md
├─ sources/                  人工维护的知识源文档
├─ knowledge/
│  └─ recommendations.json   带来源行引用的编译推荐知识
└─ indexes/
   └─ library.sqlite         已解析历史模板的只读SQLite快照
```

## 本期范围

- 模板案例只收录可解析的SAM/SMP配置，供AI对比以前的实验设置。
- SQLite保存结构化参数、单位、产品/版本信息、原始文件哈希和JSON字段定位，并提供全文索引。
- 历史文件保留原实验状态与证据，按用途和目标服务契约核对后可提交执行；新建、修改及另存为使用 SAM 模板脚本。索引摘要不等于完整模板，参数相似不代表科学适用或软件版本已验收。

## 维护方式

- 修改通用推荐时编辑sources文档，并同步更新knowledge中的编译知识；引用行与哈希必须对应。
- 从外部模板目录更新本地索引使用wikiIndexRoots与显式--wiki-index，无模型调用、不修改原件。
- 发布用的模板参考库是indexes/library.sqlite，只读加载。它不含聊天会话、模型凭据或原始SAM二进制。
- 生成新模板使用设备技能随附的 `scripts/lib/sam-profiles.json` 完整配置库与 `sam.js profiles/create`。配置库独立于本 Wiki 摘要，保留来源哈希与产品版本；运行时无需用户提供原始案例文件。
- SQLite中的路径为原始资料相对路径，源哈希用于追溯；离线快照不声称原始文件当前仍有效。
- sources以外的README、编译JSON和SQLite不会再次当作推荐知识源送模型编译。

模型统一使用wiki的query/search/read操作。query读取编译推荐，search/read读取模板参考库；配置了外部wikiIndexRoots时使用显式建立的本地索引。
