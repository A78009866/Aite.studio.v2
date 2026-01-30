require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// حدود الملفات لتحكم أفضل (مثلاً 250MB)
const upload = multer({ dest: '/tmp/', limits: { fileSize: 250 * 1024 * 1024 } });

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function sanitizeFilename(name) {
  return String(name || '').trim().replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function isValidPackageName(pkg) {
  // تحقق أساسي: يجب أن تبدأ بحرف وتتكون من حروف/أرقام/underscore/dot
  return /^[a-zA-Z][a-zA-Z0-9_\.]*$/.test(pkg);
}

async function postWithRetry(url, payload, headers, maxAttempts = 3) {
  let attempt = 0;
  const baseDelay = 1000;
  while (attempt < maxAttempts) {
    try {
      const resp = await axios.post(url, payload, { headers, timeout: 15000 });
      return resp;
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts) throw err;
      await new Promise(r => setTimeout(r, baseDelay * attempt));
    }
  }
}

app.post('/build-flutter', upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'projectZip', maxCount: 1 }]), async (req, res) => {
  let iconFile = null;
  let zipFile = null;
  try {
    const { appName, packageName } = req.body || {};
    if (!appName || !packageName) {
      return res.status(400).json({ success: false, error: "appName and packageName are required" });
    }

    if (!isValidPackageName(packageName)) {
      return res.status(400).json({ success: false, error: "Invalid package name format" });
    }

    if (!req.files || !req.files['icon'] || !req.files['projectZip']) {
      return res.status(400).json({ success: false, error: "Missing files (icon and projectZip are required)" });
    }

    iconFile = req.files['icon'][0];
    zipFile = req.files['projectZip'][0];

    // Additional type checks
    if (!iconFile.mimetype.startsWith('image/')) {
      return res.status(400).json({ success: false, error: "Icon must be an image" });
    }
    if (!zipFile.originalname.toLowerCase().endsWith('.zip')) {
      return res.status(400).json({ success: false, error: "Project file must be a .zip" });
    }

    const safeAppName = sanitizeFilename(appName);
    const requestId = Date.now().toString();

    // Upload icon first (image)
    const iconPublicId = `aite_studio/icons/${sanitizeFilename(packageName)}_icon_${requestId}`;
    const iconUpload = await cloudinary.uploader.upload(iconFile.path, {
      folder: 'aite_studio/icons',
      public_id: iconPublicId,
      overwrite: true,
      resource_type: 'image'
    });

    // Upload ZIP as raw resource
    const zipPublicId = `aite_studio/projects/${sanitizeFilename(packageName)}_source_${requestId}`;
    const zipUpload = await cloudinary.uploader.upload(zipFile.path, {
      resource_type: "raw",
      folder: "aite_studio/projects",
      public_id: zipPublicId,
      overwrite: true
    });

    // Prepare payload for repo_dispatch
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
    const ghHeaders = {
      'Authorization': `token ${process.env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json'
    };

    // محاولة مع retries بسيطة
    await postWithRetry(ghUrl, githubPayload, ghHeaders, 3);

    // Clean up temp files (بعد نجاح الرفع)
    try { if (fs.existsSync(iconFile.path)) fs.unlinkSync(iconFile.path); } catch (e) {}
    try { if (fs.existsSync(zipFile.path)) fs.unlinkSync(zipFile.path); } catch (e) {}

    // نُعيد إلى الواجهة كل المعلومات المهمة
    res.json({
      success: true,
      build_id: requestId,
      safe_app_name: safeAppName,
      icon_url: iconUpload.secure_url,
      app_name: appName,
      package_name: packageName
    });

  } catch (error) {
    console.error("Server Error:", error && (error.stack || error.message || error));
    res.status(500).json({ success: false, error: error.message || 'Internal Error' });
  } finally {
    // تأكد من تنظيف الملفات المؤقتة حتى لو حدث خطأ
    try { if (iconFile && fs.existsSync(iconFile.path)) fs.unlinkSync(iconFile.path); } catch (e) {}
    try { if (zipFile && fs.existsSync(zipFile.path)) fs.unlinkSync(zipFile.path); } catch (e) {}
  }
});

// Check status endpoint يتيح للواجهة معرفة صدور الريليز
app.get('/check-status/:buildId', async (req, res) => {
  try {
    const { buildId } = req.params;
    const { appName } = req.query;
    if (!buildId || !appName) return res.status(400).json({ error: "Missing parameters" });

    const releaseUrl = `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/releases/tags/build-${buildId}`;

    try {
      await axios.get(releaseUrl, {
        headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` },
        timeout: 8000
      });

      const downloadUrl = `https://github.com/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/releases/download/build-${buildId}/${encodeURIComponent(appName)}.apk`;
      res.json({ completed: true, download_url: downloadUrl });
    } catch (ghError) {
      // أي خطأ من GitHub نُعامله كـ not ready (404 غالباً)
      res.json({ completed: false });
    }
  } catch (error) {
    console.error("Status check error:", error);
    res.status(500).json({ error: "Check failed" });
  }
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
module.exports = app;
