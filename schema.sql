CREATE DATABASE IF NOT EXISTS ai_fund CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE ai_fund;

CREATE TABLE IF NOT EXISTS users (
  id               INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  wework_user_id   VARCHAR(64)     NOT NULL,
  risk_level       ENUM('low','medium','high') DEFAULT NULL,
  investment_years INT             DEFAULT NULL,
  target_return    VARCHAR(64)     DEFAULT NULL,
  max_loss_tolerance VARCHAR(64)   DEFAULT NULL,
  investment_goal  VARCHAR(128)    DEFAULT NULL,
  preferred_fund_types JSON        DEFAULT NULL,
  monthly_investment   VARCHAR(64) DEFAULT NULL,
  portfolio_scale      VARCHAR(64) DEFAULT NULL,
  notes                TEXT           DEFAULT NULL,
  conversation_summary TEXT           DEFAULT NULL,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wework_user_id (wework_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Migration: run this on existing databases
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS investment_goal       VARCHAR(128) DEFAULT NULL AFTER max_loss_tolerance,
  ADD COLUMN IF NOT EXISTS preferred_fund_types  JSON         DEFAULT NULL AFTER investment_goal,
  ADD COLUMN IF NOT EXISTS monthly_investment    VARCHAR(64)  DEFAULT NULL AFTER preferred_fund_types,
  ADD COLUMN IF NOT EXISTS portfolio_scale       VARCHAR(64)  DEFAULT NULL AFTER monthly_investment;
ALTER TABLE users ADD COLUMN IF NOT EXISTS conversation_summary TEXT DEFAULT NULL AFTER notes;

CREATE TABLE IF NOT EXISTS holdings (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  fund_code  VARCHAR(20)  NOT NULL,
  shares     DECIMAL(18,4) DEFAULT NULL,
  cost       DECIMAL(18,4) DEFAULT NULL,
  note       VARCHAR(255)  DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_fund (user_id, fund_code),
  CONSTRAINT fk_holdings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
