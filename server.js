
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configure Multer for file uploads (store in memory to pass to Cloudinary)
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB max file size
        files: 2 // max 2 files (icon + zip)
    }
});

app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// GitHub settings from environment variables
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;

// Middleware للتحقق من متغيرات البيئة
app.use((req, res, next) => {
    console.log('Environment Variables Check:', {
        hasCloudinary: !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET),
        hasGitHubToken: !!GITHUB_TOKEN,
        hasRepoOwner: !!REPO_OWNER,
        hasRepoName: !!REPO_NAME
    });
    next();
});

// 1. Receive build request with file uploads
app.post('/trigger-build', upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'projectZip', maxCount: 1 }]), async (req, res) => {
    console.log('=== /trigger-build REQUEST START ===');
    console.log('Request body keys:', Object.keys(req.body));
    console.log('Request files:', req.files ? Object.keys(req.files) : 'No files');
    
    const { appName, packageName } = req.body;
    const iconFile = req.files && req.files['icon'] ? req.files['icon'][0] : null;
    const zipFile = req.files && req.files['projectZip'] ? req.files['projectZip'][0] : null;

    console.log('Received data:', {
        appName,
        packageName,
        hasIconFile: !!iconFile,
        hasZipFile: !!zipFile,
        iconFileSize: iconFile?.size,
        zipFileSize: zipFile?.size
    });

    if (!appName || !packageName || !iconFile || !zipFile) {
        console.error('Missing data:', { appName, packageName, iconFile: !!iconFile, zipFile: !!zipFile });
        return res.status(400).json({ 
            success: false, 
            error: 'بيانات ناقصة: اسم التطبيق، معرف الحزمة، الأيقونة، أو ملف ZIP مفقود.' 
        });
    }

    const request_id = uuidv4();
    console.log('Generated request_id:', request_id);

    try {
        // Step 1: Upload icon to Cloudinary
        console.log('Step 1: Uploading icon to Cloudinary...');
        let icon_url = '';
        try {
            const iconUploadResult = await cloudinary.uploader.upload(
                `data:${iconFile.mimetype};base64,${iconFile.buffer.toString('base64')}`, 
                {
                    folder: 'aite-flutter-engine/icons',
                    public_id: `icon-${request_id}`,
                    overwrite: true
                }
            );
            icon_url = iconUploadResult.secure_url;
            console.log('✓ Icon uploaded successfully:', icon_url);
        } catch (cloudinaryError) {
            console.error('✗ Cloudinary icon upload failed:', cloudinaryError.message);
            return res.status(500).json({ 
                success: false, 
                error: 'فشل تحميل الأيقونة إلى Cloudinary',
                details: cloudinaryError.message 
            });
        }

        // Step 2: Upload zip to Cloudinary
        console.log('Step 2: Uploading ZIP to Cloudinary...');
        let zip_url = '';
        try {
            const zipUploadResult = await cloudinary.uploader.upload(
                `data:${zipFile.mimetype};base64,${zipFile.buffer.toString('base64')}`, 
                {
                    folder: 'aite-flutter-engine/zips',
                    resource_type: 'raw',
                    public_id: `project-${request_id}`,
                    overwrite: true
                }
            );
            zip_url = zipUploadResult.secure_url;
            console.log('✓ ZIP uploaded successfully:', zip_url);
        } catch (cloudinaryError) {
            console.error('✗ Cloudinary ZIP upload failed:', cloudinaryError.message);
            return res.status(500).json({ 
                success: false, 
                error: 'فشل تحميل ملف ZIP إلى Cloudinary',
                details: cloudinaryError.message 
            });
        }

        // Step 3: Check GitHub configuration
        console.log('Step 3: Checking GitHub configuration...');
        console.log('GitHub Config:', {
            REPO_OWNER,
            REPO_NAME,
            GITHUB_TOKEN_PRESENT: GITHUB_TOKEN ? 'YES' : 'NO',
            GITHUB_TOKEN_LENGTH: GITHUB_TOKEN?.length
        });

        if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME) {
            console.error('✗ GitHub configuration incomplete');
            return res.status(500).json({ 
                success: false, 
                error: 'إعدادات GitHub غير مكتملة',
                details: 'تأكد من تعيين GITHUB_TOKEN, REPO_OWNER, REPO_NAME'
            });
        }

        // Step 4: Trigger GitHub Action
        console.log('Step 4: Triggering GitHub Action...');
        const githubUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/dispatches`;
        console.log('GitHub API URL:', githubUrl);

        const payload = {
            event_type: 'build-flutter',
            client_payload: {
                app_name: appName,
                package_name: packageName,
                icon_url,
                zip_url,
                request_id
            }
        };

        console.log('GitHub Payload:', JSON.stringify(payload, null, 2));

        try {
            const githubResponse = await axios.post(
                githubUrl,
                payload,
                {
                    headers: {
                        'Authorization': `token ${GITHUB_TOKEN}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'User-Agent': 'Aite-Studio-Flutter-Builder'
                    },
                    timeout: 30000 // 30 seconds timeout
                }
            );

            console.log('✓ GitHub Action triggered successfully!');
            console.log('GitHub Response:', {
                status: githubResponse.status,
                statusText: githubResponse.statusText,
                data: githubResponse.data
            });

            res.json({ 
                success: true, 
                message: 'تم تشغيل عملية البناء بنجاح', 
                request_id, 
                icon_url, 
                zip_url 
            });

        } catch (githubError) {
            console.error('✗ GitHub API Error:');
            console.error('Error Message:', githubError.message);
            
            if (githubError.response) {
                console.error('Response Status:', githubError.response.status);
                console.error('Response Data:', githubError.response.data);
                console.error('Response Headers:', githubError.response.headers);
                
                if (githubError.response.status === 404) {
                    return res.status(500).json({ 
                        success: false, 
                        error: 'المستودع غير موجود أو الـ token ليس لديه صلاحيات كافية',
                        details: `المستودع: ${REPO_OWNER}/${REPO_NAME}`,
                        github_error: githubError.response.data
                    });
                } else if (githubError.response.status === 401) {
                    return res.status(500).json({ 
                        success: false, 
                        error: 'رمز GitHub Token غير صالح أو منتهي الصلاحية',
                        details: githubError.response.data
                    });
                } else if (githubError.response.status === 403) {
                    return res.status(500).json({ 
                        success: false, 
                        error: 'الصلاحيات غير كافية لتنفيذ هذا الإجراء',
                        details: githubError.response.data
                    });
                }
            } else if (githubError.request) {
                console.error('No response received:', githubError.request);
                return res.status(500).json({ 
                    success: false, 
                    error: 'لم يتم تلقي استجابة من GitHub API',
                    details: githubError.message
                });
            }
            
            return res.status(500).json({ 
                success: false, 
                error: 'خطأ في الاتصال بـ GitHub API',
                details: githubError.message
            });
        }

    } catch (error) {
        console.error('✗ Unexpected error in /trigger-build:');
        console.error('Error:', error);
        console.error('Stack:', error.stack);
        
        res.status(500).json({ 
            success: false, 
            error: 'خطأ غير متوقع في الخادم',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    } finally {
        console.log('=== /trigger-build REQUEST END ===\n');
    }
});

