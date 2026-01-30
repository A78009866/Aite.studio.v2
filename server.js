require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// استخدم الذاكرة للملفات الصغيرة (مثل 7MB) لتجنّب مشاكل الـ /tmp والأذونات
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // حد أعلى آمن (50MB)
});

// مساعدة لفحص الأخطاء عند رفع الملفات
function makeErrorResponse(code, message, details) {
  return { success: false, error: message, code, details };
}

function sanitizeFilename(name) {
  return String(name || '').trim().replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function isValidPackageName(pkg) {
  return /^[a-zA-Z][a-zA-Z0-9_\.]*$/.test(pkg);
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
    // فحص المدخلات الأساسية
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

    // نوعية الملف
    if (!iconFile.mimetype.startsWith('image/')) {
      return res.status(400).json(makeErrorResponse('INVALID_ICON', 'Icon must be an image'));
    }
    if (!zipFile.originalname.toLowerCase().endsWith('.zip')) {
      return res.status(400).json(makeErrorResponse('INVALID_ZIP', 'Project file must be a .zip'));
    }

    const requestId = Date.now().toString();
    const safeAppName = sanitizeFilename(appName);

    // رفع الأيقونة باستخدام buffer (memory) إلى فولدر مخصص
    const iconOptions = { folder: 'aite_studio/icons', public_id: `${sanitizeFilename(packageName)}_icon_${requestId}`, resource_type: 'image', overwrite: true };
    let iconUpload;
    try {
      iconUpload = await uploadToCloudinaryBuffer(iconFile.buffer, iconOptions);
    } catch (err) {
      console.error('Cloudinary icon upload error:', err);
      return res.status(500).json(makeErrorResponse('CLOUDINARY_ICON_FAIL', 'Failed to upload icon to Cloudinary', err.message || err));
    }

    // رفع ملف الـ ZIP كـ raw باستخدام upload_stream (resource_type raw)
    const zipOptions = { folder: 'aite_studio/projects', public_id: `${sanitizeFilename(packageName)}_source_${requestId}`, resource_type: 'raw', overwrite: true };
    let zipUpload;
    try {
      zipUpload = await uploadToCloudinaryBuffer(zipFile.buffer, zipOptions);
    } catch (err) {
      console.error('Cloudinary zip upload error:', err);
      return res.status(500).json(makeErrorResponse('CLOUDINARY_ZIP_FAIL', 'Failed to upload ZIP to Cloudinary', err.message || err));
    }

    // dispatch إلى GitHub Actions
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

    // نعيد نجاح مع معلومات لتحقّق الواجهة
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

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
module.exports = app;
