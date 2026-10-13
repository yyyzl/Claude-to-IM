/** /quota 的账号范围说明、窗口报告与脱敏错误；不访问认证或会话存储。 */
import type { AccountQuota, AccountQuotaWindow, LLMProvider } from '../host.js';
import { escapeHtml } from '../adapters/telegram-utils.js';

const beijingTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function windowName(window: AccountQuotaWindow, position: string): string {
  const minutes = window.windowDurationMins;
  if (minutes === 300) return '5 小时额度';
  if (minutes === 10080) return '周额度';
  if (minutes === null) return `${position}（周期未知）`;
  return `${minutes % 1440 === 0 ? `${minutes / 1440} 天` : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`}额度`;
}

function renderWindow(window: AccountQuotaWindow, position: string, queriedAt: number): string[] {
  const reset = window.resetsAt === null ? '未提供'
    : `${beijingTime.format(new Date(window.resetsAt * 1000))}${window.resetsAt * 1000 <= queriedAt ? '（时间已到，不代表额度已恢复；请重新查询）' : ''}`;
  return [
    `${windowName(window, position)}：已用 ${window.usedPercent}% · 剩余 ${Math.max(0, 100 - window.usedPercent)}%`,
    `重置时间：${reset}`,
  ];
}

export function renderAccountQuotaHtml(quota: AccountQuota): string {
  const lines = ['<b>Codex 账号额度</b>', '范围：当前 Codex 登录账号，由其它项目和客户端共享。', `查询时间：${beijingTime.format(new Date(quota.queriedAt))}（北京时间）`, '重置时间均为北京时间。'];
  if (!quota.buckets.length) lines.push('', '服务端未提供账号额度数据，无法判断剩余额度。');
  for (const bucket of quota.buckets) {
    lines.push('', `<b>${escapeHtml(bucket.limitName || bucket.limitId || '账号额度')}</b>`);
    if (bucket.primary) lines.push(...renderWindow(bucket.primary, '主窗口', quota.queriedAt));
    if (bucket.secondary) lines.push(...renderWindow(bucket.secondary, '次窗口', quota.queriedAt));
    if (!bucket.primary && !bucket.secondary) lines.push('服务端未提供额度窗口，无法判断剩余额度。');
    else if (!bucket.primary || !bucket.secondary) lines.push(`服务端未提供${bucket.primary ? '次' : '主'}窗口。`);
  }
  return lines.join('\n');
}

/** 不向消息正文或日志传播 RPC 原始错误，它可能含账号和私有字段。 */
export async function buildQuotaCommandResponse(llm: LLMProvider, backend: string, args: string): Promise<string> {
  if (args) return '用法：/quota（查看当前 Codex 登录账号额度，无需参数）。';
  if (backend !== 'codex') return '当前桥接后端不支持 Codex 账号额度查询；/usage 可查看本地 Token 用量。';
  if (!llm.getAccountQuota) return '当前 Codex 宿主未提供账号额度查询能力。';
  try { return renderAccountQuotaHtml(await llm.getAccountQuota()); }
  catch { return '未能获取账号额度（可能未登录、账号不支持、请求超时、连接断开或数据格式无效）。请检查 Codex 登录与连接后重试。'; }
}
