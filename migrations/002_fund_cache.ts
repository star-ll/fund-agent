import type { RunnableMigration } from 'umzug';

interface Ctx { db: { query(sql: string, params?: any[]): Promise<any> } }

export const fundCache: RunnableMigration<Ctx> = {
  name: '002_fund_cache',
  async up({ context: { db } }) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS fund_cache (
        fund_code         VARCHAR(10)   NOT NULL PRIMARY KEY,
        fund_name         VARCHAR(100),
        fund_type_raw     VARCHAR(50)   COMMENT 'AKShare 原始类型',
        category_l1       ENUM('股票型','混合型','债券型','指数型','QDII','FOF','货币型','其他'),
        category_l2       VARCHAR(50)   COMMENT '二级分类: 偏股混合/纯债/增强指数...',
        fund_company      VARCHAR(100),
        manager_name      VARCHAR(100),
        manager_tenure    FLOAT         COMMENT '从业年限',
        manager_best_return VARCHAR(50),
        rating_shanghai   VARCHAR(10),
        rating_merchants  VARCHAR(10),
        rating_jian       VARCHAR(10),
        fetched_at        DATETIME NOT NULL,
        created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_category_l1 (category_l1),
        INDEX idx_fund_company (fund_company),
        INDEX idx_fund_name (fund_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  },
  async down({ context: { db } }) {
    await db.query('DROP TABLE IF EXISTS fund_cache');
  },
};
