const pgPool = require('../config/pgPool');
const { DEFAULT_PLAN, getPlanPermissions, hasPlanFeature } = require('../utils/subscriptionPlans');

let companyPlanColumnState = null;

const getCompanyPlanColumnState = async () => {
  if (companyPlanColumnState) return companyPlanColumnState;

  const result = await pgPool.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'companies'
        AND column_name IN ('plan', 'subscription_plan')
    `
  );

  const columns = new Set(result.rows.map((row) => row.column_name));
  companyPlanColumnState = {
    hasPlan: columns.has('plan'),
    hasSubscriptionPlan: columns.has('subscription_plan'),
  };

  return companyPlanColumnState;
};

const loadCompanyPlan = async (companyId) => {
  const columns = await getCompanyPlanColumnState();

  let selectExpr = '$2';
  if (columns.hasPlan && columns.hasSubscriptionPlan) {
    selectExpr = 'COALESCE(plan, subscription_plan, $2)';
  } else if (columns.hasPlan) {
    selectExpr = 'COALESCE(plan, $2)';
  } else if (columns.hasSubscriptionPlan) {
    selectExpr = 'COALESCE(subscription_plan, $2)';
  }

  const result = await pgPool.query(
    `SELECT ${selectExpr} AS plan
     FROM companies
     WHERE id = $1`,
    [companyId, DEFAULT_PLAN]
  );

  return result.rows[0]?.plan || DEFAULT_PLAN;
};

const requireCompanyPlanFeature = (featureName) => async (req, res, next) => {
  try {
    const companyId = req.companyId;
    if (!companyId) {
      return res.status(403).json({ error: 'No company associated with user' });
    }

    const plan = await loadCompanyPlan(companyId);
    if (!hasPlanFeature(plan, featureName)) {
      return res.status(403).json({
        error: 'This feature is not available on the current subscription plan',
        code: 'PLAN_FEATURE_BLOCKED',
        feature: featureName,
        subscriptionPlan: plan,
        permissions: getPlanPermissions(plan),
      });
    }

    req.companyPlan = plan;
    req.companyPermissions = getPlanPermissions(plan);
    next();
  } catch (error) {
    console.error('requireCompanyPlanFeature error:', error);
    res.status(500).json({ error: 'Plan permission check failed' });
  }
};

module.exports = { requireCompanyPlanFeature, loadCompanyPlan };