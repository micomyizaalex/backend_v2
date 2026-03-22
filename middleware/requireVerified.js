// middleware/requireVerified.js
// Guards subscription/payment routes: company_admin users must have
// email verified, company verified, and account_status === 'approved'.

const { User } = require('../models');

const requireCompanyVerified = async (req, res, next) => {
  // Only applies to company_admin role; other roles pass through
  if (req.userRole !== 'company_admin') return next();

  try {
    const user = await User.findByPk(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    if (!user.email_verified) {
      return res.status(403).json({
        error: 'Please verify your email before purchasing a subscription.',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }

    if (!user.company_verified || user.account_status !== 'approved') {
      return res.status(403).json({
        error: 'Your company must be verified before purchasing a subscription.',
        code: 'COMPANY_NOT_VERIFIED',
        accountStatus: user.account_status,
      });
    }

    next();
  } catch (err) {
    res.status(500).json({ error: 'Verification check failed' });
  }
};

module.exports = { requireCompanyVerified };
