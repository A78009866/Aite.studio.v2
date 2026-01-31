
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
// Intelligent File Structure Analyzer
// =============================================================================

class ProjectAnalyzer {
  constructor(files, tempDir) {
    this.files = files;
    this.tempDir = tempDir;
    this.structure = {
      hasRootIndex: false,
      htmlFiles: [],
      entryPoint: null,
      isNested: false,
      rootFolder: null,
      assetFolders: [],
      type: 'unknown' // 'single_html', 'flat', 'nested', 'build_output'
    };
  }

  async analyze() {
    console.log('[Analyzer] Starting project analysis...');
    
    // Get all file paths
    const paths = this.files.map(f => f.relativePath || f.originalname);
    console.log(`[Analyzer] Total files: ${paths.length}`);
    
    // Find HTML files
    this.structure.htmlFiles = paths.filter(p => 
      p.toLowerCase().endsWith('.html') || p.toLowerCase().endsWith('.htm')
    );
    
    console.log(`[Analyzer] HTML files found: ${this.structure.htmlFiles.length}`);
    this.structure.htmlFiles.forEach(f => console.log(`  - ${f}`));
    
    // Check for root-level index.html
    this.structure.hasRootIndex = this.structure.htmlFiles.some(p => {
      const parts = p.split('/');
      return parts[parts.length - 1].toLowerCase().startsWith('index') && parts.length <= 2;
    });
    
    // Detect if files are nested inside a single folder
    const firstParts = paths[0]?.split('/') || [];
    if (firstParts.length > 1) {
      const potentialRoot = firstParts[0];
      const allInSameRoot = paths.every(p => p.startsWith(potentialRoot + '/'));
      if (allInSameRoot && paths.length > 1) {
        this.structure.isNested = true;
        this.structure.rootFolder = potentialRoot;
        console.log(`[Analyzer] Detected nested structure in: ${potentialRoot}`);
      }
    }
    
    // Detect build output folders (www, dist, build)
    const buildFolders = ['www', 'dist', 'build', 'public', 'output'];
    for (const folder of buildFolders) {
      const hasFolder = paths.some(p => p.startsWith(folder + '/') || p === folder);
      const hasIndexInFolder = paths.some(p => 
        p.startsWith(folder + '/') && p.toLowerCase().endsWith('index.html')
      );
      if (hasFolder && hasIndexInFolder) {
        this.structure.type = 'build_output';
        this.structure.buildFolder = folder;
        console.log(`[Analyzer] Detected build output folder: ${folder}`);
        break;
      }
    }
    
    // Determine entry point with priority
    this.findEntryPoint();
    
    // Determine project type
    if (this.structure.htmlFiles.length === 1 && !this.structure.isNested) {
      this.structure.type = 'single_html';
    } else if (this.structure.hasRootIndex && !this.structure.isNested) {
      this.structure.type = 'flat';
    } else if (this.structure.isNested) {
      this.structure.type = 'nested';
    }
    
    console.log(`[Analyzer] Project type: ${this.structure.type}`);
    console.log(`[Analyzer] Entry point: ${this.structure.entryPoint}`);
    
    return this.structure;
  }
  
  findEntryPoint() {
    const candidates = this.structure.htmlFiles;
    
    // Priority 1: Root-level index.html
    const rootIndex = candidates.find(p => {
      const parts = p.split('/');
      const name = parts[parts.length - 1].toLowerCase();
      return name.startsWith('index') && parts.length <= 2;
    });
    
    if (rootIndex) {
      this.structure.entryPoint = rootIndex;
      return;
    }
    
    // Priority 2: Any index.html in subdirectories
    const anyIndex = candidates.find(p => 
      p.toLowerCase().includes('index') || 
      p.toLowerCase().includes('home')
    );
    
    if (anyIndex) {
      this.structure.entryPoint = anyIndex;
      return;
    }
    
    // Priority 3: First HTML file
    if (candidates.length > 0) {
      this.structure.entryPoint = candidates[0];
    }
  }
  
