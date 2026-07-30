import express from 'express';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { getCampaigns, getCampaignReport, createBroadcastCampaign, handleCampaignCallback } from '../controllers/campaignController.js';

const AUDIO_FIELDS = new Set(['broadcastAudio', 'audioFile', 'audio', 'file']);
const CSV_FIELDS = new Set(['leadsCsv', 'csv']);
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25MB - generous for a short voice prompt
const MAX_CSV_BYTES = 10 * 1024 * 1024; // 10MB - generous for a large lead list

// Use OS temporary directory for upload stream buffer (guaranteed to exist on all cloud platforms like Render)
const router = express.Router();
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 2 },
  fileFilter: (req, file, cb) => {
    if (AUDIO_FIELDS.has(file.fieldname)) {
      if (!file.mimetype.startsWith('audio/')) {
        return cb(new Error(`Field "${file.fieldname}" must be an audio file, got ${file.mimetype}`));
      }
      return cb(null, true);
    }
    if (CSV_FIELDS.has(file.fieldname)) {
      const okType = file.mimetype === 'text/csv' || file.mimetype === 'text/plain' || file.mimetype === 'application/vnd.ms-excel';
      if (!okType) {
        return cb(new Error(`Field "${file.fieldname}" must be a CSV file, got ${file.mimetype}`));
      }
      return cb(null, true);
    }
    cb(new Error(`Unexpected upload field "${file.fieldname}"`));
  }
});

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
    ])(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'Upload rejected' });
      }
      next();
    });
  }
  next();
};

// Public Zero-Auth REST Endpoints for Standalone Outbound Dialer

// 1. Get all campaigns list
router.get('/', getCampaigns);

// 2. Create new Outbound Voice Broadcast Campaign
router.post('/broadcast', optionalUpload, createBroadcastCampaign);

// 3. Webhook for Asterisk dialplan to report call status. MUST be registered before '/:id'
// or Express matches it as a campaign id lookup instead (see server.js history for the bug this fixes).
router.get('/callback', handleCampaignCallback);

// 4. Get campaign detailed status & call progress
router.get('/:id', getCampaignReport);

export default router;
