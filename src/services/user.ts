import { db } from './db';
import type { UserProfile, Holding } from './storage';

// 根据企微 user_id 查询或创建用户
export async function getOrCreateUser(weworkUserId: string): Promise<number> {
  const [rows] = await db.execute<any[]>(
    'SELECT id FROM users WHERE wework_user_id = ?',
    [weworkUserId],
  );
  if (rows.length > 0) return rows[0].id;
  const [result] = await db.execute<any>(
    'INSERT INTO users (wework_user_id) VALUES (?)',
    [weworkUserId],
  );
  return result.insertId;
}

export async function loadProfileFromDB(weworkUserId: string): Promise<UserProfile | null> {
  const [userRows] = await db.execute<any[]>(
    'SELECT * FROM users WHERE wework_user_id = ?',
    [weworkUserId],
  );
  if (userRows.length === 0) return null;
  const user = userRows[0];

  const [holdingRows] = await db.execute<any[]>(
    'SELECT fund_code, shares, cost, note FROM holdings WHERE user_id = ?',
    [user.id],
  );

  if (!user.risk_level && holdingRows.length === 0) return null;

  return {
    holdings: holdingRows.map((h: any) => ({
      fund_code: h.fund_code,
      shares: h.shares ? parseFloat(h.shares) : undefined,
      cost: h.cost ? parseFloat(h.cost) : undefined,
      note: h.note,
    })),
    risk_level: user.risk_level,
    investment_years: user.investment_years,
    target_return: user.target_return,
    max_loss_tolerance: user.max_loss_tolerance,
    investment_goal: user.investment_goal,
    preferred_fund_types: user.preferred_fund_types
      ? (typeof user.preferred_fund_types === 'string' ? JSON.parse(user.preferred_fund_types) : user.preferred_fund_types)
      : undefined,
    monthly_investment: user.monthly_investment,
    portfolio_scale: user.portfolio_scale,
    notes: user.notes,
    updated_at: user.updated_at?.toISOString() ?? new Date().toISOString(),
  };
}

export async function loadSummaryFromDB(weworkUserId: string): Promise<string | null> {
  const [rows] = await db.execute<any[]>(
    'SELECT conversation_summary FROM users WHERE wework_user_id = ?',
    [weworkUserId],
  );
  return rows[0]?.conversation_summary ?? null;
}

export async function saveSummaryToDB(weworkUserId: string, summary: string): Promise<void> {
  await db.execute(
    'UPDATE users SET conversation_summary = ? WHERE wework_user_id = ?',
    [summary, weworkUserId],
  );
}

export async function saveProfileToDB(
  weworkUserId: string,
  patch: Partial<Omit<UserProfile, 'updated_at'>>,
): Promise<UserProfile> {
  const userId = await getOrCreateUser(weworkUserId);

  // 更新用户信息
  const fields: string[] = [];
  const values: (string | number)[] = [];
  if (patch.risk_level !== undefined) { fields.push('risk_level = ?'); values.push(patch.risk_level); }
  if (patch.investment_years !== undefined) { fields.push('investment_years = ?'); values.push(patch.investment_years); }
  if (patch.target_return !== undefined) { fields.push('target_return = ?'); values.push(patch.target_return); }
  if (patch.max_loss_tolerance !== undefined) { fields.push('max_loss_tolerance = ?'); values.push(patch.max_loss_tolerance); }
  if (patch.investment_goal !== undefined) { fields.push('investment_goal = ?'); values.push(patch.investment_goal); }
  if (patch.preferred_fund_types !== undefined) { fields.push('preferred_fund_types = ?'); values.push(JSON.stringify(patch.preferred_fund_types)); }
  if (patch.monthly_investment !== undefined) { fields.push('monthly_investment = ?'); values.push(patch.monthly_investment); }
  if (patch.portfolio_scale !== undefined) { fields.push('portfolio_scale = ?'); values.push(patch.portfolio_scale); }
  if (patch.notes !== undefined) { fields.push('notes = ?'); values.push(patch.notes); }

  if (fields.length > 0) {
    await db.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, [...values, userId]);
  }

  // upsert holdings
  if (patch.holdings && patch.holdings.length > 0) {
    for (const h of patch.holdings) {
      await db.execute(
        `INSERT INTO holdings (user_id, fund_code, shares, cost, note)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE shares = VALUES(shares), cost = VALUES(cost), note = VALUES(note)`,
        [userId, h.fund_code, h.shares ?? null, h.cost ?? null, h.note ?? null],
      );
    }
  }

  return (await loadProfileFromDB(weworkUserId))!;
}
