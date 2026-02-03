// =============================================================================
// Aite.studio - Smart Flutter Cloud Build Server (Fixed Names)
// =============================================================================

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { createWriteStream } = require('fs');
const crypto = require('crypto');

const app = express();

// =============================================================================
// Configuration
// =============================================================================
const CONFIG = {
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE) || 500 * 1024 * 1024,
  MAX_ICON_SIZE: 10 * 1024 * 1024,
  TEMP_DIR: process.env.TEMP_DIR || '/tmp/aite-studio',
  UPLOAD_TIMEOUT: parseInt(process.env.UPLOAD_TIMEOUT) || 300000,
};

// =============================================================================
// Middleware
// =============================================================================
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// =============================================================================
// Cloudinary Configuration
// =============================================================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

// =============================================================================
// Helper Functions
// =============================================================================

async function createTempDir() {
  const dirName = crypto.randomUUID();
  const fullPath = path.join(CONFIG.TEMP_DIR, dirName);
  await fs.mkdir(fullPath, { recursive: true });
  return fullPath;
}

async function cleanupTemp(tempPath) {
  try {
    if (tempPath && fsSync.existsSync(tempPath)) {
      await fs.rm(tempPath, { recursive: true, force: true });
      console.log(`[Cleanup] Removed: ${tempPath}`);
    }
  } catch (err) {
    console.error('[Cleanup Error]', err.message);
  }
}

function generateBuildId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function isValidPackageName(pkg) {
  return /^[a-zA-Z][a-zA-Z0-9_\.]*$/.test(pkg);
}

function sanitizeFilename(name) {
  return String(name || '').trim()
    .replace(/[^a-z0-9]/gi, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
}

function formatFileSize(bytes) {
  const sizes = ['B', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
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

async function uploadLargeFileToCloudinary(filePath, options = {}) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    
    const readStream = fsSync.createReadStream(filePath);
    readStream.pipe(uploadStream);
    
    readStream.on('error', reject);
    uploadStream.on('error', reject);
  });
}

function makeErrorResponse(code, message, details = null) {
  const response = { 
    success: false, 
    error: message, 
    code,
    timestamp: new Date().toISOString()
  };
  if (details) response.details = details;
  return response;
}

function makeSuccessResponse(data = {}) {
  return {
    success: true,
    timestamp: new Date().toISOString(),
    ...data
  };
}

// =============================================================================
// Multer Configuration
// =============================================================================

const diskStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const tempDir = await createTempDir();
      req.tempDir = tempDir;
      cb(null, tempDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const fileFilter = (req, file, cb) => {
  if (file.fieldname === 'icon') {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Icon must be an image file'), false);
    }
    cb(null, true);
  } else if (file.fieldname === 'projectZip') {
    const allowedTypes = [
      'application/zip',
      'application/x-zip',
      'application/x-zip-compressed',
      'application/octet-stream'
    ];
    const isZip = allowedTypes.includes(file.mimetype) || 
                  file.originalname.toLowerCase().endsWith('.zip');
    if (!isZip) {
      return cb(new Error('Project file must be a ZIP archive'), false);
    }
    cb(null, true);
  } else {
    cb(new Error('Unexpected field'), false);
  }
};

const upload = multer({
  storage: diskStorage,
  limits: {
    fileSize: CONFIG.MAX_FILE_SIZE,
    files: 2
  },
  fileFilter: fileFilter
});

// =============================================================================
// Routes
// =============================================================================

// Health check
app.get('/health', (req, res) => {
  res.json(makeSuccessResponse({
    status: 'healthy',
    version: '2.2.0-fixed-names',
    features: {
      universalApk: true,
      exactAppName: true,
      firebaseSave: true
    }
  }));
});

// =============================================================================
// Main Build Endpoint
// =============================================================================

