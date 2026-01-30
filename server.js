// server.js
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Cloudinary config (تأكد من تعيين المتغيرات البيئية)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Memory storage لتفادي مشاكل /tmp
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function sanitizeFilename(name) {
  return String(name || '').trim().replace(/[^a-z0-9]/gi, '_').toLowerCase();
}
function isValidPackageName(pkg) {
  return /^[a-zA-Z][a-zA-Z0-9_\.]*$/.test(pkg);
}
function makeErrorResponse(code, message, details) {
  return { success: false, error: message, code, details };
}
async function uploadToCloudinaryBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    stream.end(buffer);
  });
}

app.post('/build-flutter', upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'projectZip', maxCount: 1 }]), async (req, res) => {
  try {
    // Validate envs required for GitHub dispatch
    const owner = process.env.GITHUB_REPO_OWNER;
    const repo = process.env.GITHUB_REPO_NAME;
    const token = process.env.GITHUB_TOKEN;
    if (!owner || !repo || !token) {
      console.error('Missing GITHUB_REPO_OWNER / GITHUB_REPO_NAME / GITHUB_TOKEN envs');
      return res.status(500).json(makeErrorResponse('MISSING_ENV', 'Server misconfigured: missing GitHub repo/token env variables'));
    }

    const { appName, packageName } = req.body || {};
    if (!appName || !packageName) return res.status(400).json(makeErrorResponse('MISSING_FIELDS', 'appName and packageName are required'));
    if (!isValidPackageName(packageName)) return res.status(400).json(makeErrorResponse('INVALID_PACKAGE', 'Invalid package name format'));
    if (!req.files || !req.files.icon || !req.files.projectZip) return res.status(400).json(makeErrorResponse('MISSING_FILES', 'icon and projectZip files are required'));

    const iconFile = req.files.icon[0];
    const zipFile = req.files.projectZip[0];
    if (!iconFile.mimetype.startsWith('image/')) return res.status(400).json(makeErrorResponse('INVALID_ICON', 'Icon must be an image'));
    if (!zipFile.originalname.toLowerCase().endsWith('.zip')) return res.status(400).json(makeErrorResponse('INVALID_ZIP', 'Project file must be a .zip'));

    const requestId = Date.now().toString();
    const safeAppName = sanitizeFilename(appName);

    // Upload icon (buffer) to Cloudinary
    let iconUpload;
    try {
      iconUpload = await uploadToCloudinaryBuffer(iconFile.buffer, {
        folder: 'aite_studio/icons',
        public_id: `${sanitizeFilename(packageName)}_icon_${requestId}`,
        resource_type: 'image',
        overwrite: true
      });
    } catch (err) {
      console.error('Cloudinary icon upload error:', err);
      return res.status(500).json(makeErrorResponse('CLOUDINARY_ICON_FAIL', 'Failed to upload icon', (err && err.message) || err));
    }

    // Upload ZIP
    let zipUpload;
    try {
      zipUpload = await uploadToCloudinaryBuffer(zipFile.buffer, {
        folder: 'aite_studio/projects',
        public_id: `${sanitizeFilename(packageName)}_source_${requestId}`,
        resource_type: 'raw',
        overwrite: true
      });
    } catch (err) {
      console.error('Cloudinary zip upload error:', err);
      return res.status(500).json(makeErrorResponse('CLOUDINARY_ZIP_FAIL', 'Failed to upload ZIP', (err && err.message) || err));
    }

    // Prepare GitHub dispatch payload
    const githubPayload = {
      event_type: "build-flutter",
      client_payload: {
        app_name: safeAppName,
        display_name: appName,
        package_name: packageName,
        icon_url: iconUpload.secure_url,
        zip_url: zipUpload.secure_url,
        request_id: requestId
      }
    };

    const ghUrl = `https://api.github.com/repos/${owner}/${repo}/dispatches`;
    const ghHeaders = {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    };

    // Log payload for debugging (لا تعرض هذا في بيئة عامة)
    console.log('Dispatching to GitHub:', ghUrl);
    console.log('Payload:', JSON.stringify(githubPayload, null, 2));

    try {
      // استخدم JSON.stringify صراحةً لضمان إرسال JSON نصي
      const resp = await axios.post(ghUrl, JSON.stringify(githubPayload), {
        headers: ghHeaders,
        timeout: 20000,
        validateStatus: null // لا ترمي استثناء تلقائياً حتى نتمكن من فحص الجسم
      });

      // GitHub returns 204 No Content on success for repository_dispatch
      console.log('GitHub response status:', resp.status);
      // إذا كان الجسم نصياً أو HTML نعرضه كما هو
      console.log('GitHub response headers:', resp.headers);
      if (resp.data) {
        console.log('GitHub response data (first 200 chars):', typeof resp.data === 'string' ? resp.data.slice(0,200) : JSON.stringify(resp.data).slice(0,200));
      }

      if (resp.status >= 200 && resp.status < 300) {
        return res.json({
          success: true,
          build_id: requestId,
          safe_app_name: safeAppName,
          icon_url: iconUpload.secure_url,
          app_name: appName,
          package_name: packageName
        });
      } else {
        // إعادة نص الخطأ كما هو لمساعدة التشخيص (قد يكون HTML أو نص خطأ)
        const body = (resp.data && (typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data))) || '';
        console.error('GitHub dispatch failed', resp.status, body);
        return res.status(500).json(makeErrorResponse('GITHUB_DISPATCH_RESPONSE', 'GitHub dispatch failed', { status: resp.status, body: body.slice(0,200) }));
      }
    } catch (err) {
      // التقاط أخطاء الشبكة وAxios
      console.error('Axios error while dispatching to GitHub:', err && (err.stack || err.message || err));
      if (err.response) {
        // حاول طباعة الجسم كما هو
        const r = err.response;
        const body = r.data && (typeof r.data === 'string' ? r.data : JSON.stringify(r.data));
        return res.status(500).json(makeErrorResponse('GITHUB_DISPATCH_ERROR', 'Failed to dispatch to GitHub', { status: r.status, body: body && body.slice(0,500) }));
      }
      return res.status(500).json(makeErrorResponse('GITHUB_DISPATCH_NETWORK', 'Network/Timeout error when dispatching to GitHub', err.message || err));
    }

  } catch (err) {
    console.error('Unexpected server error:', err && (err.stack || err));
    return res.status(500).json(makeErrorResponse('SERVER_ERROR', 'Unexpected server error', err.message || err));
  }
});

