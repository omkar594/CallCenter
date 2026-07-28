import express from 'express';
import { 
  initiateOutboundCall, 
  submitDisposition, 
  updateAgentBreakStatus, 
  getAgentBucket, 
  reassignAbsenteeBucket,
  triggerLanguageTransfer
} from '../controllers/callController.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { injectTenantContext } from '../middleware/rls.js';

const router = express.Router();

router.use(authenticateToken);
router.use(injectTenantContext);

// Agent features
router.post('/dial', authorizeRoles(['agent']), initiateOutboundCall);
router.post('/disposition', authorizeRoles(['agent']), submitDisposition);
router.post('/break', authorizeRoles(['agent']), updateAgentBreakStatus);
router.get('/bucket', authorizeRoles(['agent']), getAgentBucket);
router.post('/transfer-language', authorizeRoles(['agent']), triggerLanguageTransfer);

// Supervisor (TL / Mentor / Client Admin) features
router.post('/reassign-bucket', authorizeRoles(['team_leader', 'mentor', 'client_admin']), reassignAbsenteeBucket);

export default router;
