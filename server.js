const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// إعدادات GitHub من متغيرات البيئة
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;

// 1. استقبال طلب البناء
app.post('/trigger-build', async (req, res) => {
    const { app_name, package_name, icon_url, zip_url, request_id } = req.body;

    if (!app_name || !package_name || !zip_url || !request_id) {
        return res.status(400).json({ success: false, error: 'بيانات ناقصة' });
    }

    try {
        // إرسال طلب لـ GitHub Action
        await axios.post(
            `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/dispatches`,
            {
                event_type: 'build-flutter',
                client_payload: {
                    app_name,
                    package_name,
                    icon_url,
                    zip_url,
                    request_id // هذا المعرف هو مفتاح الربط
                }
            },
            {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            }
        );

        res.json({ success: true, message: 'Build triggered', request_id });
    } catch (error) {
        console.error('GitHub Error:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'فشل الاتصال بـ GitHub' });
    }
});

// 2. التحقق من الحالة وجلب رابط التحميل الفريد
app.get('/check-status', async (req, res) => {
    const { request_id } = req.query;

    try {
        // جلب آخر عمليات التشغيل (Runs)
        const runsResponse = await axios.get(
            `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs`,
            { headers: { 'Authorization': `token ${GITHUB_TOKEN}` } }
        );

        // البحث عن العملية التي تحتوي على نفس request_id
        // ملاحظة: GitHub لا يعرض الـ client_payload مباشرة في القائمة، 
        // لذا سنبحث عن طريق التسمية (إذا قمت بتعديل اسم الـ Run في ملف YML)
        // أو سنفترض أن أحدث عملية "queued" أو "in_progress" هي المطلوبة إذا كان التزامن سريعاً.
        // لكن الحل الأدق هو البحث عن "Release" يحمل التاج build-{request_id}

        // الطريقة الأضمن: التحقق هل تم إنشاء Release بهذا الـ ID؟
        try {
            const releaseResponse = await axios.get(
                `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/build-${request_id}`,
                { headers: { 'Authorization': `token ${GITHUB_TOKEN}` } }
            );

            if (releaseResponse.data && releaseResponse.data.assets.length > 0) {
                // تم العثور على الإصدار! العملية انتهت بنجاح
                return res.json({
                    status: 'completed',
                    conclusion: 'success',
                    download_url: releaseResponse.data.assets[0].browser_download_url
                });
            }
        } catch (err) {
            // إذا لم يتم العثور على Release (404)، فهذا يعني أن البناء لم ينتهِ بعد أو فشل
        }

        // إذا لم نجد Release، نتحقق من حالة الـ Action هل فشلت؟
        // هذا الجزء تقريبي، يعتمد على جلب أحدث عملية dispatch
        const latestRun = runsResponse.data.workflow_runs[0];
        if (latestRun && latestRun.status === 'completed' && latestRun.conclusion === 'failure') {
             // هنا يجب التأكد أن هذا الـ Run يخصنا، لكن للتبسيط في هذا المثال سنفترض ذلك
             // (لتحسين الدقة، اجعل ملف YAML يغير اسم الـ Run ليكون: Build ID: {request_id})
             return res.json({ status: 'completed', conclusion: 'failure' });
        }

        // ما زال قيد العمل
        res.json({ status: 'in_progress' });

    } catch (error) {
        console.error(error.message);
        res.json({ status: 'error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
