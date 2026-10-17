const router = require('express').Router();
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth, requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { reconcileSingleCampaign } = require('../services/reconciliation');
const cache = require('../utils/cache');

router.use(requireAuth);
router.use(requireAdmin);

/**
 * Log admin action to audit table
 */
async function logAdminAction(adminUserId, actionType, targetType, targetId, details = null) {
  try {
    await db.query(
      `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [adminUserId, actionType, targetType, targetId, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    logger.error('Failed to log admin action', { error: err.message, actionType, targetType });
  }
}

/**
 * @openapi
 * /api/admin/stats:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get platform statistics
 *     description: Returns aggregate platform statistics. Requires admin authentication.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Platform statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total_users:
 *                   type: integer
 *                 banned_users:
 *                   type: integer
 *                 campaign_status:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       status:
 *                         type: string
 *                       count:
 *                         type: string
 *                 deleted_campaigns:
 *                   type: integer
 *                 total_raised:
 *                   type: number
 *                 total_contributions:
 *                   type: integer
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to fetch statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const users = await db.query('SELECT COUNT(*) FROM users WHERE is_banned = false');
    const bannedUsers = await db.query('SELECT COUNT(*) FROM users WHERE is_banned = true');
    const campaigns = await db.query('SELECT status, COUNT(*) FROM campaigns WHERE deleted_at IS NULL GROUP BY status');
    const deletedCampaigns = await db.query('SELECT COUNT(*) FROM campaigns WHERE deleted_at IS NOT NULL');
    const raised = await db.query('SELECT SUM(raised_amount) as total FROM campaigns WHERE deleted_at IS NULL');
    const contributions = await db.query('SELECT COUNT(*) FROM contributions');

    res.json({
      total_users: parseInt(users.rows[0].count),
      banned_users: parseInt(bannedUsers.rows[0].count),
      campaign_status: campaigns.rows,
      deleted_campaigns: parseInt(deletedCampaigns.rows[0].count),
      total_raised: parseFloat(raised.rows[0]?.total || 0),
      total_contributions: parseInt(contributions.rows[0].count),
    });
  } catch (err) {
    logger.error('Error fetching admin stats', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

/**
 * @openapi
 * /api/admin/campaigns:
 *   get:
 *     tags:
 *       - Admin
 *     summary: List all campaigns with filters
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by campaign status
 *       - in: query
 *         name: include_deleted
 *         schema:
 *           type: string
 *           enum: ['true', 'false']
 *         description: Include soft-deleted campaigns when set to 'true'
 *     responses:
 *       200:
 *         description: List of campaigns
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to fetch campaigns
 */
router.get('/campaigns', async (req, res) => {
  try {
    const { status, include_deleted } = req.query;
    const params = [];
    let where = 'WHERE 1=1';

    if (include_deleted !== 'true') {
      where += ' AND c.deleted_at IS NULL';
    }

    if (status) {
      params.push(status);
      where += ` AND c.status = $${params.length}`;
    }

    const { rows } = await db.query(
      `SELECT c.id, c.title, c.status, c.raised_amount, c.target_amount, 
              c.asset_type, c.created_at, c.deleted_at,
              u.id as creator_id, u.name as creator_name, u.email as creator_email,
              (SELECT COUNT(*) FROM contributions WHERE campaign_id = c.id) as contribution_count
       FROM campaigns c 
       JOIN users u ON c.creator_id = u.id
       ${where}
       ORDER BY c.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    logger.error('Error fetching campaigns for admin', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

/**
 * @openapi
 * /api/admin/campaigns/deleted:
 *   get:
 *     tags:
 *       - Admin
 *     summary: List only deleted campaigns
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of soft-deleted campaigns
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to fetch deleted campaigns
 */
router.get('/campaigns/deleted', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.title, c.status, c.raised_amount, c.target_amount, 
              c.asset_type, c.created_at, c.deleted_at,
              u.id as creator_id, u.name as creator_name, u.email as creator_email,
              (SELECT COUNT(*) FROM contributions WHERE campaign_id = c.id) as contribution_count
       FROM campaigns c 
       JOIN users u ON c.creator_id = u.id
       WHERE c.deleted_at IS NOT NULL
       ORDER BY c.deleted_at DESC`
    );
    res.json(rows);
  } catch (err) {
    logger.error('Error fetching deleted campaigns for admin', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch deleted campaigns' });
  }
});

/**
 * @openapi
 * /api/admin/campaigns/{id}/suspend:
 *   patch:
 *     tags:
 *       - Admin
 *     summary: Suspend a campaign
 *     description: Suspends a campaign, preventing new contributions. Logged to the admin audit log.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Campaign ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Reason for suspension
 *     responses:
 *       200:
 *         description: Campaign suspended
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 campaign:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Campaign not found
 *       500:
 *         description: Failed to suspend campaign
 */
router.patch('/campaigns/:id/suspend', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { rows: campaignRows } = await db.query(
      'SELECT id, status FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignRows[0];

    const { rows: updated } = await db.query(
      `UPDATE campaigns SET status = $1 WHERE id = $2 RETURNING id, title, status, created_at`,
      ['suspended', id]
    );

    await logAdminAction(req.user.userId, 'suspend', 'campaign', id, { 
      reason: reason || null,
      previous_status: campaign.status 
    });

    logger.info('Campaign suspended', { campaignId: id, adminId: req.user.userId, reason });
    cache.invalidate(`campaigns:id:${id}`);
    cache.invalidatePrefix('campaigns:list:');
    res.json({ message: 'Campaign suspended', campaign: updated[0] });
  } catch (err) {
    logger.error('Error suspending campaign', { error: err.message, campaignId: req.params.id });
    res.status(500).json({ error: 'Failed to suspend campaign' });
  }
});

/**
 * @openapi
 * /api/admin/campaigns/{id}/restore:
 *   patch:
 *     tags:
 *       - Admin
 *     summary: Restore a campaign
 *     description: Restores a suspended campaign to active, or restores a soft-deleted campaign.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Campaign ID
 *     responses:
 *       200:
 *         description: Campaign restored
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 campaign:
 *                   type: object
 *       400:
 *         description: Only suspended or deleted campaigns can be restored
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Campaign not found
 *       500:
 *         description: Failed to restore campaign
 */
router.patch('/campaigns/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: campaignRows } = await db.query(
      'SELECT id, status, deleted_at FROM campaigns WHERE id = $1',
      [id]
    );

    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignRows[0];

    // Handle soft-deleted campaign restoration
    if (campaign.deleted_at) {
      const { rows: updated } = await db.query(
        `UPDATE campaigns SET deleted_at = NULL, status = 'active' WHERE id = $1 RETURNING id, title, status, deleted_at`,
        [id]
      );

      await logAdminAction(req.user.userId, 'restore', 'campaign', id, { 
        restored_from: 'deleted'
      });

      logger.info('Soft-deleted campaign restored', { campaignId: id, adminId: req.user.userId });
      cache.invalidate(`campaigns:id:${id}`);
      cache.invalidatePrefix('campaigns:list:');
      return res.json({ message: 'Campaign restored from deleted', campaign: updated[0] });
    }

    // Handle suspended campaign restoration
    if (campaign.status !== 'suspended') {
      return res.status(400).json({ error: 'Only suspended or deleted campaigns can be restored' });
    }

    const { rows: updated } = await db.query(
      `UPDATE campaigns SET status = $1 WHERE id = $2 RETURNING id, title, status, created_at`,
      ['active', id]
    );

    await logAdminAction(req.user.userId, 'restore', 'campaign', id, { 
      previous_status: campaign.status 
    });

    logger.info('Campaign restored', { campaignId: id, adminId: req.user.userId });
    cache.invalidate(`campaigns:id:${id}`);
    cache.invalidatePrefix('campaigns:list:');
    res.json({ message: 'Campaign restored', campaign: updated[0] });
  } catch (err) {
    logger.error('Error restoring campaign', { error: err.message, campaignId: req.params.id });
    res.status(500).json({ error: 'Failed to restore campaign' });
  }
});

/**
 * @openapi
 * /api/admin/campaigns/{id}:
 *   delete:
 *     tags:
 *       - Admin
 *     summary: Soft-delete (archive) a campaign
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Campaign ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Reason for deletion
 *     responses:
 *       200:
 *         description: Campaign deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 campaign:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Campaign not found
 *       500:
 *         description: Failed to delete campaign
 */
router.delete('/campaigns/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { rows: campaignRows } = await db.query(
      'SELECT id, title FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { rows: updated } = await db.query(
      `UPDATE campaigns SET deleted_at = NOW() WHERE id = $1 RETURNING id, title, deleted_at`,
      [id]
    );

    await logAdminAction(req.user.userId, 'delete', 'campaign', id, { 
      reason: reason || null
    });

    logger.info('Campaign deleted', { campaignId: id, adminId: req.user.userId, reason });
    cache.invalidate(`campaigns:id:${id}`);
    cache.invalidatePrefix('campaigns:list:');
    res.json({ message: 'Campaign deleted', campaign: updated[0] });
  } catch (err) {
    logger.error('Error deleting campaign', { error: err.message, campaignId: req.params.id });
    res.status(500).json({ error: 'Failed to delete campaign' });
  }
});

/**
 * @openapi
 * /api/admin/campaigns/{id}/feature:
 *   patch:
 *     tags:
 *       - Admin
 *     summary: Mark a campaign as featured
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Campaign ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               note:
 *                 type: string
 *                 description: Optional note about why the campaign was featured
 *     responses:
 *       200:
 *         description: Campaign featured
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 campaign:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Campaign not found
 *       500:
 *         description: Failed to feature campaign
 */
router.patch('/campaigns/:id/feature', async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    const { rows: campaignRows } = await db.query(
      'SELECT id, status FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { rows: updated } = await db.query(
      `UPDATE campaigns 
       SET featured = true, featured_at = NOW(), featured_note = $1 
       WHERE id = $2 RETURNING id, title, featured, featured_at, featured_note`,
      [note || null, id]
    );

    await logAdminAction(req.user.userId, 'feature', 'campaign', id, { note });

    logger.info('Campaign featured', { campaignId: id, adminId: req.user.userId });
    cache.invalidate(`campaigns:id:${id}`);
    cache.invalidatePrefix('campaigns:list:');
    cache.invalidate('campaigns:featured');
    res.json({ message: 'Campaign featured', campaign: updated[0] });
  } catch (err) {
    logger.error('Error featuring campaign', { error: err.message, campaignId: req.params.id });
    res.status(500).json({ error: 'Failed to feature campaign' });
  }
});

/**
 * @openapi
 * /api/admin/campaigns/{id}/unfeature:
 *   patch:
 *     tags:
 *       - Admin
 *     summary: Remove featured status from a campaign
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Campaign ID
 *     responses:
 *       200:
 *         description: Campaign unfeatured
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 campaign:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Campaign not found
 *       500:
 *         description: Failed to unfeature campaign
 */
router.patch('/campaigns/:id/unfeature', async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: campaignRows } = await db.query(
      'SELECT id FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { rows: updated } = await db.query(
      `UPDATE campaigns 
       SET featured = false, featured_at = NULL, featured_note = NULL 
       WHERE id = $1 RETURNING id, title, featured`,
      [id]
    );

    await logAdminAction(req.user.userId, 'unfeature', 'campaign', id, {});

    logger.info('Campaign unfeatured', { campaignId: id, adminId: req.user.userId });
    cache.invalidate(`campaigns:id:${id}`);
    cache.invalidatePrefix('campaigns:list:');
    cache.invalidate('campaigns:featured');
    res.json({ message: 'Campaign unfeatured', campaign: updated[0] });
  } catch (err) {
    logger.error('Error unfeaturing campaign', { error: err.message, campaignId: req.params.id });
    res.status(500).json({ error: 'Failed to unfeature campaign' });
  }
});

/**
 * @openapi
 * /api/admin/users:
 *   get:
 *     tags:
 *       - Admin
 *     summary: List all users with optional filtering
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: include_banned
 *         schema:
 *           type: string
 *           enum: ['true', 'false']
 *         description: Include banned users when set to 'true'
 *     responses:
 *       200:
 *         description: List of users
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to fetch users
 */
router.get('/users', async (req, res) => {
  try {
    const { include_banned } = req.query;
    let where = 'WHERE 1=1';

    if (include_banned !== 'true') {
      where += ' AND u.is_banned = false';
    }

    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.is_admin, u.is_banned, u.created_at,
              (SELECT COUNT(*) FROM campaigns WHERE creator_id = u.id AND deleted_at IS NULL) as campaign_count,
              (SELECT COUNT(*) FROM contributions WHERE sender_public_key = u.wallet_public_key
                 OR sender_public_key IN (SELECT public_key FROM user_wallet_keys WHERE user_id = u.id)) as contribution_count
       FROM users u
       ${where}
       ORDER BY u.created_at DESC`,
      []
    );
    res.json(rows);
  } catch (err) {
    logger.error('Error fetching users for admin', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * @openapi
 * /api/admin/users/{id}/ban:
 *   patch:
 *     tags:
 *       - Admin
 *     summary: Ban a user
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reason
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Reason for banning the user
 *     responses:
 *       200:
 *         description: User banned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 user:
 *                   type: object
 *       400:
 *         description: Reason required or user already banned
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: User not found
 *       500:
 *         description: Failed to ban user
 */
router.patch('/users/:id/ban', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({ error: 'Reason is required for banning a user' });
    }

    const { rows: userRows } = await db.query(
      'SELECT id, email, is_banned FROM users WHERE id = $1',
      [id]
    );

    if (!userRows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userRows[0];

    if (user.is_banned) {
      return res.status(400).json({ error: 'User is already banned' });
    }

    const { rows: updated } = await db.query(
      `UPDATE users SET is_banned = true WHERE id = $1 RETURNING id, email, is_banned`,
      [id]
    );

    await logAdminAction(req.user.userId, 'ban', 'user', id, { 
      reason: reason
    });

    logger.info('User banned', { userId: id, adminId: req.user.userId, reason });
    res.json({ message: 'User banned', user: updated[0] });
  } catch (err) {
    logger.error('Error banning user', { error: err.message, userId: req.params.id });
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

/**
 * @openapi
 * /api/admin/users/{id}/unban:
 *   patch:
 *     tags:
 *       - Admin
 *     summary: Unban a user
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *     responses:
 *       200:
 *         description: User unbanned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 user:
 *                   type: object
 *       400:
 *         description: User is not banned
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: User not found
 *       500:
 *         description: Failed to unban user
 */
router.patch('/users/:id/unban', async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: userRows } = await db.query(
      'SELECT id, email, is_banned FROM users WHERE id = $1',
      [id]
    );

    if (!userRows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userRows[0];

    if (!user.is_banned) {
      return res.status(400).json({ error: 'User is not banned' });
    }

    const { rows: updated } = await db.query(
      `UPDATE users SET is_banned = false WHERE id = $1 RETURNING id, email, is_banned`,
      [id]
    );

    await logAdminAction(req.user.userId, 'unban', 'user', id, {});

    logger.info('User unbanned', { userId: id, adminId: req.user.userId });
    res.json({ message: 'User unbanned', user: updated[0] });
  } catch (err) {
    logger.error('Error unbanning user', { error: err.message, userId: req.params.id });
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

/**
 * @openapi
 * /api/admin/audit-log:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get admin action audit log
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *           maximum: 1000
 *         description: Maximum number of entries to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of entries to skip
 *     responses:
 *       200:
 *         description: Audit log entries with pagination
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 actions:
 *                   type: array
 *                   items:
 *                     type: object
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *                     total:
 *                       type: integer
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to fetch audit log
 */
router.get('/audit-log', async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 100, 1000);
    const offsetNum = parseInt(offset) || 0;

    const { rows } = await db.query(
      `SELECT a.id, a.admin_user_id, u.email as admin_email, a.action_type, 
              a.target_type, a.target_id, a.details, a.created_at
       FROM admin_actions a
       JOIN users u ON a.admin_user_id = u.id
       ORDER BY a.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limitNum, offsetNum]
    );

    const { rows: countRows } = await db.query('SELECT COUNT(*) FROM admin_actions');
    const total = parseInt(countRows[0].count);

    res.json({
      actions: rows,
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        total: total
      }
    });
  } catch (err) {
    logger.error('Error fetching audit log', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

/**
 * @openapi
 * /api/admin/users/{id}/promote:
 *   patch:
 *     tags:
 *       - Admin
 *     summary: Promote a user to admin
 *     description: Only super-admins may promote users.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *     responses:
 *       200:
 *         description: User promoted to admin
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 user:
 *                   type: object
 *       400:
 *         description: User is already an admin
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Super-admin access required
 *       404:
 *         description: User not found
 *       500:
 *         description: Failed to promote user
 */
router.patch('/users/:id/promote', requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: userRows } = await db.query(
      'SELECT id, email, is_admin FROM users WHERE id = $1',
      [id]
    );

    if (!userRows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userRows[0];

    if (user.is_admin) {
      return res.status(400).json({ error: 'User is already an admin' });
    }

    const { rows: updated } = await db.query(
      `UPDATE users SET is_admin = true WHERE id = $1 RETURNING id, email, is_admin`,
      [id]
    );

    await logAdminAction(req.user.userId, 'promote', 'user', id, {});

    logger.info('User promoted to admin', { userId: id, adminId: req.user.userId });
    res.json({ message: 'User promoted to admin', user: updated[0] });
  } catch (err) {
    logger.error('Error promoting user', { error: err.message, userId: req.params.id });
    res.status(500).json({ error: 'Failed to promote user' });
  }
});

/**
 * @openapi
 * /api/admin/users/{id}/demote:
 *   patch:
 *     tags:
 *       - Admin
 *     summary: Demote an admin to regular user
 *     description: Only super-admins may demote admins. Self-demotion is blocked, and demoting the last admin is blocked.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *     responses:
 *       200:
 *         description: Admin demoted to user
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 user:
 *                   type: object
 *       400:
 *         description: User is not an admin
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Super-admin access required or self-demotion attempted
 *       404:
 *         description: User not found
 *       409:
 *         description: Cannot demote the last admin
 *       500:
 *         description: Failed to demote user
 */
router.patch('/users/:id/demote', requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Block self-demotion
    if (String(id) === String(req.user.userId)) {
      return res.status(403).json({ error: 'You cannot demote yourself' });
    }

    const { rows: userRows } = await db.query(
      'SELECT id, email, is_admin FROM users WHERE id = $1',
      [id]
    );

    if (!userRows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userRows[0];

    if (!user.is_admin) {
      return res.status(400).json({ error: 'User is not an admin' });
    }

    // Quorum guard: ensure at least one admin (besides the target) will remain
    const { rows: adminCountRows } = await db.query(
      `SELECT COUNT(*) FROM users WHERE is_admin = true AND id != $1`,
      [id]
    );
    const remainingAdmins = parseInt(adminCountRows[0].count, 10);
    if (remainingAdmins < 1) {
      return res.status(409).json({ error: 'Cannot demote the last admin — the platform would be locked out' });
    }

    const { rows: updated } = await db.query(
      `UPDATE users SET is_admin = false WHERE id = $1 RETURNING id, email, is_admin`,
      [id]
    );

    await logAdminAction(req.user.userId, 'demote', 'user', id, {});

    logger.info('Admin demoted to user', { userId: id, adminId: req.user.userId });
    res.json({ message: 'Admin demoted to user', user: updated[0] });
  } catch (err) {
    logger.error('Error demoting admin', { error: err.message, userId: req.params.id });
    res.status(500).json({ error: 'Failed to demote user' });
  }
});

/**
 * @openapi
 * /api/admin/milestones:
 *   get:
 *     tags:
 *       - Admin
 *     summary: List all milestones across campaigns
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, approved, released]
 *         description: Filter milestones by status
 *     responses:
 *       200:
 *         description: List of milestones with campaign and creator details
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *       400:
 *         description: Invalid status value
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to fetch milestones
 */
// Migrate old /milestones endpoint if needed
router.get('/milestones', async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const allowedStatuses = ['pending', 'approved', 'released'];
  if (status && !allowedStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowedStatuses.join(', ')}` });
  }

  const params = [];
  let where = 'WHERE 1=1';
  if (status) {
    params.push(status