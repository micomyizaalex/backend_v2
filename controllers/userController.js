const path = require('path');
const fs = require('fs');
const { User } = require('../models');
const { Op } = require('sequelize');

// ─── GET /api/user/profile ────────────────────────────────────────────────────
const getProfile = async (req, res) => {
  try {
    const user = await User.findByPk(req.userId, { attributes: { exclude: ['password'] } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      id: user.id,
      name: user.full_name || '',
      email: user.email,
      phone: user.phone_number || null,
      role: user.role,
      profile_image: user.avatar_url || null,
      email_verified: user.email_verified,
      company_id: user.company_id || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── PUT /api/user/profile ────────────────────────────────────────────────────
const updateProfile = async (req, res) => {
  try {
    const user = await User.findByPk(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Accept both naming conventions from the frontend FormData
    const name = req.body.full_name ?? req.body.name;
    const phone = req.body.phone_number ?? req.body.phone;

    // Validate phone if provided
    if (phone !== undefined && phone !== '') {
      const digits = phone.replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) {
        return res.status(400).json({ error: 'Phone number must be 8–15 digits' });
      }
    }

    if (typeof name !== 'undefined') user.full_name = name.trim();
    if (typeof phone !== 'undefined') user.phone_number = phone || null;

    // Handle profile image upload
    if (req.file) {
      // Delete old file if it exists and is in our uploads dir
      if (user.avatar_url && user.avatar_url.startsWith('/uploads/')) {
        const oldPath = path.join(__dirname, '..', user.avatar_url);
        fs.unlink(oldPath, () => {}); // silent — file may not exist
      }
      user.avatar_url = `/uploads/profiles/${req.file.filename}`;
    }

    await user.save();

    res.json({
      message: 'Profile updated successfully',
      user: {
        id: user.id,
        name: user.full_name || '',
        email: user.email,
        phone: user.phone_number || null,
        role: user.role,
        profile_image: user.avatar_url || null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── PUT /api/user/change-password ───────────────────────────────────────────
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new passwords are required' });
    }
    if (newPassword.length < 8 || !/[0-9]/.test(newPassword) || !/[A-Za-z]/.test(newPassword)) {
      return res.status(400).json({ error: 'New password must be at least 8 characters and include letters and numbers' });
    }

    const user = await User.findByPk(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ok = await user.comparePassword(currentPassword);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── Admin helpers (kept for admin routes) ───────────────────────────────────
const getAllUsers = async (req, res) => {
  try {
    const users = await User.findAll({
      where: { id: { [Op.ne]: req.userId } },
      attributes: { exclude: ['password'] },
    });
    res.json(users);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getUserById = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, { attributes: { exclude: ['password'] } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

module.exports = {
  getProfile,
  updateProfile,
  changePassword,
  getAllUsers,
  getUserById,
};
