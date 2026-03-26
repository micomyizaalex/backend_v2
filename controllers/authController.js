const { User, Company, Driver } = require('../models');
const { generateAccessToken, generateRefreshToken, verifyToken } = require('../config/jwt');
const pool = require('../config/pgPool');
const { generateSecureToken } = require('../utils/generateToken');
const { sendEmail } = require('../utils/mailer');
const { DEFAULT_PLAN, getPlanPermissions, normalizePlan } = require('../utils/subscriptionPlans');

async function buildUserPayload(user) {
  if (!user) {
    throw new Error('User not found');
  }

  const safeUser = user.toSafeObject();
  const company = safeUser.company_id ? await Company.findByPk(safeUser.company_id) : null;
  const companyPlan = normalizePlan(company?.plan || company?.subscription_plan) || DEFAULT_PLAN;
  const permissions = safeUser.permissions && Object.keys(safeUser.permissions).length
    ? safeUser.permissions
    : getPlanPermissions(companyPlan);

  return {
    id: safeUser.id,
    name: safeUser.full_name || safeUser.name || '',
    email: safeUser.email,
    phone: safeUser.phone_number || safeUser.phone || null,
    role: safeUser.role,
    avatar_url: safeUser.avatar_url || null,
    companyId: safeUser.company_id || null,
    emailVerified: safeUser.email_verified,
    companyVerified: safeUser.company_verified,
    accountStatus: safeUser.account_status,
    subscriptionPlan: companyPlan,
    planPermissions: permissions,
  };
}

// Helper to compute a default home path for a given role
function roleHomePath(role) {
  switch (role) {
    case 'driver':
      return '/driver/dashboard';
    case 'company_admin':
    case 'company': // legacy/alternate role value
      return '/company/dashboard';
    case 'commuter':
      return '/dashboard/commuter';
    case 'admin':
      return '/dashboard/admin';
    default:
      return '/';
  }
}

const register = async (req, res) => {
  try {
    const { full_name, email, password, role, company_name, phone_number } = req.body;

    // Prevent admin role creation via signup
    if (role === 'admin') {
      return res.status(403).json({ error: 'Admin accounts cannot be created through signup' });
    }

    // Validate role
    const allowedRoles = ['commuter', 'company_admin', 'driver'];
    if (role && !allowedRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role specified' });
    }

    const user = await User.create({
      full_name,
      email,
      password,
      role: role || 'commuter',
      phone_number,
      company_id: req.body.company_id || null
    });

    // If registering a company admin, create a PENDING company and require email + admin verification
    if (role === 'company_admin') {
      const { address, country } = req.body;

      if (!company_name) {
        return res.status(400).json({ error: 'company_name is required for company registration' });
      }

      const company = await Company.create({
        owner_id: user.id,
        name: company_name,
        email: email,
        phone: phone_number,
        address: address || null,
        country: country || null,
        status: 'pending',
        is_approved: false,
      });

      // Link company to user — keep inactive until email is verified
      await user.update({
        company_id: company.id,
        is_active: false,
        account_status: 'pending',
        company_verified: false,
      });

      // Send email verification
      await _sendVerificationEmail(user);

      return res.status(201).json({
        message: 'Company account created. Please check your email to verify your account before continuing.',
        email: user.email,
      });
    }

    // If registering as a driver and a license_number was provided, create a Driver profile
    if (role === 'driver') {
      const { license_number } = req.body;
      try {
        if (license_number) {
          await Driver.create({
            company_id: req.body.company_id || null,
            user_id: user.id,
            name: full_name,
            license_number,
            phone: phone_number,
            email
          });
        }
      } catch (drvErr) {
        console.warn('Failed to create Driver profile during registration:', drvErr && drvErr.message ? drvErr.message : drvErr);
      }
    }

    // Send email verification — do NOT issue tokens yet
    await _sendVerificationEmail(user);

    res.status(201).json({
      message: 'Registration successful. Please check your email to verify your account before logging in.',
      email: user.email
    });
  } catch (error) {
    if (error?.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ error: 'An account with that email already exists.' });
    }

    if (error?.name === 'SequelizeValidationError' && Array.isArray(error.errors) && error.errors.length > 0) {
      return res.status(400).json({ error: error.errors[0].message });
    }

    res.status(400).json({ error: error.message });
  }
};

