require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const app = express();

// =============================================================================
// Configuration
// =============================================================================
const CONFIG = {
  MAX_FILE_SIZE: Infinity,
  MAX_ICON_SIZE: Infinity,
  TEMP_DIR: process.env.TEMP_DIR || '/tmp/aite-studio',
  UPLOAD_TIMEOUT: parseInt(process.env.UPLOAD_TIMEOUT) || 600000,
};

// =============================================================================
// Middleware
// =============================================================================
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID']
}));

app.use(express.json({ limit: '4gb' }));
app.use(express.urlencoded({ extended: true, limit: '4gb' }));

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
// Flutter Project Analyzer
// =============================================================================

class FlutterProjectAnalyzer {
  constructor(tempDir) {
    this.tempDir = tempDir;
    this.projectRoot = null;
    this.info = {
      hasPubspec: false,
      hasLib: false,
      hasAndroid: false,
      appName: null,
      dependencies: [],
      flutterVersion: null,
      isValid: false,
      projectPath: null
    };
  }

  async analyzeFromZip(zipPath) {
    console.log('[FlutterAnalyzer] Analyzing ZIP file...');
    const extractDir = path.join(this.tempDir, 'extracted');
    await fs.mkdir(extractDir, { recursive: true });

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);

    this.projectRoot = await this.findProjectRoot(extractDir);
    if (!this.projectRoot) {
      throw new Error('No valid Flutter project found in ZIP. Missing pubspec.yaml');
    }

    await this.analyzeProject();
    return this.info;
  }

  async analyzeFromFolder(files) {
    console.log('[FlutterAnalyzer] Analyzing folder upload... files=' + files.length);
    const projectDir = path.join(this.tempDir, 'project');
    await fs.mkdir(projectDir, { recursive: true });

    for (const file of files) {
      const relativePath = file.originalname || file.name || 'unknown';
      const safePath = relativePath.replace(/\.\.\//g, '').replace(/^\//, '');
      const destPath = path.join(projectDir, safePath);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      try {
        await fs.copyFile(file.path, destPath);
      } catch (copyErr) {
        console.warn('[FlutterAnalyzer] Could not copy: ' + relativePath + ' - ' + copyErr.message);
      }
    }

    this.projectRoot = await this.findProjectRoot(projectDir);
    if (!this.projectRoot) {
      throw new Error('No valid Flutter project found. Missing pubspec.yaml');
    }

    await this.analyzeProject();
    return this.info;
  }

  async findProjectRoot(dir) {
    // Check current directory
    try {
      await fs.access(path.join(dir, 'pubspec.yaml'));
      return dir;
    } catch (e) {}

    // Check immediate subdirectories
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          await fs.access(path.join(dir, entry.name, 'pubspec.yaml'));
          return path.join(dir, entry.name);
        } catch (e) {}
      }
    }

    // Deep search (2 levels max)
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          const subDir = path.join(dir, entry.name);
          const subEntries = await fs.readdir(subDir, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (subEntry.isDirectory()) {
              try {
                await fs.access(path.join(subDir, subEntry.name, 'pubspec.yaml'));
                return path.join(subDir, subEntry.name);
              } catch (e) {}
            }
          }
        } catch (e) {}
      }
    }

    return null;
  }

  async analyzeProject() {
    const root = this.projectRoot;
    this.info.projectPath = root;

    // Check pubspec.yaml
    try {
      const pubspecContent = await fs.readFile(path.join(root, 'pubspec.yaml'), 'utf8');
      this.info.hasPubspec = true;

      const nameMatch = pubspecContent.match(/^name:\s*(.+)$/m);
      if (nameMatch) this.info.appName = nameMatch[1].trim();

      const sdkMatch = pubspecContent.match(/sdk:\s*["'](.+?)["']/);
      if (sdkMatch) this.info.flutterVersion = sdkMatch[1];

      const depsSection = pubspecContent.split('dependencies:')[1];
      if (depsSection) {
        const lines = depsSection.split('\n');
        for (const line of lines) {
          if (line.match(/^\s{2}\w/) && !line.includes('#')) {
            const dep = line.trim().split(':')[0];
            if (dep && dep !== 'flutter') this.info.dependencies.push(dep);
          }
          if (line.match(/^\w/) && !line.startsWith(' ')) break;
        }
      }
    } catch (e) {
      this.info.hasPubspec = false;
    }

    try { await fs.access(path.join(root, 'lib')); this.info.hasLib = true; } catch (e) {}
    try { await fs.access(path.join(root, 'android')); this.info.hasAndroid = true; } catch (e) {}

    this.info.isValid = this.info.hasPubspec && this.info.hasLib;

    console.log('[FlutterAnalyzer] Results: valid=' + this.info.isValid +
      ' name=' + this.info.appName + ' lib=' + this.info.hasLib +
      ' android=' + this.info.hasAndroid + ' deps=' + this.info.dependencies.length +
      ' sdk=' + this.info.flutterVersion);
  }

  async createProjectZip() {
    if (!this.projectRoot) throw new Error('No project root found');

    const zipPath = path.join(this.tempDir, 'flutter-project.zip');
    const zip = new AdmZip();
    const skipDirs = ['build', '.dart_tool', '.idea', '.gradle', '.pub-cache', 'ios', '.git', 'node_modules'];

    const addDirToZip = (dirPath, zipDir) => {
      const items = fsSync.readdirSync(dirPath);
      for (const item of items) {
        if (skipDirs.includes(item)) continue;
        const fullPath = path.join(dirPath, item);
        const stat = fsSync.statSync(fullPath);
        if (stat.isDirectory()) {
          addDirToZip(fullPath, path.join(zipDir, item));
        } else {
          zip.addLocalFile(fullPath, zipDir);
        }
      }
    };

    addDirToZip(this.projectRoot, '');
    zip.writeZip(zipPath);

    const zipBuffer = await fs.readFile(zipPath);
    console.log('[FlutterAnalyzer] ZIP created: ' + formatFileSize(zipBuffer.length));
    return { zipPath, zipBuffer };
  }
}

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
    }
  } catch (err) {
    console.error('[Cleanup Error]', err.message);
  }
}

