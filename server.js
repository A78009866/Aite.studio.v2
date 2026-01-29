const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { v4: uuidv4 } = require('uuid');
const stream = require('stream'); // إضافة مكتبة stream للتعامل مع الملفات الكبيرة
require('dotenv').config();

const app = express();

// إعدادات Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// إعداد Multer (التخزين في الذاكرة مؤقتاً)
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // وضع حد أقصى 50 ميجا لتجنب تعليق السيرفر
});

app.use(express.json());
app.use(cors());
app.use(express.static('public'));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;

// --- دالة مساعدة لرفع الملفات عبر Stream (أكثر ثباتاً للملفات الكبيرة) ---
const uploadToCloudinary = (buffer, folder, public_id, resource_type = 'image') => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: folder,
                public_id: public_id,
                resource_type: resource_type
            },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );
        const bufferStream = new stream.PassThrough();
        bufferStream.end(buffer);
        bufferStream.pipe(uploadStream);
    });
};

// 1. استقبال طلب البناء
app.post('/trigger-build', upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'projectZip', maxCount: 1 }]), async (req, res) => {
    try {
        const { appName, packageName } = req.body;
        
        // التحقق من وجود الملفات
        if (!req.files || !req.files['icon'] || !req.files['projectZip']) {
            return res.status(400).json({ success: false, error: 'بيانات ناقصة: الأيقونة أو ملف ZIP مفقود.' });
        }

        const iconFile = req.files['icon'][0];
        const zipFile = req.files['projectZip'][0];

        if (!appName || !packageName) {
            return res.status(400).json({ success: false, error: 'بيانات ناقصة: اسم التطبيق أو معرف الحزمة.' });
        }

        const request_id = uuidv4();

        console.log(`Starting upload for Request ID: ${request_id}`);

        // رفع الأيقونة
        const iconResult = await uploadToCloudinary(
            iconFile.buffer, 
            'aite-flutter-engine/icons', 
            `icon-${request_id}`, 
            'image'
        );

        // رفع ملف المشروع (ZIP) - بصيغة raw
        const zipResult = await uploadToCloudinary(
            zipFile.buffer, 
            'aite-flutter-engine/zips', 
            `project-${request_id}`, 
            'raw'
        );

        console.log('Uploads completed. Triggering GitHub Action...');

        // إرسال الطلب إلى GitHub
        await axios.post(
            `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/dispatches`,
            {
                event_type: 'build-flutter',
                client_payload: {
                    app_name: appName,
                    package_name: packageName,
                    icon_url: iconResult.secure_url,
                    zip_url: zipResult.secure_url,
                    request_id
                }
            },
            {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            }
        );

        res.json({ 
            success: true, 
            message: 'Build triggered', 
            request_id, 
            icon_url: iconResult.secure_url, 
            zip_url: zipResult.secure_url 
        });

    } catch (error) {
        console.error('Server Error:', error);
        // التأكد من إرجاع JSON دائماً حتى في حالة الخطأ
        res.status(500).json({ 
            success: false, 
            error: error.message || 'خطأ داخلي في السيرفر' 
        });
    }
});

// 2. التحقق من الحالة
app.get('/check-status', async (req, res) => {
    const { request_id } = req.query;

    if (!request_id) {
        return res.status(400).json({ status: 'error', message: 'معرف الطلب مفقود.' });
    }

    try {
        const releaseResponse = await axios.get(
            `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/build-${request_id}`,
            { headers: { 'Authorization': `token ${GITHUB_TOKEN}` } }
        );

        if (releaseResponse.data && releaseResponse.data.assets.length > 0) {
            return res.json({
                status: 'completed',
                conclusion: 'success',
                download_url: releaseResponse.data.assets[0].browser_download_url
            });
        }
    } catch (err) {
        if (err.response && err.response.status !== 404) {
            console.error('GitHub API Error:', err.message);
        }
    }

    // إذا لم نجد الإصدار، نفترض أنه قيد التقدم (لتبسيط الكود)
    res.json({ status: 'in_progress' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
