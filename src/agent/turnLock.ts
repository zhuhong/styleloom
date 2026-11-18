/** 同一项目同时只允许一轮 Agent 对话（用户聊天或渲染完成唤醒）。 */
const activeProjects = new Set<string>();

export function isAgentTurnActive(projectId: string) {
  return activeProjects.has(projectId);
}

export function tryBeginAgentTurn(projectId: string) {
  if (activeProjects.has(projectId)) return false;
  activeProjects.add(projectId);
  return true;
}

export function endAgentTurn(projectId: string) {
  activeProjects.delete(projectId);
}
