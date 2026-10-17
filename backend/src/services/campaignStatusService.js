const db = require('../config/database');
const logger = require('../config/logger');
const { triggerCampaignStatusActions } = require('./campaignStatusActions');
const { runWithRequestContext, getRequestId } = require('../config/requestContext');

const PREVIOUS_STATUS = 'active';
const CRON_REQUEST_ID = 'campaign-status-cron';

async function runStatusActionsForCampaign(campaign, requestId) {
  if (!campaign) return;
  const correlationId = requestId || getRequestId() || CRON_REQUEST_ID;
  try {
    await runWithRequestContext({ requestId: correlationId }, () =>
      triggerCampaignStatusActions(campaign, PREVIOUS_STATUS)
    );
  } catch (err) {
    logger.error('Campaign status actions failed', {
      campaign_id: campaign.id,
      status: campaign.status,
      error: err.message,
    });
  }
}

/**
 * Reconcile status for one campaign (active → funded or failed based on goal/deadline).
 */
async function refreshCampaignStatus(campaignId, client) {
  const runner = client || db;
  const { rows: failed } = await runner.query(
    `UPDATE campaigns
     SET status = 'failed'
     WHERE id = $1
       AND status = 'active'
       AND deadline IS NOT NULL
       AND deadline < CURRENT_DATE
       AND raised_amount < target_amount
     RETURNING id, title, target_amount, raised_amount, deadline, status`,
    [campaignId]
  );

  const { rows: funded } = await runner.query(
    `UPDATE campaigns
     SET status = 'funded'
     WHERE id = $1
       AND status = 'active'
       AND raised_amount >= target_amount
     RETURNING id, title, target_amount, raised_amount, deadline, status`,
    [campaignId]
  );

  const result = {
    failed: failed[0] || null,
    funded: funded[0] || null,
  };

  if (result.funded) await runStatusActionsForCampaign(result.funded);
  if (result.failed) await runStatusActionsForCampaign(result.failed);

  return result;
}

/**
 * Batch refresh for all still-active campaigns (hourly cron).
 */
async function refreshActiveCampaignStatuses() {
  const requestId = getRequestId() || CRON_REQUEST_ID;
  const { rows: funded } = await db.query(
    `UPDATE campaigns
     SET status = 'funded'
     WHERE status = 'active'
       AND raised_amount >= target_amount
     RETURNING id, title, target_amount, raised_amount, deadline, status`
  );

  const { rows: failed } = await db.query(
    `UPDATE campaigns
     SET status = 'failed'
     WHERE status = 'active'
       AND deadline IS NOT NULL
       AND deadline < CURRENT_DATE
       AND raised_amount < target_amount
     RETURNING id, title, target_amount, raised_amount, deadline, status`
  );

  if (funded.length || failed.length) {
    logger.info('Campaign status refresh completed', {
      funded_count: funded.length,
      failed_count: failed.length,
    });
  }

  for (const campaign of funded) {
    await runStatusActionsForCampaign(campaign, requestId);
  }
  for (const campaign of failed) {
    await runStatusActionsForCampaign(campaign, requestId);
  }

  return { funded, failed };
}

module.exports = {
  refreshCampaignStatus,
  refreshActiveCampaignStatuses,
};