// 2. Check status and fetch unique download link
app.get('/check-status', async (req, res) => {
    console.log('=== /check-status REQUEST ===');
    console.log('Query params:', req.query);
    
    const { request_id } = req.query;

    if (!request_id) {
        console.error('Missing request_id');
        return res.status(400).json({ 
            status: 'error', 
            message: 'معرف الطلب (request_id) مفقود.' 
        });
    }

    console.log('Checking status for request_id:', request_id);

    try {
        // First, check if a Release with this ID exists
        console.log('Checking GitHub release...');
        const releaseUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/build-${request_id}`;
        console.log('Release URL:', releaseUrl);

        try {
            const releaseResponse = await axios.get(
                releaseUrl,
                { 
                    headers: { 
                        'Authorization': `token ${GITHUB_TOKEN}`,
                        'User-Agent': 'Aite-Studio-Flutter-Builder'
                    },
                    timeout: 10000
                }
            );

            if (releaseResponse.data && releaseResponse.data.assets && releaseResponse.data.assets.length > 0) {
                console.log('✓ Release found! Build completed successfully');
                return res.json({
                    status: 'completed',
                    conclusion: 'success',
                    download_url: releaseResponse.data.assets[0].browser_download_url,
                    release_name: releaseResponse.data.name
                });
            }
        } catch (releaseError) {
            if (releaseError.response && releaseError.response.status === 404) {
                console.log('Release not found yet (still building)...');
            } else {
                console.error('Error checking release:', releaseError.message);
            }
        }

        // Check workflow runs for this request
        console.log('Checking workflow runs...');
        const runsUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs`;
        console.log('Workflow runs URL:', runsUrl);

        try {
            const runsResponse = await axios.get(
                runsUrl,
                { 
                    headers: { 
                        'Authorization': `token ${GITHUB_TOKEN}`,
                        'User-Agent': 'Aite-Studio-Flutter-Builder'
                    },
                    params: {
                        event: 'repository_dispatch',
                        per_page: 20
                    },
                    timeout: 10000
                }
            );

            const relevantRun = runsResponse.data.workflow_runs.find(run => {
                // Check if this run is related to our request_id
                // This is a basic check - you might need to customize based on your workflow
                return run.head_branch === 'main' && 
                       run.event === 'repository_dispatch' &&
                       run.status === 'completed' &&
                       run.conclusion === 'failure';
            });

            if (relevantRun) {
                console.log('✓ Found failed workflow run');
                return res.json({
                    status: 'completed',
                    conclusion: 'failure',
                    message: 'فشل عملية البناء في GitHub Actions'
                });
            }
        } catch (runsError) {
            console.error('Error checking workflow runs:', runsError.message);
        }

        // If neither completed nor failed, assume in progress
        console.log('Build still in progress...');
        res.json({ 
            status: 'in_progress',
            message: 'جاري عملية البناء...'
        });

    } catch (error) {
        console.error('✗ Error in /check-status:', error.message);
        console.error('Stack:', error.stack);
        
        res.status(500).json({ 
            status: 'error', 
            message: 'خطأ في التحقق من حالة البناء',
            details: error.message
        });
    } finally {
        console.log('=== /check-status REQUEST END ===\n');
    }
});

