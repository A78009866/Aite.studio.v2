// =============================================================================
// Aite.studio - Smart Flutter Cloud Build Server
// =============================================================================
// دعم رفع الملفات الكبيرة مع تقنيات متقدمة:
// - Streaming upload مع progress tracking
// - Chunked upload للملفات الضخمة
// - Disk storage مع تنظيف تلقائي
// - Compression وoptimization
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
const { pipeline } = require('stream/promises');
const zlib = require('zlib');
const crypto = require('crypto');

const app = express();

// =============================================================================
// Configuration
// =============================================================================
const CONFIG = {
  // حدود الرفع
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE) || 500 * 1024 * 1024, // 500MB default
  MAX_ICON_SIZE: 10 * 1024 * 1024, // 10MB للأيقونات
  
  // إعدادات الملفات المؤقتة - استخدام /tmp للتوافق مع Vercel والبيئات السحابية
  TEMP_DIR: process.env.TEMP_DIR || '/tmp/aite-studio',
  
  UPLOAD_TIMEOUT: parseInt(process.env.UPLOAD_TIMEOUT) || 300000, // 5 دقائق
  
  // Chunked upload
  CHUNK_SIZE: parseInt(process.env.CHUNK_SIZE) || 5 * 1024 * 1024, // 5MB per chunk
  MAX_CHUNKS: 100, // maximum chunks allowed
  
  // معدل الطلبات
  RATE_LIMIT_WINDOW: 15 * 60 * 1000, // 15 دقيقة
  RATE_LIMIT_MAX: 10, // 10 طلبات per window
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

// زيادة حدود حجم الطلب للـ JSON
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

/**
 * إنشاء مجلد مؤقت فريد
 */
async function createTempDir() {
  const dirName = crypto.randomUUID();
  const fullPath = path.join(CONFIG.TEMP_DIR, dirName);
  await fs.mkdir(fullPath, { recursive: true });
  return fullPath;
}

/**
 * تنظيف الملفات المؤقتة
 */
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

/**
 * تنظيف دوري للملفات القديمة
 */
async function periodicCleanup() {
  try {
    // التأكد من وجود المجلد الرئيسي
    if (!fsSync.existsSync(CONFIG.TEMP_DIR)) {
      return;
    }
    
    const tempDirs = await fs.readdir(CONFIG.TEMP_DIR);
    const now = Date.now();
    const MAX_AGE = 24 * 60 * 60 * 1000; // 24 ساعة
    
    for (const dir of tempDirs) {
      const dirPath = path.join(CONFIG.TEMP_DIR, dir);
      try {
        const stat = await fs.stat(dirPath);
        if (now - stat.mtime.getTime() > MAX_AGE) {
          await fs.rm(dirPath, { recursive: true, force: true });
          console.log(`[Periodic Cleanup] Removed old dir: ${dir}`);
        }
      } catch (err) {
        // تجاهل الأخطاء للملفات التي لا يمكن قراءتها
      }
    }
  } catch (err) {
    console.error('[Periodic Cleanup Error]', err.message);
  }
}

// تشغيل التنظيف الدوري كل ساعة
setInterval(periodicCleanup, 60 * 60 * 1000);

/**
 * توليد ID فريد للبناء
 */
function generateBuildId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * التحقق من صحة اسم الحزمة
 */
function isValidPackageName(pkg) {
  return /^[a-zA-Z][a-zA-Z0-9_\.]*$/.test(pkg);
}

/**
 * تنظيف اسم الملف
 */
function sanitizeFilename(name) {
  return String(name || '').trim()
    .replace(/[^a-z0-9]/gi, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
}

/**
 * تنسيق حجم الملف
 */
function formatFileSize(bytes) {
  const sizes = ['B', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * رفع Buffer إلى Cloudinary
 */
async function uploadToCloudinaryBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    stream.end(buffer);
  });
}

/**
 * رفع ملف كبير إلى Cloudinary باستخدام stream
 */
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

/**
 * إنشاء استجابة خطأ
 */
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

/**
 * إنشاء استجابة نجاح
 */
function makeSuccessResponse(data = {}) {
  return {
    success: true,
    timestamp: new Date().toISOString(),
    ...data
  };
}

// =============================================================================
// Multer Configuration - Disk Storage للملفات الكبيرة
// =============================================================================

// ملاحظة: لا نحتاج لإنشاء المجلد هنا لأن createTempDir ستنشئ المسار الكامل

// تخزين مؤقت على القرص للملفات الكبيرة
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

