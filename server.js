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
app.use(express.static('public')); // لخدمة ملف index.html
app.use(express.json());

// إعدادات Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// إعداد Multer لاستقبال الملفات (تخزين مؤقت)
const upload = multer({ dest: '/tmp/' });

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// نقطة النهاية لبناء فلاتر
app.post('/build-flutter', upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'projectZip', maxCount: 1 }]), async (req, res) => {
    try {
        const { appName, packageName } = req.body;
        const iconFile = req.files['icon'][0];
        const zipFile = req.files['projectZip'][0];

        console.log(`Received build request for: ${appName}`);

        // 1. رفع الأيقونة لـ Cloudinary
        const iconUpload = await cloudinary.uploader.upload(iconFile.path, {
            folder: "aite_studio/icons"
        });

        // 2. رفع ملف المشروع (ZIP) لـ Cloudinary كـ Raw File
        const zipUpload = await cloudinary.uploader.upload(zipFile.path, {
            resource_type: "raw",
            folder: "aite_studio/projects",
            public_id: `${packageName}_source_${Date.now()}`
        });

        // 3. إرسال أمر البناء لـ GitHub Actions
        const githubPayload = {
            event_type: "build-flutter",
            client_payload: {
                app_name: appName,
                package_name: packageName,
                icon_url: iconUpload.secure_url,
                zip_url: zipUpload.secure_url,
                request_id: Date.now().toString()
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

        // تنظيف الملفات المؤقتة
        fs.unlinkSync(iconFile.path);
        fs.unlinkSync(zipFile.path);

        res.json({ 
            success: true, 
            message: "تم استلام المشروع وبدء عملية المعالجة والبناء في السيرفرات السحابية.",
            build_id: githubPayload.client_payload.request_id
        });

    } catch (error) {
        console.error("Build Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Aite Studio Server running on port ${PORT}`));
