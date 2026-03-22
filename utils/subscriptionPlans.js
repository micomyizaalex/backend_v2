const PLAN_ORDER = ['Starter', 'Growth', 'Enterprise'];

const PLAN_DEFINITIONS = {
  Starter: {
    name: 'Starter',
    description: 'Basic dashboard access with starter operational limits.',
    maxBuses: 5,
    maxRoutes: 10,
    maxActiveSchedules: 30,
    features: {
      basicDashboard: true,
      addBuses: true,
      addRoutes: true,
      advancedSchedules: false,
      unlimitedRoutes: false,
      basicAnalytics: false,
      fullAnalytics: false,
      revenueReports: false,
      premiumFeatures: false,
      prioritySupport: false,
    },
  },
  Growth: {
    name: 'Growth',
    description: 'Adds advanced scheduling, unlimited routes, and basic analytics.',
    maxBuses: 20,
    maxRoutes: null,
    maxActiveSchedules: null,
    features: {
      basicDashboard: true,
      addBuses: true,
      addRoutes: true,
      advancedSchedules: true,
      unlimitedRoutes: true,
      basicAnalytics: true,
      fullAnalytics: false,
      revenueReports: false,
      premiumFeatures: false,
      prioritySupport: false,
    },
  },
  Enterprise: {
    name: 'Enterprise',
    description: 'Full analytics, revenue reports, premium features, and priority support.',
    maxBuses: null,
    maxRoutes: null,
    maxActiveSchedules: null,
    features: {
      basicDashboard: true,
      addBuses: true,
      addRoutes: true,
      advancedSchedules: true,
      unlimitedRoutes: true,
      basicAnalytics: true,
      fullAnalytics: true,
      revenueReports: true,
      premiumFeatures: true,
      prioritySupport: true,
    },
  },
};

const DEFAULT_PLAN = 'Starter';

const normalizePlan = (value) => {
  const input = String(value || '').trim().toLowerCase();
  return PLAN_ORDER.find((plan) => plan.toLowerCase() === input) || null;
};

const getPlanDefinition = (plan) => {
  const normalized = normalizePlan(plan) || DEFAULT_PLAN;
  return PLAN_DEFINITIONS[normalized];
};

const getPlanPermissions = (plan) => {
  const definition = getPlanDefinition(plan);
  return {
    plan: definition.name,
    description: definition.description,
    limits: {
      maxBuses: definition.maxBuses,
      maxRoutes: definition.maxRoutes,
      maxActiveSchedules: definition.maxActiveSchedules,
    },
    features: definition.features,
    featureList: Object.entries(definition.features)
      .filter(([, enabled]) => enabled)
      .map(([feature]) => feature),
  };
};

const hasPlanFeature = (plan, featureName) => {
  const permissions = getPlanPermissions(plan);
  return !!permissions.features[featureName];
};

const isPlanUpgrade = (fromPlan, toPlan) => {
  const fromIndex = PLAN_ORDER.indexOf(normalizePlan(fromPlan) || DEFAULT_PLAN);
  const toIndex = PLAN_ORDER.indexOf(normalizePlan(toPlan) || DEFAULT_PLAN);
  return toIndex > fromIndex;
};

const defaultNextPaymentDate = (baseDate = new Date()) => {
  const next = new Date(baseDate);
  next.setDate(next.getDate() + 30);
  return next.toISOString().slice(0, 10);
};

module.exports = {
  DEFAULT_PLAN,
  PLAN_ORDER,
  PLAN_DEFINITIONS,
  normalizePlan,
  getPlanDefinition,
  getPlanPermissions,
  hasPlanFeature,
  isPlanUpgrade,
  defaultNextPaymentDate,
};