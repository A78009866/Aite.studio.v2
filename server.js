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
const upload = multer({ storage: storage });

app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// GitHub settings from environment variables
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;

// 1. Receive build request with file uploads
app.post('/trigger-build', upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'projectZip', maxCount: 1 }]), async (req, res) => {
    const { appName, packageName } = req.body;
    const iconFile = req.files['icon'] ? req.files['icon'][0] : null;
    const zipFile = req.files['projectZip'] ? req.files['projectZip'][0] : null;

    if (!appName || !packageName || !iconFile || !zipFile) {
        return res.status(400).json({ success: false, error: 'بيانات ناقصة: اسم التطبيق، معرف الحزمة، الأيقونة، أو ملف ZIP مفقود.' });
    }

    const request_id = uuidv4(); // Generate a unique ID for this build request

    try {
        // Upload icon to Cloudinary
        const iconUploadResult = await cloudinary.uploader.upload(`data:${iconFile.mimetype};base64,${iconFile.buffer.toString('base64')}`, {
            folder: 'aite-flutter-engine/icons',
            public_id: `icon-${request_id}`
        });
        const icon_url = iconUploadResult.secure_url;

        // Upload zip file to Cloudinary
        const zipUploadResult = await cloudinary.uploader.upload(`data:${zipFile.mimetype};base64,${zipFile.buffer.toString('base64')}`, {
            folder: 'aite-flutter-engine/zips',
            resource_type: 'raw', // Treat as a raw file
            public_id: `project-${request_id}`
        });
        const zip_url = zipUploadResult.secure_url;

        // Send request to GitHub Action
        await axios.post(
            `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/dispatches`,
            {
                event_type: 'build-flutter',
                client_payload: {
                    app_name: appName,
                    package_name: packageName,
                    icon_url,
                    zip_url,
                    request_id // This ID links the build to the release
                }
            },
            {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            }
        );

        res.json({ success: true, message: 'Build triggered', request_id, icon_url, zip_url });
    } catch (error) {
        console.error('GitHub or Cloudinary Error:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'فشل في الاتصال بـ GitHub أو Cloudinary.' });
    }
});

// 2. Check status and fetch unique download link
app.get('/check-status', async (req, res) => {
    const { request_id } = req.query;

    if (!request_id) {
        return res.status(400).json({ status: 'error', message: 'معرف الطلب (request_id) مفقود.' });
    }

    try {
        // Check if a Release with this ID exists
        const releaseResponse = await axios.get(
            `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/build-${request_id}`,
            { headers: { 'Authorization': `token ${GITHUB_TOKEN}` } }
        );

        if (releaseResponse.data && releaseResponse.data.assets.length > 0) {
            // Release found! Build completed successfully
            return res.json({
                status: 'completed',
                conclusion: 'success',
                download_url: releaseResponse.data.assets[0].browser_download_url
            });
        }
    } catch (err) {
        // If release not found (404), it means the build is not yet complete or failed.
        // We don't need to log 404 errors here, as it's expected during polling.
        if (err.response && err.response.status !== 404) {
            console.error('Error checking GitHub Release:', err.message);
        }
    }

    // If no release found, check for a failed workflow run
    // This part is less robust as GitHub API doesn't directly expose client_payload in run list.
    // For simplicity, if no release is found, we assume it's still in progress.
    // A more advanced solution would involve modifying the GitHub Action to update a separate status endpoint.
    try {
        const runsResponse = await axios.get(
            `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs?event=repository_dispatch&per_page=10`, // Fetch recent runs
            { headers: { 'Authorization': `token ${GITHUB_TOKEN}` } }
        );

        const relevantRun = runsResponse.data.workflow_runs.find(run =>
            run.event === 'repository_dispatch' &&
            run.status === 'completed' &&
            run.conclusion === 'failure' &&
            run.head_branch === 'main' // Assuming builds are on main branch
            // More robust identification would require custom outputs from GitHub Action
        );

        if (relevantRun) {
            // This is a generic failure check, not tied to a specific request_id without more info from GitHub Actions.
            // For now, we prioritize the release check. If a release isn't found, it's likely still building or failed without a release.
            // We'll return 'in_progress' to keep polling until a release appears or a more specific failure can be identified.
        }
    } catch (err) {
        console.error('Error checking GitHub Workflow Runs:', err.message);
    }

    // If neither a successful release nor a clear failure is found, assume in progress
    res.json({ status: 'in_progress' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
