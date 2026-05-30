import type { RunnableMigration } from 'umzug';

interface Ctx { db: { query(sql: string, params?: any[]): Promise<any> } }

export const addConversationSummary: RunnableMigration<Ctx> = {
  name: '001_add_conversation_summary',
  async up({ context: { db } }) {
    const [rows] = await db.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'users'
         AND COLUMN_NAME = 'conversation_summary'`,
    );
    if (rows.length === 0) {
      await db.query(
        `ALTER TABLE users ADD COLUMN conversation_summary TEXT DEFAULT NULL`,
      );
    }
  },
  async down({ context: { db } }) {
    const [rows] = await db.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'users'
         AND COLUMN_NAME = 'conversation_summary'`,
    );
    if (rows.length > 0) {
      await db.query(`ALTER TABLE users DROP COLUMN conversation_summary`);
    }
  },
};