app.post('/build-flutter', 
  upload.fields([
    { name: 'icon', maxCount: 1 },
    { name: 'projectZip', maxCount: 1 }
  ]),
  async (req, res) => {
    const requestId = generateBuildId();
    const tempDir = req.tempDir;
    
    console.log(`[${requestId}] New build request started`);
    
    try {
      const owner = process.env.GITHUB_REPO_OWNER;
      const repo = process.env.GITHUB_REPO_NAME;
      const token = process.env.GITHUB_TOKEN;
      
      if (!owner || !repo || !token) {
        await cleanupTemp(tempDir);
        return res.status(500).json(makeErrorResponse(
          'MISSING_ENV',
          'Server misconfigured: missing GitHub repo/token'
        ));
      }

      const { appName, packageName } = req.body || {};
      
      if (!appName || !packageName) {
        await cleanupTemp(tempDir);
        return res.status(400).json(makeErrorResponse(
          'MISSING_FIELDS',
          'appName and packageName are required'
        ));
      }

      if (!isValidPackageName(packageName)) {
        await cleanupTemp(tempDir);
        return res.status(400).json(makeErrorResponse(
          'INVALID_PACKAGE',
          'Invalid package name format'
        ));
      }

      if (!req.files || !req.files.icon || !req.files.projectZip) {
        await cleanupTemp(tempDir);
        return res.status(400).json(makeErrorResponse(
          'MISSING_FILES',
          'Both icon and projectZip files are required'
        ));
      }

      const iconFile = req.files.icon[0];
      const zipFile = req.files.projectZip[0];

      console.log(`[${requestId}] Icon: ${iconFile.originalname} (${formatFileSize(iconFile.size)})`);
      console.log(`[${requestId}] ZIP: ${zipFile.originalname} (${formatFileSize(zipFile.size)})`);

      if (iconFile.size > CONFIG.MAX_ICON_SIZE) {
        await cleanupTemp(tempDir);
        return res.status(400).json(makeErrorResponse(
          'ICON_TOO_LARGE',
          `Icon max size is ${formatFileSize(CONFIG.MAX_ICON_SIZE)}`
        ));
      }

      // We still need a safe name for internal IDs, but we will send the REAL name to GitHub
      const safeAppName = sanitizeFilename(appName);

      // Upload Icon
      console.log(`[${requestId}] Uploading icon...`);
      let iconUpload;
      try {
        const iconBuffer = await fs.readFile(iconFile.path);
        iconUpload = await uploadToCloudinaryBuffer(iconBuffer, {
          folder: 'aite_studio/icons',
          public_id: `${sanitizeFilename(packageName)}_icon_${requestId}`,
          resource_type: 'image',
          overwrite: true,
          transformation: [
            { width: 512, height: 512, crop: 'fill' },
            { quality: 'auto:good', fetch_format: 'png' }
          ]
        });
        console.log(`[${requestId}] Icon uploaded: ${iconUpload.secure_url}`);
      } catch (err) {
        await cleanupTemp(tempDir);
        return res.status(500).json(makeErrorResponse(
          'CLOUDINARY_ICON_FAIL',
          'Failed to upload icon',
          err.message
        ));
      }

      // Upload ZIP
      console.log(`[${requestId}] Uploading ZIP...`);
      let zipUpload;
      try {
        if (zipFile.size > 50 * 1024 * 1024) {
          zipUpload = await uploadLargeFileToCloudinary(zipFile.path, {
            folder: 'aite_studio/projects',
            public_id: `${sanitizeFilename(packageName)}_source_${requestId}`,
            resource_type: 'raw',
            overwrite: true
          });
        } else {
          const zipBuffer = await fs.readFile(zipFile.path);
          zipUpload = await uploadToCloudinaryBuffer(zipBuffer, {
            folder: 'aite_studio/projects',
            public_id: `${sanitizeFilename(packageName)}_source_${requestId}`,
            resource_type: 'raw',
            overwrite: true
          });
        }
        console.log(`[${requestId}] ZIP uploaded: ${zipUpload.secure_url}`);
      } catch (err) {
        await cleanupTemp(tempDir);
        return res.status(500).json(makeErrorResponse(
          'CLOUDINARY_ZIP_FAIL',
          'Failed to upload project ZIP',
          err.message
        ));
      }

      // Dispatch to GitHub Actions
      console.log(`[${requestId}] Dispatching to GitHub...`);
      
      const githubPayload = {
        event_type: 'build-flutter',
        client_payload: {
          // FIX: Send the REAL appName (e.g., "متجري") instead of safeAppName
          app_name: appName,
          // We also send safe name if needed for other things, but app_name is priority
          safe_name: safeAppName,
          display_name: appName,
          package_name: packageName,
          icon_url: iconUpload.secure_url,
          zip_url: zipUpload.secure_url,
          request_id: requestId,
          timestamp: new Date().toISOString()
        }
      };

      const ghUrl = `https://api.github.com/repos/${owner}/${repo}/dispatches`;
      const ghHeaders = {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      };

      const resp = await axios.post(ghUrl, githubPayload, {
        headers: ghHeaders,
        timeout: 30000,
        validateStatus: null
      });

      console.log(`[${requestId}] GitHub response: ${resp.status}`);

      if (resp.status >= 200 && resp.status < 300) {
        await cleanupTemp(tempDir);
        
        return res.json(makeSuccessResponse({
          build_id: requestId,
          safe_app_name: safeAppName,
          app_name: appName,
          package_name: packageName,
          icon_url: iconUpload.secure_url,
          zip_url: zipUpload.secure_url,
          message: 'Build started successfully',
          check_status_url: `/check-status/${requestId}`
        }));
      } else {
        const body = resp.data ? JSON.stringify(resp.data) : '';
        await cleanupTemp(tempDir);
        return res.status(500).json(makeErrorResponse(
          'GITHUB_DISPATCH_FAILED',
          'Failed to dispatch build',
          { status: resp.status, body: body.slice(0, 500) }
        ));
      }

    } catch (err) {
      console.error(`[${requestId}] Error:`, err.stack || err.message);
      await cleanupTemp(tempDir);
      return res.status(500).json(makeErrorResponse(
        'SERVER_ERROR',
        'Unexpected server error',
        err.message
      ));
    }
  }
);

// =============================================================================
// Status Check Endpoint
// =============================================================================

