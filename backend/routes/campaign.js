import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { getCampaigns, getCampaignReport, createBroadcastCampaign } from '../controllers/campaignController.js';

// Ensure upload directories exist on boot (essential for cloud containers like Render)
if (!fs.existsSync('uploads/temp')) {
  fs.mkdirSync('uploads/temp', { recursive: true });
}
if (!fs.existsSync('uploads/campaign_audio')) {
  fs.mkdirSync('uploads/campaign_audio', { recursive: true });
}

const router = express.Router();
const upload = multer({ dest: 'uploads/temp/' });

// Conditional upload middleware: handles multipart/form-data uploads OR skips for application/json payloads
const optionalUpload = (req, res, next) => {
  if (req.is('multipart/form-data')) {
    return upload.fields([
      { name: 'leadsCsv', maxCount: 1 },
      { name: 'csv', maxCount: 1 },
      { name: 'broadcastAudio', maxCount: 1 },
      { name: 'audioFile', maxCount: 1 },
      { name: 'audio', maxCount: 1 },
      { name: 'file', maxCount: 1 }
    ])(req, res, next);
  }
  next();
};

// Public Zero-Auth REST Endpoints for Standalone Outbound Dialer

// 1. Get all campaigns list
router.get('/', getCampaigns);

// 2. Create new Outbound Voice Broadcast Campaign
router.post('/broadcast', optionalUpload, createBroadcastCampaign);

// 3. Get campaign detailed status & call progress
router.get('/:id', getCampaignReport);

export default router;