// Internal helper shared by register and sendEmailVerification
async function _sendVerificationEmail(user) {
  // Remove any previous pending token for this user
  await pool.query('DELETE FROM email_verifications WHERE user_id = $1', [user.id]);

  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  await pool.query(
    'INSERT INTO email_verifications (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [user.id, token, expiresAt]
  );

  const baseUrl = process.env.APP_URL || process.env.FRONTEND_URL || 'https://safaritix.com';
  const verifyUrl = `${baseUrl}/verify-email?token=${token}`;

  await sendEmail({
    to: user.email,
    subject: 'SafariTix – Verify Your Email Address',
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px;border:1px solid #e5e7eb;border-radius:8px;">
        <h2 style="color:#0077B6;">Verify Your Email</h2>
        <p>Hi ${user.full_name || 'there'},</p>
        <p>Thanks for joining SafariTix! Click the button below to verify your email. This link expires in <strong>24 hours</strong>.</p>
        <a href="${verifyUrl}" style="display:inline-block;margin:20px 0;padding:12px 28px;background:#0077B6;color:#fff;text-decoration:none;border-radius:6px;font-size:15px;">Verify Email</a>
        <p style="color:#6b7280;font-size:13px;">If you didn't create a SafariTix account, you can safely ignore this email.</p>
      </div>
    `,
    text: `Verify your SafariTix email: ${verifyUrl}`
  });
}

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await user.comparePassword(password);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is not active' });
    }

    if (!user.email_verified) {
      return res.status(403).json({
        error: 'Email not verified. Please check your inbox and verify your email before logging in.',
        code: 'EMAIL_NOT_VERIFIED',
        email: user.email
      });
    }

    const token = generateAccessToken(user.id, user.role);
    const refreshTok = generateRefreshToken(user.id);

    // Persist refresh token
    const rtExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, refreshTok, rtExpiry]
    ).catch(() => {}); // non-blocking – table may not exist yet in dev

    // Update last login timestamp
    await user.update({ last_login: new Date() }).catch(() => {});

    const userPayload = await buildUserPayload(user);

    res.json({
      user: { ...userPayload, homePath: roleHomePath(userPayload.role) },
      token,
      refreshToken: refreshTok,
      homePath: roleHomePath(userPayload.role),
      must_change_password: !!user.must_change_password
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const changePassword = async (req, res) => {
  try {
    const userId = req.userId;
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8 || !/[0-9]/.test(newPassword) || !/[A-Za-z]/.test(newPassword)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters and include letters and numbers' });
    }

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // If user has must_change_password true, allow change without currentPassword verification
    if (!user.must_change_password) {
      if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
      const ok = await user.comparePassword(currentPassword);
      if (!ok) return res.status(401).json({ error: 'Invalid current password' });
    }

    user.password = newPassword;
    user.must_change_password = false;
    await user.save();

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const updateProfile = async (req, res) => {
  try {
    const userId = req.userId;
    const { full_name, email, phone_number, avatar_url, preferences } = req.body;
    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // update allowed fields
    if (typeof full_name !== 'undefined') user.full_name = full_name;
    if (typeof email !== 'undefined') user.email = email;
    if (typeof phone_number !== 'undefined') user.phone_number = phone_number;
    if (typeof avatar_url !== 'undefined') user.avatar_url = avatar_url;
    if (typeof preferences !== 'undefined') user.preferences = preferences;

    await user.save();

    const userPayload = await buildUserPayload(user);

    res.json({ user: { ...userPayload, homePath: roleHomePath(userPayload.role) } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const getMe = async (req, res) => {
  try {
    const user = await User.findByPk(req.userId);
    if (!user) {
      return res.status(401).json({ error: 'User account no longer exists' });
    }

    const userPayload = await buildUserPayload(user);
    res.json({ user: { ...userPayload, homePath: roleHomePath(userPayload.role) }, homePath: roleHomePath(userPayload.role) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};



// ─── Refresh Token ────────────────────────────────────────────────────────────
const refreshToken = async (req, res) => {
  const { refreshToken: token } = req.body;
  if (!token) return res.status(400).json({ error: 'Refresh token required' });

  const decoded = verifyToken(token);
  if (!decoded || !decoded.userId) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  // Check the token exists in DB and is not expired
  const { rows } = await pool.query(
    'SELECT id FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()',
    [token]
  );
  if (rows.length === 0) {
    return res.status(401).json({ error: 'Refresh token not recognised or expired' });
  }

  const user = await User.findByPk(decoded.userId);
  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'User account not active' });
  }

  // Rotate: delete old token, issue new pair
  await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [token]);

  const newAccessToken  = generateAccessToken(user.id, user.role);
  const newRefreshToken = generateRefreshToken(user.id);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [user.id, newRefreshToken, expiresAt]
  );

  res.json({ token: newAccessToken, refreshToken: newRefreshToken });
};

// ─── Logout ───────────────────────────────────────────────────────────────────
const logout = async (req, res) => {
  const { refreshToken: token } = req.body;
  if (token) {
    await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [token]).catch(() => {});
  }
  res.json({ message: 'Logged out successfully' });
};

// ─── Forgot Password ──────────────────────────────────────────────────────────
const forgotPassword = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  // Always return success to avoid user enumeration
  const user = await User.findOne({ where: { email } });
  if (!user) return res.json({ message: 'If that email exists, a reset link has been sent' });

  // Invalidate any previous tokens for this user
  await pool.query('DELETE FROM password_resets WHERE user_id = $1', [user.id]);

  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await pool.query(
    'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [user.id, token, expiresAt]
  );

  const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${token}`;

  await sendEmail({
    to: user.email,
    subject: 'SafariTix – Password Reset Request',
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px;border:1px solid #e5e7eb;border-radius:8px;">
        <h2 style="color:#0077B6;">Reset Your Password</h2>
        <p>Hi ${user.full_name || 'there'},</p>
        <p>We received a request to reset your SafariTix password. Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
        <a href="${resetUrl}" style="display:inline-block;margin:20px 0;padding:12px 28px;background:#0077B6;color:#fff;text-decoration:none;border-radius:6px;font-size:15px;">Reset Password</a>
        <p style="color:#6b7280;font-size:13px;">If you didn't request this, please ignore this email. Your password will remain unchanged.</p>
      </div>
    `,
    text: `Reset your SafariTix password: ${resetUrl}`
  });

  res.json({ message: 'If that email exists, a reset link has been sent' });
};

// ─── Reset Password ───────────────────────────────────────────────────────────
const resetPassword = async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required' });

  if (newPassword.length < 8 || !/[0-9]/.test(newPassword) || !/[A-Za-z]/.test(newPassword)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters and include letters and numbers' });
  }

  const { rows } = await pool.query(
    'SELECT id, user_id FROM password_resets WHERE token = $1 AND used = FALSE AND expires_at > NOW()',
    [token]
  );
  if (rows.length === 0) return res.status(400).json({ error: 'Token is invalid or has expired' });

  const { id: resetId, user_id } = rows[0];

  const user = await User.findByPk(user_id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.password = newPassword;
  user.must_change_password = false;
  await user.save();

  await pool.query('UPDATE password_resets SET used = TRUE WHERE id = $1', [resetId]);

  // Invalidate all refresh tokens on password change
  await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [user_id]);

  res.json({ message: 'Password reset successfully. Please log in with your new password.' });
};

// ─── Send Email Verification (authenticated — for account settings) ─────────────
const sendEmailVerification = async (req, res) => {
  const userId = req.userId;
  const user = await User.findByPk(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.email_verified) return res.status(400).json({ error: 'Email is already verified' });
  await _sendVerificationEmail(user);
  res.json({ message: 'Verification email sent. Please check your inbox.' });
};

// ─── Resend Email Verification (public — user provides their email) ─────────────
const resendEmailVerification = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  // Anti-enumeration: always succeed externally
  const user = await User.findOne({ where: { email } });
  if (!user || user.email_verified) {
    return res.json({ message: 'If that email exists and is unverified, a new link has been sent.' });
  }
  await _sendVerificationEmail(user);
  res.json({ message: 'If that email exists and is unverified, a new link has been sent.' });
};

// ─── Verify Email ─────────────────────────────────────────────────────────────
const verifyEmail = async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Verification token required' });

  const { rows } = await pool.query(
    'SELECT id, user_id FROM email_verifications WHERE token = $1 AND expires_at > NOW()',
    [token]
  );
  if (rows.length === 0) return res.status(400).json({ error: 'Token is invalid or has expired' });

  const { id: verifyId, user_id } = rows[0];

  // Activate the user account so they can log in after verification
  const user = await User.findByPk(user_id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  await user.update({ email_verified: true, is_active: true });
  await pool.query('DELETE FROM email_verifications WHERE id = $1', [verifyId]);

  let message = 'Email verified successfully. You can now log in.';
  let requiresDocuments = false;
  if (user.role === 'company_admin') {
    message = 'Your email is verified. Please submit company verification documents to complete your registration.';
    requiresDocuments = true;
  }

  res.json({ message, role: user.role, requiresDocuments });
};

module.exports = {
  register,
  login,
  getMe,
  changePassword,
  updateProfile,
  refreshToken,
  logout,
  forgotPassword,
  resetPassword,
  sendEmailVerification,
  resendEmailVerification,
  verifyEmail,
};