app.get('/check-status/:buildId', async (req, res) => {
  try {
    const { buildId } = req.params;
    
    if (!buildId) {
      return res.status(400).json(makeErrorResponse('MISSING_BUILD_ID', 'Build ID required'));
    }

    const owner = process.env.GITHUB_REPO_OWNER;
    const repo = process.env.GITHUB_REPO_NAME;
    const token = process.env.GITHUB_TOKEN;
    
    if (!owner || !repo || !token) {
      return res.status(500).json(makeErrorResponse('MISSING_ENV', 'Server misconfigured'));
    }

    // Check workflow runs
    const runsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs?event=repository_dispatch&per_page=10`;
    
    try {
      const runsResp = await axios.get(runsUrl, {
        headers: { 'Authorization': `token ${token}` },
        timeout: 10000
      });
      
      const run = runsResp.data.workflow_runs.find(r => 
        r.display_title?.includes(buildId) || 
        r.head_commit?.message?.includes(buildId) ||
        r.id?.toString() === buildId
      );
      
      if (!run) {
        // Fallback: Check release directly
        const releaseUrl = `https://api.github.com/repos/${owner}/${repo}/releases/tags/build-${buildId}`;
        try {
          const releaseResp = await axios.get(releaseUrl, {
            headers: { 'Authorization': `token ${token}` },
            timeout: 8000,
            validateStatus: null
          });
          
          if (releaseResp.status === 200) {
            const assets = releaseResp.data.assets || [];
            const apkAsset = assets.find(a => a.name.endsWith('.apk'));
            if (apkAsset) {
              return res.json(makeSuccessResponse({
                completed: true,
                status: 'success',
                download_url: apkAsset.browser_download_url,
                build_id: buildId,
                created_at: releaseResp.data.created_at
              }));
            }
          }
        } catch (e) {
          // Release not found
        }
        
        return res.json(makeSuccessResponse({
          completed: false,
          status: 'pending',
          build_id: buildId,
          progress: 5
        }));
      }
      
      const status = run.status;
      const conclusion = run.conclusion;
      
      if (status === 'completed' && conclusion === 'success') {
        const releaseUrl = `https://api.github.com/repos/${owner}/${repo}/releases/tags/build-${buildId}`;
        try {
          const releaseResp = await axios.get(releaseUrl, {
            headers: { 'Authorization': `token ${token}` },
            timeout: 8000,
            validateStatus: null
          });
          
          if (releaseResp.status === 200) {
            const assets = releaseResp.data.assets || [];
            const apkAsset = assets.find(a => a.name.endsWith('.apk'));
            if (apkAsset) {
              return res.json(makeSuccessResponse({
                completed: true,
                status: 'success',
                download_url: apkAsset.browser_download_url,
                build_id: buildId,
                completed_at: run.updated_at,
                app_name: run.display_title
              }));
            }
          }
        } catch (e) {
          console.log(`[${buildId}] Release check error:`, e.message);
        }
        
        return res.json(makeSuccessResponse({
          completed: false,
          status: 'publishing',
          build_id: buildId,
          progress: 95
        }));
      }
      
      if (status === 'completed' && conclusion === 'failure') {
        return res.json(makeSuccessResponse({
          completed: true,
          status: 'failed',
          build_id: buildId,
          run_url: run.html_url,
          error: 'Build failed in GitHub Actions'
        }));
      }
      
      let progress = 10;
      if (status === 'in_progress') progress = 60;
      if (status === 'queued') progress = 20;
      
      return res.json(makeSuccessResponse({
        completed: false,
        status: status,
        build_id: buildId,
        progress: progress,
        run_url: run.html_url
      }));
      
    } catch (err) {
      console.error(`[${buildId}] Status check error:`, err.message);
      return res.status(500).json(makeErrorResponse('CHECK_FAILED', 'Failed to check status'));
    }
    
  } catch (err) {
    console.error('Status endpoint error:', err.message);
    return res.status(500).json(makeErrorResponse('SERVER_ERROR', err.message));
  }
});

// =============================================================================
// Error Handling Middleware
// =============================================================================

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json(makeErrorResponse(
        'FILE_TOO_LARGE',
        `File too large. Max is ${formatFileSize(CONFIG.MAX_FILE_SIZE)}`
      ));
    }
    return res.status(400).json(makeErrorResponse('UPLOAD_ERROR', err.message));
  }

  if (err) {
    console.error('Error:', err.stack || err.message);
    return res.status(500).json(makeErrorResponse('SERVER_ERROR', err.message));
  }

  next();
});

// =============================================================================
// Static Files
// =============================================================================

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =============================================================================
// Start Server
// =============================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log('🚀 Aite.studio - Fixed Cloud Build Server');
  console.log('='.repeat(60));
  console.log(`📡 Port: ${PORT}`);
  console.log(`📁 Temp: ${CONFIG.TEMP_DIR}`);
  console.log(`📦 Max Size: ${formatFileSize(CONFIG.MAX_FILE_SIZE)}`);
  console.log('='.repeat(60));
});

module.exports = app;
