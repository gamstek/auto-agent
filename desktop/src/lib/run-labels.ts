const tools: Record<string, string> = {
  skill: '加载技能',
  read: '读取资料',
  wiki: '检索知识',
  execute_script: '执行脚本',
  web_fetch: '读取网页',
  web_search: '搜索网页',
};
const states: Record<string, string> = {
  running: '进行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  timeout: '超时',
  unknown: '结果未知',
  interrupted: '已中断',
  dependency_blocked: '未执行：依赖阻断',
  output_limit: '输出超限',
  waiting_for_operator: '等待对账',
};
export const toolLabel = (name: string) => tools[name] ?? name;
export const runStatusLabel = (status: string) => states[status] ?? status;
