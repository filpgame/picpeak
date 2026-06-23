/**
 * Public workflow-approval endpoint — the confirm/deny links emailed to the
 * admin when a workflow gate is reached. Token is the single-use raw value
 * (hashed at rest); the action resumes the run down the matching edge.
 *
 * GET is used so the link is clickable from an email client. The token is
 * single-use and the handler is idempotent (a second click shows "already
 * recorded"), so prefetching can't double-act.
 */
const express = require('express');

const router = express.Router();
const { actByToken } = require('../services/workflows');

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${title}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;padding:0 20px;text-align:center;color:#1f2937">`
    + `<h2 style="font-weight:600">${title}</h2><p style="color:#4b5563;line-height:1.6">${body}</p></body></html>`;
}

router.get('/:token/:action', async (req, res) => {
  const { token, action } = req.params;
  if (!['confirm', 'deny'].includes(action)) {
    return res.status(400).send(page('Invalid link', 'This confirmation link is not valid.'));
  }
  try {
    const result = await actByToken(token, action);
    if (!result.ok && result.reason === 'not_found') {
      return res.status(404).send(page('Link not found', 'This confirmation link is invalid or has been revoked.'));
    }
    if (!result.ok && result.reason === 'expired') {
      return res.status(410).send(page('Link expired', 'This confirmation link has expired. Use the workflow inbox in the admin panel instead.'));
    }
    if (result.already) {
      return res.send(page('Already recorded', `This request was already ${result.status}.`));
    }
    return res.send(page(
      'Thank you',
      action === 'confirm'
        ? 'Confirmed — the workflow will continue.'
        : 'Recorded — the workflow has been told there is no payment / to stop.',
    ));
  } catch (e) {
    return res.status(500).send(page('Something went wrong', 'We could not record your response. Please try again or use the admin panel.'));
  }
});

module.exports = router;
