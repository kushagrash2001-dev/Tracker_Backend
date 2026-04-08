require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');


const Device = require('./models/Device');
const Activity = require('./models/Activity');
const UserActivitySummary = require('./models/UserActivitySummary');

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. MONGODB CONNECTION ---
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/timeTrackerDB')
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.log('❌ MongoDB Error:', err));
const ImageKit = require('imagekit');


const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
});

// store file in memory (not disk)
const storage = multer.memoryStorage();
const upload = multer({ storage });
// --- 2. CLOUDINARY SETUP ---
// You will get these keys by creating a free Cloudinary account

// ==========================================
// ROUTE 1: THE AGENT INGESTION ENDPOINT
// ==========================================
// app.post('/api/track', upload.single('screenshot'), async (req, res) => {
//   try {
//     if (!req.file) return res.status(400).json({ error: 'No image provided' });

//     const data = JSON.parse(req.body.activityData);

//     // 1. Find or Create the Device (Machine)
//     let device = await Device.findOne({ machineName: data.machineName });
//     if (!device) {
//       device = new Device({ machineName: data.machineName });
//     }
//     device.lastActive = new Date(); // Update their last seen time
//     await device.save();

//     // 2. Save the Telemetry Log with the Cloudinary URL
//     const newActivity = new Activity({
//       activityId: data.id,
//       machineName: data.machineName,
//       activeWindow: data.activeWindow,
//       idleSeconds: data.idleSeconds,
//       status: data.status,
//       localIp: data.localIp,
//       macAddress: data.macAddress,
//       ramUsagePct: data.ramUsagePct,
//       cpuCores: data.cpuCores,
//       batteryPct: data.batteryPct,
//       isPluggedIn: data.isPluggedIn,
//       freeDiskSpaceGB: data.freeDiskSpaceGB,
//       screenshotUrl: req.file.path, // This is the live Cloudinary URL!
//       timestamp: new Date(data.timestamp * 1000)
//     });

//     await newActivity.save();

//     console.log(`[SYNCED] ${data.machineName} (${device.employeeName}) - RAM: ${data.ramUsagePct}%`);

//     // 3. Send 200 OK -> THIS triggers the Go Agent to delete its local folder files
//     res.status(200).json({ success: true });

//   } catch (error) {
//     console.error('Ingestion Error:', error);
//     // If we send 500, the Go agent keeps the files and tries again later
//     res.status(500).json({ error: 'Failed to process tracking data' });
//   }
// });

// ==========================================
// HELPER: Aggregate Unique Activity
// ==========================================
async function aggregateUniqueActivity(deviceId, username, machineName, data) {
  try {
    // Normalize timestamp to start of day for grouping
    const today = new Date(data.timestamp * 1000);
    today.setHours(0, 0, 0, 0);

    // Find or Create Summary Document for Today
    let summary = await UserActivitySummary.findOne({ deviceId, date: today });
    if (!summary) {
      summary = new UserActivitySummary({ 
        deviceId, 
        username: username || "Unknown", 
        machineName, 
        date: today 
      });
    }

    const timestampMs = data.timestamp * 1000;
    const isActive = data.status === 'active';
    let totalTrackedTime = 0;

    // ✅ CASE 1: New Agent sends precise 'activityLog' array
    if (data.activityLog && Array.isArray(data.activityLog) && data.activityLog.length > 0) {
      for (const log of data.activityLog) {
        // Process Browser Entries
        if (log.type === 'browser' && log.url) {
          summary.upsertUrl({
            url: log.url,
            pageTitle: log.pageTitle || "Unknown Page",
            timestamp: timestampMs,
            status: data.status // Use overall status for consistency
          }, log.durationSec); // Add exact seconds
        } 
        // Process App Entries
        else if (log.type === 'app' && log.appName) {
          summary.upsertApp({
            appName: log.appName,
            windowTitle: log.windowTitle || "Untitled Window",
            timestamp: timestampMs,
            status: data.status
          }, log.durationSec); // Add exact seconds
        }
        totalTrackedTime += log.durationSec;
      }
    } 
    // ⚠️ CASE 2: Fallback for Old Agent (No activityLog)
    else {
      const intervalSeconds = 20; // Default interval for old agent
      
      if (data.browserUrl && data.browserUrl.trim() !== '') {
        summary.upsertUrl({ 
          url: data.browserUrl, 
          pageTitle: data.pageTitle || "Unknown Page", 
          timestamp: timestampMs, 
          status: data.status 
        }, intervalSeconds);
      } else if (data.activeWindow && data.activeWindow.trim() !== 'Unknown') {
        summary.upsertApp({ 
          appName: data.activeWindow, 
          windowTitle: data.windowTitle || "Untitled", 
          timestamp: timestampMs, 
          status: data.status 
        }, intervalSeconds);
      }
      totalTrackedTime = intervalSeconds;
    }

    // Update Global Daily Stats
    summary.stats.totalScreenshots += 1;
    
    // If status is active, add time to active. If idle, add to idle.
    if (isActive) {
      summary.stats.totalActiveSec += totalTrackedTime;
    } else {
      summary.stats.totalIdleSec += totalTrackedTime;
    }
    
    summary.lastUpdated = new Date();
    await summary.save();

  } catch (err) {
    console.error("❌ Aggregation Error:", err.message);
    // Don't crash the main request if aggregation fails
  }
}

