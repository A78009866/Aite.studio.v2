require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// إعداد التخزين المؤقت
const upload = multer({ dest: '/tmp/uploads/' });

// إعداد Cloudinary (لرفع ملف الـ Zip)
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

app.post('/build-flutter', upload.single('projectZip'), async (req, res) => {
    try {
        console.log("📥 Received Flutter Project...");
        
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        // 1. رفع ملف الـ Zip إلى Cloudinary للحصول على رابط مباشر
        const result = await cloudinary.uploader.upload(req.file.path, {
            resource_type: "raw",
            public_id: `flutter_builds/${Date.now()}_project.zip`
        });

        const zipUrl = result.secure_url;
        console.log("☁️ Project uploaded to:", zipUrl);

        // 2. تفعيل GitHub Action
        const githubToken = process.env.GITHUB_TOKEN;
        const repoOwner = process.env.GITHUB_USER;
        const repoName = process.env.GITHUB_REPO;

        await axios.post(
            `https://api.github.com/repos/${repoOwner}/${repoName}/dispatches`,
            {
                event_type: "build-flutter",
                client_payload: {
                    zip_url: zipUrl,
                    app_name: req.body.appName || "MyFlutterApp"
                }
            },
            {
                headers: {
                    "Authorization": `Bearer ${githubToken}`,
                    "Accept": "application/vnd.github.v3+json"
                }
            }
        );

        // تنظيف الملف المؤقت
        fs.unlinkSync(req.file.path);

        res.json({ 
            success: true, 
            message: "Build started! AI will handle errors automatically.",
            zipUrl: zipUrl 
        });

    } catch (error) {
        console.error("Build Error:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Flutter Builder running on port ${PORT}`));
