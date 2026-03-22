const express = require('express');
const router = express.Router();
const auth = require('../middleware/authenticate');
const { isAdmin } = require('../middleware/authorize');
const ruraRoutesController = require('../controllers/ruraRoutesController');

router.get('/', auth, isAdmin, ruraRoutesController.listRoutes);
router.post('/', auth, isAdmin, ruraRoutesController.createRoute);
router.put('/:id', auth, isAdmin, ruraRoutesController.updateRoute);
router.delete('/:id', auth, isAdmin, ruraRoutesController.softDeleteRoute);

module.exports = router;
