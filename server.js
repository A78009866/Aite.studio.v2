require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const AdmZip = require('adm-zip');

const app = express();
app.use(cors());
app.use(express.json());

// إعدادات Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ storage: multer.memoryStorage() });

/**
 * وظيفة الكشف عن الإصدار (المنطق الذكي النهائي)
 * القاعدة: إذا كان المشروع حديثاً (Dart 3+) نعطيه أحدث Flutter متاح.
 * هذا يحل مشكلة تعارض المكتبات الحديثة مع الإصدارات القديمة.
 */
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
                console.log(`Detected Dart SDK: ${dartVersion}`);
                
                // المشاريع الحديثة (Dart 3.0+) تحتاج Flutter 3.24+
                if (dartVersion >= 3.0) return '3.24.3';
                
                // المشاريع المتوسطة (Null Safety)
                if (dartVersion >= 2.12) return '3.10.0';
            }
        }
    } catch (e) {
        console.warn("Version detection failed, using default:", e.message);
    }
    // في حالة الشك، استخدم الأحدث والأقوى
    return '3.24.3';
}

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

app.post('/build-flutter', upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'projectZip', maxCount: 1 }]), async (req, res) => {
    try {
        const { appName, packageName } = req.body;
        
        // 1. اكتشاف النسخة
        const detectedFlutterVersion = detectFlutterVersion(req.files['projectZip'][0].buffer);
        console.log(`Selected Flutter Version: ${detectedFlutterVersion}`);

        // 2. رفع الملفات
        const iconResult = await uploadToCloudinary(req.files['icon'][0].buffer, "aite_studio/icons", "image");
        const zipResult = await uploadToCloudinary(req.files['projectZip'][0].buffer, "aite_studio/projects", "raw", `${packageName}_src_${Date.now()}`);

        const requestId = Date.now().toString();

        // 3. إرسال أمر البناء لـ GitHub
        await axios.post(
            `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/dispatches`,
            {
                event_type: "build-flutter",
                client_payload: {
                    app_name: appName.trim().replace(/[^a-z0-9]/gi, '_').toLowerCase(),
                    display_name: appName,
                    package_name: packageName,
                    icon_url: iconResult.secure_url,
                    zip_url: zipResult.secure_url,
                    flutter_version: detectedFlutterVersion,
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

        res.json({ success: true, build_id: requestId });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