function generateBuildId() {
  return Date.now() + '-' + crypto.randomBytes(4).toString('hex');
}

function isValidPackageName(pkg) {
  return /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(pkg) &&
         pkg.length <= 100 && !pkg.includes('..') && !pkg.startsWith('.') && !pkg.endsWith('.');
}

function sanitizeFilename(name) {
  return String(name || '').trim().replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').toLowerCase();
}

function formatFileSize(bytes) {
  const sizes = ['B', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + sizes[i];
}

async function uploadToCloudinaryBuffer(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options || {}, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    stream.end(buffer);
  });
}

async function uploadLargeFileToCloudinary(filePath, options) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(options || {}, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    const readStream = fsSync.createReadStream(filePath);
    readStream.pipe(uploadStream);
    readStream.on('error', reject);
    uploadStream.on('error', reject);
  });
}

function makeErrorResponse(code, message, details) {
  const response = { success: false, error: message, code: code, timestamp: new Date().toISOString() };
  if (details) response.details = details;
  return response;
}

function makeSuccessResponse(data) {
  return Object.assign({ success: true, timestamp: new Date().toISOString() }, data || {});
}

// =============================================================================
// Multer Configuration
// =============================================================================

const diskStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      if (!req.tempDir) { req.tempDir = await createTempDir(); }
      cb(null, req.tempDir);
    } catch (err) { cb(err); }
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '-' + file.originalname);
  }
});

const fileFilter = (req, file, cb) => {
  if (file.fieldname === 'icon') {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Icon must be an image file'), false);
    cb(null, true);
  } else if (file.fieldname === 'projectFiles') {
    cb(null, true);
  } else {
    cb(new Error('Unexpected field'), false);
  }
};

const upload = multer({
  storage: diskStorage,
  limits: { fileSize: Infinity, files: 50000, fieldSize: Infinity, fieldNameSize: 1000 },
  fileFilter: fileFilter
});

// =============================================================================
// Routes
// =============================================================================

app.get('/health', (req, res) => {
  res.json(makeSuccessResponse({
    status: 'healthy',
    version: '5.0.0-flutter',
    features: { flutterToApk: true, folderUpload: true, zipUpload: true, telegramNotification: true, aiRepair: true }
  }));
});