// status endpoint
app.get('/check-status/:buildId', async (req, res) => {
  try {
    const { buildId } = req.params;
    const { appName } = req.query;
    if (!buildId || !appName) return res.status(400).json({ error: "Missing parameters" });

    const owner = process.env.GITHUB_REPO_OWNER;
    const repo = process.env.GITHUB_REPO_NAME;
    const token = process.env.GITHUB_TOKEN;
    if (!owner || !repo || !token) return res.status(500).json({ error: "Missing GitHub envs" });

    const releaseUrl = `https://api.github.com/repos/${owner}/${repo}/releases/tags/build-${buildId}`;
    try {
      const resp = await axios.get(releaseUrl, { headers: { 'Authorization': `token ${token}` }, timeout: 8000, validateStatus: null });
      if (resp.status >= 200 && resp.status < 300) {
        const downloadUrl = `https://github.com/${owner}/${repo}/releases/download/build-${buildId}/${encodeURIComponent(appName)}.apk`;
        return res.json({ completed: true, download_url: downloadUrl });
      } else {
        return res.json({ completed: false });
      }
    } catch (err) {
      console.error("Status check error:", err && (err.stack || err));
      return res.status(500).json({ error: "Check failed" });
    }
  } catch (error) {
    console.error("Status endpoint error:", error && (error.stack || error));
    return res.status(500).json({ error: "Check failed" });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
module.exports = app;
