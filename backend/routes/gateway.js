import express from 'express';
import { getGateways, createGateway, getPortAllocations, allocatePort, getLiveGatewayStatus } from '../controllers/gatewayController.js';

const router = express.Router();

// Public Zero-Auth REST Endpoints for SIM Gateway Telemetry
router.get('/', getGateways);
router.post('/', createGateway);
router.get('/ports', getPortAllocations);
router.get('/allocations', getPortAllocations);
router.post('/ports/allocate', allocatePort);
router.get('/:gatewayId/live', getLiveGatewayStatus);

export default router;
