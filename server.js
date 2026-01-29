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

const upload = multer({ dest: '/tmp/' });

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function sanitizeFilename(name) {
    return name.trim().replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// --- 1. نقطة بدء البناء ---
app.post('/build-flutter', upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'projectZip', maxCount: 1 }]), async (req, res) => {
    try {
        const { appName, packageName } = req.body;
        const safeAppName = sanitizeFilename(appName);

        if (!req.files || !req.files['icon'] || !req.files['projectZip']) {
            throw new Error("يرجى رفع جميع الملفات المطلوبة");
        }

        const iconFile = req.files['icon'][0];
        const zipFile = req.files['projectZip'][0];

        console.log(`[Build] Starting build for: ${appName} (${safeAppName})`);

        // رفع الأيقونة
        const iconUpload = await cloudinary.uploader.upload(iconFile.path, { folder: "aite_studio/icons" });
        // رفع المشروع
        const zipUpload = await cloudinary.uploader.upload(zipFile.path, {
            resource_type: "raw",
            folder: "aite_studio/projects",
            public_id: `${packageName}_source_${Date.now()}`
        });

        const requestId = Date.now().toString();

        // إرسال لـ GitHub
        await axios.post(
            `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/dispatches`,
            {
                event_type: "build-flutter",
                client_payload: {
                    app_name: safeAppName,
                    display_name: appName,
                    package_name: packageName,
                    icon_url: iconUpload.secure_url,
                    zip_url: zipUpload.secure_url,
                    request_id: requestId
                }
            },
            {
                headers: {
                    'Authorization': `token ${process.env.GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            }
        );

        // تنظيف
        if (fs.existsSync(iconFile.path)) fs.unlinkSync(iconFile.path);
        if (fs.existsSync(zipFile.path)) fs.unlinkSync(zipFile.path);

        res.json({
            success: true,
            build_id: requestId,
            safe_app_name: safeAppName,
            icon_url: iconUpload.secure_url,
            app_name: appName,
            package_name: packageName
        });

    } catch (error) {
        console.error("[Build Error]:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- 2. نقطة التحقق (التي كانت تسبب المشكلة) ---
app.get('/check-status/:buildId', async (req, res) => {
    try {
        const { buildId } = req.params;
        const { appName } = req.query; // الاسم الآمن (مثال: azer)

        // التحقق من وجود Release Tag
        const releaseUrl = `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/releases/tags/build-${buildId}`;
        
        try {
            // محاولة جلب بيانات الإصدار
            const response = await axios.get(releaseUrl, {
                headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` }
            });
            
            // إذا نجح الطلب، يعني أن البناء انتهى
            console.log(`[Check] Build ${buildId} found!`);

            // بناء رابط التحميل المباشر
            // ملاحظة: تأكدنا من السجلات أن الملف اسمه azer.apk (نفس appName المرسل)
            const downloadUrl = `https://github.com/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/releases/download/build-${buildId}/${appName}.apk`;
            
            res.json({ completed: true, download_url: downloadUrl });

        } catch (ghError) {
            // إذا كان الخطأ 404 من جيت هب، يعني لم ينتهِ بعد
            if (ghError.response && ghError.response.status === 404) {
                res.json({ completed: false });
            } else {
                console.error("[GitHub API Error]:", ghError.message);
                // ربما التوكن خطأ؟
                res.json({ completed: false, error: "GitHub Access Error" });
            }
        }
    } catch (error) {
        console.error("[Server Check Error]:", error);
        res.status(500).json({ error: "Check failed" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

module.exports = app;
