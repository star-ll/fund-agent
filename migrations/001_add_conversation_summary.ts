import type { RunnableMigration } from 'umzug';

// context 由 umzug 注入 mysql2 Pool
interface Ctx { db: { query(sql: string): Promise<unknown> } }

export const addConversationSummary: RunnableMigration<Ctx> = {
  name: '001_add_conversation_summary',
  async up({ context: { db } }) {
    await db.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS conversation_summary TEXT DEFAULT NULL`,
    );
  },
  async down({ context: { db } }) {
    await db.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS conversation_summary`,
    );
  },
};
