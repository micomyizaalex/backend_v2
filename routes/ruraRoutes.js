const express = require('express');
const router = express.Router();
const auth = require('../middleware/authenticate');
const { isAdmin, requireRoles } = require('../middleware/authorize');
const ruraRoutesController = require('../controllers/ruraRoutesController');

// Read-only endpoints accessible by company admins and system admins
router.get('/locations', auth, requireRoles(['admin','company_admin']), ruraRoutesController.getLocations);
router.get('/stats',     auth, requireRoles(['admin','company_admin']), ruraRoutesController.getStats);
router.get('/',          auth, requireRoles(['admin','company_admin']), ruraRoutesController.listRoutes);
router.get('/:id/stops', auth, requireRoles(['admin','company_admin']), ruraRoutesController.getRouteStops);

// Mutation endpoints — admin only
router.post('/',         auth, isAdmin, ruraRoutesController.createRoute);
router.put('/:id',       auth, isAdmin, ruraRoutesController.updateRoute);
router.delete('/:id',    auth, isAdmin, ruraRoutesController.deleteRoute);

module.exports = router;