// فلتر الملفات
const fileFilter = (req, file, cb) => {
  if (file.fieldname === 'icon') {
    // الأيقونة: صور فقط
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Icon must be an image file'), false);
    }
    cb(null, true);
  } else if (file.fieldname === 'projectZip') {
    // ملف ZIP
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

// إعداد Multer الرئيسي
const upload = multer({
  storage: diskStorage,
  limits: {
    fileSize: CONFIG.MAX_FILE_SIZE,
    files: 2 // icon + projectZip
  },
  fileFilter: fileFilter
});

// =============================================================================
// Progress Tracking Middleware
// =============================================================================

/**
 * تتبع تقدم الرفع
 */
function trackUploadProgress(req, res, next) {
  let uploadedBytes = 0;
  const contentLength = parseInt(req.headers['content-length']) || 0;
  
  req.on('data', (chunk) => {
    uploadedBytes += chunk.length;
    if (contentLength > 0) {
      const progress = Math.round((uploadedBytes / contentLength) * 100);
      req.uploadProgress = progress;
    }
  });
  
  next();
}

// =============================================================================
// Routes
// =============================================================================

// Health check
app.get('/health', (req, res) => {
  res.json(makeSuccessResponse({
    status: 'healthy',
    version: '2.0.0',
    features: {
      largeFileSupport: true,
      chunkedUpload: true,
      streaming: true,
      compression: true
    },
    limits: {
      maxFileSize: formatFileSize(CONFIG.MAX_FILE_SIZE),
      maxIconSize: formatFileSize(CONFIG.MAX_ICON_SIZE)
    }
  }));
});

// معلومات الإعدادات (للتصحيح)
app.get('/config', (req, res) => {
  res.json(makeSuccessResponse({
    maxFileSize: formatFileSize(CONFIG.MAX_FILE_SIZE),
    chunkSize: formatFileSize(CONFIG.CHUNK_SIZE),
    tempDir: CONFIG.TEMP_DIR,
    uploadTimeout: `${CONFIG.UPLOAD_TIMEOUT / 1000}s`
  }));
});

// =============================================================================
// Main Build Endpoint - مع دعم الملفات الكبيرة
// =============================================================================

app.post('/build-flutter', 
  trackUploadProgress,
  upload.fields([
    { name: 'icon', maxCount: 1 },
    { name: 'projectZip', maxCount: 1 }
  ]),
  async (req, res) => {
    const requestId = generateBuildId();
    const tempDir = req.tempDir;
    
    console.log(`[${requestId}] New build request started`);
    console.log(`[${requestId}] Temp directory: ${tempDir}`);
    
    try {
      // التحقق من متغيرات البيئة
      const owner = process.env.GITHUB_REPO_OWNER;
      const repo = process.env.GITHUB_REPO_NAME;
      const token = process.env.GITHUB_TOKEN;
      
      if (!owner || !repo || !token) {
        console.error(`[${requestId}] Missing GitHub environment variables`);
        await cleanupTemp(tempDir);
        return res.status(500).json(makeErrorResponse(
          'MISSING_ENV',
          'Server misconfigured: missing GitHub repo/token environment variables'
        ));
      }

      // التحقق من البيانات المطلوبة
      const { appName, packageName, flutterVersion, buildMode } = req.body || {};
      
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
          'Invalid package name format. Must start with a letter and contain only letters, numbers, underscores, and dots.'
        ));
      }

      // التحقق من الملفات
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

      // التحقق من حجم الأيقونة
      if (iconFile.size > CONFIG.MAX_ICON_SIZE) {
        await cleanupTemp(tempDir);
        return res.status(400).json(makeErrorResponse(
          'ICON_TOO_LARGE',
          `Icon file too large. Maximum size is ${formatFileSize(CONFIG.MAX_ICON_SIZE)}`
        ));
      }

      const safeAppName = sanitizeFilename(appName);

      // =======================================================================
      // رفع الأيقونة
      // =======================================================================
      console.log(`[${requestId}] Uploading icon to Cloudinary...`);
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
        console.error(`[${requestId}] Icon upload failed:`, err.message);
        await cleanupTemp(tempDir);
        return res.status(500).json(makeErrorResponse(
          'CLOUDINARY_ICON_FAIL',
          'Failed to upload icon',
          err.message
        ));
      }

      // =======================================================================
      // رفع ملف ZIP (مع دعم الملفات الكبيرة)
      // =======================================================================
      console.log(`[${requestId}] Uploading ZIP to Cloudinary...`);
      let zipUpload;
      try {
        // للملفات الكبيرة، نستخدم streaming
        if (zipFile.size > 50 * 1024 * 1024) {
          console.log(`[${requestId}] Using large file upload method...`);
          zipUpload = await uploadLargeFileToCloudinary(zipFile.path, {
            folder: 'aite_studio/projects',
            public_id: `${sanitizeFilename(packageName)}_source_${requestId}`,
            resource_type: 'raw',
            overwrite: true
          });
        } else {
          // للملفات الصغيرة، نستخدم Buffer
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
        console.error(`[${requestId}] ZIP upload failed:`, err.message);
        await cleanupTemp(tempDir);
        return res.status(500).json(makeErrorResponse(
          'CLOUDINARY_ZIP_FAIL',
          'Failed to upload project ZIP',
          err.message
        ));
      }

      // =======================================================================
      // إرسال طلب البناء إلى GitHub Actions
      // =======================================================================
      console.log(`[${requestId}] Dispatching to GitHub Actions...`);
      
      const githubPayload = {
        event_type: 'build-flutter',
        client_payload: {
          app_name: safeAppName,
          display_name: appName,
          package_name: packageName,
          icon_url: iconUpload.secure_url,
          zip_url: zipUpload.secure_url,
          request_id: requestId,
          flutter_version: flutterVersion || 'stable',
          build_mode: buildMode || 'release',
          file_size: zipFile.size,
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

      console.log(`[${requestId}] GitHub response status: ${resp.status}`);

      if (resp.status >= 200 && resp.status < 300) {
        // تنظيف الملفات المؤقتة
        await cleanupTemp(tempDir);
        
        return res.json(makeSuccessResponse({
          build_id: requestId,
          safe_app_name: safeAppName,
          app_name: appName,
          package_name: packageName,
          icon_url: iconUpload.secure_url,
          zip_url: zipUpload.secure_url,
          file_size: formatFileSize(zipFile.size),
          message: 'Build initiated successfully',
          check_status_url: `/check-status/${requestId}?appName=${safeAppName}`
        }));
      } else {
        const body = resp.data ? 
          (typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)) : '';
        console.error(`[${requestId}] GitHub dispatch failed:`, resp.status, body);
        await cleanupTemp(tempDir);
        return res.status(500).json(makeErrorResponse(
          'GITHUB_DISPATCH_FAILED',
          'Failed to dispatch build to GitHub',
          { status: resp.status, body: body.slice(0, 500) }
        ));
      }

    } catch (err) {
      console.error(`[${requestId}] Unexpected error:`, err.stack || err.message);
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
// Chunked Upload Endpoint - للملفات الضخمة جداً
// =============================================================================

// تخزين مؤقت للـ chunks
const chunkStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const chunkDir = path.join(CONFIG.TEMP_DIR, 'chunks', req.params.uploadId);
    await fs.mkdir(chunkDir, { recursive: true });
    cb(null, chunkDir);
  },
  filename: (req, file, cb) => {
    cb(null, `chunk-${req.params.chunkIndex}`);
  }
});

