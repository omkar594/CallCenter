import express from 'express';
import { login, logout, createAgent, getMySipCredentials } from '../controllers/authController.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

router.post('/login', login);
router.post('/logout', authenticateToken, logout);

// Workstream 7: agent provisioning + softphone credential fetch.
router.post('/agents', authenticateToken, authorizeRoles(['super_admin', 'client_admin', 'team_leader']), createAgent);
router.get('/me/sip-credentials', authenticateToken, getMySipCredentials);

export default router;