  async prepareForBuild() {
    console.log('[Analyzer] Preparing files for build...');
    
    const wwwDir = path.join(this.tempDir, 'www');
    await fs.mkdir(wwwDir, { recursive: true });
    
    // Strategy based on structure type
    switch (this.structure.type) {
      case 'single_html':
        await this.prepareSingleHtml(wwwDir);
        break;
      case 'build_output':
        await this.prepareBuildOutput(wwwDir);
        break;
      case 'nested':
        await this.prepareNested(wwwDir);
        break;
      case 'flat':
      default:
        await this.prepareFlat(wwwDir);
        break;
    }
    
    // Ensure index.html exists at root of www
    await this.ensureIndexHtml(wwwDir);
    
    return wwwDir;
  }
  
  async prepareSingleHtml(wwwDir) {
    console.log('[Analyzer] Preparing single HTML file...');
    const file = this.files[0];
    const destPath = path.join(wwwDir, 'index.html');
    await fs.copyFile(file.path, destPath);
  }
  
  async prepareBuildOutput(wwwDir) {
    console.log(`[Analyzer] Preparing build output from ${this.structure.buildFolder}...`);
    const buildDir = this.structure.buildFolder;
    
    for (const file of this.files) {
      const relativePath = file.relativePath || file.originalname;
      if (relativePath.startsWith(buildDir + '/')) {
        const destRelative = relativePath.slice(buildDir.length + 1);
        const destPath = path.join(wwwDir, destRelative);
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.copyFile(file.path, destPath);
      }
    }
  }
  
  async prepareNested(wwwDir) {
    console.log(`[Analyzer] Preparing nested structure from ${this.structure.rootFolder}...`);
    const root = this.structure.rootFolder;
    
    for (const file of this.files) {
      const relativePath = file.relativePath || file.originalname;
      if (relativePath.startsWith(root + '/')) {
        const destRelative = relativePath.slice(root.length + 1);
        const destPath = path.join(wwwDir, destRelative);
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.copyFile(file.path, destPath);
      }
    }
  }
  