// =============================================================================
// Main Build Endpoint - Flutter to APK
// =============================================================================

app.post('/build-flutter',
  upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'projectFiles', maxCount: 5000 }]),
  async (req, res) => {
    const requestId = generateBuildId();
    const tempDir = req.tempDir;

    console.log('[' + requestId + '] New Flutter build request');

    try {
      const owner = process.env.GITHUB_REPO_OWNER;
      const repo = process.env.GITHUB_REPO_NAME;
      const token = process.env.GITHUB_TOKEN;

      if (!owner || !repo || !token) {
        await cleanupTemp(tempDir);
        return res.status(500).json(makeErrorResponse('MISSING_ENV', 'Server misconfigured: missing GitHub repo/token'));
      }

      const appName = (req.body || {}).appName;
      const packageName = (req.body || {}).packageName;
      const uploadType = (req.body || {}).uploadType;

      if (!appName || !packageName) {
        await cleanupTemp(tempDir);
        return res.status(400).json(makeErrorResponse('MISSING_FIELDS', 'appName and packageName are required'));
      }

      if (!isValidPackageName(packageName)) {
        await cleanupTemp(tempDir);
        return res.status(400).json(makeErrorResponse('INVALID_PACKAGE', 'Invalid package name. Use format: com.example.app'));
      }

      if (!req.files || !req.files.icon || !req.files.projectFiles || req.files.projectFiles.length === 0) {
        await cleanupTemp(tempDir);
        return res.status(400).json(makeErrorResponse('MISSING_FILES', 'Both icon and project files are required'));
      }

      const iconFile = req.files.icon[0];
      const projectFiles = req.files.projectFiles;

      console.log('[' + requestId + '] Icon=' + iconFile.originalname + ' Type=' + uploadType + ' Files=' + projectFiles.length);

      // No icon size limit

      const safeAppName = sanitizeFilename(appName);

      // Upload Icon to Cloudinary
      let iconUpload;
      try {
        const iconBuffer = await fs.readFile(iconFile.path);
        iconUpload = await uploadToCloudinaryBuffer(iconBuffer, {
          folder: 'aite_studio/icons',
          public_id: sanitizeFilename(packageName) + '_icon_' + requestId,
          resource_type: 'image',
          overwrite: true,
          transformation: [{ width: 512, height: 512, crop: 'fill' }, { quality: 'auto:good', fetch_format: 'png' }]
        });
        console.log('[' + requestId + '] Icon uploaded: ' + iconUpload.secure_url);
      } catch (err) {
        await cleanupTemp(tempDir);
        return res.status(500).json(makeErrorResponse('CLOUDINARY_ICON_FAIL', 'Failed to upload icon', err.message));
      }

      // Analyze & Process Flutter Project
      let zipBuffer, zipUpload, projectInfo;

      try {
        const analyzer = new FlutterProjectAnalyzer(tempDir);
        const firstFile = projectFiles[0];
        const isDirectZip = uploadType === 'zip' ||
          firstFile.originalname.toLowerCase().endsWith('.zip') ||
          firstFile.mimetype === 'application/zip';

        if (isDirectZip && projectFiles.length === 1) {
          projectInfo = await analyzer.analyzeFromZip(firstFile.path);
        } else {
          projectInfo = await analyzer.analyzeFromFolder(projectFiles);
        }

        if (!projectInfo.isValid) {
          await cleanupTemp(tempDir);
          return res.status(400).json(makeErrorResponse('INVALID_FLUTTER_PROJECT',
            'Invalid Flutter project. Must contain pubspec.yaml and lib/ folder.',
            { hasPubspec: projectInfo.hasPubspec, hasLib: projectInfo.hasLib, hasAndroid: projectInfo.hasAndroid }
          ));
        }

        const result = await analyzer.createProjectZip();
        zipBuffer = result.zipBuffer;
        console.log('[' + requestId + '] Project ZIP: ' + formatFileSize(zipBuffer.length));
      } catch (err) {
        await cleanupTemp(tempDir);
        return res.status(400).json(makeErrorResponse('PROJECT_ANALYSIS_FAIL', err.message || 'Failed to analyze Flutter project'));
      }

      // Upload ZIP to Cloudinary
      try {
        const uploadOpts = {
          folder: 'aite_studio/flutter-projects',
          public_id: sanitizeFilename(packageName) + '_source_' + requestId,
          resource_type: 'raw',
          overwrite: true
        };

        if (zipBuffer.length > 50 * 1024 * 1024) {
          const zipPath = path.join(tempDir, 'large-flutter-project.zip');
          await fs.writeFile(zipPath, zipBuffer);
          zipUpload = await uploadLargeFileToCloudinary(zipPath, uploadOpts);
        } else {
          zipUpload = await uploadToCloudinaryBuffer(zipBuffer, uploadOpts);
        }
        console.log('[' + requestId + '] ZIP uploaded: ' + zipUpload.secure_url);
      } catch (err) {
        await cleanupTemp(tempDir);
        return res.status(500).json(makeErrorResponse('CLOUDINARY_ZIP_FAIL', 'Failed to upload project ZIP', err.message));
      }

      // Dispatch to GitHub Actions
      const githubPayload = {
        event_type: 'build-flutter',
        client_payload: {
          app_name: appName,
          safe_name: safeAppName,
          display_name: appName,
          package_name: packageName,
          icon_url: iconUpload.secure_url,
          zip_url: zipUpload.secure_url,
          upload_type: uploadType || 'folder',
          request_id: requestId,
          timestamp: new Date().toISOString(),
          project_info: {
            original_name: projectInfo.appName,
            dependencies_count: projectInfo.dependencies.length,
            has_android: projectInfo.hasAndroid,
            flutter_sdk: projectInfo.flutterVersion
          }
        }
      };

      const ghUrl = 'https://api.github.com/repos/' + owner + '/' + repo + '/dispatches';
      const ghHeaders = {
        'Authorization': 'token ' + token,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      };

      const resp = await axios.post(ghUrl, githubPayload, { headers: ghHeaders, timeout: 30000, validateStatus: null });
      console.log('[' + requestId + '] GitHub response: ' + resp.status);

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
          project_info: {
            original_name: projectInfo.appName,
            dependencies_count: projectInfo.dependencies.length,
            has_android: projectInfo.hasAndroid,
            flutter_sdk: projectInfo.flutterVersion
          },
          message: 'Flutter build started',
          check_status_url: '/check-status/' + requestId
        }));
      } else {
        const body = resp.data ? JSON.stringify(resp.data) : '';
        await cleanupTemp(tempDir);
        return res.status(500).json(makeErrorResponse('GITHUB_DISPATCH_FAILED', 'Failed to dispatch build',
          { status: resp.status, body: body.slice(0, 500) }
        ));
      }

    } catch (err) {
      console.error('[' + requestId + '] Error:', err.stack || err.message);
      await cleanupTemp(tempDir);
      return res.status(500).json(makeErrorResponse('SERVER_ERROR', 'Unexpected server error', err.message));
    }
  }
);