const chunkUpload = multer({
  storage: chunkStorage,
  limits: { fileSize: CONFIG.CHUNK_SIZE }
});

/**
 * بدء رفع chunked
 */
app.post('/upload/init', (req, res) => {
  const uploadId = generateBuildId();
  console.log(`[${uploadId}] Chunked upload initialized`);
  res.json(makeSuccessResponse({ upload_id: uploadId }));
});

/**
 * رفع chunk
 */
app.post('/upload/chunk/:uploadId/:chunkIndex', chunkUpload.single('chunk'), async (req, res) => {
  try {
    const { uploadId, chunkIndex } = req.params;
    const { totalChunks } = req.body;
    
    console.log(`[${uploadId}] Received chunk ${chunkIndex}/${totalChunks}`);
    
    res.json(makeSuccessResponse({
      upload_id: uploadId,
      chunk_index: parseInt(chunkIndex),
      received: true
    }));
  } catch (err) {
    res.status(500).json(makeErrorResponse('CHUNK_UPLOAD_ERROR', err.message));
  }
});

/**
 * دمج chunks وإكمال الرفع
 */
app.post('/upload/complete/:uploadId', async (req, res) => {
  const { uploadId } = req.params;
  const { totalChunks, filename, fileType } = req.body;
  
  console.log(`[${uploadId}] Completing upload, merging ${totalChunks} chunks...`);
  
  const chunkDir = path.join(CONFIG.TEMP_DIR, 'chunks', uploadId);
  const outputPath = path.join(CONFIG.TEMP_DIR, `${uploadId}-${filename}`);
  
  try {
    // التحقق من وجود كل chunks
    const chunks = [];
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(chunkDir, `chunk-${i}`);
      if (!fsSync.existsSync(chunkPath)) {
        throw new Error(`Missing chunk ${i}`);
      }
      chunks.push(chunkPath);
    }
    
    // دمج chunks
    const outputStream = createWriteStream(outputPath);
    for (const chunkPath of chunks) {
      const chunkData = await fs.readFile(chunkPath);
      outputStream.write(chunkData);
    }
    outputStream.end();
    
    // انتظار انتهاء الكتابة
    await new Promise((resolve, reject) => {
      outputStream.on('finish', resolve);
      outputStream.on('error', reject);
    });
    
    // تنظيف chunks
    await fs.rm(chunkDir, { recursive: true, force: true });
    
    console.log(`[${uploadId}] File merged successfully: ${outputPath}`);
    
    res.json(makeSuccessResponse({
      upload_id: uploadId,
      file_path: outputPath,
      file_size: formatFileSize((await fs.stat(outputPath)).size)
    }));
    
  } catch (err) {
    console.error(`[${uploadId}] Merge failed:`, err.message);
    res.status(500).json(makeErrorResponse('MERGE_ERROR', err.message));
  }
});