  async prepareFlat(wwwDir) {
    console.log('[Analyzer] Preparing flat structure...');
    
    for (const file of this.files) {
      const relativePath = file.relativePath || file.originalname;
      // Remove any parent directory references for safety
      const safePath = relativePath.replace(/^\.\.\//, '').replace(/^\//, '');
      const destPath = path.join(wwwDir, safePath);
      
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(file.path, destPath);
    }
  }
  
  async ensureIndexHtml(wwwDir) {
    const indexPath = path.join(wwwDir, 'index.html');
    
    // Check if index.html exists
    try {
      await fs.access(indexPath);
      console.log('[Analyzer] index.html already exists');
      return;
    } catch {
      console.log('[Analyzer] Creating index.html...');
    }
    
    // Find the entry point file
    const entryFile = this.structure.entryPoint;
    if (!entryFile) {
      throw new Error('No HTML entry point found');
    }
    
    // Get just the filename
    const entryName = path.basename(entryFile);
    
    // If entry point is not index.html, copy or redirect
    if (entryName.toLowerCase() !== 'index.html') {
      const entryPath = path.join(wwwDir, entryName);
      
      try {
        // Try to copy the entry file to index.html
        await fs.copyFile(entryPath, indexPath);
        console.log(`[Analyzer] Copied ${entryName} to index.html`);
      } catch (err) {
        // If file doesn't exist at root, search for it
        const files = await fs.readdir(wwwDir, { recursive: true });
        const foundEntry = files.find(f => f.toLowerCase().endsWith(entryName.toLowerCase()));
        
        if (foundEntry) {
          const sourcePath = path.join(wwwDir, foundEntry);
          await fs.copyFile(sourcePath, indexPath);
          console.log(`[Analyzer] Copied ${foundEntry} to index.html`);
        } else {
          // Create a redirect page
          const redirectHtml = `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="refresh" content="0; url=${entryName}">
  <title>Redirecting...</title>
</head>
<body>
  <p>Redirecting to <a href="${entryName}">${entryName}</a>...</p>
</body>
</html>`;
          await fs.writeFile(indexPath, redirectHtml);
          console.log(`[Analyzer] Created redirect to ${entryName}`);
        }
      }
    }
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
  // Android package name validation
  return /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(pkg) && 
         pkg.length <= 100 &&
         !pkg.includes('..') &&
         !pkg.startsWith('.') &&
         !pkg.endsWith('.');
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
    // Preserve original filename and path for folder uploads
    const uniqueName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${file.originalname}`;
    cb(null, uniqueName);
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

const upload = multer({
  storage: diskStorage,
  limits: {
    fileSize: CONFIG.MAX_FILE_SIZE,
    files: 2000 // Allow up to 2000 files for large projects
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
    version: '4.0.0-intelligent',
    features: {
      webToApk: true,
      intelligentStructure: true,
      htmlFile: true,
      folderUpload: true,
      zipUpload: true,
      nestedProjects: true,
      buildOutputDetection: true
    }
  }));
});

// =============================================================================
// Main Build Endpoint - Intelligent Web to APK
// =============================================================================

app.post('/build-web2apk', 
  upload.fields([
    { name: 'icon', maxCount: 1 },
    { name: 'projectFiles', maxCount: 2000 }
  ]),
  async (req, res) => {
    const requestId = generateBuildId();
    const tempDir = req.tempDir;
    
    console.log(`[${requestId}] 🚀 New intelligent build request`);
    
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
          'Invalid package name format. Must be like com.example.app (lowercase, starts with letter)'
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

      console.log(`[${requestId}] 📊 Upload summary:`);
      console.log(`  - Icon: ${iconFile.originalname} (${formatFileSize(iconFile.size)})`);
      console.log(`  - Upload Type: ${uploadType}`);
      console.log(`  - Total Files: ${projectFiles.length}`);

      if (iconFile.size > CONFIG.MAX_ICON_SIZE) {
        await cleanupTemp(tempDir);
        return res.status(400).json(makeErrorResponse(
          'ICON_TOO_LARGE',
          `Icon max size is ${formatFileSize(CONFIG.MAX_ICON_SIZE)}`
        ));
      }

      const safeAppName = sanitizeFilename(appName);

      // Upload Icon
      console.log(`[${requestId}] 📤 Uploading icon...`);
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
        console.log(`[${requestId}] ✅ Icon uploaded: ${iconUpload.secure_url}`);
      } catch (err) {
        await cleanupTemp(tempDir);
        return res.status(500).json(makeErrorResponse(
          'CLOUDINARY_ICON_FAIL',
          'Failed to upload icon',
          err.message
        ));
      }

      // Intelligent Project Processing
      console.log(`[${requestId}] 🧠 Analyzing project structure...`);
      
      let zipBuffer;
      let zipUpload;
      
      try {
        // Check if it's a direct ZIP upload
        const firstFile = projectFiles[0];
        const isDirectZip = uploadType === 'zip' || 
                           firstFile.originalname.toLowerCase().endsWith('.zip') ||
                           firstFile.mimetype === 'application/zip';
        
        if (isDirectZip && projectFiles.length === 1) {
          // Use ZIP directly but analyze its structure
          console.log(`[${requestId}] 📦 Using uploaded ZIP directly`);
          zipBuffer = await fs.readFile(firstFile.path);
          
          // Analyze ZIP contents for logging
          try {
            const zip = new AdmZip(firstFile.path);
            const entries = zip.getEntries();
            const htmlFiles = entries.filter(e => e.entryName.toLowerCase().endsWith('.html'));
            console.log(`[${requestId}] 📂 ZIP contains ${entries.length} entries, ${htmlFiles.length} HTML files`);
            
            if (htmlFiles.length > 0) {
              console.log(`[${requestId}] 📄 HTML files: ${htmlFiles.map(e => e.entryName).join(', ')}`);
            }
          } catch (zipErr) {
            console.log(`[${requestId}] ⚠️ Could not analyze ZIP: ${zipErr.message}`);
          }
          
        } else {
          // Use intelligent analyzer for folder uploads
          console.log(`[${requestId}] 🔍 Running intelligent structure analysis...`);
          const analyzer = new ProjectAnalyzer(projectFiles, tempDir);
          const structure = await analyzer.analyze();
          
          console.log(`[${requestId}] 📊 Analysis results:`);
          console.log(`  - Type: ${structure.type}`);
          console.log(`  - Entry Point: ${structure.entryPoint}`);
          console.log(`  - Is Nested: ${structure.isNested}`);
          
          // Prepare optimized structure
          const wwwDir = await analyzer.prepareForBuild();
          
          // Create optimized ZIP
          console.log(`[${requestId}] 📦 Creating optimized ZIP...`);
          const zipPath = path.join(tempDir, 'optimized-project.zip');
          const zip = new AdmZip();
          
          // Add www folder contents to ZIP root (GitHub Actions expects this)
          const addDirectoryToZip = (dirPath, zipPath) => {
            const items = fsSync.readdirSync(dirPath);
            for (const item of items) {
              const fullPath = path.join(dirPath, item);
              const stat = fsSync.statSync(fullPath);
              if (stat.isDirectory()) {
                addDirectoryToZip(fullPath, path.join(zipPath, item));
              } else {
                zip.addLocalFile(fullPath, zipPath);
              }
            }
          };
          
          addDirectoryToZip(wwwDir, '');
          zip.writeZip(zipPath);
          zipBuffer = await fs.readFile(zipPath);
          
          console.log(`[${requestId}] ✅ Optimized ZIP created: ${formatFileSize(zipBuffer.length)}`);
        }

        // Upload ZIP to Cloudinary
        console.log(`[${requestId}] 📤 Uploading project ZIP...`);
        
        if (zipBuffer.length > 50 * 1024 * 1024) {
          // Large file - use stream
          const zipPath = path.join(tempDir, 'large-project.zip');
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
        
        console.log(`[${requestId}] ✅ ZIP uploaded: ${zipUpload.secure_url}`);
        
      } catch (err) {
        await cleanupTemp(tempDir);
        return res.status(500).json(makeErrorResponse(
          'ZIP_PROCESSING_FAIL',
          'Failed to process project files',
          err.message
        ));
      }

      // Dispatch to GitHub Actions
      console.log(`[${requestId}] 🚀 Dispatching to GitHub Actions...`);
      
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
          timestamp: new Date().toISOString(),
          intelligent_build: true
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

      console.log(`[${requestId}] 📡 GitHub response: ${resp.status}`);

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
          intelligent_build: true,
          message: 'Build started with intelligent structure detection',
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
      console.error(`[${requestId}] ❌ Error:`, err.stack || err.message);
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
    const runsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs?event=repository_dispatch&per_page=20`;
    
    try {
      const runsResp = await axios.get(runsUrl, {
        headers: { 'Authorization': `token ${token}` },
        timeout: 10000
      });
      
      // Find run by build ID in various fields
      const run = runsResp.data.workflow_runs.find(r => 
        r.display_title?.includes(buildId) || 
        r.head_commit?.message?.includes(buildId) ||
        (r.head_commit?.message?.includes('client_payload') && 
         runsResp.data.workflow_runs.indexOf(r) < 5) // Check recent runs
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
          progress: 5,
          message: 'Build queued, waiting for GitHub Actions...'
        }));
      }
      
