'use strict';

const express = require('express');
const { db, logActivity } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const logger = require('../utils/logger');

const router = express.Router();

// GET /api/admin/whatsapp/config
router.get('/config', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const config = await db('whatsapp_configs').first();
    if (!config) {
      return res.json({
        phone_number_id: '',
        waba_id: '',
        access_token: '',
        template_name: 'gallery_ready',
        enabled: false,
      });
    }
    res.json({
      phone_number_id: config.phone_number_id,
      waba_id: config.waba_id,
      access_token: config.access_token ? '********' : '',
      template_name: config.template_name,
      enabled: Boolean(config.enabled),
    });
  } catch (error) {
    logger.error('GET whatsapp-config error:', error);
    res.status(500).json({ error: 'Failed to load WhatsApp configuration' });
  }
});

// PUT /api/admin/whatsapp/config
router.put('/config', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const { phone_number_id, waba_id, access_token, template_name, enabled } = req.body;

    const existing = await db('whatsapp_configs').first();

    const data = {
      phone_number_id: phone_number_id || '',
      waba_id: waba_id || '',
      template_name: template_name || 'gallery_ready',
      enabled: Boolean(enabled),
      updated_at: new Date(),
    };

    if (access_token && access_token !== '********') {
      data.access_token = access_token;
    }

    if (existing) {
      await db('whatsapp_configs').where('id', existing.id).update(data);
    } else {
      if (!data.access_token) data.access_token = '';
      await db('whatsapp_configs').insert(data);
    }

    await logActivity(
      'whatsapp_config_updated',
      { phone_number_id, enabled },
      null,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('PUT whatsapp-config error:', error);
    res.status(500).json({ error: 'Failed to save WhatsApp configuration' });
  }
});

// POST /api/admin/whatsapp/test
router.post('/test', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const config = await db('whatsapp_configs').first();
    if (!config || !config.phone_number_id || !config.access_token) {
      return res.status(400).json({ error: 'WhatsApp is not configured' });
    }

    const testComponents = [
      'Test User',
      'Test Gallery',
      'https://example.com/gallery/test',
      '',
      '',
    ];

    const result = await sendWhatsAppMessage(phone, config, 'pt_BR', testComponents);
    res.json({ success: true, messageId: result.messageId });
  } catch (error) {
    logger.error('WhatsApp test send error:', error);
    res.status(500).json({ error: error.message || 'Failed to send test message' });
  }
});

module.exports = router;