// 3. Health check endpoint
app.get('/health', (req, res) => {
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
            cloudinary: !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET),
            github: !!(process.env.GITHUB_TOKEN && process.env.REPO_OWNER && process.env.REPO_NAME)
        }
    };
    res.json(health);
});

// 4. Test GitHub connection endpoint
app.get('/test-github', async (req, res) => {
    try {
        if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME) {
            return res.status(500).json({
                success: false,
                error: 'GitHub environment variables not set'
            });
        }

        const testUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
        console.log('Testing GitHub connection to:', testUrl);
        
        const response = await axios.get(testUrl, {
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent': 'Aite-Studio-Flutter-Builder'
            },
            timeout: 10000
        });

        res.json({
            success: true,
            message: 'GitHub connection successful',
            repository: response.data.full_name,
            permissions: response.data.permissions
        });
    } catch (error) {
        console.error('GitHub test failed:', error.message);
        
        if (error.response) {
            res.status(error.response.status).json({
                success: false,
                error: `GitHub API error: ${error.response.status}`,
                details: error.response.data
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to connect to GitHub',
                details: error.message
            });
        }
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        success: false, 
        error: 'خطأ داخلي في الخادم',
        message: err.message
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        success: false, 
        error: 'الصفحة غير موجودة',
        path: req.path
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('========================================');
    console.log(`🚀 Server running on port ${PORT}`);
    console.log('Environment:', process.env.NODE_ENV || 'development');
    console.log('========================================');
});
