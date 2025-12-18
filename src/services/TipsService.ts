/**
 * Tips Service
 *
 * Manages strategy tips for AI players
 */

import { v4 as uuidv4 } from 'uuid';
import { getStorageService } from './StorageService.js';

export interface TipCondition {
  type: string;
  [key: string]: any;
}

export interface Tip {
  id: string;
  category: 'aggressive' | 'defensive' | 'situational';
  subcategory: string;
  priority: number;
  content: string;
  shortPrompt: string;
  weight: number;
  active: boolean;
  condition?: TipCondition;
  createdAt: string;
  updatedAt: string;
  metadata?: {
    author: string;
    source: string;
  };
}

export interface TipProfile {
  name: string;
  tipIds: string[];
  description?: string;
  createdAt: string;
}

export interface TipsDatabase {
  version: string;
  lastUpdated: string;
  tips: Tip[];
  profiles: TipProfile[];
  categories: Record<string, {
    description: string;
    color: string;
    subcategories: string[];
  }>;
}

const TIPS_FILE = 'tips/tips.json';

const DEFAULT_DATABASE: TipsDatabase = {
  version: '1.0.0',
  lastUpdated: new Date().toISOString(),
  tips: [],
  profiles: [],
  categories: {
    aggressive: {
      description: 'Tips for maximizing opponent disruption',
      color: '#ef4444',
      subcategories: ['capture', 'blocking', 'racing']
    },
    defensive: {
      description: 'Tips for protecting tokens and minimizing risk',
      color: '#3b82f6',
      subcategories: ['safety', 'avoidance', 'stacking']
    },
    situational: {
      description: 'Tips for specific game situations',
      color: '#22c55e',
      subcategories: ['opening', 'midgame', 'endgame', 'comeback']
    }
  }
};

// In-memory cache for injected tips
let injectedTips: { tipIds: string[]; applyTo: string } | null = null;

export class TipsService {
  private storage = getStorageService();

  /**
   * Load tips database
   */
  private loadDatabase(): TipsDatabase {
    return this.storage.readJson(TIPS_FILE, DEFAULT_DATABASE);
  }

  /**
   * Save tips database
   */
  private saveDatabase(db: TipsDatabase): void {
    db.lastUpdated = new Date().toISOString();
    this.storage.writeJson(TIPS_FILE, db);
  }

  /**
   * Get all tips with optional filters
   */
  async getTips(filters?: {
    category?: string;
    active?: boolean;
    subcategory?: string;
  }): Promise<Tip[]> {
    const db = this.loadDatabase();
    let tips = db.tips;

    if (filters?.category) {
      tips = tips.filter(t => t.category === filters.category);
    }
    if (filters?.active !== undefined) {
      tips = tips.filter(t => t.active === filters.active);
    }
    if (filters?.subcategory) {
      tips = tips.filter(t => t.subcategory === filters.subcategory);
    }

    return tips.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Get tip by ID
   */
  async getTipById(id: string): Promise<Tip | null> {
    const db = this.loadDatabase();
    return db.tips.find(t => t.id === id) || null;
  }

  /**
   * Create new tip
   */
  async createTip(data: {
    category: 'aggressive' | 'defensive' | 'situational';
    subcategory?: string;
    content: string;
    shortPrompt: string;
    priority?: number;
    weight?: number;
    condition?: TipCondition;
  }): Promise<Tip> {
    const db = this.loadDatabase();

    const tip: Tip = {
      id: `tip_${uuidv4().slice(0, 8)}`,
      category: data.category,
      subcategory: data.subcategory || 'general',
      priority: data.priority || 5,
      content: data.content,
      shortPrompt: data.shortPrompt,
      weight: data.weight || 1.0,
      active: true,
      condition: data.condition,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        author: 'user',
        source: 'api'
      }
    };

    db.tips.push(tip);
    this.saveDatabase(db);

    return tip;
  }

  /**
   * Update tip
   */
  async updateTip(id: string, updates: Partial<Tip>): Promise<Tip | null> {
    const db = this.loadDatabase();
    const index = db.tips.findIndex(t => t.id === id);

    if (index === -1) {
      return null;
    }

    const tip = db.tips[index];
    const updatedTip: Tip = {
      ...tip,
      ...updates,
      id: tip.id, // Prevent ID change
      createdAt: tip.createdAt, // Prevent creation date change
      updatedAt: new Date().toISOString()
    };

    db.tips[index] = updatedTip;
    this.saveDatabase(db);

    return updatedTip;
  }

  /**
   * Delete tip
   */
  async deleteTip(id: string): Promise<boolean> {
    const db = this.loadDatabase();
    const index = db.tips.findIndex(t => t.id === id);

    if (index === -1) {
      return false;
    }

    db.tips.splice(index, 1);

    // Also remove from profiles
    db.profiles.forEach(p => {
      p.tipIds = p.tipIds.filter(tid => tid !== id);
    });

    this.saveDatabase(db);
    return true;
  }

  /**
   * Get categories
   */
  getCategories(): Record<string, { description: string; color: string; subcategories: string[] }> {
    const db = this.loadDatabase();
    return db.categories;
  }

  /**
   * Inject tips for next game/session
   */
  async injectTips(tipIds: string[], applyTo: string): Promise<{ count: number }> {
    injectedTips = { tipIds, applyTo };
    return { count: tipIds.length };
  }

  /**
   * Get currently injected tips
   */
  getInjectedTips(): { tipIds: string[]; applyTo: string } | null {
    return injectedTips;
  }

  /**
   * Clear injected tips
   */
  clearInjectedTips(): void {
    injectedTips = null;
  }

  /**
   * Get tips for prompt injection
   */
  async getTipsForPrompt(category?: string): Promise<string[]> {
    const db = this.loadDatabase();
    let tips = db.tips.filter(t => t.active);

    // If specific tips are injected, use those
    if (injectedTips) {
      tips = tips.filter(t => injectedTips!.tipIds.includes(t.id));
    } else if (category) {
      tips = tips.filter(t => t.category === category);
    }

    // Sort by priority and weight
    tips.sort((a, b) => {
      const priorityDiff = a.priority - b.priority;
      if (priorityDiff !== 0) return priorityDiff;
      return b.weight - a.weight;
    });

    // Return short prompts
    return tips.map(t => t.shortPrompt);
  }

  // ============ Profiles ============

  /**
   * Get all profiles
   */
  async getProfiles(): Promise<TipProfile[]> {
    const db = this.loadDatabase();
    return db.profiles;
  }

  /**
   * Create profile
   */
  async createProfile(data: {
    name: string;
    tipIds: string[];
    description?: string;
  }): Promise<TipProfile> {
    const db = this.loadDatabase();

    const profile: TipProfile = {
      name: data.name,
      tipIds: data.tipIds,
      description: data.description,
      createdAt: new Date().toISOString()
    };

    db.profiles.push(profile);
    this.saveDatabase(db);

    return profile;
  }

  /**
   * Get profile by name
   */
  async getProfile(name: string): Promise<TipProfile | null> {
    const db = this.loadDatabase();
    return db.profiles.find(p => p.name === name) || null;
  }
}
