require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// إعدادات مهمة لـ Vercel
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// استخدام الذاكرة المؤقتة بدلاً من القرص لأن Vercel لا يسمح بالكتابة الدائمة
const upload = multer({ storage: multer.memoryStorage() });

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// دالة مساعدة
function sanitizeFilename(name) {
    return name.trim().replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// 1. نقطة البناء
app.post('/build-flutter', upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'projectZip', maxCount: 1 }]), async (req, res) => {
    try {
        const { appName, packageName } = req.body;
        const safeAppName = sanitizeFilename(appName);

        if (!req.files || !req.files['icon'] || !req.files['projectZip']) {
            return res.status(400).json({ error: "يرجى رفع جميع الملفات" });
        }

        // تحويل Buffer إلى Base64 للرفع المباشر (لأننا نستخدم memoryStorage)
        const iconB64 = `data:${req.files['icon'][0].mimetype};base64,${req.files['icon'][0].buffer.toString('base64')}`;
        
        // رفع الأيقونة
        const iconUpload = await cloudinary.uploader.upload(iconB64, {
            folder: "aite_studio/icons"
        });

        // رفع ملف ZIP (يحتاج معالجة خاصة مع الذاكرة، لكن سنستخدم طريقة temp file مؤقتة مدعومة في Vercel /tmp)
        const zipPath = `/tmp/${Date.now()}.zip`;
        fs.writeFileSync(zipPath, req.files['projectZip'][0].buffer);
        
        const zipUpload = await cloudinary.uploader.upload(zipPath, {
            resource_type: "raw",
            folder: "aite_studio/projects",
            public_id: `${packageName}_source_${Date.now()}`
        });

        const requestId = Date.now().toString();

        // GitHub Dispatch
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
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

        res.json({
            success: true,
            build_id: requestId,
            safe_app_name: safeAppName,
            icon_url: iconUpload.secure_url,
            app_name: appName,
            package_name: packageName
        });

    } catch (error) {
        console.error("Build Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. نقطة التحقق (Check Status)
app.get('/check-status/:buildId', async (req, res) => {
    try {
        const { buildId } = req.params;
        const { appName } = req.query;

        // التحقق من التاج في GitHub
        const releaseUrl = `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/releases/tags/build-${buildId}`;
        
        try {
            await axios.get(releaseUrl, {
                headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` }
            });

            // إذا وجدنا التاج، نعيد الرابط
            const downloadUrl = `https://github.com/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/releases/download/build-${buildId}/${appName}.apk`;
            
            res.json({ completed: true, download_url: downloadUrl });

        } catch (ghError) {
            if (ghError.response && ghError.response.status === 404) {
                res.json({ completed: false });
            } else {
                throw ghError;
            }
        }
    } catch (error) {
        console.error("Check Status Error:", error.message);
        res.status(500).json({ error: "Check failed" });
    }
});

const PORT = process.env.PORT || 3000;
// تصدير التطبيق ليعمل مع Vercel
module.exports = app;

if (require.main === module) {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
