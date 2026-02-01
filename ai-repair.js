// ai-repair.js
const fs = require('fs');
const axios = require('axios');
const path = require('path');

// إعدادات الـ API
const API_KEY = process.env.AI_API_KEY;
const API_URL = "https://api.z.ai/v1/chat/completions"; // تأكد من الرابط الصحيح لـ Z.ai

async function repairBuild() {
    console.log("🚑 Starting AI Auto-Repair Sequence...");

    // 1. قراءة سجل الخطأ
    const logPath = path.join(__dirname, 'build_log.txt');
    if (!fs.existsSync(logPath)) {
        console.error("❌ No build log found.");
        process.exit(1);
    }
    const logContent = fs.readFileSync(logPath, 'utf8');
    const errorSnippet = logContent.slice(-2000); // نأخذ آخر 2000 حرف حيث يوجد الخطأ عادة

    // 2. قراءة ملفات الإعداد الحالية (للسياق)
    let pubspec = "";
    let gradle = "";
    
    try {
        pubspec = fs.readFileSync('pubspec.yaml', 'utf8');
        gradle = fs.readFileSync('android/app/build.gradle', 'utf8');
    } catch (e) {
        console.log("⚠️ Could not read config files, proceeding with logs only.");
    }

    // 3. تجهيز الطلب للذكاء الاصطناعي
    const prompt = `
    You are a Senior Flutter DevOps Engineer.
    My 'flutter build apk' failed. Here is the last part of the log:
    ---
    ${errorSnippet}
    ---
    
    Here is my pubspec.yaml:
    ${pubspec}

    Here is my android/app/build.gradle:
    ${gradle}
    
    ANALYZE the error. If it is a version conflict, minSdk issue, or syntax error, provide the FULL CORRECTED CONTENT of the file that needs changing.
    
    Return JSON ONLY in this format:
    {
        "filename": "path/to/file",
        "content": "new full file content"
    }
    If you cannot fix it, return {"error": "unknown"}.
    `;

    try {
        console.log("📡 Consulting AI Architect...");
        const response = await axios.post(API_URL, {
            model: "model-id-here", // استبدل باسم الموديل المناسب في Z.ai
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1
        }, {
            headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" }
        });

        const aiResponse = response.data.choices[0].message.content;
        
        // تنظيف الرد (لضمان أنه JSON فقط)
        const jsonString = aiResponse.replace(/```json/g, '').replace(/```/g, '').trim();
        const fix = JSON.parse(jsonString);

        if (fix.error) {
            console.error("❌ AI could not determine a fix.");
            process.exit(1);
        }

        // 4. تطبيق الإصلاح
        console.log(`✅ Applying fix to: ${fix.filename}`);
        fs.writeFileSync(fix.filename, fix.content);
        console.log("🔧 File patched successfully!");

    } catch (error) {
        console.error("❌ AI Repair failed:", error.message);
        if(error.response) console.error(error.response.data);
        process.exit(1);
    }
}

repairBuild();
