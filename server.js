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

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Use memory storage for small uploads to avoid /tmp issues
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
    const { appName, packageName } = req.body || {};
    if (!appName || !packageName) {
      return res.status(400).json(makeErrorResponse('MISSING_FIELDS', 'appName and packageName are required'));
    }
    if (!isValidPackageName(packageName)) {
      return res.status(400).json(makeErrorResponse('INVALID_PACKAGE', 'Invalid package name format'));
    }
    if (!req.files || !req.files.icon || !req.files.projectZip) {
      return res.status(400).json(makeErrorResponse('MISSING_FILES', 'icon and projectZip files are required'));
    }

    const iconFile = req.files.icon[0];
    const zipFile = req.files.projectZip[0];

    if (!iconFile.mimetype.startsWith('image/')) {
      return res.status(400).json(makeErrorResponse('INVALID_ICON', 'Icon must be an image'));
    }
    if (!zipFile.originalname.toLowerCase().endsWith('.zip')) {
      return res.status(400).json(makeErrorResponse('INVALID_ZIP', 'Project file must be a .zip'));
    }

    const requestId = Date.now().toString();
    const safeAppName = sanitizeFilename(appName);

    // Upload icon buffer to Cloudinary
    const iconOptions = { folder: 'aite_studio/icons', public_id: `${sanitizeFilename(packageName)}_icon_${requestId}`, resource_type: 'image', overwrite: true };
    let iconUpload;
    try {
      iconUpload = await uploadToCloudinaryBuffer(iconFile.buffer, iconOptions);
    } catch (err) {
      console.error('Cloudinary icon upload error:', err);
      return res.status(500).json(makeErrorResponse('CLOUDINARY_ICON_FAIL', 'Failed to upload icon to Cloudinary', err.message || err));
    }

    // Upload ZIP buffer to Cloudinary (raw)
    const zipOptions = { folder: 'aite_studio/projects', public_id: `${sanitizeFilename(packageName)}_source_${requestId}`, resource_type: 'raw', overwrite: true };
    let zipUpload;
    try {
      zipUpload = await uploadToCloudinaryBuffer(zipFile.buffer, zipOptions);
    } catch (err) {
      console.error('Cloudinary zip upload error:', err);
      return res.status(500).json(makeErrorResponse('CLOUDINARY_ZIP_FAIL', 'Failed to upload ZIP to Cloudinary', err.message || err));
    }

    // Dispatch to GitHub Actions
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
    const ghUrl = `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/dispatches`;

    try {
      await axios.post(ghUrl, githubPayload, {
        headers: {
          'Authorization': `token ${process.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json'
        },
        timeout: 20000
      });
    } catch (err) {
      console.error('GitHub dispatch error:', err && (err.response ? err.response.data : err.message || err));
      return res.status(500).json(makeErrorResponse('GITHUB_DISPATCH_FAIL', 'Failed to trigger GitHub Actions', (err.response && err.response.data) || err.message || err));
    }

    res.json({
      success: true,
      build_id: requestId,
      safe_app_name: safeAppName,
      icon_url: iconUpload.secure_url,
      app_name: appName,
      package_name: packageName
    });

  } catch (err) {
    console.error('Unexpected server error:', err && (err.stack || err));
    res.status(500).json(makeErrorResponse('SERVER_ERROR', 'Unexpected error', err.message || err));
  }
});

// Check status endpoint
app.get('/check-status/:buildId', async (req, res) => {
  try {
    const { buildId } = req.params;
    const { appName } = req.query;
    if (!buildId || !appName) return res.status(400).json({ error: "Missing parameters" });

    const releaseUrl = `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/releases/tags/build-${buildId}`;
    try {
      await axios.get(releaseUrl, { headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` }, timeout: 8000 });
      const downloadUrl = `https://github.com/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/releases/download/build-${buildId}/${encodeURIComponent(appName)}.apk`;
      return res.json({ completed: true, download_url: downloadUrl });
    } catch (ghError) {
      return res.json({ completed: false });
    }
  } catch (error) {
    console.error("Status check error:", error);
    return res.status(500).json({ error: "Check failed" });
  }
});

// Start server (always listen)
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT} - env=${process.env.NODE_ENV || 'undefined'}`);
});

module.exports = app;