// ==========================================
// ROUTE: POST /api/track
// ==========================================
app.post('/api/track', upload.single('screenshot'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image provided' });
    }

    // Parse JSON from agent
    const data = JSON.parse(req.body.activityData);

    // ✅ Upload to ImageKit
    let uploadedImage;
    try {
      uploadedImage = await imagekit.upload({
        file: req.file.buffer, // memory buffer
        fileName: `screenshot_${Date.now()}.png`,
        folder: "/tracker_screenshots",
      });
    } catch (uploadErr) {
      console.error("❌ Image upload failed:", uploadErr.message);
      return res.status(500).json({ error: "Image upload failed" });
    }

    const screenshotUrl = uploadedImage.url;
    const fileId = uploadedImage.fileId;

    // 1. FIND OR CREATE DEVICE
    const device = await Device.findOneAndUpdate(
      { machineName: data.machineName },
      {
        $set: { lastActive: new Date() },
        $setOnInsert: { employeeName: data.username || "Unassigned User" }
      },
      { upsert: true, returnDocument: 'after' }
    );

    // 2. SAVE ACTIVITY (WITH IMAGEKIT DATA)
    const activityPayload = {
      deviceId: device._id,
      activityId: data.id,
      activeWindow: data.activeWindow,
      browserUrl: data.browserUrl,
      username: data.username,
      idleSeconds: data.idleSeconds,
      status: data.status,
      localIp: data.localIp,
      macAddress: data.macAddress,
      ramUsagePct: data.ramUsagePct,
      cpuCores: data.cpuCores,
      batteryPct: data.batteryPct,
      isPluggedIn: data.isPluggedIn,
      freeDiskSpaceGB: data.freeDiskSpaceGb || data.freeDiskSpaceGB,
      screenshotUrl: screenshotUrl,
      imagekitFileId: fileId, // 🔥 store for deletion
      timestamp: new Date(data.timestamp * 1000),
    };

    await Activity.findOneAndUpdate(
      { activityId: data.id },
      { $set: activityPayload },
     { upsert: true, returnDocument: 'after' }
    );

    // 3. AGGREGATE ACTIVITY
    await aggregateUniqueActivity(
      device._id,
      data.username,
      data.machineName,
      data
    );

    console.log(
      `[SYNCED] ${data.machineName} (${data.username}) | Logs: ${
        data.activityLog ? data.activityLog.length : 1
      }`
    );

    res.status(200).json({ success: true });

  } catch (error) {
    console.error('❌ Ingestion Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
// ==========================================
// ROUTE: GET UNIQUE USER ACTIVITY (DEDUPLICATED)
// ==========================================

// Get all unique URLs/apps for a user on a specific date
app.get('/api/user/:deviceId/activity/:date', async (req, res) => {
  try {
    const { deviceId, date } = req.params;
    const queryDate = new Date(date);
    queryDate.setHours(0, 0, 0, 0);
    
    const summary = await UserActivitySummary.findOne({ 
      deviceId, 
      date: queryDate 
    }).populate('deviceId', 'employeeName machineName');
    
    if (!summary) {
      return res.json({ 
        message: "No activity found for this date",
        date: queryDate.toISOString().split('T')[0],
        urls: [],
        applications: [],
        stats: {}
      });
    }
    
    // Sort URLs by time spent (most visited first)
    const sortedUrls = [...summary.urls]
      .sort((a, b) => b.timeSpentSec - a.timeSpentSec)
      .map(u => ({
        ...u.toObject(),
        timeSpentMin: Math.round(u.timeSpentSec / 60)
      }));
      
    // Sort apps by time spent
    const sortedApps = [...summary.applications]
      .sort((a, b) => b.timeSpentSec - a.timeSpentSec)
      .map(a => ({
        ...a.toObject(),
        timeSpentMin: Math.round(a.timeSpentSec / 60)
      }));
    
    res.json({
      date: summary.date.toISOString().split('T')[0],
      user: summary.username,
      machine: summary.machineName,
      stats: {
        ...summary.stats.toObject(),
        totalActiveMin: Math.round(summary.stats.totalActiveSec / 60),
        totalIdleMin: Math.round(summary.stats.totalIdleSec / 60)
      },
      urls: sortedUrls,
      applications: sortedApps
    });
    
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get activity summary for date range (for dashboard charts)
app.get('/api/user/:deviceId/activity-range', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { startDate, endDate } = req.query;
    
    let start = startDate ? new Date(startDate) : new Date();
    let end = endDate ? new Date(endDate) : new Date();
    start.setHours(0,0,0,0);
    end.setHours(23,59,59,999);
    
    const summaries = await UserActivitySummary.find({
      deviceId,
      date: { $gte: start, $lte: end }
    }).sort({ date: 1 });
    
    const timeline = summaries.map(s => ({
      date: s.date.toISOString().split('T')[0],
      activeMin: Math.round(s.stats.totalActiveSec / 60),
      idleMin: Math.round(s.stats.totalIdleSec / 60),
      uniqueUrls: s.stats.uniqueUrlCount,
      uniqueApps: s.stats.uniqueAppCount,
      screenshots: s.stats.totalScreenshots
    }));
    
    // Aggregate top URLs across range
    const urlMap = {};
    const appMap = {};
    summaries.forEach(s => {
      s.urls.forEach(u => {
        if (!urlMap[u.domain]) urlMap[u.domain] = { domain: u.domain, timeSec: 0, visits: 0 };
        urlMap[u.domain].timeSec += u.timeSpentSec;
        urlMap[u.domain].visits += u.visitCount;
      });
      s.applications.forEach(a => {
        if (!appMap[a.appName]) appMap[a.appName] = { name: a.appName, timeSec: 0 };
        appMap[a.appName].timeSec += a.timeSpentSec;
      });
    });
    
    res.json({
      timeline,
      topDomains: Object.values(urlMap)
        .map(d => ({ ...d, timeMin: Math.round(d.timeSec / 60) }))
        .sort((a,b) => b.timeSec - a.timeSec)
        .slice(0, 10),
      topApps: Object.values(appMap)
        .map(a => ({ ...a, timeMin: Math.round(a.timeSec / 60) }))
        .sort((a,b) => b.timeSec - a.timeSec)
        .slice(0, 10)
    });
    
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
// ==========================================
// ROUTE 2: GET ALL DEVICES (For Admin Dashboard)
// ==========================================
app.get('/api/admin/devices', async (req, res) => {
  try {
    const devices = await Device.find();
    res.json(devices);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});
app.get('/api/admin/stats/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { startDate, endDate } = req.query;

        // --- Default to Today ---
        let start = startDate ? new Date(startDate) : new Date();
        let end = endDate ? new Date(endDate) : new Date();

        // --- Set Boundaries ---
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);

        // --- Validate Date Range (Max 7 Days) ---
        const diffInDays = (end - start) / (1000 * 60 * 60 * 24);
        if (diffInDays > 7.1) {
            return res.status(400).json({ 
                error: "Date range too large. Maximum allowed is 7 days.",
                maxDays: 7
            });
        }

        // --- Validate Future Dates (FIXED) ---
        // Compare at day level, not millisecond level
        const today = new Date();
        today.setHours(23, 59, 59, 999); // Set to end of today
        
        if (start > today || end > today) {
            return res.status(400).json({ 
                error: "Cannot select future dates" 
            });
        }

        // --- Database Query ---
        const logs = await Activity.find({
            deviceId,
            timestamp: { $gte: start, $lte: end }
        }).sort({ timestamp: 1 });

        if (!logs.length) {
            return res.json({ 
                empty: true,
                summary: {
                    activeMinutes: 0,
                    idleMinutes: 0,
                    offlineMinutes: 0,
                    rangeDays: Math.ceil(diffInDays),
                    health: { avgRam: 0, battery: 0 }
                },
                appBreakdown: [],
                timeline: []
            });
        }

        // --- Aggregation ---
        let activeSec = 0, idleSec = 0, gapSec = 0;
        const apps = {};

        logs.forEach((log, i) => {
            if (log.status === 'active') activeSec += 30;
            else idleSec += 30;

            const appName = log.activeWindow.split(' - ').pop() || "System";
            apps[appName] = (apps[appName] || 0) + 30;

            if (i > 0) {
                const diff = (new Date(logs[i].timestamp) - new Date(logs[i-1].timestamp)) / 1000;
                if (diff > 300) gapSec += (diff - 30);
            }
        });

        res.json({
            summary: {
                activeMinutes: Math.floor(activeSec / 60),
                idleMinutes: Math.floor(idleSec / 60),
                offlineMinutes: Math.floor(gapSec / 60),
                rangeDays: Math.ceil(diffInDays),
                startDate: start.toISOString().split('T')[0],
                endDate: end.toISOString().split('T')[0],
                health: {
                    avgRam: Math.round(logs.reduce((s, l) => s + (l.ramUsagePct || 0), 0) / logs.length),
                    battery: logs[logs.length - 1]?.batteryPct || 0
                }
            },
            appBreakdown: Object.entries(apps)
                .map(([name, sec]) => ({ name, minutes: Math.floor(sec / 60) }))
                .sort((a, b) => b.minutes - a.minutes),
            timeline: logs
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});
app.put('/api/admin/devices/:id', async (req, res) => {
  try {
    const device = await Device.findByIdAndUpdate(req.params.id, { employeeName: req.body.employeeName }, { new: true });
    res.json(device);
  } catch (err) {
    res.status(500).json({ error: "Update failed" });
  }
});
app.get('/api/admin/global-health', async (req, res) => {
  const total = await Device.countDocuments();
  const online = await Device.countDocuments({ lastActive: { $gte: new Date(Date.now() - 120000) } });
  res.json({ total, online, offline: total - online });
});
// ==========================================
// ROUTE 3: RENAME A DEVICE (Admin Feature)
// ==========================================
app.put('/api/devices/:id', async (req, res) => {
  try {
    const { employeeName } = req.body;
    const updatedDevice = await Device.findByIdAndUpdate(
      req.params.id, 
      { employeeName }, 
      { new: true }
    );
    res.json(updatedDevice);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update device name' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 MERN Backend running on port ${PORT}`));