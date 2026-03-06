const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const auth = require('../middleware/authenticate');
const { uploadProfileImage } = require('../middleware/upload');

// ─── Profile endpoints (all roles) ───────────────────────────────────────────
router.get('/profile', auth, userController.getProfile);
router.put('/profile', auth, (req, res, next) => {
  uploadProfileImage(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, userController.updateProfile);
router.put('/change-password', auth, userController.changePassword);

// ─── Admin helpers ────────────────────────────────────────────────────────────
router.get('/', auth, userController.getAllUsers);
router.get('/:id', auth, userController.getUserById);

module.exports = router;
