import { Umzug } from 'umzug';
import { db } from './db';
import { logger } from '../utils/logger';
import { addConversationSummary } from '../../migrations/001_add_conversation_summary';
import { fundCache } from '../../migrations/002_fund_cache';

// ---------------------------------------------------------------------------
// 自定义 MySQL 存储：用 _migrations 表记录已执行的迁移
// ---------------------------------------------------------------------------
const mysqlStorage = () => {
  const table = '_migrations';

  return {
    async logMigration({ name }: { name: string }) {
      await db.query(`INSERT INTO ${table} (name) VALUES (?)`, [name]);
    },
    async unlogMigration({ name }: { name: string }) {
      await db.query(`DELETE FROM ${table} WHERE name = ?`, [name]);
    },
    async executed() {
      try {
        const [rows] = await db.query<any[]>(`SELECT name FROM ${table}`);
        return rows.map((r) => r.name);
      } catch {
        // 表不存在时创建
        await db.query(
          `CREATE TABLE IF NOT EXISTS ${table} (name VARCHAR(255) PRIMARY KEY)`,
        );
        return [] as string[];
      }
    },
  };
};

const migrator = new Umzug({
  migrations: [addConversationSummary, fundCache],
  context: { db },
  storage: mysqlStorage(),
  logger: {
    info: (msg) => logger.info('migration', JSON.stringify(msg)),
    warn: (msg) => logger.warn('migration', JSON.stringify(msg)),
    error: (msg) => logger.error('migration', JSON.stringify(msg)),
    debug: () => {},
  },
});

let _applied = false;

export async function runMigrations(): Promise<void> {
  if (_applied) return;
  _applied = true;

  try {
    const pending = await migrator.pending();
    if (pending.length > 0) {
      logger.info('migration', `发现 ${pending.length} 个待执行迁移: ${pending.map((m) => m.name).join(', ')}`);
      const result = await migrator.up();
      logger.info('migration', `已执行 ${result.length} 个迁移`);
    } else {
      logger.info('migration', '无待执行迁移');
    }
  } catch (err) {
    logger.error('migration', '迁移执行失败', err instanceof Error ? err.message : String(err));
  }
}
