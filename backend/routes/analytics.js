import express from 'express';
import { getLiveMetrics, getCallLogs } from '../controllers/analyticsController.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { injectTenantContext } from '../middleware/rls.js';

const router = express.Router();

router.use(authenticateToken);
router.use(injectTenantContext);

router.get('/live', authorizeRoles(['client_admin', 'mentor', 'team_leader']), getLiveMetrics);
router.get('/logs', authorizeRoles(['super_admin', 'client_admin', 'mentor', 'team_leader']), getCallLogs);

export default router;
