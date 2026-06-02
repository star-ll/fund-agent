import type { RunnableMigration } from 'umzug';

interface Ctx { db: { query(sql: string, params?: any[]): Promise<any> } }

export const addPriceAlerts: RunnableMigration<Ctx> = {
  name: '004_price_alerts',
  async up({ context: { db } }) {
    const [rows] = await db.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'price_alerts'`,
    );
    if (rows.length === 0) {
      await db.query(`
        CREATE TABLE price_alerts (
          id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
          user_id       INT UNSIGNED NOT NULL,
          fund_code     VARCHAR(20)   NOT NULL,
          direction     ENUM('above','below') NOT NULL COMMENT 'above=涨破, below=跌破',
          target_nav    DECIMAL(12,4) NOT NULL COMMENT '目标净值',
          active        TINYINT(1)   NOT NULL DEFAULT 1,
          triggered     TINYINT(1)   NOT NULL DEFAULT 0,
          triggered_at  DATETIME      DEFAULT NULL,
          note          VARCHAR(255)  DEFAULT NULL,
          created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_user_active (user_id, active)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    }
  },
  async down({ context: { db } }) {
    const [rows] = await db.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'price_alerts'`,
    );
    if (rows.length > 0) {
      await db.query('DROP TABLE price_alerts');
    }
  },
};
