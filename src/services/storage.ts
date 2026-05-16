import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(__dirname, '../../data');
const PROFILE_PATH = path.join(DATA_DIR, 'profile.json');

export interface Holding {
  fund_code: string;
  shares?: number;
  cost?: number;
  note?: string;
}

export interface UserProfile {
  holdings: Holding[];
  risk_level?: 'low' | 'medium' | 'high';
  investment_years?: number;
  target_return?: string;
  max_loss_tolerance?: string;
  notes?: string;
  updated_at: string;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadProfile(): UserProfile | null {
  try {
    if (!fs.existsSync(PROFILE_PATH)) return null;
    return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8')) as UserProfile;
  } catch {
    return null;
  }
}

export function saveProfile(patch: Partial<Omit<UserProfile, 'updated_at'>>): UserProfile {
  ensureDataDir();
  const existing = loadProfile() ?? { holdings: [], updated_at: '' };

  // 合并 holdings：按 fund_code 去重，新数据覆盖旧数据
  if (patch.holdings) {
    const map = new Map(existing.holdings.map((h) => [h.fund_code, h]));
    for (const h of patch.holdings) map.set(h.fund_code, { ...map.get(h.fund_code), ...h });
    existing.holdings = Array.from(map.values());
  }

  const updated: UserProfile = {
    ...existing,
    ...patch,
    holdings: existing.holdings,
    updated_at: new Date().toISOString(),
  };

  fs.writeFileSync(PROFILE_PATH, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}
