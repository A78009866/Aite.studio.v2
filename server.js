require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// استخدام الذاكرة (مهم لـ Vercel)
const upload = multer({ storage: multer.memoryStorage() });

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function sanitizeFilename(name) {
    return name.trim().replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// --- دالة مساعدة للرفع المباشر (Stream Upload) ---
const uploadToCloudinary = (buffer, folder, resourceType, publicId = null) => {
    return new Promise((resolve, reject) => {
        const options = { folder: folder, resource_type: resourceType };
        if (publicId) options.public_id = publicId;

        const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
            if (error) return reject(error);
            resolve(result);
        });
        stream.end(buffer);
    });
};

// 1. نقطة البناء (تم إصلاح مشكلة ZIP هنا)
app.post('/build-flutter', upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'projectZip', maxCount: 1 }]), async (req, res) => {
    try {
        const { appName, packageName } = req.body;
        const safeAppName = sanitizeFilename(appName);

        if (!req.files || !req.files['icon'] || !req.files['projectZip']) {
            return res.status(400).json({ error: "Missing files" });
        }

        console.log(`Starting build for ${appName}...`);

        // 1. رفع الأيقونة
        const iconResult = await uploadToCloudinary(
            req.files['icon'][0].buffer,
            "aite_studio/icons",
            "image"
        );

        // 2. رفع ملف ZIP (الإصلاح: استخدام uploadToCloudinary بدلاً من الملفات المحلية)
        // هذا يضمن أن الملف وصل كاملاً إلى Cloudinary
        const zipResult = await uploadToCloudinary(
            req.files['projectZip'][0].buffer,
            "aite_studio/projects",
            "raw", // مهم جداً للملفات المضغوطة
            `${packageName}_source_${Date.now()}`
        );

        console.log("Uploads complete. ZIP URL:", zipResult.secure_url);

        const requestId = Date.now().toString();

        // 3. إرسال إلى GitHub
        await axios.post(
            `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/dispatches`,
            {
                event_type: "build-flutter",
                client_payload: {
                    app_name: safeAppName,
                    display_name: appName,
                    package_name: packageName,
                    icon_url: iconResult.secure_url,
                    zip_url: zipResult.secure_url, // الرابط الآن مضمون
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

        res.json({
            success: true,
            build_id: requestId,
            safe_app_name: safeAppName,
            icon_url: iconResult.secure_url,
            app_name: appName,
            package_name: packageName
        });

    } catch (error) {
        console.error("Build Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. التحقق من الحالة
app.get('/check-status/:buildId', async (req, res) => {
    try {
        const { buildId } = req.params;
        const { appName } = req.query;

        const releaseUrl = `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/releases/tags/build-${buildId}`;
        
        try {
            await axios.get(releaseUrl, {
                headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` }
            });

            const downloadUrl = `https://github.com/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/releases/download/build-${buildId}/${appName}.apk`;
            res.json({ completed: true, download_url: downloadUrl });

        } catch (ghError) {
            if (ghError.response && ghError.response.status === 404) {
                res.json({ completed: false });
            } else {
                res.json({ completed: false });
            }
        }
    } catch (error) {
        res.status(500).json({ error: "Check failed" });
    }
});

const PORT = process.env.PORT || 3000;
module.exports = app;
if (require.main === module) {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
