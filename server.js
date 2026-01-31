
# Let's create the fixed server.js code
fixed_code = '''// =============================================================================
// Aite.studio - Web to APK Builder Server (FIXED VERSION)
// Supports: Single HTML file, Folder (multiple files), ZIP archive
// FIXED: Preserves folder structure and handles file paths correctly
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
const AdmZip = require('adm-zip');

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
  return /^[a-zA-Z][a-zA-Z0-9_\\.]*$/.test(pkg);
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
// FIXED: Multer Configuration with proper path preservation
// =============================================================================

const diskStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      // Use request-specific temp directory
      if (!req.tempDir) {
        req.tempDir = await createTempDir();
      }
      cb(null, req.tempDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    // FIXED: Preserve original filename exactly as uploaded
    // The relative path is stored in file.originalname when using preservePath
    const safeName = file.originalname.replace(/\\/g, '/'); // Normalize slashes
    cb(null, safeName);
  }
});

const fileFilter = (req, file, cb) => {
  if (file.fieldname === 'icon') {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Icon must be an image file'), false);
    }
    cb(null, true);
  } else if (file.fieldname === 'projectFiles') {
    // Accept all file types for project files
    cb(null, true);
  } else {
    cb(new Error('Unexpected field'), false);
  }
};

// FIXED: Added preservePath: true to keep folder structure
const upload = multer({
  storage: diskStorage,
  preservePath: true, // CRITICAL: Preserves the relative path from webkitdirectory
  limits: {
    fileSize: CONFIG.MAX_FILE_SIZE,
    files: 1000
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
    version: '3.2.0-web2apk-fixed',
    features: {
      webToApk: true,
      htmlFile: true,
      folderUpload: true,
      zipUpload: true,
      exactAppName: true,
      firebaseSave: true,
      preserveStructure: true // NEW: Indicates folder structure is preserved
    }
  }));
});

// =============================================================================
// FIXED: Main Build Endpoint with proper ZIP structure
// =============================================================================

app.post('/build-web2apk', 
  upload.fields([
    { name: 'icon', maxCount: 1 },
    { name: 'projectFiles', maxCount: 1000 }
  ]),
  async (req, res) => {
    const requestId = generateBuildId();
    const tempDir = req.tempDir;
    
    console.log(`[${requestId}] New Web-to-APK build request started`);
    
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

      const { appName, packageName, uploadType } = req.body || {};
      
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

      if (!req.files || !req.files.icon || !req.files.projectFiles || req.files.projectFiles.length === 0) {
        await cleanupTemp(tempDir);
        return res.status(400).json(makeErrorResponse(
          'MISSING_FILES',
          'Both icon and project files are required'
        ));
      }

      const iconFile = req.files.icon[0];
      const projectFiles = req.files.projectFiles;

      console.log(`[${requestId}] Icon: ${iconFile.originalname} (${formatFileSize(iconFile.size)})`);
      console.log(`[${requestId}] Upload Type: ${uploadType}`);
      console.log(`[${requestId}] Project Files: ${projectFiles.length} file(s)`);
      
      // Debug: Log file paths to verify structure is preserved
      console.log(`[${requestId}] First few files:`);
      projectFiles.slice(0, 5).forEach(f => {
        console.log(`  - ${f.originalname} (${formatFileSize(f.size)})`);
      });

      if (iconFile.size > CONFIG.MAX_ICON_SIZE) {
        await cleanupTemp(tempDir);
        return res.status(400).json(makeErrorResponse(
          'ICON_TOO_LARGE',
          `Icon max size is ${formatFileSize(CONFIG.MAX_ICON_SIZE)}`
        ));
      }

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

      // Process and upload project files
      console.log(`[${requestId}] Processing project files...`);
      let zipUpload;
      
      try {
        let zipBuffer;
        
        // Check if first file is already a ZIP
        const firstFile = projectFiles[0];
        const isZipUpload = uploadType === 'zip' || 
                           firstFile.originalname.toLowerCase().endsWith('.zip') ||
                           firstFile.mimetype === 'application/zip';
        
        if (isZipUpload && projectFiles.length === 1) {
          // Use the uploaded ZIP directly
          console.log(`[${requestId}] Using uploaded ZIP file directly`);
          zipBuffer = await fs.readFile(firstFile.path);
        } else {
          // FIXED: Create ZIP preserving folder structure
          console.log(`[${requestId}] Creating ZIP from ${projectFiles.length} file(s) with structure...`);
          const zipPath = path.join(tempDir, 'project-bundle.zip');
          
          const zip = new AdmZip();
          
          for (const file of projectFiles) {
            const fileBuffer = await fs.readFile(file.path);
            
            // FIXED: Use the original path which includes relative folder structure
            // When using webkitdirectory, originalname contains the relative path
            let entryName = file.originalname;
            
            // Remove leading slash if present
            entryName = entryName.replace(/^\\//, '');
            
            // Normalize path separators
            entryName = entryName.replace(/\\\\/g, '/');
            
            console.log(`[${requestId}] Adding to ZIP: ${entryName}`);
            zip.addFile(entryName, fileBuffer);
          }
          
          zip.writeZip(zipPath);
          zipBuffer = await fs.readFile(zipPath);
          
          // Debug: Log ZIP contents
          const debugZip = new AdmZip(zipPath);
          console.log(`[${requestId}] ZIP contents:`);
          debugZip.getEntries().forEach(entry => {
            console.log(`  - ${entry.entryName}`);
          });
        }

        // Upload ZIP to Cloudinary
        console.log(`[${requestId}] Uploading ZIP (${formatFileSize(zipBuffer.length)})...`);
        
        if (zipBuffer.length > 50 * 1024 * 1024) {
          // Large file - use stream
          const zipPath = path.join(tempDir, 'upload.zip');
          await fs.writeFile(zipPath, zipBuffer);
          zipUpload = await uploadLargeFileToCloudinary(zipPath, {
            folder: 'aite_studio/web-projects',
            public_id: `${sanitizeFilename(packageName)}_source_${requestId}`,
            resource_type: 'raw',
            overwrite: true
          });
        } else {
          zipUpload = await uploadToCloudinaryBuffer(zipBuffer, {
            folder: 'aite_studio/web-projects',
            public_id: `${sanitizeFilename(packageName)}_source_${requestId}`,
            resource_type: 'raw',
            overwrite: true
          });
        }
        
        console.log(`[${requestId}] ZIP uploaded: ${zipUpload.secure_url}`);
      } catch (err) {
        await cleanupTemp(tempDir);
        return res.status(500).json(makeErrorResponse(
          'ZIP_PROCESSING_FAIL',
          'Failed to process project files',
          err.message
        ));
      }

      // Dispatch to GitHub Actions
      console.log(`[${requestId}] Dispatching to GitHub for build...`);
      
      const githubPayload = {
        event_type: 'build-web2apk',
        client_payload: {
          app_name: appName,
          safe_name: safeAppName,
          display_name: appName,
          package_name: packageName,
          icon_url: iconUpload.secure_url,
          zip_url: zipUpload.secure_url,
          upload_type: uploadType || 'folder',
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
          upload_type: uploadType,
          message: 'Web-to-APK build started successfully',
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
  console.log('🚀 Aite.studio - Web to APK Builder (FIXED)');
  console.log('='.repeat(60));
  console.log(`📡 Port: ${PORT}`);
  console.log(`📁 Temp: ${CONFIG.TEMP_DIR}`);
  console.log(`📦 Max Size: ${formatFileSize(CONFIG.MAX_FILE_SIZE)}`);
  console.log(`✅ Supports: HTML, Folder (with structure), ZIP`);
  console.log(`🔧 Fixed: Folder structure preservation`);
  console.log('='.repeat(60));
});

module.exports = app;
'''

print("Fixed server.js generated successfully!")
print("\nKey changes made:")
print("1. Added preservePath: true to multer config")
print("2. Fixed filename function to use originalname directly")
print("3. Added path normalization for Windows/Unix slashes")
print("4. Added debug logging for ZIP contents")
print("5. Fixed ZIP entry paths to maintain folder structure")
