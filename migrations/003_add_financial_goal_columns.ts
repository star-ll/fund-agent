import type { RunnableMigration } from 'umzug';

interface Ctx { db: { query(sql: string, params?: any[]): Promise<any> } }

export const addFinancialGoalColumns: RunnableMigration<Ctx> = {
  name: '003_add_financial_goal_columns',
  async up({ context: { db } }) {
    const columns = [
      { name: 'investment_goal', sql: `ALTER TABLE users ADD COLUMN investment_goal VARCHAR(128) DEFAULT NULL AFTER max_loss_tolerance` },
      { name: 'preferred_fund_types', sql: `ALTER TABLE users ADD COLUMN preferred_fund_types JSON DEFAULT NULL AFTER investment_goal` },
      { name: 'monthly_investment', sql: `ALTER TABLE users ADD COLUMN monthly_investment VARCHAR(64) DEFAULT NULL AFTER preferred_fund_types` },
      { name: 'portfolio_scale', sql: `ALTER TABLE users ADD COLUMN portfolio_scale VARCHAR(64) DEFAULT NULL AFTER monthly_investment` },
    ];

    for (const col of columns) {
      const [rows] = await db.query(
        `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'users'
           AND COLUMN_NAME = ?`,
        [col.name],
      );
      if (rows.length === 0) {
        await db.query(col.sql);
      }
    }
  },
  async down({ context: { db } }) {
    const columns = ['portfolio_scale', 'monthly_investment', 'preferred_fund_types', 'investment_goal'];
    for (const col of columns) {
      const [rows] = await db.query(
        `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'users'
           AND COLUMN_NAME = ?`,
        [col],
      );
      if (rows.length > 0) {
        await db.query(`ALTER TABLE users DROP COLUMN \`${col}\``);
      }
    }
  },
};
