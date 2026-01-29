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

// Cloudinary Configuration
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ dest: '/tmp/' });

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// دالة مساعدة لتنظيف اسم الملف ليكون صالحاً للروابط
function sanitizeFilename(name) {
    return name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// 1. Build Endpoint
app.post('/build-flutter', upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'projectZip', maxCount: 1 }]), async (req, res) => {
    try {
        const { appName, packageName } = req.body;
        
        // تنظيف اسم الملف لاستخدامه في الرابط والـ APK
        const safeAppName = sanitizeFilename(appName); 

        if (!req.files || !req.files['icon'] || !req.files['projectZip']) {
            throw new Error("Missing files");
        }

        const iconFile = req.files['icon'][0];
        const zipFile = req.files['projectZip'][0];

        // Upload Icon
        const iconUpload = await cloudinary.uploader.upload(iconFile.path, { folder: "aite_studio/icons" });

        // Upload ZIP
        const zipUpload = await cloudinary.uploader.upload(zipFile.path, {
            resource_type: "raw",
            folder: "aite_studio/projects",
            public_id: `${packageName}_source_${Date.now()}`
        });

        const requestId = Date.now().toString();

        // Trigger GitHub Dispatch
        const githubPayload = {
            event_type: "build-flutter",
            client_payload: {
                app_name: safeAppName, // نرسل الاسم الآمن للملف
                display_name: appName, // الاسم الذي سيظهر داخل التطبيق (Label)
                package_name: packageName,
                icon_url: iconUpload.secure_url,
                zip_url: zipUpload.secure_url,
                request_id: requestId
            }
        };

        await axios.post(
            `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/dispatches`,
            githubPayload,
            {
                headers: {
                    'Authorization': `token ${process.env.GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            }
        );

        // Cleanup
        if (fs.existsSync(iconFile.path)) fs.unlinkSync(iconFile.path);
        if (fs.existsSync(zipFile.path)) fs.unlinkSync(zipFile.path);

        res.json({
            success: true,
            message: "Build initiated",
            build_id: requestId,
            safe_app_name: safeAppName // نرسل الاسم الآمن للفرونت إند ليستخدمه في التحقق
        });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. Status Check Endpoint (جديد)
app.get('/check-status/:buildId', async (req, res) => {
    try {
        const { buildId } = req.params;
        const { appName } = req.query; // نستقبل اسم التطبيق الآمن

        // نتحقق مما إذا كان GitHub قد أصدر Release بهذا التاج
        const releaseUrl = `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/releases/tags/build-${buildId}`;
        
        try {
            const response = await axios.get(releaseUrl, {
                headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` }
            });

            // إذا وصلنا هنا، يعني أن الـ Release موجود
            // نقوم بصياغة الرابط الدقيق كما طلبت
            // Format: https://github.com/OWNER/REPO/releases/download/build-ID/AppName.apk
            const downloadUrl = `https://github.com/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/releases/download/build-${buildId}/${appName}.apk`;

            res.json({ 
                completed: true, 
                download_url: downloadUrl 
            });

        } catch (ghError) {
            if (ghError.response && ghError.response.status === 404) {
                // 404 يعني أن الـ Release لم يتم إنشاؤه بعد (ما زال قيد البناء)
                res.json({ completed: false });
            } else {
                throw ghError;
            }
        }
    } catch (error) {
        console.error("Status Check Error:", error.message);
        res.status(500).json({ error: "Failed to check status" });
    }
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
