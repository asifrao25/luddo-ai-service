/**
 * Tips Management API Routes
 *
 * Endpoints:
 * GET    /api/tips              - List all tips (with filters)
 * GET    /api/tips/:id          - Get single tip
 * POST   /api/tips              - Create new tip
 * PUT    /api/tips/:id          - Update tip
 * DELETE /api/tips/:id          - Delete tip
 * POST   /api/tips/inject       - Inject tips into active session
 * GET    /api/tips/profiles     - List tip profiles
 * POST   /api/tips/profiles     - Create tip profile
 */

import { Router } from 'express';
import { TipsService } from '../../services/TipsService.js';

const router = Router();
const tipsService = new TipsService();

// List all tips
router.get('/', async (req, res) => {
  try {
    const { category, active, subcategory } = req.query;
    const tips = await tipsService.getTips({
      category: category as string,
      active: active === 'true' ? true : active === 'false' ? false : undefined,
      subcategory: subcategory as string
    });
    res.json({
      tips,
      total: tips.length,
      categories: tipsService.getCategories()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tips', message: (error as Error).message });
  }
});

// Get single tip
router.get('/:id', async (req, res) => {
  try {
    const tip = await tipsService.getTipById(req.params.id);
    if (!tip) {
      return res.status(404).json({ error: 'Tip not found' });
    }
    res.json({ tip });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tip', message: (error as Error).message });
  }
});

// Create new tip
router.post('/', async (req, res) => {
  try {
    const { category, subcategory, content, shortPrompt, priority, weight, condition } = req.body;

    if (!category || !content || !shortPrompt) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['category', 'content', 'shortPrompt']
      });
    }

    const tip = await tipsService.createTip({
      category,
      subcategory,
      content,
      shortPrompt,
      priority: priority || 5,
      weight: weight || 1.0,
      condition
    });

    res.status(201).json({ tip, id: tip.id });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create tip', message: (error as Error).message });
  }
});

// Update tip
router.put('/:id', async (req, res) => {
  try {
    const tip = await tipsService.updateTip(req.params.id, req.body);
    if (!tip) {
      return res.status(404).json({ error: 'Tip not found' });
    }
    res.json({ tip });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update tip', message: (error as Error).message });
  }
});

// Delete tip
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await tipsService.deleteTip(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Tip not found' });
    }
    res.json({ deleted: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete tip', message: (error as Error).message });
  }
});

// Inject tips into active session
router.post('/inject', async (req, res) => {
  try {
    const { tipIds, applyTo = 'next_game' } = req.body;

    if (!tipIds || !Array.isArray(tipIds) || tipIds.length === 0) {
      return res.status(400).json({
        error: 'Missing required field',
        required: ['tipIds (array)']
      });
    }

    const result = await tipsService.injectTips(tipIds, applyTo);
    res.json({ status: 'injected', tipsApplied: result.count });
  } catch (error) {
    res.status(500).json({ error: 'Failed to inject tips', message: (error as Error).message });
  }
});

// List tip profiles
router.get('/profiles', async (req, res) => {
  try {
    const profiles = await tipsService.getProfiles();
    res.json({ profiles });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch profiles', message: (error as Error).message });
  }
});

// Create tip profile
router.post('/profiles', async (req, res) => {
  try {
    const { name, tipIds, description } = req.body;

    if (!name || !tipIds || !Array.isArray(tipIds)) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['name', 'tipIds (array)']
      });
    }

    const profile = await tipsService.createProfile({ name, tipIds, description });
    res.status(201).json({ profile });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create profile', message: (error as Error).message });
  }
});

export { router as tipsRoutes };
