import { db } from './db';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
export interface FundCache {
  fund_code: string;
  fund_name?: string;
  fund_type_raw?: string;
  category_l1?: string;
  category_l2?: string;
  fund_company?: string;
  manager_name?: string;
  manager_tenure?: number;
  manager_best_return?: string;
  rating_shanghai?: string;
  rating_merchants?: string;
  rating_jian?: string;
  fetched_at: string;
}

export interface SearchResult {
  fund_code: string;
  fund_name: string;
  fund_type_raw: string;
  category_l1: string;
  category_l2: string;
  fund_company: string;
  manager_name: string;
  rating_shanghai: string;
  rating_merchants: string;
  rating_jian: string;
}

// ---------------------------------------------------------------------------
// AKShare 原始类型 → 标准化分类解析
// ---------------------------------------------------------------------------
function classify(rawType: string): { l1: string; l2: string } {
  const t = (rawType ?? '').trim();

  if (/QDII/i.test(t))                    return { l1: 'QDII', l2: '' };
  if (/FOF/i.test(t))                     return { l1: 'FOF', l2: '' };
  if (/货币|货币市场/i.test(t))           return { l1: '货币型', l2: '' };

  if (/股票型/.test(t))                   return { l1: '股票型', l2: parseL2(t, '股票') };

  if (/混合型/.test(t)) {
    if (/偏股/.test(t))                   return { l1: '混合型', l2: '偏股混合' };
    if (/偏债/.test(t))                   return { l1: '混合型', l2: '偏债混合' };
    if (/灵活/.test(t))                   return { l1: '混合型', l2: '灵活配置' };
    if (/平衡/.test(t))                   return { l1: '混合型', l2: '平衡混合' };
    return { l1: '混合型', l2: parseL2(t, '混合') };
  }

  if (/债券型/.test(t)) {
    if (/长债|中长期/.test(t))            return { l1: '债券型', l2: '中长期纯债' };
    if (/中短债|短债/.test(t))            return { l1: '债券型', l2: '中短债' };
    if (/可转债/.test(t))                 return { l1: '债券型', l2: '可转债' };
    if (/一级债/.test(t))                 return { l1: '债券型', l2: '一级债基' };
    if (/二级债|增强/.test(t))            return { l1: '债券型', l2: '二级债基' };
    return { l1: '债券型', l2: parseL2(t, '债券') };
  }

  if (/指数型/.test(t)) {
    if (/ETF联接|ETF/.test(t))            return { l1: '指数型', l2: 'ETF联接' };
    if (/增强/.test(t))                   return { l1: '指数型', l2: '增强指数' };
    return { l1: '指数型', l2: parseL2(t, '指数') };
  }

  if (/ETF/.test(t))                      return { l1: '指数型', l2: 'ETF' };
  if (/LOF/.test(t))                      return { l1: '混合型', l2: 'LOF' };

  return { l1: '其他', l2: t };
}

function parseL2(raw: string, l1: string): string {
  const parts = raw.split(/[-–—]/);
  if (parts.length > 1) return parts.slice(1).join('-').trim();
  return raw.replace(l1, '').replace('型', '').trim();
}

// ---------------------------------------------------------------------------
// 缓存读写
// ---------------------------------------------------------------------------
const CACHE_TTL_DAYS = 7;

export async function getFundCache(fundCode: string): Promise<FundCache | null> {
  const [rows] = await db.execute<any[]>(
    `SELECT
      fund_code, fund_name, fund_type_raw, category_l1, category_l2,
      fund_company, manager_name, manager_tenure, manager_best_return,
      rating_shanghai, rating_merchants, rating_jian,
      fetched_at
    FROM fund_cache
    WHERE fund_code = ?
      AND fetched_at > DATE_SUB(NOW(), INTERVAL ${CACHE_TTL_DAYS} DAY)`,
    [fundCode],
  );
  return rows.length > 0 ? rows[0] : null;
}

export async function saveFundInfo(fundCode: string, data: {
  fund_name?: string;
  fund_type?: string;
  fund_company?: string;
}): Promise<void> {
  const { l1, l2 } = classify(data.fund_type ?? '');
  await db.execute(
    `INSERT INTO fund_cache (fund_code, fund_name, fund_type_raw, category_l1, category_l2, fund_company, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       fund_name = VALUES(fund_name),
       fund_type_raw = VALUES(fund_type_raw),
       category_l1 = VALUES(category_l1),
       category_l2 = VALUES(category_l2),
       fund_company = VALUES(fund_company),
       fetched_at = NOW()`,
    [fundCode, data.fund_name ?? null, data.fund_type ?? null, l1, l2, data.fund_company ?? null],
  );
  console.log(`[fund-cache] saved info for ${fundCode} name=${data.fund_name} type=${l1}/${l2}`);
}

export async function saveManagerInfo(fundCode: string, data: {
  manager_name?: string;
  manager_tenure?: number;
  manager_best_return?: string;
}): Promise<void> {
  await db.execute(
    `INSERT INTO fund_cache (fund_code, manager_name, manager_tenure, manager_best_return, fetched_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       manager_name = VALUES(manager_name),
       manager_tenure = VALUES(manager_tenure),
       manager_best_return = VALUES(manager_best_return),
       fetched_at = NOW()`,
    [fundCode, data.manager_name ?? null, data.manager_tenure ?? null, data.manager_best_return ?? null],
  );
  console.log(`[fund-cache] saved manager for ${fundCode} name=${data.manager_name}`);
}

export async function saveRatingInfo(fundCode: string, data: {
  rating_shanghai?: string;
  rating_merchants?: string;
  rating_jian?: string;
}): Promise<void> {
  await db.execute(
    `INSERT INTO fund_cache (fund_code, rating_shanghai, rating_merchants, rating_jian, fetched_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       rating_shanghai = VALUES(rating_shanghai),
       rating_merchants = VALUES(rating_merchants),
       rating_jian = VALUES(rating_jian),
       fetched_at = NOW()`,
    [fundCode, data.rating_shanghai ?? null, data.rating_merchants ?? null, data.rating_jian ?? null],
  );
  console.log(`[fund-cache] saved rating for ${fundCode}`);
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------
export async function searchFundCache(params: {
  category_l1?: string;
  category_l2?: string;
  fund_company?: string;
  keyword?: string;
  limit?: number;
}): Promise<SearchResult[]> {
  const conditions: string[] = [];
  const values: any[] = [];

  if (params.category_l1) {
    conditions.push('category_l1 = ?');
    values.push(params.category_l1);
  }
  if (params.category_l2) {
    conditions.push('category_l2 = ?');
    values.push(params.category_l2);
  }
  if (params.fund_company) {
    conditions.push('fund_company = ?');
    values.push(params.fund_company);
  }
  if (params.keyword) {
    conditions.push('(fund_name LIKE ? OR fund_code LIKE ?)');
    const kw = `%${params.keyword}%`;
    values.push(kw, kw);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(params.limit ?? 20, 50);

  const [rows] = await db.execute<any[]>(
    `SELECT fund_code, fund_name, fund_type_raw, category_l1, category_l2,
            fund_company, manager_name, rating_shanghai, rating_merchants, rating_jian
     FROM fund_cache
     ${where}
     ORDER BY fund_code
     LIMIT ${limit}`,
    values,
  );

  return rows;
}
