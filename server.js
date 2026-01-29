require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const AdmZip = require('adm-zip'); // تأكد من تثبيت هذه المكتبة: npm install adm-zip

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// استخدام الذاكرة
const upload = multer({ storage: multer.memoryStorage() });

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function sanitizeFilename(name) {
    return name.trim().replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// --- دالة لاكتشاف إصدار Flutter المناسب من ملف pubspec.yaml ---
function detectFlutterVersion(zipBuffer) {
    try {
        const zip = new AdmZip(zipBuffer);
        const zipEntries = zip.getEntries();
        let pubspecContent = null;

        for (const entry of zipEntries) {
            if (entry.entryName.endsWith('pubspec.yaml') && !entry.entryName.includes('__MACOSX')) {
                pubspecContent = entry.getData().toString('utf8');
                break;
            }
        }

        if (pubspecContent) {
            const sdkMatch = pubspecContent.match(/sdk:\s*['"]?>=?([\d.]+)/);
            if (sdkMatch && sdkMatch[1]) {
                const dartVersion = parseFloat(sdkMatch[1]);
                console.log(`Detected Dart SDK requirement: ${dartVersion}`);

                // تحديث القيم لضمان عدم الوقوع في فخ Dart 3.0.0
                if (dartVersion >= 3.5) return '3.24.0';
                if (dartVersion >= 3.3) return '3.22.0';
                if (dartVersion >= 3.0) return '3.16.0'; // رفعنا الإصدار من 3.10 إلى 3.16 لضمان Dart > 3.1
                if (dartVersion >= 2.12) return '3.7.0';
            }
        }
    } catch (e) {
        console.warn("Failed to detect version, using stable:", e.message);
    }
    return '3.24.0'; // جعلنا الإصدار الافتراضي حديثاً بدلاً من stable لزيادة الاستقرار
}

// --- دالة مساعدة للرفع المباشر ---
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

// 1. نقطة البناء
app.post('/build-flutter', upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'projectZip', maxCount: 1 }]), async (req, res) => {
    try {
        const { appName, packageName } = req.body;
        const safeAppName = sanitizeFilename(appName);

        if (!req.files || !req.files['icon'] || !req.files['projectZip']) {
            return res.status(400).json({ error: "Missing files" });
        }

        console.log(`Starting build for ${appName}...`);

        // 1. تحديد إصدار Flutter قبل الرفع
        const detectedFlutterVersion = detectFlutterVersion(req.files['projectZip'][0].buffer);
        console.log(`Selected Flutter Version: ${detectedFlutterVersion}`);

        // 2. رفع الأيقونة
        const iconResult = await uploadToCloudinary(
            req.files['icon'][0].buffer,
            "aite_studio/icons",
            "image"
        );

        // 3. رفع ملف ZIP
        const zipResult = await uploadToCloudinary(
            req.files['projectZip'][0].buffer,
            "aite_studio/projects",
            "raw",
            `${packageName}_source_${Date.now()}`
        );

        console.log("Uploads complete. ZIP URL:", zipResult.secure_url);

        const requestId = Date.now().toString();

        // 4. إرسال إلى GitHub مع الإصدار المكتشف
        await axios.post(
            `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/dispatches`,
            {
                event_type: "build-flutter",
                client_payload: {
                    app_name: safeAppName,
                    display_name: appName,
                    package_name: packageName,
                    icon_url: iconResult.secure_url,
                    zip_url: zipResult.secure_url,
                    flutter_version: detectedFlutterVersion, // <-- نرسل الإصدار هنا
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
            package_name: packageName,
            detected_version: detectedFlutterVersion
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