// =============================================================================
// Status Check Endpoint
// =============================================================================

app.get('/check-status/:buildId', async (req, res) => {
  try {
    const buildId = req.params.buildId;
    if (!buildId) return res.status(400).json(makeErrorResponse('MISSING_BUILD_ID', 'Build ID required'));

    const owner = process.env.GITHUB_REPO_OWNER;
    const repo = process.env.GITHUB_REPO_NAME;
    const token = process.env.GITHUB_TOKEN;
    if (!owner || !repo || !token) return res.status(500).json(makeErrorResponse('MISSING_ENV', 'Server misconfigured'));

    const runsUrl = 'https://api.github.com/repos/' + owner + '/' + repo + '/actions/runs?event=repository_dispatch&per_page=20';

    try {
      const runsResp = await axios.get(runsUrl, { headers: { 'Authorization': 'token ' + token }, timeout: 10000 });

      const run = runsResp.data.workflow_runs.find(function(r) {
        return (r.display_title && r.display_title.includes(buildId)) ||
          (r.head_commit && r.head_commit.message && r.head_commit.message.includes(buildId)) ||
          (r.head_commit && r.head_commit.message && r.head_commit.message.includes('client_payload') &&
           runsResp.data.workflow_runs.indexOf(r) < 5);
      });

      if (!run) {
        // Check release directly
        const releaseUrl = 'https://api.github.com/repos/' + owner + '/' + repo + '/releases/tags/build-' + buildId;
        try {
          const releaseResp = await axios.get(releaseUrl, {
            headers: { 'Authorization': 'token ' + token }, timeout: 8000, validateStatus: null
          });
          if (releaseResp.status === 200) {
            const assets = releaseResp.data.assets || [];
            const apkAsset = assets.find(function(a) { return a.name.endsWith('.apk'); });
            if (apkAsset) {
              return res.json(makeSuccessResponse({
                completed: true, status: 'success',
                download_url: apkAsset.browser_download_url,
                build_id: buildId, created_at: releaseResp.data.created_at
              }));
            }
          }
        } catch (e) {}

        return res.json(makeSuccessResponse({
          completed: false, status: 'pending', build_id: buildId,
          progress: 5, message: 'Build queued, waiting for GitHub Actions...'
        }));
      }

      const status = run.status;
      const conclusion = run.conclusion;
      let progress = 5;
      if (status === 'queued') progress = 10;
      if (status === 'in_progress') progress = 50;
      if (status === 'completed' && conclusion === 'success') progress = 95;

      if (status === 'completed' && conclusion === 'success') {
        const releaseUrl = 'https://api.github.com/repos/' + owner + '/' + repo + '/releases/tags/build-' + buildId;
        try {
          const releaseResp = await axios.get(releaseUrl, {
            headers: { 'Authorization': 'token ' + token }, timeout: 8000, validateStatus: null
          });
          if (releaseResp.status === 200) {
            const assets = releaseResp.data.assets || [];
            const apkAsset = assets.find(function(a) { return a.name.endsWith('.apk'); });
            if (apkAsset) {
              return res.json(makeSuccessResponse({
                completed: true, status: 'success',
                download_url: apkAsset.browser_download_url,
                build_id: buildId, completed_at: run.updated_at,
                app_name: run.display_title, progress: 100
              }));
            }
          }
        } catch (e) {
          console.log('[' + buildId + '] Release check error:', e.message);
        }

        return res.json(makeSuccessResponse({
          completed: false, status: 'publishing', build_id: buildId,
          progress: 95, message: 'Build successful, creating release...'
        }));
      }

      if (status === 'completed' && conclusion === 'failure') {
        return res.json(makeSuccessResponse({
          completed: true, status: 'failed', build_id: buildId,
          run_url: run.html_url, error: 'Build failed in GitHub Actions', progress: 0
        }));
      }

      return res.json(makeSuccessResponse({
        completed: false, status: status, build_id: buildId,
        progress: progress, run_url: run.html_url, message: 'Build ' + status + '...'
      }));

    } catch (err) {
      console.error('[' + buildId + '] Status check error:', err.message);
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

app.use(function(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json(makeErrorResponse('FILE_TOO_LARGE', 'File too large. Max: ' + formatFileSize(CONFIG.MAX_FILE_SIZE)));
    if (err.code === 'LIMIT_FILE_COUNT') return res.status(413).json(makeErrorResponse('TOO_MANY_FILES', 'Too many files'));
    return res.status(400).json(makeErrorResponse('UPLOAD_ERROR', err.message));
  }
  if (err) {
    console.error('Error:', err.stack || err.message);
    return res.status(500).json(makeErrorResponse('SERVER_ERROR', err.message));
  }
  next();
});

// =============================================================================
// Static Files & Server
// =============================================================================

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', function() {
  console.log('============================================================');
  console.log('  Aite.studio - Flutter to APK Builder');
  console.log('============================================================');
  console.log('  Port: ' + PORT);
  console.log('  Temp: ' + CONFIG.TEMP_DIR);
  console.log('  Max Size: ' + formatFileSize(CONFIG.MAX_FILE_SIZE));
  console.log('  Features: Flutter Build, AI Repair, Telegram Notify');
  console.log('  Supports: Flutter Folder, Flutter ZIP, Old & New Projects');
  console.log('============================================================');
});

module.exports = app;