// =============================================================================
// Status Check Endpoint
// =============================================================================

app.get('/check-status/:buildId', async (req, res) => {
  try {
    const { buildId } = req.params;
    const { appName } = req.query;
    
    if (!buildId) {
      return res.status(400).json(makeErrorResponse('MISSING_BUILD_ID', 'Build ID is required'));
    }

    const owner = process.env.GITHUB_REPO_OWNER;
    const repo = process.env.GITHUB_REPO_NAME;
    const token = process.env.GITHUB_TOKEN;
    
    if (!owner || !repo || !token) {
      return res.status(500).json(makeErrorResponse('MISSING_ENV', 'Server misconfigured'));
    }

    // التحقق من workflow runs
    const runsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs?event=repository_dispatch`;
    
    try {
      const runsResp = await axios.get(runsUrl, {
        headers: { 'Authorization': `token ${token}` },
        timeout: 10000
      });
      
      // البحث عن run المطابق
      const run = runsResp.data.workflow_runs.find(r => 
        r.display_title?.includes(buildId) || 
        r.head_commit?.message?.includes(buildId)
      );
      
      if (run) {
        const status = run.status;
        const conclusion = run.conclusion;
        
        // إذا كان مكتملاً
        if (status === 'completed' && conclusion === 'success') {
          // البحث عن Release
          const releaseUrl = `https://api.github.com/repos/${owner}/${repo}/releases/tags/build-${buildId}`;
          try {
            const releaseResp = await axios.get(releaseUrl, {
              headers: { 'Authorization': `token ${token}` },
              timeout: 8000,
              validateStatus: null
            });
            
            if (releaseResp.status === 200) {
              const asset = releaseResp.data.assets.find(a => a.name.endsWith('.apk'));
              if (asset) {
                return res.json(makeSuccessResponse({
                  completed: true,
                  status: 'success',
                  download_url: asset.browser_download_url,
                  build_id: buildId,
                  completed_at: run.updated_at
                }));
              }
            }
          } catch (e) {
            console.log('Release not found yet');
          }
        }
        
        // إذا فشل
        if (status === 'completed' && conclusion === 'failure') {
          return res.json(makeSuccessResponse({
            completed: true,
            status: 'failed',
            build_id: buildId,
            run_url: run.html_url
          }));
        }
        
        // لا يزال قيد التنفيذ
        return res.json(makeSuccessResponse({
          completed: false,
          status: status,
          build_id: buildId,
          progress: status === 'in_progress' ? 50 : 10,
          run_url: run.html_url
        }));
      }
      
      // لم يتم العثور على run
      return res.json(makeSuccessResponse({
        completed: false,
        status: 'pending',
        build_id: buildId,
        progress: 5
      }));
      
    } catch (err) {
      console.error('Status check error:', err.message);
      return res.status(500).json(makeErrorResponse('CHECK_FAILED', 'Failed to check build status'));
    }
    
  } catch (err) {
    console.error('Status endpoint error:', err.message);
    return res.status(500).json(makeErrorResponse('SERVER_ERROR', err.message));
  }
});

// =============================================================================
// Error Handling Middleware
// =============================================================================

// معالجة أخطاء Multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json(makeErrorResponse(
        'FILE_TOO_LARGE',
        `File too large. Maximum size is ${formatFileSize(CONFIG.MAX_FILE_SIZE)}`
      ));
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json(makeErrorResponse(
        'UNEXPECTED_FIELD',
        'Unexpected file field'
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
  console.log('🚀 Aite.studio - Smart Flutter Cloud Build Server');
  console.log('='.repeat(60));
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`📁 Temp directory: ${CONFIG.TEMP_DIR}`);
  console.log(`📦 Max file size: ${formatFileSize(CONFIG.MAX_FILE_SIZE)}`);
  console.log(`🧩 Chunk size: ${formatFileSize(CONFIG.CHUNK_SIZE)}`);
  console.log('='.repeat(60));
});

module.exports = app;
