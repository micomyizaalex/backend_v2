const { User, Post, Comment } = require('../models');

// Check if user is admin
const isAdmin = (req, res, next) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// Role-based guard to keep protected routes tight
const requireRoles = (roles = []) => (req, res, next) => {
  if (!req.userRole || !roles.includes(req.userRole)) {
    return res.status(403).json({ error: 'Forbidden', message: 'Insufficient role to access this resource' });
  }
  next();
};

// Ensure current user is associated with a company and attach companyId to request
const requireCompany = async (req, res, next) => {
  try {
    const { User, Company } = require('../models');
    const user = await User.findByPk(req.userId);
    if (!user) return res.status(403).json({ error: 'User not found' });

    const companyId = user.company_id || (await Company.findOne({ where: { owner_id: req.userId }, attributes: ['id'] }))?.id || null;
    if (!companyId) return res.status(403).json({ error: 'No company associated with user' });

    req.companyId = companyId;
    next();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Ensure driver has changed temporary password before accessing driver-only routes
const ensurePasswordChanged = (req, res, next) => {
  try {
    if (req.userRole === 'driver' && req.mustChangePassword) {
      return res.status(403).json({ error: 'PASSWORD_CHANGE_REQUIRED', message: 'Please change your temporary password' });
    }
    next();
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

// Check if user owns resource (post)
const isPostOwner = async (req, res, next) => {
  try {
    const post = await Post.findByPk(req.params.id);
    
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (post.user_id !== req.userId && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    next();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Check if user owns resource (comment)
const isCommentOwner = async (req, res, next) => {
  try {
    const comment = await Comment.findByPk(req.params.id);
    
    if (!comment) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    if (comment.user_id !== req.userId && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    next();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Check if user owns resource (user profile)
const isProfileOwner = (req, res, next) => {
  if (req.params.id && req.params.id != req.userId && req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }
  next();
};

module.exports = {
  isAdmin,
  isPostOwner,
  isCommentOwner,
  isProfileOwner,
  requireRoles
  ,requireCompany
  ,ensurePasswordChanged
};