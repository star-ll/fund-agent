import { db } from './db';
import { getFundInfo, type FundInfo } from './fund';
import { getOrCreateUser } from './user';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface PriceAlert {
  id: number;
  user_id: number;
  fund_code: string;
  direction: 'above' | 'below';
  target_nav: number;
  active: boolean;
  triggered: boolean;
  triggered_at: string | null;
  note: string | null;
  created_at: string;
}

export interface PriceAlertInput {
  fund_code: string;
  direction: 'above' | 'below';
  target_nav: number;
  note?: string;
}

export interface AlertCheckResult {
  alert_id: number;
  fund_code: string;
  fund_name: string;
  direction: 'above' | 'below';
  target_nav: number;
  current_nav: number;
  triggered: boolean;
  note: string | null;
}

// ---------------------------------------------------------------------------
// 创建预警
// ---------------------------------------------------------------------------

export async function createAlert(
  weworkUserId: string,
  input: PriceAlertInput,
): Promise<PriceAlert> {
  const userId = await getOrCreateUser(weworkUserId);

  const [result] = await db.execute<any>(
    `INSERT INTO price_alerts (user_id, fund_code, direction, target_nav, note)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, input.fund_code, input.direction, input.target_nav, input.note ?? null],
  );

  const [rows] = await db.execute<any[]>(
    'SELECT * FROM price_alerts WHERE id = ?',
    [result.insertId],
  );

  const r = rows[0];
  return {
    id: r.id,
    user_id: r.user_id,
    fund_code: r.fund_code,
    direction: r.direction,
    target_nav: parseFloat(r.target_nav),
    active: r.active === 1,
    triggered: r.triggered === 1,
    triggered_at: r.triggered_at,
    note: r.note,
    created_at: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// 列出用户的所有预警
// ---------------------------------------------------------------------------

export async function listAlerts(weworkUserId: string): Promise<PriceAlert[]> {
  const userId = await getOrCreateUser(weworkUserId);

  const [rows] = await db.execute<any[]>(
    'SELECT * FROM price_alerts WHERE user_id = ? ORDER BY created_at DESC',
    [userId],
  );

  return rows.map((r: any) => ({
    id: r.id,
    user_id: r.user_id,
    fund_code: r.fund_code,
    direction: r.direction,
    target_nav: parseFloat(r.target_nav),
    active: r.active === 1,
    triggered: r.triggered === 1,
    triggered_at: r.triggered_at,
    note: r.note,
    created_at: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// 删除预警
// ---------------------------------------------------------------------------

export async function deleteAlert(
  weworkUserId: string,
  alertId: number,
): Promise<{ deleted: boolean }> {
  const userId = await getOrCreateUser(weworkUserId);

  const [result] = await db.execute<any>(
    'DELETE FROM price_alerts WHERE id = ? AND user_id = ?',
    [alertId, userId],
  );

  return { deleted: result.affectedRows > 0 };
}

// ---------------------------------------------------------------------------
// 启用 / 禁用预警
// ---------------------------------------------------------------------------

export async function toggleAlert(
  weworkUserId: string,
  alertId: number,
  active: boolean,
): Promise<PriceAlert | null> {
  const userId = await getOrCreateUser(weworkUserId);

  await db.execute(
    `UPDATE price_alerts
     SET active = ?, triggered = 0, triggered_at = NULL
     WHERE id = ? AND user_id = ?`,
    [active ? 1 : 0, alertId, userId],
  );

  const [rows] = await db.execute<any[]>(
    'SELECT * FROM price_alerts WHERE id = ?',
    [alertId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    user_id: r.user_id,
    fund_code: r.fund_code,
    direction: r.direction,
    target_nav: parseFloat(r.target_nav),
    active: r.active === 1,
    triggered: r.triggered === 1,
    triggered_at: r.triggered_at,
    note: r.note,
    created_at: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// 检查所有活跃预警（调用 /fund/info 获取最新净值）
// ---------------------------------------------------------------------------

export async function checkAlerts(
  weworkUserId: string,
): Promise<{ alerts: AlertCheckResult[]; triggered: AlertCheckResult[] }> {
  const activeAlerts = await listAlerts(weworkUserId);
  const active = activeAlerts.filter((a) => a.active && !a.triggered);

  if (active.length === 0) {
    return { alerts: [], triggered: [] };
  }

  // 去重基金代码，批量获取最新净值
  const fundCodes = [...new Set(active.map((a) => a.fund_code))];
  const navMap = new Map<string, { nav: number; name: string }>();

  const fundInfos = await Promise.allSettled(
    fundCodes.map(async (code) => {
      const info: FundInfo = await getFundInfo(code);
      return { code, nav: parseFloat(info.单位净值), name: info.基金简称 };
    }),
  );

  for (const result of fundInfos) {
    if (result.status === 'fulfilled' && !Number.isNaN(result.value.nav)) {
      navMap.set(result.value.code, { nav: result.value.nav, name: result.value.name });
    }
  }

  const results: AlertCheckResult[] = [];
  const newlyTriggered: number[] = [];

  for (const alert of active) {
    const navData = navMap.get(alert.fund_code);
    if (!navData) continue;

    const { nav, name } = navData;
    const triggered =
      alert.direction === 'above'
        ? nav > alert.target_nav
        : nav < alert.target_nav;

    const checkResult: AlertCheckResult = {
      alert_id: alert.id,
      fund_code: alert.fund_code,
      fund_name: name,
      direction: alert.direction,
      target_nav: alert.target_nav,
      current_nav: nav,
      triggered,
      note: alert.note,
    };

    results.push(checkResult);

    if (triggered) {
      newlyTriggered.push(alert.id);
    }
  }

  // 标记已触发
  if (newlyTriggered.length > 0) {
    await db.execute(
      `UPDATE price_alerts SET triggered = 1, triggered_at = NOW()
       WHERE id IN (${newlyTriggered.map(() => '?').join(',')})`,
      newlyTriggered,
    );
  }

  return {
    alerts: results,
    triggered: results.filter((r) => r.triggered),
  };
}
