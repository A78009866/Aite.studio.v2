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
app.use(express.static(path.join(__dirname, 'public')));

// إعدادات Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ storage: multer.memoryStorage() });

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function sanitizeFilename(name) {
    return name.trim().replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

/**
 * دالة ذكية لاكتشاف إصدار Flutter المناسب.
 * تم التحديث لتفضيل النسخ الحديثة جداً لتجنب مشاكل Dart SDK.
 */
function detectFlutterVersion(zipBuffer) {
    try {
        const zip = new AdmZip(zipBuffer);
        const zipEntries = zip.getEntries();
        let pubspecContent = null;

        // البحث عن pubspec.yaml
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

                // استراتيجية اختيار النسخة:
                // إذا كان المشروع يتطلب Dart 3.0 أو أحدث، نعطيه أحدث نسخة مستقرة (3.24.3)
                // لأنها تحتوي على Dart 3.5 وتدعم المكتبات الحديثة وتتوافق عكسياً مع Dart 3.0
                if (dartVersion >= 3.0) return '3.24.3';
                
                // للمشاريع القديمة (Null Safety وما بعدها)
                if (dartVersion >= 2.12) return '3.7.0';
            }
        }
    } catch (e) {
        console.warn("Detection failed, defaulting to stable:", e.message);
    }
    // الافتراضي هو الأقوى والأحدث
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
        const safeAppName = sanitizeFilename(appName);

        if (!req.files || !req.files['icon'] || !req.files['projectZip']) {
            return res.status(400).json({ error: "Missing files" });
        }

        // اكتشاف النسخة
        const detectedFlutterVersion = detectFlutterVersion(req.files['projectZip'][0].buffer);
        console.log(`Building with Flutter version: ${detectedFlutterVersion}`);

        // رفع الملفات
        const iconResult = await uploadToCloudinary(req.files['icon'][0].buffer, "aite_studio/icons", "image");
        const zipResult = await uploadToCloudinary(req.files['projectZip'][0].buffer, "aite_studio/projects", "raw", `${packageName}_src_${Date.now()}`);

        const requestId = Date.now().toString();

        // إرسال طلب البناء إلى GitHub
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

        res.json({ success: true, build_id: requestId, app_name: appName, detected_version: detectedFlutterVersion });

    } catch (error) {
        console.error("Build Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/check-status/:buildId', async (req, res) => {
    try {
        const { buildId } = req.params;
        const { appName } = req.query;
        // ملاحظة: الرابط هنا يعتمد على أن GitHub Action سينشئ Release بنفس التاق
        const releaseUrl = `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/releases/tags/build-${buildId}`;
        
        try {
            await axios.get(releaseUrl, { headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` } });
            const downloadUrl = `https://github.com/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/releases/download/build-${buildId}/${appName}.apk`;
            res.json({ completed: true, download_url: downloadUrl });
        } catch (e) {
            // لم يتم العثور على الإصدار بعد
            res.json({ completed: false });
        }
    } catch (e) {
        res.status(500).json({ error: "Failed to check status" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