      const status = run.status;
      const conclusion = run.conclusion;
      
      // Map GitHub status to progress
      let progress = 5;
      if (status === 'queued') progress = 10;
      if (status === 'in_progress') progress = 50;
      if (status === 'completed' && conclusion === 'success') progress = 95;
      
      if (status === 'completed' && conclusion === 'success') {
        // Check for release
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
                app_name: run.display_title,
                progress: 100
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
          progress: 95,
          message: 'Build successful, creating release...'
        }));
      }
      
      if (status === 'completed' && conclusion === 'failure') {
        return res.json(makeSuccessResponse({
          completed: true,
          status: 'failed',
          build_id: buildId,
          run_url: run.html_url,
          error: 'Build failed in GitHub Actions',
          progress: 0
        }));
      }
      
      return res.json(makeSuccessResponse({
        completed: false,
        status: status,
        build_id: buildId,
        progress: progress,
        run_url: run.html_url,
        message: `Build ${status}...`
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
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(413).json(makeErrorResponse(
        'TOO_MANY_FILES',
        'Too many files uploaded'
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
  console.log('🚀 Aite.studio - Intelligent Web to APK Builder');
  console.log('='.repeat(60));
  console.log(`📡 Port: ${PORT}`);
  console.log(`📁 Temp: ${CONFIG.TEMP_DIR}`);
  console.log(`📦 Max Size: ${formatFileSize(CONFIG.MAX_FILE_SIZE)}`);
  console.log(`🧠 Features: Smart Structure Detection`);
  console.log(`✅ Supports: HTML, Folders, ZIP, Nested Projects`);
  console.log('='.repeat(60));
});

module.exports = app;
